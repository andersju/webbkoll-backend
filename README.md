# Webbkoll backend

This is the backend for the [Webbkoll](https://github.com/andersju/webbkoll) site checker.
It's a tiny script that makes use of [Puppeteer](https://github.com/GoogleChrome/puppeteer).
It visits a given URL with Chromium and returns JSON with headers, cookies, requests, etc.
It's not pretty.

Node.js 8.x LTS required. Simply run `npm install`, which should install everything necessary,
including a local copy of Chromium; and then `npm start` or (`nodejs index.js`) to start.
Usage: `http://localhost:8100/?fetch_url=http://www.example.com`

Make sure you have all necessary system dependencies; see [Puppeteer's troubleshooting page](https://github.com/GoogleChrome/puppeteer/blob/master/docs/troubleshooting.md) for e.g. a list of necessary Ubuntu/Debian packages.

The script listens to port 8100 by default. Output is logged to `webbkoll-backend.log`.
Note that this script should be considered highly experimental, and it has NO throttling
or access control whatsoever -- this needs to be handled elsewhere (for Webbkoll the frontend handles this).
Don't put it on a public-facing server unless you're looking for trouble.

Inspired by [Puppeteer as a Service](https://github.com/GoogleChromeLabs/pptraas.com).

### Keep it running

Sample systemd unit file:

```
[Unit]
Description=Webbkoll-backend

[Service]
Type=simple
ExecStart=/usr/bin/npm start
WorkingDirectory=/home/foobar/webbkoll-backend
User=foobar
Group=foobar
Restart=always

[Install]
WantedBy=multi-user.target
```

Run `systemctl daemon-reload` for good measure, and then try `systemctl start webbkoll-backend`.
(And `systemctl enable webbkoll-backend` to have it started automatically.)