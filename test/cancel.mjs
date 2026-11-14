// Chrome's "started debugging this browser" bar belongs to all of Chrome, and it can go away on its
// own, such as when a tab in another profile attaches. Chrome then detaches with canceled_by_user,
// which is not the user's stop button: the profile stays on, the tab's next step works, a step cut
// short by the close says what happened, and a tab that keeps losing the bar is left alone.
//
// Chrome for Testing never closes the bar itself, so the extension's test-only simulate_detach
// command does what Chrome does when it goes: let go of the tab, then handle the drop.
//
//   node test/cancel.mjs

import crypto from 'node:crypto';
import http from 'node:http';
import { BridgeClient } from '../src/bridge-client.mjs';
import { launchTestBrowser, sleep } from './harness.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

// A page whose server takes its time holds Page.navigate in flight (see navigate in background.js),
// which is a step the test can cut short at a moment it knows about. The answer is let go later, so
// the tab ends up on a real page.
let reachedSlow;
let answerSlow = () => {};
const slowArrived = new Promise((resolve) => (reachedSlow = resolve));
const server = http.createServer((request, response) => {
  if (request.url.startsWith('/slow')) {
    answerSlow = () => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>Slow</title><h1>Hello after the wait</h1>');
    };
    reachedSlow();
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end('<!doctype html><title>Page</title><h1>Hello from the page</h1>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await launchTestBrowser();
const bridge = new BridgeClient({ sessionId: crypto.randomUUID(), label: 'Claude', theme: 'claude' });
/** The same answer browser_list_profiles prints: whether Tabhand is on or paused in the profile. */
const state = async () => (await bridge.request('profiles')).profiles[0]?.state;
const step = async (cmd, params = {}) => {
  try {
    return { text: JSON.stringify(await bridge.request(cmd, params)) };
  } catch (error) {
    return { error: true, text: String(error?.message ?? error) };
  }
};

try {
  if (!browser.connected) throw new Error('The test browser did not connect.');
  check('the profile starts on', (await state()) === 'on');

  // a. Chrome takes the bar away on an agent's tab: that is not the user pausing Tabhand.
  const first = (await bridge.request('open_tab', { url: `${origin}/first` })).tabId;
  let r = await step('simulate_detach', { tabId: first });
  check('a close of the bar is simulated on an agent tab', !r.error, r.text);
  const afterClose = await state();
  check('the profile is still on, not paused', afterClose === 'on', afterClose);

  // b. The tab's next step takes it back and works.
  r = await step('snapshot', { tabId: first });
  check('the next step on that tab re-attaches and reads the page', !r.error && /Hello from the page/.test(r.text), r.text.slice(0, 120));

  // c. A step that is in flight when the bar closes says what happened.
  const cut = (await bridge.request('open_tab', { url: `${origin}/cut` })).tabId;
  const navigating = step('navigate', { tabId: cut, url: `${origin}/slow` });
  await slowArrived;
  await bridge.request('simulate_detach', { tabId: cut });
  r = await navigating;
  check(
    "the step cut short by the close says Chrome's debugging bar was closed",
    r.error && /Chrome's debugging bar was closed/.test(r.text),
    r.text,
  );
  answerSlow();
  await sleep(1000);
  r = await step('snapshot', { tabId: cut });
  check('and the step after it works again', !r.error && /Hello after the wait/.test(r.text), r.text.slice(0, 120));

  // d. A tab that keeps losing the bar stops being taken back.
  const stuck = (await bridge.request('open_tab', { url: `${origin}/stuck` })).tabId;
  let taken = 0;
  for (let i = 0; i < 6; i++) {
    r = await step('snapshot', { tabId: stuck });
    if (r.error) break;
    taken++;
    await bridge.request('simulate_detach', { tabId: stuck });
  }
  r = await step('snapshot', { tabId: stuck });
  check('the tab is taken back after each close, until the sixth', taken === 6, `taken back ${taken} times`);
  check("after six, the next step says the bar keeps closing instead of re-attaching", r.error && /keeps closing/.test(r.text), r.text);
  check('and asks about it rather than looping', /Ask the user/.test(r.text));

  // An extension's own detach fires no onDetach, so each simulate must be recorded exactly once.
  const closes = (await bridge.request('diagnostics')).issues.filter((issue) => issue.kind === 'detached');
  check('each close is handled once', closes.length === 8, `${closes.length} handled`);
} catch (error) {
  check('runs without throwing', false, error.stack);
} finally {
  bridge.close();
  server.closeAllConnections?.();
  server.close();
  await browser.close();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
