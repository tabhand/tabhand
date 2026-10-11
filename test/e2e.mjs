// End-to-end test against a throwaway Chrome for Testing profile (never your real Chrome).
// Two agent sessions work at once while we sample the frontmost macOS app: the test fails if
// the browser ever comes to the front.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { frontmostApp, launchTestBrowser, sleep } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotPath = path.join(os.tmpdir(), 'tabhand-e2e-shot.jpg');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

// ------------------------------------------------------------- focus sampling (macOS)
const focus = [];
const timeline = [];
let t0 = Date.now();
const mark = (event) => timeline.push(`${String(Date.now() - t0).padStart(6)} ms  ${event}`);

// ------------------------------------------------------------- MCP helpers
async function agent(label) {
  const client = new Client({ name: 'tabhand-e2e', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, 'bin/tabhand.mjs'), 'mcp', '--label', label],
      env: { ...process.env },
    }),
  );
  const call = async (name, args = {}) => {
    const started = Date.now();
    mark(`${label} → ${name}`);
    const result = await client.callTool({ name, arguments: args });
    mark(`${label} ← ${name}`);
    const ms = Date.now() - started;
    if (ms > 5000) console.log(`SLOW  ${label} ${name} took ${ms} ms`);
    const text = result.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
    return { ...result, text };
  };
  return { client, call };
}
const tabIdOf = (text) => Number(/^Tab (\d+):/m.exec(text)?.[1]);

// ------------------------------------------------------------- run
let browser = null;
let sampler = null;
try {
  browser = await launchTestBrowser();
  check('extension connects to the bridge', browser.connected);
  await sleep(1500);

  const userApp = frontmostApp();
  t0 = Date.now();
  mark(`front: ${userApp}`);
  sampler = setInterval(() => {
    const app = frontmostApp();
    if (app !== focus.at(-1)) mark(`front: ${app}`);
    focus.push(app);
  }, 200);

  const [a, b] = await Promise.all([agent('Agent A'), agent('Agent B')]);

  const runA = async () => {
    const opened = await a.call('browser_open_tab', { url: 'https://example.com' });
    const tab = tabIdOf(opened.text);
    check('A opens a background tab', !opened.isError && /Example Domain/.test(opened.text), opened.text);
    const snap = await a.call('browser_snapshot', { tabId: tab });
    const ref = /link "Learn more" \[ref=(e\d+)\]/.exec(snap.text)?.[1];
    check('A reads the page with refs', Boolean(ref), ref);
    const clicked = await a.call('browser_click', { tabId: tab, ref });
    check('A clicks a link and the page navigates', /iana\.org/.test(clicked.text), clicked.text.split('\n')[0]);
    const shot = await a.call('browser_screenshot', { tabId: tab });
    const image = shot.content.find((item) => item.type === 'image');
    if (image) fs.writeFileSync(shotPath, Buffer.from(image.data, 'base64'));
    check('A screenshots a background tab', image && image.data.length > 20_000, `${image?.data.length ?? 0} base64 chars`);

    const wiki = await a.call('browser_open_tab', { url: 'https://en.wikipedia.org/wiki/Main_Page' });
    const wikiTab = tabIdOf(wiki.text);
    const wikiSnap = await a.call('browser_snapshot', { tabId: wikiTab });
    const searchRef = /(?:searchbox|combobox|textbox) "Search Wikipedia"[^\n]*\[ref=(e\d+)\]/.exec(wikiSnap.text)?.[1];
    const typed = await a.call('browser_type', { tabId: wikiTab, ref: searchRef, text: 'Playwright (software)', submit: true });
    check('A types into a field and submits', /Playwright/.test(typed.text), typed.text.split('\n')[0]);
    const scrolled = await a.call('browser_scroll', { tabId: wikiTab, direction: 'down', amount: 800 });
    check('A scrolls', /Scroll position [1-9]/.test(scrolled.text), scrolled.text.split('\n')[1]);
    const listed = await a.call('browser_list_tabs');
    check('A lists only its own two tabs', listed.text.split('\n').length === 2, listed.text.replace(/\n/g, ' | '));
    return { tab, wikiTab };
  };

  const runB = async () => {
    const opened = await b.call('browser_open_tab', { url: 'https://news.ycombinator.com' });
    const tab = tabIdOf(opened.text);
    check('B works in parallel', !opened.isError && /Hacker News/.test(opened.text), opened.text);
    const snap = await b.call('browser_snapshot', { tabId: tab });
    check('B reads its page', /link "new"/.test(snap.text));
    return { tab };
  };

  const [tabsA, tabsB] = await Promise.all([runA(), runB()]);

  const crossRead = await b.call('browser_snapshot', { tabId: tabsA.tab });
  check("B cannot read A's tab", crossRead.isError === true, crossRead.text);
  const crossClose = await a.call('browser_close_tab', { tabId: tabsB.tab });
  check("A cannot close B's tab", crossClose.isError === true, crossClose.text);
  const listedB = await b.call('browser_list_tabs');
  check('B lists only its own tab', listedB.text.split('\n').length === 1, listedB.text);

  for (const tabId of [tabsA.tab, tabsA.wikiTab]) await a.call('browser_close_tab', { tabId });
  await b.call('browser_close_tab', { tabId: tabsB.tab });
  await Promise.all([a.client.close(), b.client.close()]);

  clearInterval(sampler);
  sampler = null;
  const apps = [...new Set(focus)];
  const stolen = focus.filter((app) => /Chrome for Testing|Chromium/.test(app)).length;
  if (stolen || process.env.TABHAND_TIMELINE) console.log(`\nTimeline:\n${timeline.join('\n')}\n`);
  check('browser never came to the front', stolen === 0, `${focus.length} samples; frontmost: ${apps.join(', ')}; started in ${userApp}`);
} catch (error) {
  check('test run', false, error.stack);
} finally {
  if (sampler) clearInterval(sampler);
  await browser?.close();
  console.log(`\nScreenshot: ${shotPath}`);
  const failed = results.filter((result) => !result.ok).length;
  console.log(failed ? `${failed} of ${results.length} checks failed` : `All ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
