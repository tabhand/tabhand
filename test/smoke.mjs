// Quick check against the Chrome you have open: one background tab, one click, one screenshot,
// while sampling which app is in front. Needs `tabhand install` and the extension loaded.
//
//   node test/smoke.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontmost = () => {
  try {
    const asn = execFileSync('lsappinfo', ['front'], { encoding: 'utf8' }).trim();
    return /^\s*"([^"]*)"/.exec(execFileSync('lsappinfo', ['info', asn], { encoding: 'utf8' }))?.[1] ?? '?';
  } catch {
    return '?';
  }
};

const startApp = frontmost();
const samples = [];
const sampler = setInterval(() => samples.push(frontmost()), 200);
const client = new Client({ name: 'tabhand-smoke', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'bin/tabhand.mjs'), 'mcp', '--label', 'Tabhand test'] }));
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
  if (result.isError) throw new Error(`${name}: ${text}`);
  return { ...result, text };
};

let ok = false;
try {
  const opened = await call('browser_open_tab', { url: 'https://example.com' });
  console.log(opened.text);
  const tabId = Number(/^Tab (\d+):/.exec(opened.text)[1]);
  const snapshot = await call('browser_snapshot', { tabId });
  const ref = /link "Learn more" \[ref=(e\d+)\]/.exec(snapshot.text)?.[1];
  console.log((await call('browser_click', { tabId, ref })).text.split('\n')[0]);
  const shot = await call('browser_screenshot', { tabId });
  const file = path.join(os.tmpdir(), 'tabhand-smoke.jpg');
  fs.writeFileSync(file, Buffer.from(shot.content.find((item) => item.type === 'image').data, 'base64'));
  console.log(`Screenshot: ${file}`);
  await call('browser_close_tab', { tabId });
  ok = true;
} catch (error) {
  console.error(error.message);
} finally {
  clearInterval(sampler);
  await client.close();
  const chromeInFront = samples.filter((app) => app === 'Google Chrome').length;
  const startedInChrome = startApp === 'Google Chrome';
  console.log(`Frontmost apps during the run: ${[...new Set(samples)].join(', ')} (started in ${startApp})`);
  if (!startedInChrome && chromeInFront > 0) console.log('Chrome came to the front during the run.');
  process.exit(ok ? 0 : 1);
}
