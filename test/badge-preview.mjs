// Renders the tab badges for every theme in a mock tab strip, at real size and zoomed.
//
//   node test/badge-preview.mjs [output.jpg]

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { badgeImage } from '../extension/badge.js';
import { THEMES, themeFor } from '../extension/themes.js';
import { BridgeClient } from '../src/bridge-client.mjs';
import { launchTestBrowser, sleep } from './harness.mjs';

const output = process.argv[2] ?? path.join(os.tmpdir(), 'tabhand-badges.jpg');
const svgIcon = (svg) => `data:image/svg+xml,${encodeURIComponent(svg)}`;
const sites = [
  { title: 'Ada Lovelace - Wikipedia', icon: svgIcon('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#fff" stroke="#a2a9b1"/><text x="8" y="12.5" font-family="Georgia" font-size="12" text-anchor="middle">W</text></svg>') },
  { title: 'Pull requests · GitHub', icon: svgIcon('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="#1f2328"/><circle cx="8" cy="7" r="3.2" fill="#fff"/><rect x="6.4" y="9" width="3.2" height="5" fill="#fff"/></svg>') },
  { title: 'Inbox (3) - Gmail', icon: svgIcon('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect y="3" width="16" height="11" rx="1.5" fill="#fff" stroke="#ccc"/><path d="M1 4 L8 9.5 L15 4" fill="none" stroke="#ea4335" stroke-width="2"/></svg>') },
];
const themes = Object.keys(THEMES);

const tab = (title, icon, size) =>
  `<div class="tab"><img src="${icon}" width="${size}" height="${size}"><span>${title}</span></div>`;
const page = `<!doctype html><html><head><style>
  body { margin: 0; padding: 28px; background: #f3f4f6; font: 12.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #3c4043; }
  .strip { display: flex; gap: 2px; background: #dee1e6; padding: 8px 8px 0; border-radius: 10px 10px 0 0; margin-bottom: 18px; flex-wrap: wrap; }
  .tab { display: flex; align-items: center; gap: 8px; width: 205px; height: 34px; padding: 0 12px; background: #eef0f3; border-radius: 8px 8px 0 0; }
  .tab span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tab:first-child { background: #fff; }
  h2 { font-size: 12px; margin: 6px 0 8px; color: #5f6368; font-weight: 600; }
  .zoom { display: flex; gap: 28px; flex-wrap: wrap; }
  .zoom figure { margin: 0; text-align: center; font-size: 12px; color: #5f6368; }
  .zoom img { display: block; margin: 0 auto 6px; image-rendering: auto; }
</style></head><body>
  <h2>Tab strip (real size): your tab first, then agent tabs</h2>
  <div class="strip">${tab(sites[2].title, sites[2].icon, 16)}${themes
    .slice(0, 4)
    .map((key, i) => tab(sites[i % 2].title, badgeImage(themeFor(key)), 16))
    .join('')}</div>
  <div class="strip">${tab(sites[0].title, sites[0].icon, 16)}${themes
    .slice(4)
    .map((key, i) => tab(sites[(i + 1) % 3].title, badgeImage(themeFor(key)), 16))
    .join('')}</div>
  <h2>Zoomed in</h2>
  <div class="zoom">${themes
    .map((key) => `<figure><img src="${badgeImage(themeFor(key))}" width="64" height="64">${key}</figure>`)
    .join('')}</div>
</body></html>`;

const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(page);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await launchTestBrowser();
const bridge = new BridgeClient({ sessionId: crypto.randomUUID(), label: 'Preview' });
let ok = false;
try {
  if (!browser.connected) throw new Error('The test browser did not connect.');
  const { tabId } = await bridge.request('open_tab', { url: `http://127.0.0.1:${server.address().port}/` });
  await sleep(500);
  fs.writeFileSync(output, Buffer.from((await bridge.request('screenshot', { tabId })).data, 'base64'));
  console.log(`Saved ${output}`);
  ok = true;
} catch (error) {
  console.error(error.message);
} finally {
  bridge.close();
  server.close();
  await browser.close();
  process.exit(ok ? 0 : 1);
}
