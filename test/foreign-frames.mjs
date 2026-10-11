// Password managers such as iCloud Passwords put their own frames into pages when a text field gets
// focus, and Chrome knocks Tabhand's debugger off any page that shows another extension's frame.
// Checks that an agent still gets through such pages, with a stand-in extension doing the same.
//
//   node test/foreign-frames.mjs

import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeClient } from '../src/bridge-client.mjs';
import { launchTestBrowser, sleep } from './harness.mjs';

const autofill = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/autofill-extension');
const page = (autofocus) => `<!doctype html><title>Sign in</title><body style="font: 16px sans-serif; padding: 40px">
  <p><input aria-label="Email" ${autofocus ? 'autofocus' : ''}></p>
  <p><input aria-label="Name"></p>
  <p id="autofill-status">Autofill menus shown: 0, removed: 0</p>
  <p id="typed">Typed:</p>
  <script>
    const inputs = [...document.querySelectorAll('input')];
    for (const input of inputs) {
      input.addEventListener('input', () => {
        typed.textContent = 'Typed: ' + inputs.map((field) => field.value).join(' / ');
      });
    }
  </script>
</body>`;
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(page(request.url.includes('autofocus')));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await launchTestBrowser({ extensions: [autofill] });
const bridge = new BridgeClient({ sessionId: crypto.randomUUID(), label: 'Claude', theme: 'claude' });
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
};
const menus = (snapshot) => /Autofill menus shown: (\d+), removed: (\d+)/.exec(snapshot);
const field = (snapshot, name) => new RegExp(`textbox "${name}"[^\\n]*\\[ref=(e\\d+)\\]`).exec(snapshot)?.[1];

try {
  if (!browser.connected) throw new Error('The test browser did not connect.');

  // The menu turns up while the page loads, for a field that has focus from the start.
  let started = Date.now();
  const first = await bridge.request('open_tab', { url: `${origin}/?autofocus` });
  const openMs = Date.now() - started;
  await sleep(1500);
  let { snapshot } = await bridge.request('snapshot', { tabId: first.tabId });
  let shown = menus(snapshot);
  check(
    'a page whose menu turns up while it loads opens without stalling',
    openMs < 5000 && Number(shown?.[1]) >= 1 && shown?.[1] === shown?.[2],
    `${openMs} ms, ${shown?.[0]}`,
  );

  // The menu turns up when the agent clicks into a field: right away, or a moment later like
  // iCloud Passwords, when the agent is already on its next step.
  for (const [when, query] of [['right away', ''], ['a moment later', '?menu-delay=40']]) {
    const { tabId } = await bridge.request('open_tab', { url: `${origin}/${query}` });
    ({ snapshot } = await bridge.request('snapshot', { tabId }));
    started = Date.now();
    await bridge.request('click', { tabId, ref: field(snapshot, 'Email') });
    const clickMs = Date.now() - started;
    await bridge.request('type', { tabId, ref: field(snapshot, 'Email'), text: 'ada@example.com', clear: true });
    await bridge.request('type', { tabId, ref: field(snapshot, 'Name'), text: 'Ada' });
    await sleep(1500);
    ({ snapshot } = await bridge.request('snapshot', { tabId }));
    const typed = /Typed:[^\n]*/.exec(snapshot)?.[0];
    shown = menus(snapshot);
    check(
      `menu ${when}: clicking and typing into fields work, each text typed once`,
      clickMs < 5000 && typed === 'Typed: ada@example.com / Ada',
      `click ${clickMs} ms, ${typed}`,
    );
    check(
      `menu ${when}: the stand-in password manager really showed it, and it was taken out`,
      Number(shown?.[1]) >= 1 && shown?.[1] === shown?.[2],
      shown?.[0],
    );
  }
} catch (error) {
  check('test run', false, error.message);
} finally {
  bridge.close();
  server.close();
  await browser.close();
}

const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} check(s) failed` : 'All checks passed');
process.exit(failed ? 1 : 0);
