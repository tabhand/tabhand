// A ref is the element's DOM node id, and Chrome gives those ids out again in a new page. A ref
// from another tab's snapshot, or from before the tab navigated, would therefore quietly act on
// whatever element has that id now. This checks that such a ref is refused without touching the
// page, while refs from the page's own snapshots keep working, including across a same-document
// (SPA) route change and a narrowed (find) snapshot.
//
//   node test/stale-refs.mjs

import crypto from 'node:crypto';
import http from 'node:http';
import { BridgeClient } from '../src/bridge-client.mjs';
import { browserDevTools, launchTestBrowser, sleep } from './harness.mjs';

const page = (title) => `<!doctype html><title>${title}</title>
<body style="font: 16px sans-serif; padding: 40px">
  <h1>${title}</h1>
  <p><label>Field label <input id="field"></label></p>
  <p><a id="route" href="/spa" onclick="event.preventDefault(); history.pushState({}, '', '/spa'); document.getElementById('where').textContent = 'where: /spa'; return false;">Change route</a></p>
  <p><button id="far" onclick="document.getElementById('picked').textContent = 'picked: far'">Far button</button></p>
  <p id="picked">picked: nothing</p>
  <p id="where">where: /</p>
</body>`;
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  const title = { '/a-two': 'Second document', '/b': 'Other tab' }[request.url] ?? 'First page';
  response.end(page(title));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await launchTestBrowser({ args: ['--remote-debugging-port=0'] });
const bridge = new BridgeClient({ sessionId: crypto.randomUUID(), label: 'Claude', theme: 'claude' });
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const STALE = /isn't from a snapshot of this page/;
const refOf = (snapshot, pattern) => pattern.exec(snapshot)?.[1];
const FIELD = /textbox "Field label"[^\n]*\[ref=(e\d+)\]/;
const fieldOf = (text) => /textbox "Field label"[^\n]* value="([^"]*)"/.exec(text)?.[1] ?? '';
const pickedOf = (text) => /picked: (\w+)/.exec(text)?.[1] ?? '?';
const whereOf = (text) => /where: (\/\S*)/.exec(text)?.[1] ?? '?';
/** Runs a step and hands back its result, or the message it failed with. */
const attempt = async (cmd, params) => {
  try {
    return { ok: true, result: await bridge.request(cmd, params) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
};
/** The tab's page: the outline as it is, and on one line for reading its state. */
const lookAt = async (tabId) => {
  const { url, snapshot } = await bridge.request('snapshot', { tabId });
  return { url, text: snapshot, flat: snapshot.replace(/\n\s*/g, ' ') };
};
const outcome = (step) => (step.ok ? 'went through' : step.error);

try {
  if (!browser.connected) throw new Error('The test browser did not connect.');

  // a. A ref from another tab's snapshot, on a tab whose page was never snapshotted.
  const first = (await bridge.request('open_tab', { url: `${base}/a` })).tabId;
  const firstSnap = await bridge.request('snapshot', { tabId: first });
  const firstField = refOf(firstSnap.snapshot, FIELD);
  const firstLink = refOf(firstSnap.snapshot, /link "Change route" \[ref=(e\d+)\]/);
  check('the first tab gives refs to act on', Boolean(firstField && firstLink), `${firstField}, ${firstLink}`);

  const second = (await bridge.request('open_tab', { url: `${base}/b` })).tabId;
  const typedAcross = await attempt('type', { tabId: second, ref: firstField, text: 'hijacked' });
  const clickedAcross = await attempt('click', { tabId: second, ref: firstLink });
  check("a type with another tab's ref is refused", !typedAcross.ok && STALE.test(typedAcross.error), outcome(typedAcross));
  check("a click with another tab's ref is refused", !clickedAcross.ok && STALE.test(clickedAcross.error), outcome(clickedAcross));
  const secondPage = await lookAt(second);
  check(
    'and the other tab was not touched',
    secondPage.url.endsWith('/b') && /Other tab/.test(secondPage.flat) && fieldOf(secondPage.text) === '' && pickedOf(secondPage.flat) === 'nothing',
    `url: ${secondPage.url}, field: "${fieldOf(secondPage.text)}", ${pickedOf(secondPage.flat)}`,
  );

  // b. The same tab navigates to a new document, without a new snapshot.
  await bridge.request('navigate', { tabId: first, url: `${base}/a-two` });
  const typedAfterNav = await attempt('type', { tabId: first, ref: firstField, text: 'stale' });
  check('after a new document, an old ref is refused', !typedAfterNav.ok && STALE.test(typedAfterNav.error), outcome(typedAfterNav));
  const navigatedPage = await lookAt(first);
  check(
    'and the new document was not touched',
    navigatedPage.url.endsWith('/a-two') && /Second document/.test(navigatedPage.flat) && fieldOf(navigatedPage.text) === '',
    `url: ${navigatedPage.url}, field: "${fieldOf(navigatedPage.text)}"`,
  );

  // c. A new snapshot of the new document gives refs that work.
  const freshSnap = await bridge.request('snapshot', { tabId: first });
  const freshField = refOf(freshSnap.snapshot, FIELD);
  const typedFresh = await attempt('type', { tabId: first, ref: freshField, text: 'fresh' });
  const freshPage = await lookAt(first);
  check(
    'a new snapshot gives refs that work again',
    typedFresh.ok && fieldOf(freshPage.text) === 'fresh',
    `${outcome(typedFresh)}, field: "${fieldOf(freshPage.text)}"`,
  );

  // d. A same-document route change keeps the elements: refs from before it still work.
  const beforeSpa = await bridge.request('snapshot', { tabId: first });
  const spaField = refOf(beforeSpa.snapshot, FIELD);
  const spaLink = refOf(beforeSpa.snapshot, /link "Change route" \[ref=(e\d+)\]/);
  const changedRoute = await attempt('click', { tabId: first, ref: spaLink });
  const typedAfterSpa = await attempt('type', { tabId: first, ref: spaField, text: 'spa', clear: true });
  const spaPage = await lookAt(first);
  check(
    'an SPA route change keeps the refs from before it',
    changedRoute.ok && changedRoute.result.url.endsWith('/spa') && whereOf(spaPage.flat) === '/spa' && typedAfterSpa.ok && fieldOf(spaPage.text) === 'spa',
    `url: ${changedRoute.ok ? changedRoute.result.url : changedRoute.error}, ${outcome(typedAfterSpa)}, field: "${fieldOf(spaPage.text)}"`,
  );

  // e. A narrowed snapshot adds to the set; it does not take the full snapshot's refs away.
  const full = await bridge.request('snapshot', { tabId: first });
  const farButton = refOf(full.snapshot, /button "Far button" \[ref=(e\d+)\]/);
  const narrowed = await bridge.request('snapshot', { tabId: first, find: 'Field label' });
  const excluded = !/Far button/.test(narrowed.snapshot);
  const clickedFar = await attempt('click', { tabId: first, ref: farButton });
  const farPage = await lookAt(first);
  check(
    'a narrowed snapshot keeps the refs from the full one',
    excluded && clickedFar.ok && pickedOf(farPage.flat) === 'far',
    `narrowed past the button: ${excluded}, ${outcome(clickedFar)}, ${pickedOf(farPage.flat)}`,
  );

  // f. A drop on the same document keeps the refs: nothing says the page changed while Tabhand was off.
  const beforeDrop = await bridge.request('snapshot', { tabId: first });
  const dropField = refOf(beforeDrop.snapshot, FIELD);
  await bridge.request('simulate_detach', { tabId: first });
  const typedAfterDrop = await attempt('type', { tabId: first, ref: dropField, text: 'kept', clear: true });
  const dropPage = await lookAt(first);
  check(
    'losing the debugger on the same document keeps the refs',
    typedAfterDrop.ok && fieldOf(dropPage.text) === 'kept',
    `${outcome(typedAfterDrop)}, field: "${fieldOf(dropPage.text)}"`,
  );

  // g. A document that changed while Tabhand was off the tab: the next step sees another loader, so
  // the old ref is refused. The navigation is made from outside Tabhand, as a page's own would be.
  const beforeGap = await bridge.request('snapshot', { tabId: first });
  const gapField = refOf(beforeGap.snapshot, FIELD);
  await bridge.request('simulate_detach', { tabId: first });
  const devtools = await browserDevTools(browser.profile);
  try {
    const { targetInfos } = await devtools.send('Target.getTargets');
    const target = targetInfos.find((info) => info.type === 'page' && info.url.endsWith('/spa'));
    const { sessionId } = await devtools.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    await devtools.send('Page.navigate', { url: `${base}/a-three` }, sessionId);
    for (let i = 0; i < 50; i++) {
      const { frameTree } = await devtools.send('Page.getFrameTree', {}, sessionId);
      if (frameTree.frame.url.endsWith('/a-three')) break;
      await sleep(100);
    }
    await devtools.send('Target.detachFromTarget', { sessionId });
  } finally {
    devtools.close();
  }
  await sleep(200);
  const typedAfterGap = await attempt('type', { tabId: first, ref: gapField, text: 'stale' });
  check(
    'a document that changed while Tabhand was off the tab refuses the old ref',
    !typedAfterGap.ok && STALE.test(typedAfterGap.error),
    outcome(typedAfterGap),
  );

  for (const tabId of [first, second]) await bridge.request('close_tab', { tabId });
} catch (error) {
  check('test run', false, error.stack);
} finally {
  bridge.close();
  server.close();
  await browser.close();
  process.exit(results.every(Boolean) ? 0 : 1);
}
