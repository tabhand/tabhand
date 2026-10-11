// The cursor sits on the page while the agent works: it shows before the first action, comes back
// after each page load, and fades out once the agent is done. The tab's icon carries the agent's
// badge for the same stretch, then gets the site's own icon back. The test pages report what they
// see, so this needs no special access to the extension.
//
//   node test/cursor-presence.mjs

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { BridgeClient } from '../src/bridge-client.mjs';
import { frontmostApp, launchTestBrowser, sleep } from './harness.mjs';

const reports = {};
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#0ea5e9"/></svg>';
const page = (name, body) => `<!doctype html><title>Page ${name}</title><link rel="icon" href="/icon.svg">
  <body style="font: 16px sans-serif; padding: 40px">${body}
  <script>setInterval(() => {
    const icon = document.querySelector('link[rel~="icon"]');
    const badge = Boolean(icon?.hasAttribute('data-tabhand-badge') && icon.href.startsWith('data:image/svg+xml'));
    fetch('/report?page=${name}&cursor=' + document.querySelectorAll('tabhand-cursor').length +
      '&badge=' + Number(badge) + '&icon=' + encodeURIComponent(icon?.getAttribute('href') ?? ''));
  }, 250);</script>`;
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/report') {
    reports[url.searchParams.get('page')] = {
      cursor: Number(url.searchParams.get('cursor')),
      badge: Number(url.searchParams.get('badge')),
      icon: url.searchParams.get('icon'),
      at: Date.now(),
    };
    response.end();
    return;
  }
  if (url.pathname === '/icon.svg') {
    response.writeHead(200, { 'content-type': 'image/svg+xml' });
    response.end(ICON);
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(
    url.pathname === '/b'
      ? page('b', '<h1>Page B</h1><p>Arrived.</p>')
      : page('a', '<h1>Page A</h1><p><button>Does nothing</button></p><p style="margin-top: 200px"><a href="/b">Go to page B</a></p>'),
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
/** Waits for the named page to report something, after `since`. */
async function pageReports(name, test, since, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const report = reports[name];
    if (report && report.at > since && test(report)) return true;
    await sleep(150);
  }
  return false;
}
const cursorOn = (name, expected, since, timeoutMs) => pageReports(name, (report) => report.cursor === expected, since, timeoutMs);

const browser = await launchTestBrowser();
const bridge = new BridgeClient({ sessionId: crypto.randomUUID(), label: 'Claude', theme: 'claude' });
const focus = new Set();
const sampler = setInterval(() => focus.add(frontmostApp()), 200);
try {
  if (!browser.connected) throw new Error('The test browser did not connect.');
  let since = Date.now();
  const { tabId } = await bridge.request('open_tab', { url: `${origin}/a` });
  check('cursor sits on the page before the agent does anything', await cursorOn('a', 1, since));
  check("the tab's icon shows the agent's badge while it works", await pageReports('a', (report) => report.badge === 1, since));

  let { snapshot } = await bridge.request('snapshot', { tabId });
  await bridge.request('click', { tabId, ref: /button "Does nothing" \[ref=(e\d+)\]/.exec(snapshot)?.[1] });
  since = Date.now();
  check('cursor stays between actions', await cursorOn('a', 1, since));

  ({ snapshot } = await bridge.request('snapshot', { tabId }));
  const clicked = await bridge.request('click', { tabId, ref: /link "Go to page B" \[ref=(e\d+)\]/.exec(snapshot)?.[1] });
  since = Date.now();
  check('cursor comes back after the page loads', clicked.navigated && (await cursorOn('b', 1, since)), clicked.url);
  check('the badge comes back after the page loads', await pageReports('b', (report) => report.badge === 1, since));
  const shot = await bridge.request('screenshot', { tabId, keepCursor: true });
  const shotPath = path.join(os.tmpdir(), 'tabhand-cursor-presence.jpg');
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  console.log(`      screenshot with the cursor where the agent last clicked: ${shotPath}`);

  // The agent session ends; after the bridge's 30-second grace period the cursor should leave.
  bridge.close();
  since = Date.now();
  check('cursor fades out once the agent is done', await cursorOn('b', 0, since, 45_000));
  check("the site's own icon comes back", await pageReports('b', (report) => report.badge === 0 && report.icon === '/icon.svg', since, 5_000), reports.b?.icon);
} catch (error) {
  check('test run', false, error.message);
} finally {
  clearInterval(sampler);
  check('the browser never came to the front', ![...focus].some((app) => /Chrome for Testing/.test(app)), [...focus].join(', '));
  bridge.close();
  server.close();
  await browser.close();
  process.exit(results.every(Boolean) ? 0 : 1);
}
