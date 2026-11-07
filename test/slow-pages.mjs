// GitHub issues #1 to #3, against local pages in a throwaway Chrome for Testing profile:
//   #1 a page whose server takes 30 s to answer, and one that never finishes loading: opening or
//      navigating to it returns the tab well before an MCP client's request timeout (often 60 s),
//      the tab stays the agent's to read, and the page shows up once it arrives;
//   #2 a snapshot narrowed to some text, or to what the agent can act on, on a 2,500-row page;
//   #3 a reload that brings fresh data from the server.
//
//   node test/slow-pages.mjs

import crypto from 'node:crypto';
import http from 'node:http';
import { BridgeClient } from '../src/bridge-client.mjs';
import { launchTestBrowser, sleep } from './harness.mjs';

let count = 0;
const rows = Array.from({ length: 2500 }, (_, i) => `<tr><td>Invoice ${1000 + i}</td><td>$${(i * 7) % 900}.00</td><td><button>Edit ${1000 + i}</button></td></tr>`).join('');
const server = http.createServer((request, response) => {
  const html = (body) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html>${body}`);
  };
  if (request.url === '/slow') setTimeout(() => html('<title>Slow page</title><h1>Slow page arrived</h1>'), 30_000);
  else if (request.url === '/hang') {
    // Headers and the start of the page, then nothing: the document never finishes loading.
    response.writeHead(200, { 'content-type': 'text/html' });
    response.write('<!doctype html><title>Hanging page</title><h1>Still coming</h1>');
  } else if (request.url === '/counter') html(`<title>Counter</title><h1>Count ${++count}</h1>`);
  else if (request.url === '/big') html(`<title>Invoices</title><h1>Invoices</h1><nav><a href="/a">Home</a> <a href="/b">Billing</a></nav><table>${rows}</table>`);
  else html('<title>Home</title><h1>Home</h1>');
});
server.keepAliveTimeout = 120_000;
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await launchTestBrowser();
const bridge = new BridgeClient({ sessionId: crypto.randomUUID(), label: 'Claude', theme: 'claude' });
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).slice(0, 240)})` : ''}`);
};
const timed = async (work) => {
  const started = Date.now();
  try {
    return { value: await work(), ms: Date.now() - started };
  } catch (error) {
    return { error, ms: Date.now() - started };
  }
};

try {
  if (!browser.connected) throw new Error('The test browser did not connect.');

  // #1: opening a slow page.
  const opened = await timed(() => bridge.request('open_tab', { url: `${base}/slow` }));
  const slowTab = opened.value?.tabId;
  check('#1 opening a page whose server takes 30 s returns the tab within 25 s', !opened.error && slowTab && opened.ms < 25_000, `${opened.ms} ms${opened.error ? `, ${opened.error.message}` : ''}`);
  check('#1 and says the page is still loading', opened.value?.loading === true, JSON.stringify(opened.value ?? {}));
  const early = await timed(() => bridge.request('snapshot', { tabId: slowTab }));
  check('#1 the still-loading tab is the agent\'s to read, and reading it doesn\'t hang', !early.error && early.ms < 15_000 && /still loading/.test(early.value?.snapshot ?? ''), early.error?.message ?? `${early.ms} ms: ${early.value?.snapshot}`);
  const { tabs } = await bridge.request('list_tabs', {});
  check('#1 and it is in the list of its tabs', tabs.some((tab) => tab.tabId === slowTab));
  await sleep(Math.max(0, 33_000 - opened.ms - early.ms));
  const later = await bridge.request('snapshot', { tabId: slowTab });
  check('#1 once the server answers, the page is there', /Slow page arrived/.test(later.snapshot), later.snapshot.slice(0, 120));

  // #1: navigating to a page that never finishes loading.
  const hung = await timed(() => bridge.request('navigate', { tabId: slowTab, url: `${base}/hang` }));
  check('#1 navigating to a page that never finishes loading returns within 25 s', !hung.error && hung.ms < 25_000, `${hung.ms} ms${hung.error ? `, ${hung.error.message}` : ''}`);
  const partial = await bridge.request('snapshot', { tabId: slowTab });
  check('#1 and what has arrived can be read', /Still coming/.test(partial.snapshot), partial.snapshot.slice(0, 120));

  // #3: reload.
  await bridge.request('navigate', { tabId: slowTab, url: `${base}/counter` });
  const first = (await bridge.request('snapshot', { tabId: slowTab })).snapshot.match(/Count (\d+)/)?.[1];
  const reloaded = await timed(() => bridge.request('reload', { tabId: slowTab }));
  const second = (await bridge.request('snapshot', { tabId: slowTab })).snapshot.match(/Count (\d+)/)?.[1];
  check('#3 reload brings fresh data from the server', !reloaded.error && first && second && Number(second) > Number(first), `${first} → ${second}${reloaded.error ? `, ${reloaded.error.message}` : ''}`);
  const hard = await timed(() => bridge.request('reload', { tabId: slowTab, ignoreCache: true }));
  const third = (await bridge.request('snapshot', { tabId: slowTab })).snapshot.match(/Count (\d+)/)?.[1];
  check('#3 and so does a reload that skips the cache', !hard.error && Number(third) > Number(second), `${second} → ${third}${hard.error ? `, ${hard.error.message}` : ''}`);

  // #2: narrower snapshots of a long page.
  await bridge.request('navigate', { tabId: slowTab, url: `${base}/big` });
  const full = (await bridge.request('snapshot', { tabId: slowTab })).snapshot;
  const found = (await bridge.request('snapshot', { tabId: slowTab, find: 'Invoice 3043' })).snapshot;
  check(
    '#2 find returns the matching row, with its button, and little else',
    /Invoice 3043/.test(found) && /button "Edit 3043" \[ref=e\d+\]/.test(found) && found.length < 1500 && !/Invoice 1043/.test(found),
    `${found.length} chars vs ${full.length} in full: ${found.replace(/\n/g, ' | ').slice(0, 200)}`,
  );
  const nothing = (await bridge.request('snapshot', { tabId: slowTab, find: 'no such words here' })).snapshot;
  check('#2 find that matches nothing says so', /Nothing on the page matches/.test(nothing), nothing.slice(0, 120));
  const actions = (await bridge.request('snapshot', { tabId: slowTab, interactiveOnly: true })).snapshot;
  const lines = actions.split('\n').filter((line) => line.trim().startsWith('- '));
  check(
    '#2 interactiveOnly keeps what can be acted on and drops the text',
    /link "Billing" \[ref=e\d+\]/.test(actions) && !/text: \$/.test(actions) && lines.filter((line) => /\[ref=e\d+\]/.test(line)).length / lines.length > 0.9,
    `${actions.length} chars, ${lines.length} lines`,
  );
  check('#2 a long snapshot that gets cut says how to read less', /find/.test(full.split('\n').at(-1)), full.split('\n').at(-1));
  await bridge.request('close_tab', { tabId: slowTab });
} catch (error) {
  check('test run', false, error.stack);
} finally {
  bridge.close();
  await browser.close();
  server.closeAllConnections?.();
  server.close();
}
console.log(results.every(Boolean) ? `${results.length}/${results.length} passed` : `${results.filter((ok) => !ok).length} of ${results.length} failed`);
process.exit(results.every(Boolean) ? 0 : 1);
