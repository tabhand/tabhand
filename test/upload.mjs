// browser_upload_file: attaches files to a file field, and through a button that opens a file
// picker (intercepted, so no system dialog), with the page receiving exactly the files' bytes.
// Uses a file bigger than the 1 MB cap on messages to the extension, so it travels in pieces.
//
//   node test/upload.mjs

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { frontmostApp, launchTestBrowser, sleep } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = `<!doctype html><title>Upload</title><body style="font: 16px sans-serif; padding: 40px">
  <p><input type="file" multiple aria-label="Direct files" id="direct"></p>
  <p><button id="pick">Choose a picture</button><input type="file" id="hidden" style="display: none"></p>
  <p id="report">Nothing yet</p>
  <script>
    const lines = {};
    const show = async (input) => {
      const files = await Promise.all([...input.files].map(async (file) => {
        const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
        const hash = [...new Uint8Array(digest)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
        return file.name + ' ' + file.size + ' ' + file.type + ' ' + hash;
      }));
      lines[input.id] = input.id + ': ' + files.join(', ');
      report.textContent = Object.values(lines).join(' | ');
    };
    direct.addEventListener('change', () => show(direct));
    hidden.addEventListener('change', () => show(hidden));
    pick.addEventListener('click', () => hidden.click());
  </script>
</body>`;
const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(page);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tabhand-upload-'));
const files = {
  'notes.txt': Buffer.from('hello from tabhand\n'),
  'big.bin': crypto.randomBytes(1_500_000),
  'picture.png': fs.readFileSync(path.join(root, 'extension', 'icons', '128.png')),
};
for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(folder, name), data);
const expected = (name, type) =>
  `${name} ${files[name].length} ${type} ${crypto.createHash('sha256').update(files[name]).digest('hex').slice(0, 12)}`;

const browser = await launchTestBrowser();
const client = new Client({ name: 'upload-test', version: '0' });
const focus = new Set();
const sampler = setInterval(() => focus.add(frontmostApp()), 200);
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.map((item) => item.text ?? '').join('\n');
  if (result.isError) throw new Error(`${name}: ${text}`);
  return text;
};

try {
  if (!browser.connected) throw new Error('The test browser did not connect.');
  // The test browser's bridge: the SDK passes servers only a minimal environment unless told.
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'bin', 'tabhand.mjs'), 'mcp'], env: process.env }));
  const tabId = Number(/^Tab (\d+):/.exec(await call('browser_open_tab', { url: `http://127.0.0.1:${server.address().port}/` }))[1]);
  let snapshot = await call('browser_snapshot', { tabId });
  const ref = (pattern) => new RegExp(`${pattern}[^\\n]*\\[ref=(e\\d+)\\]`).exec(snapshot)?.[1];

  await call('browser_upload_file', { tabId, ref: ref('"Direct files"'), paths: [path.join(folder, 'notes.txt'), path.join(folder, 'big.bin')] });
  await call('browser_upload_file', { tabId, ref: ref('button "Choose a picture"'), paths: [path.join(folder, 'picture.png')] });
  await sleep(500);
  snapshot = await call('browser_snapshot', { tabId });
  const report = /direct:[^\n]*/.exec(snapshot)?.[0] ?? snapshot.slice(0, 300);
  check(
    'a file field gets the files, byte for byte, including one sent in pieces',
    report.includes(`direct: ${expected('notes.txt', 'text/plain')}, ${expected('big.bin', 'application/octet-stream')}`),
    report,
  );
  check("a button's file picker is caught and gets the file", report.includes(`hidden: ${expected('picture.png', 'image/png')}`), report);
} catch (error) {
  check('test run', false, error.message);
} finally {
  clearInterval(sampler);
  check('the browser never came to the front', ![...focus].some((app) => /Chrome for Testing/.test(app)), [...focus].join(', '));
  await client.close().catch(() => {});
  server.close();
  await browser.close();
  fs.rmSync(folder, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} check(s) failed` : 'All checks passed');
process.exit(failed ? 1 : 0);
