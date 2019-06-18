'use strict';

const express = require('express');
const puppeteer = require('puppeteer');
const {TimeoutError} = require('puppeteer/Errors');
const {URL} = require('url');
const log4js = require('log4js');
const psl = require('psl');
const tldjs = require('tldjs');
const ip = require('ip');

log4js.configure({
  appenders: {
    out: {type: 'stdout'},
    app: {type: 'file', filename: 'webbkoll-backend.log'},
  },
  categories: {
    default: {
      appenders: ['out', 'app'],
      level: 'info',
    },
  },
});

const logger = log4js.getLogger();

const PORT = process.env.PORT || 8100;
const WEBBKOLL_ENV = process.env.WEBBKOLL_ENV || 'prod';
const app = express();

function urldecode(url) {
  return decodeURIComponent(url.replace(/\+/g, ' '));
}

app.get('/', async (request, response) => {
  const url = urldecode(request.query.fetch_url);

  try {
    const parsedUrl = new URL(urldecode(request.query.fetch_url));
    if (!['http:', 'https:'].includes(parsedUrl.protocol) || !(psl.parse(parsedUrl.hostname).listed)) {
      return response.status(500).type('application/json').send(JSON.stringify({
        'success': false,
        'reason': 'Failed to fetch this URL: invalid URL',
      }));
    }
  } catch (err) {
    return response.status(500).type('application/json').send(JSON.stringify({
      'success': false,
      'reason': 'Failed to fetch this URL: invalid URL',
    }));
  }

  logger.info('Trying ' + url);

  const timeout = request.query.timeout || 25000;
  const browser = await puppeteer.launch({headless: true});
  const viewport = {
    width: 1920,
    height: 1080,
  };

  try {
    const context = await browser.createIncognitoBrowserContext();
    const page = await context.newPage();
    const client = await page.target().createCDPSession();

    await page.setViewport(viewport);
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/76.0.3803.0 Safari/537.36');

    if (WEBBKOLL_ENV != 'dev') {
      await page.setRequestInterception(true);
      page.on('request', interceptedRequest => {
        let parsedUrl = tldjs.parse(interceptedRequest.url());
        // Unless in dev mode, don't allow requests to private IPs or to domains with non-existent TLDs
        if ((parsedUrl.isIp && ip.isPrivate(parsedUrl.hostname)) || (!parsedUrl.isIp && !parsedUrl.tldExists)) {
          interceptedRequest.abort();
        } else {
          interceptedRequest.continue();
        }
      });
    }

    let responses = [];
    page.on('response', (response) => {
      responses.push({
        'url': response.url(),
        'remote_address': response.remoteAddress(),
        'headers': response.headers()
      });
    });

    await client.send('Security.enable');
    let securityInfo = {};
    client.on('Security.securityStateChanged', state => {
      securityInfo = state;
    });

    // On some broken pages neither the load event nor the DOMContentLoaded
    // event are ever fired, so it's normally best to only wait until
    // networkidle2 ("consider navigation to be finished when there are no
    // more than 2 network connections for at least 500 ms"). However, that
    // breaks some other pages where waiting for DOMContentLoaded first is more
    // appropriate. Ugly workaround: try both, if necessary!
    let pageResponse;
    try {
      pageResponse = await page.goto(url, {
        waitUntil: ['domcontentloaded', 'networkidle2'],
        timeout: timeout,
      });
    } catch (err) {
      if (err instanceof TimeoutError) {
        logger.info('First try of ' + url + ' timed out; trying with just networkidle2');
        pageResponse = await page.goto(url, {
          waitUntil: ['networkidle2'],
          timeout: timeout,
        });
      } else {
        throw(err)
      }
    }

    let content = await page.content();
    // Necessary to get *ALL* cookies
    let cookies = await client.send('Network.getAllCookies');
    //let localStorage = await page.evaluate(() => { return {...localStorage}; });
    // ^- prettier, but we've got to truncate things for sanity:
    let localStorageData = {};
    try {
      localStorageData = await page.evaluate(() => {
        let tmpObj = {};
        let keys = Object.keys(localStorage);
        for (let i = 0; i < keys.length; ++i) {
          tmpObj[keys[i].substring(0,100)] = localStorage.getItem(keys[i]).substring(0,100);
        }
        return tmpObj;
      });
    } catch (err) {
      console.log("Accessing localStorage failed. This shouldn't happen. Error:");
      console.log(err);
    }

    let title = await page.title();

    let finalUrl = await page.url();
    let parsedUrl = new URL(finalUrl);
    let isValidUrl = psl.parse(parsedUrl.hostname).listed;

    let responseHeaders = pageResponse.headers();
    let responseStatus = pageResponse.status();

    let webbkollStatus = 200;
    let results = {};
    if (responseStatus >= 200 && responseStatus <= 299 && isValidUrl) {
      // TODO: Use response interception when available
      // (https://github.com/GoogleChrome/puppeteer/issues/1191)
      if (responseHeaders['content-type'] && (responseHeaders['content-type'].startsWith('text/html') || responseHeaders['content-type'].startsWith('application/xhtml+xml'))) {
        logger.info('Successfully checked ' + url);
        results = {
          'success': true,
          'input_url': url,
          'final_url': finalUrl,
          'responses': responses,
          'response_headers': responseHeaders,
          'status': responseStatus,
          'remote_address': pageResponse.remoteAddress(),
          'cookies': cookies.cookies,
          'localStorage': localStorageData,
          'security_info': securityInfo,
          'content': content.substring(0, 5000000) // upper limit for sanity
        };
      } else {
        logger.warn('Failed checking ' + url + ': ' + responseStatus);
        results = {
          'success': false,
          'reason': 'Page does not have text/html Content-Type',
        };
        webbkollStatus = 500;
      }
    } else if (!isValidUrl) {
      logger.warn('Failed checking ' + url + ': ' + responseStatus);
      results = {
        'success': false,
        'reason': 'Invalid URL.',
      };
      webbkollStatus = 500;
    } else {
      logger.warn('Failed checking ' + url + ': ' + responseStatus);
      results = {
        'success': false,
        'reason': 'Failed to fetch this URL: ' + responseStatus + ' (' + title + ')',
      };
      webbkollStatus = 500;
    }

    response.status(webbkollStatus).type('application/json').send(JSON.stringify(results));
    await context.close();
  } catch (err) {
    logger.warn('Failed checking ' + url + ': ' + err.toString());
    response.status(500).type('application/json').send(JSON.stringify({
      'success': false,
      'reason': 'Failed to fetch this URL: ' + err.toString(),
    }));
  }
  await browser.close();
  logger.info('Finished with ' + url);
});

app.get('/status', async (request, response) => {
  response.status(200).send('OK!');
});

app.listen(PORT, function() {
  logger.info(`Webkoll backend listening on port ${PORT}`);
});
