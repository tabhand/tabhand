// Renders every cursor theme side by side in a throwaway browser and saves a screenshot.
//
//   node test/cursor-gallery.mjs [output.jpg]

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { tabhandCursor } from '../extension/cursor.js';
import { themeFor } from '../extension/themes.js';
import { BridgeClient } from '../src/bridge-client.mjs';
import { launchTestBrowser, sleep } from './harness.mjs';

const output = process.argv[2] ?? path.join(os.tmpdir(), 'tabhand-cursors.jpg');
const cards = [
  { theme: 'claude', label: 'Claude', ui: 'button' },
  { theme: 'codex', label: 'Codex', ui: 'input', typing: true },
  { theme: 'opencode', label: 'OpenCode', ui: 'button', dark: true },
  { theme: 'cursor', label: 'Cursor', ui: 'input' },
  { theme: 'gemini', label: 'Gemini', ui: 'input' },
  { theme: 'copilot', label: 'Copilot', ui: 'button' },
  { theme: 'agent', label: 'Windsurf', ui: 'button', dark: true },
  { theme: 'agent', label: 'Agent', ui: 'input' },
];

const frame = ({ theme, label, ui, typing, dark }) => {
  const call = (options) => `(${tabhandCursor})(${JSON.stringify(options)});`;
  const target = ui === 'button' ? { x: 150, y: 96 } : { x: 132, y: 84 };
  const script = call({ action: 'move', ...target, label, theme: themeFor(theme), animate: false }) + (typing ? call({ action: 'typing', typing: true }) : '');
  const control =
    ui === 'button'
      ? '<button>Continue</button>'
      : `<div class="input">${typing ? 'Weather in Lisb<span class="caret"></span>' : 'Search…'}</div>`;
  return `<!doctype html><html><head><style>
    html, body { margin: 0; height: 100%; font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { background: ${dark ? '#17181c' : '#ffffff'}; color: ${dark ? '#e7e7ea' : '#1f2328'}; padding: 22px 22px; box-sizing: border-box; overflow: hidden; }
    .line { height: 9px; border-radius: 5px; background: ${dark ? '#2a2c33' : '#eceef1'}; margin-bottom: 9px; }
    button { margin-top: 18px; margin-left: 76px; padding: 10px 22px; border-radius: 10px; border: 0; font: 600 14px/1 inherit;
      background: ${dark ? '#f4f4f5' : '#1f2328'}; color: ${dark ? '#17181c' : '#fff'}; }
    .input { margin-top: 16px; padding: 11px 14px; border-radius: 10px; border: 1.5px solid ${dark ? '#3a3d45' : '#d0d7de'}; width: 190px;
      color: ${typing ? 'inherit' : '#8c959f'}; ${typing ? 'border-color: #8c959f;' : ''} }
    .caret { display: inline-block; width: 1.5px; height: 16px; background: currentColor; vertical-align: -3px; margin-left: 1px; }
  </style></head><body><div class="line" style="width: 62%"></div><div class="line" style="width: 44%"></div>${control}<script>${script}</script></body></html>`;
};

const page = `<!doctype html><html><head><style>
  html, body { margin: 0; background: #f3f4f6; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 18px; padding: 26px; }
  iframe { width: 100%; height: 178px; border: 0; border-radius: 16px; box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 8px 24px rgba(0,0,0,.08); display: block; }
</style></head><body><div class="grid">${cards
  .map((card) => `<iframe srcdoc="${frame(card).replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe>`)
  .join('')}</div></body></html>`;

const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(page);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const browser = await launchTestBrowser();
const bridge = new BridgeClient({ sessionId: crypto.randomUUID(), label: 'Gallery' });
let ok = false;
try {
  if (!browser.connected) throw new Error('The test browser did not connect.');
  const { tabId } = await bridge.request('open_tab', { url: `http://127.0.0.1:${server.address().port}/` });
  await sleep(600);
  const shot = await bridge.request('screenshot', { tabId });
  fs.writeFileSync(output, Buffer.from(shot.data, 'base64'));
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
