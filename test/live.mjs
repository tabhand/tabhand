// Every tool against a real browser profile you already have Tabhand in (Dia, Brave, Edge, or a
// Chrome profile), through your real install: two agents at once, on a local test page, while
// sampling which app is in front. Tabs open in the background and close at the end; nothing is
// sent anywhere but 127.0.0.1.
//
//   node test/live.mjs --profile Dia --app Dia
//
// --profile is the name or id from browser_list_profiles. --app is the browser's name as macOS
// shows it (Dia, Brave Browser, Microsoft Edge, Google Chrome), for the check that it never comes
// to the front; leave the browser in the background while this runs.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flag = (name) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
};
const profile = flag('--profile');
const app = flag('--app');
if (!profile) {
  console.error('Usage: node test/live.mjs --profile <name or id> [--app <app name>]');
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).replace(/\s+/g, ' ').slice(0, 220)})` : ''}`);
};

// ---------------------------------------------------------------- the test page

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Tabhand live test</title>
<style>
  body { font: 16px system-ui; margin: 24px; }
  .menu .secret { display: none; }
  .menu:hover .secret { display: inline-block; }
  #list li { padding: 8px; margin: 4px 0; width: 220px; border: 1px solid #999; list-style: none; }
  .tall { height: 2600px; }
</style>
<h1>Tabhand live test</h1>
<p>Status: <output id="status">idle</output></p>
<p><button onclick="say('clicked the button')">Press me</button>
<span role="button" tabindex="0" onclick="say('clicked the span')">Span button</span></p>
<form onsubmit="event.preventDefault(); say('searched for ' + this.q.value)">
  <input name="q" aria-label="Query" value="old text">
</form>
<p><select aria-label="Fruit" onchange="say('chose ' + this.value)"><option>Apple</option><option>Banana</option><option>Cherry</option></select>
<label><input type="checkbox" onchange="say('agree is ' + this.checked)"> Agree</label></p>
<p><span tabindex="0" role="textbox" aria-label="Key catcher" onkeydown="say('key ' + event.key)">Key catcher</span></p>
<p class="menu">Hover menu <button class="secret" onclick="say('secret action')">Secret action</button></p>
<ul id="list"><li draggable="true">One</li><li draggable="true">Two</li><li draggable="true">Three</li></ul>
<p><input type="file" aria-label="Upload" onchange="say('file ' + this.files[0].name + ' ' + this.files[0].size)"></p>
<p><button onclick="say('confirm ' + confirm('Proceed?'))">Confirm it</button>
<button onclick="say('prompt ' + prompt('Your name?', ''))">Prompt it</button>
<button onclick="alert('Hello from the page'); say('alert closed')">Alert it</button></p>
<p><a href="/other" target="_blank">Open other</a> <button onclick="window.open('/other?popup=1', 'pop', 'width=400,height=300')">Pop other</button></p>
<div class="tall"></div>
<p>Bottom of the page</p>
<script>
  const say = (text) => (document.getElementById('status').textContent = text);
  let dragged = null;
  for (const item of document.querySelectorAll('#list li')) {
    item.addEventListener('dragstart', () => (dragged = item));
    item.addEventListener('dragover', (event) => event.preventDefault());
    item.addEventListener('drop', (event) => {
      event.preventDefault();
      if (dragged && dragged !== item) item.after(dragged);
      say('order ' + [...document.querySelectorAll('#list li')].map((li) => li.textContent).join(' '));
    });
  }
</script>`;

const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  if (request.url.startsWith('/other')) response.end('<!doctype html><title>Other page</title><h1>Other page</h1>');
  else response.end(PAGE);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const uploadFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tabhand-live-')), 'live-upload.txt');
fs.writeFileSync(uploadFile, 'x'.repeat(1234));

// ---------------------------------------------------------------- agents

const frontmost = () => {
  try {
    const asn = execFileSync('lsappinfo', ['front'], { encoding: 'utf8' }).trim();
    return /^\s*"([^"]*)"/.exec(execFileSync('lsappinfo', ['info', asn], { encoding: 'utf8' }))?.[1] ?? '?';
  } catch {
    return '?';
  }
};

const installed = path.join(os.homedir(), '.tabhand', 'bin', 'tabhand');
async function agent(label, theme) {
  const client = new Client({ name: `tabhand-live-${theme}`, version: '0' });
  await client.connect(new StdioClientTransport({ command: installed, args: ['mcp', '--label', label, '--theme', theme], stderr: 'ignore' }));
  /** Calls a tool; gives up after 30 seconds so one stuck step doesn't stop the run. */
  const call = async (name, args = {}) => {
    step = `${label}: ${name}${args.text ? ` "${args.text}"` : ''}`;
    const result = await Promise.race([
      client.callTool({ name, arguments: args }, undefined, { timeout: 130_000 }),
      sleep(30_000).then(() => ({ isError: true, content: [{ type: 'text', text: `${name} took over 30 seconds` }] })),
    ]);
    const text = result.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
    return { error: Boolean(result.isError), text, image: result.content.find((item) => item.type === 'image')?.data ?? '' };
  };
  return { call, close: () => client.close() };
}
const tabOf = (text) => Number(/^Tab (\d+):/.exec(text)?.[1]) || null;
const refFor = (snapshot, pattern) => new RegExp(`${pattern}[^\\n]*\\[ref=(e\\d+)\\]`).exec(snapshot)?.[1];

const startApp = frontmost();
/** Which app was in front every 200 ms, and the step running then. */
const samples = [];
let step = 'start';
const sampler = setInterval(() => samples.push({ app: frontmost(), step }), 200);
const A = await agent('Live A', 'claude');
const B = await agent('Live B', 'codex');
const opened = [];

try {
  // Both agents open a tab in the profile at once.
  const [a, b] = await Promise.all([A.call('browser_open_tab', { profile, url: base }), B.call('browser_open_tab', { profile, url: `${base}/other` })]);
  const tab = tabOf(a.text);
  const tabB = tabOf(b.text);
  check(`A opens a background tab in ${profile}`, !a.error && tab && a.text.includes('Tabhand live test'), a.text);
  check(`B opens one there at the same time`, !b.error && tabB, b.text);
  opened.push([A, tab], [B, tabB]);

  let snap = (await A.call('browser_snapshot', { tabId: tab })).text;
  check('A reads the page with refs', /button "Press me" \[ref=e\d+\]/.test(snap), snap.split('\n').slice(0, 3).join(' | '));

  // What the page says now, from a fresh snapshot.
  const status = async () => {
    snap = (await A.call('browser_snapshot', { tabId: tab })).text;
    const lines = snap.split('\n');
    const at = lines.findIndex((line) => line.includes('Status:'));
    return lines.slice(at, at + 3).map((line) => line.trim()).join(' ');
  };
  const said = async (pattern) => {
    const now = await status();
    return { ok: pattern.test(snap), now };
  };

  let r = await A.call('browser_click', { tabId: tab, ref: refFor(snap, 'button "Press me"') });
  let s = await said(/clicked the button/);
  check('clicks a button by ref', !r.error && s.ok, r.error ? r.text : s.now);

  r = await A.call('browser_click', { tabId: tab, text: 'Span button' });
  s = await said(/clicked the span/);
  check('clicks a plain element by its text', !r.error && s.ok, r.error ? r.text : s.now);

  r = await A.call('browser_type', { tabId: tab, ref: refFor(snap, 'textbox "Query"'), text: 'tabhand in the browser', clear: true, submit: true });
  s = await said(/searched for tabhand in the browser/);
  check('types into a field, replacing its text, and submits', !r.error && s.ok, r.error ? r.text : s.now);

  r = await A.call('browser_type', { tabId: tab, ref: refFor(snap, 'combobox "Fruit"'), text: 'Cherry' });
  s = await said(/chose Cherry/);
  check('chooses a dropdown option', !r.error && s.ok, r.error ? r.text : s.now);

  r = await A.call('browser_click', { tabId: tab, ref: refFor(snap, 'checkbox "Agree"') });
  s = await said(/agree is true/);
  check('ticks a checkbox', !r.error && s.ok, r.error ? r.text : s.now);

  r = await A.call('browser_click', { tabId: tab, ref: refFor(snap, 'textbox "Key catcher"') });
  r = await A.call('browser_press_key', { tabId: tab, key: 'ArrowDown' });
  s = await said(/key ArrowDown/);
  check('presses a key', !r.error && s.ok, r.error ? r.text : s.now);

  r = await A.call('browser_hover', { tabId: tab, text: 'Hover menu' });
  const secret = refFor(r.text, 'button "Secret action"');
  check('hovering shows a hover-only button', !r.error && Boolean(secret), r.text.split('\n')[0]);
  if (secret) {
    r = await A.call('browser_click', { tabId: tab, ref: secret });
    s = await said(/secret action/);
    check('and it can be clicked', !r.error && s.ok, r.error ? r.text : s.now);
  }

  r = await A.call('browser_drag', { tabId: tab, fromText: 'One', toText: 'Three' });
  s = await said(/order Two Three One/);
  check('drags a list item onto another', !r.error && s.ok, r.error ? r.text : s.now);

  await status();
  r = await A.call('browser_upload_file', { tabId: tab, ref: refFor(snap, '(?:button|textbox|generic)?[^\\n]*"Upload"'), paths: [uploadFile] });
  s = await said(/file live-upload\.txt 1234/);
  check('uploads a file, byte for byte', !r.error && s.ok, r.error ? r.text : s.now);

  r = await A.call('browser_click', { tabId: tab, text: 'Confirm it' });
  const confirmAsked = /Proceed\?/.test(r.text);
  r = await A.call('browser_handle_dialog', { tabId: tab, accept: true });
  s = await said(/confirm true/);
  check('hears about a confirm dialog and accepts it', confirmAsked && !r.error && s.ok, r.error ? r.text : s.now);

  r = await A.call('browser_click', { tabId: tab, text: 'Prompt it' });
  r = await A.call('browser_handle_dialog', { tabId: tab, accept: true, text: 'Mustafa' });
  s = await said(/prompt Mustafa/);
  check('answers a prompt dialog', !r.error && s.ok, r.error ? r.text : s.now);

  r = await A.call('browser_click', { tabId: tab, text: 'Alert it' });
  s = await said(/alert closed/);
  check('an alert gets closed and reported', !r.error && s.ok && /Hello from the page/.test(r.text), r.text.split('\n').slice(0, 2).join(' | '));

  r = await A.call('browser_click', { tabId: tab, text: 'Open other' });
  const linkTab = Number(/Tab (\d+)/.exec(r.text.split('\n').slice(1).join('\n'))?.[1]) || null;
  check('a link to a new tab gives the agent that tab', !r.error && Boolean(linkTab) && linkTab !== tab, r.text.split('\n').slice(0, 3).join(' | '));

  r = await A.call('browser_click', { tabId: tab, text: 'Pop other' });
  check('so does a popup window', !r.error && /Other page|\/other/.test(r.text.split('\n').slice(1).join(' ')), r.text.split('\n').slice(0, 3).join(' | '));

  // The top of the page, with the steps' results on it; check the pictures by eye.
  r = await A.call('browser_screenshot', { tabId: tab });
  const shot = path.join(os.tmpdir(), 'tabhand-live-shot.jpg');
  if (r.image) fs.writeFileSync(shot, Buffer.from(r.image, 'base64'));
  check('screenshots the background tab', !r.error && r.image.length > 5000, `${r.image.length} base64 chars, ${shot}`);
  r = await A.call('browser_screenshot', { tabId: tab, fullPage: true });
  const fullShot = path.join(os.tmpdir(), 'tabhand-live-full.jpg');
  if (r.image) fs.writeFileSync(fullShot, Buffer.from(r.image, 'base64'));
  check('and the whole page', !r.error && r.image.length > 5000, `${r.image.length} base64 chars, ${fullShot}`);

  r = await A.call('browser_scroll', { tabId: tab, direction: 'down', amount: 2000 });
  snap = (await A.call('browser_snapshot', { tabId: tab })).text;
  check('scrolls', !r.error, r.text.split('\n')[0]);

  r = await A.call('browser_navigate', { tabId: tab, url: `${base}/other` });
  check('navigates', !r.error && r.text.includes('Other page'), r.text.split('\n')[0]);

  // Agents stay in their lane.
  r = await B.call('browser_snapshot', { tabId: tab });
  check("B can't read A's tab", r.error, r.text.split('\n')[0]);
  r = await A.call('browser_close_tab', { tabId: tabB });
  check("A can't close B's tab", r.error, r.text.split('\n')[0]);
  const listA = (await A.call('browser_list_tabs')).text;
  const listB = (await B.call('browser_list_tabs')).text;
  check('A lists its own tabs, the opened ones included', listA.includes(String(tab)) && (!linkTab || listA.includes(String(linkTab))) && !listA.includes(String(tabB)), listA.replace(/\n/g, ' | '));
  check('B lists only its own', listB.includes(String(tabB)) && !listB.includes(String(tab)), listB.replace(/\n/g, ' | '));

  for (const [who, id] of [[A, linkTab], ...opened]) if (id) await who.call('browser_close_tab', { tabId: id });
  // The popup and anything else still open.
  for (const who of [A, B]) {
    for (const id of [...(await who.call('browser_list_tabs')).text.matchAll(/^Tab (\d+)/gm)].map((m) => Number(m[1]))) await who.call('browser_close_tab', { tabId: id });
  }
  check('closes every tab it opened', !/^Tab \d+/m.test((await A.call('browser_list_tabs')).text) && !/^Tab \d+/m.test((await B.call('browser_list_tabs')).text));
} catch (error) {
  check('runs without throwing', false, error.stack);
} finally {
  clearInterval(sampler);
  await A.close().catch(() => {});
  await B.close().catch(() => {});
  server.close();
  const apps = [...new Set(samples.map((sample) => sample.app))];
  if (app) {
    const during = [...new Set(samples.filter((sample) => sample.app === app).map((sample) => sample.step))];
    if (startApp === app) console.log(`(skipped the front check: ${app} was in front when the run started)`);
    else check(`${app} never came to the front`, !during.length, during.length ? `in front during: ${during.join('; ')}` : `${samples.length} samples: ${apps.join(', ')}`);
  } else {
    console.log(`Apps in front during the run: ${apps.join(', ')}`);
  }
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
