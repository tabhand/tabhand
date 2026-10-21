// Chrome reloads the extension when it updates (and when you reload it by hand), and forgets what
// the extension kept for the session then. An agent at work keeps its tabs and its tab group
// through that: its next tab joins the same group. After Chrome restarts, tabs get new ids, so only
// tabs still in the agent's own group come back; a tab of yours never goes to an agent.
//
//   node test/extension-reload.mjs

import crypto from 'node:crypto';
import http from 'node:http';
import { BridgeClient } from '../src/bridge-client.mjs';
import { status } from '../src/install.mjs';
import { browserDevTools, launchTestBrowser, sleep } from './harness.mjs';

const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(`<!doctype html><title>Page ${request.url}</title><h1>Page ${request.url}</h1>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await launchTestBrowser({ args: ['--remote-debugging-port=0'] });
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
};

const devtools = await browserDevTools(browser.profile);
/** Runs an expression in the extension's service worker. */
async function inExtension(expression) {
  for (let i = 0; i < 50; i++) {
    const { targetInfos } = await devtools.send('Target.getTargets');
    const worker = targetInfos.find((target) => target.type === 'service_worker' && target.url.endsWith('/background.js'));
    if (worker) {
      const { sessionId } = await devtools.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
      try {
        const { result, exceptionDetails } = await devtools.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
        return result.value;
      } finally {
        await devtools.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      }
    }
    await sleep(100);
  }
  throw new Error('No extension service worker');
}
const groupsInBrowser = () => inExtension('chrome.tabGroups.query({}).then((groups) => groups.length)');
const listed = async (bridge) => (await bridge.request('list_tabs')).tabs.map((tab) => tab.tabId);

/**
 * Does to Tabhand what Chrome does when it reloads the extension: forgets what it kept for the
 * session, detaches it from every tab and restarts its worker (and with it, its helper). Chrome for
 * Testing doesn't bring an extension loaded from the command line back after chrome.runtime.reload().
 */
async function reload(bridge) {
  await inExtension(`(async () => {
    await chrome.storage.session.clear();
    for (const target of await chrome.debugger.getTargets()) {
      if (target.attached && target.tabId) await chrome.debugger.detach({ tabId: target.tabId }).catch(() => {});
    }
  })()`);
  const { targetInfos } = await devtools.send('Target.getTargets');
  const worker = targetInfos.find((target) => target.type === 'service_worker' && target.url.endsWith('/background.js'));
  const scopeURL = `${new URL(worker.url).origin}/`;
  const { targetId } = await devtools.send('Target.createTarget', { url: 'about:blank', background: true });
  const { sessionId } = await devtools.send('Target.attachToTarget', { targetId, flatten: true });
  await devtools.send('ServiceWorker.enable', {}, sessionId);
  await devtools.send('ServiceWorker.stopAllWorkers', {}, sessionId);
  for (let i = 0; i < 40 && (await status()).connected; i++) await sleep(250);
  await devtools.send('ServiceWorker.startWorker', { scopeURL }, sessionId);
  await devtools.send('Target.closeTarget', { targetId });
  for (let i = 0; i < 80; i++) {
    try {
      await bridge.request('list_tabs');
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error('The extension did not come back after the reload.');
}

try {
  if (!browser.connected) throw new Error('The test browser did not connect.');
  const bridge = new BridgeClient({ sessionId: crypto.randomUUID(), label: 'Claude', theme: 'claude' });
  const first = await bridge.request('open_tab', { url: `${base}/first` });
  const second = await bridge.request('open_tab', { url: `${base}/second` });
  // A tab of the user's, outside any group.
  const { targetId } = await devtools.send('Target.createTarget', { url: `${base}/yours`, background: true });
  await sleep(1000);
  const yours = await inExtension(`chrome.debugger.getTargets().then((targets) => targets.find((target) => target.id === ${JSON.stringify(targetId)}).tabId)`);
  check('before the reload, the agent has one group', (await groupsInBrowser()) === 1, `groups: ${await groupsInBrowser()}`);

  await reload(bridge);
  const after = await listed(bridge);
  check('after the reload, the agent still has its tabs', after.includes(first.tabId) && after.includes(second.tabId), `listed: ${after.join(', ')}`);
  let snapshot = '';
  try {
    snapshot = (await bridge.request('snapshot', { tabId: first.tabId })).snapshot;
  } catch (error) {
    snapshot = error.message;
  }
  check('and can still read them', snapshot.includes('Page /first'), snapshot.slice(0, 80));
  const third = await bridge.request('open_tab', { url: `${base}/third` });
  check('its next tab joins the same group', (await groupsInBrowser()) === 1, `groups: ${await groupsInBrowser()}`);
  check('the agent has all three tabs', (await listed(bridge)).length === 3, `listed: ${(await listed(bridge)).join(', ')}`);

  // What Chrome would have kept from before it restarted: sessions naming tabs and groups by ids
  // that may now belong to others. One names a group that's gone; one names the agent's real group,
  // but with a tab of the user's that isn't in it.
  const group = await inExtension(`chrome.tabs.get(${third.tabId}).then((tab) => tab.groupId)`);
  await inExtension(`chrome.storage.local.get('sessions').then(({ sessions = {} }) => chrome.storage.local.set({ sessions: {
    ...sessions,
    'stale-session-gone-group': { label: 'Old', theme: 'agent', groupId: 12345, windowId: null, tabIds: [${yours}] },
    'stale-session-wrong-tab': { label: 'Old', theme: 'agent', groupId: ${group}, windowId: null, tabIds: [${yours}] },
  } }))`);
  await reload(bridge);
  for (const sessionId of ['stale-session-gone-group', 'stale-session-wrong-tab']) {
    const stale = new BridgeClient({ sessionId, label: 'Old' });
    let reached;
    try {
      await stale.request('snapshot', { tabId: yours });
      reached = true;
    } catch {
      reached = false;
    }
    const tabs = await listed(stale);
    check(`a kept session can't reach a tab outside its group (${sessionId})`, !reached && !tabs.includes(yours), `reached: ${reached}, listed: ${tabs.join(', ')}`);
    stale.close();
  }
  check('the agent still has its three tabs after a second reload', (await listed(bridge)).length === 3, `listed: ${(await listed(bridge)).join(', ')}`);

  // Once the agent goes, its group is marked done and the session isn't kept any more.
  bridge.close();
  await sleep(31_000);
  const kept = await inExtension(`chrome.storage.local.get('sessions').then(({ sessions = {} }) => Object.keys(sessions).length)`);
  const title = await inExtension(`chrome.tabGroups.get(${group}).then((group) => group.title)`);
  check('when the agent is done, its group says so and nothing is kept', title === 'Claude (done)' && kept === 0, `title: ${title}, kept: ${kept}`);
} catch (error) {
  check('test run', false, error.stack);
} finally {
  devtools.close();
  server.close();
  await browser.close();
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
