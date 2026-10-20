// What happens when an agent clicks something that opens a new tab or window? Checks that the
// user's tab stays active, Chrome stays in the background, and the agent can reach the new tab.
// Then checks the other way round: a tab the user opens never goes to the agent, even right after
// the agent's page tried to open one, or while the agent's tab is the one in front.
//
//   node test/new-tabs.mjs

import crypto from 'node:crypto';
import http from 'node:http';
import { BridgeClient } from '../src/bridge-client.mjs';
import { browserDevTools, frontmostApp, launchTestBrowser, sleep } from './harness.mjs';

const page = `<!doctype html><title>Opener</title><body style="font: 16px sans-serif; padding: 40px">
  <p><a href="/target?via=link" target="_blank">Open in new tab</a></p>
  <p><button onclick="window.open('/target?via=script')">Open with script</button></p>
  <p><button onclick="window.open('/target?via=popup', 'popup', 'width=520,height=420')">Open popup window</button></p>
  <p><button onclick="const opened = window.open(); opened.location = '/target?via=blank'">Open blank window</button></p>
</body>`;
// Opens a window as it loads, with no click: Chrome blocks it, though the page still asked.
const blockedPopup = `<!doctype html><title>Blocked popup</title><script>window.open('/target?via=blocked')</script>`;
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  if (request.url.startsWith('/target') || request.url.startsWith('/yours')) {
    response.end(`<!doctype html><title>Target ${request.url}</title><h1>Target</h1>`);
  } else {
    response.end(request.url.startsWith('/blocked-popup') ? blockedPopup : page);
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await launchTestBrowser({ args: ['--remote-debugging-port=0'] });
const bridge = new BridgeClient({ sessionId: crypto.randomUUID(), label: 'Claude', theme: 'claude' });
const focus = new Set();
const sampler = setInterval(() => focus.add(frontmostApp()), 200);
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
};

try {
  if (!browser.connected) throw new Error('The test browser did not connect.');
  const { tabId } = await bridge.request('open_tab', { url: `${base}/` });
  let expectedTabs = 1;
  for (const [name, pattern, windows] of [
    ['link with target=_blank', /link "Open in new tab" \[ref=(e\d+)\]/, 1],
    ['window.open() tab', /button "Open with script" \[ref=(e\d+)\]/, 1],
    ['popup window', /button "Open popup window" \[ref=(e\d+)\]/, 2],
    ['blank window.open() sent on to a page', /button "Open blank window" \[ref=(e\d+)\]/, 2],
  ]) {
    const { snapshot } = await bridge.request('snapshot', { tabId });
    const result = await bridge.request('click', { tabId, ref: pattern.exec(snapshot)?.[1] });
    await sleep(1500);
    expectedTabs++;
    const state = await bridge.request('diagnostics');
    const userWindow = state.windows.find((window) => window.type === 'normal');
    check(
      `${name}: your tab stays active, the agent owns and hears about the new one`,
      userWindow?.activeTab === 'user' && state.sessionTabs === expectedTabs && result.opened.length === 1 && state.windows.length === windows,
      `active: ${userWindow?.activeTab}, agent tabs: ${state.sessionTabs}, reported: ${result.opened.length}, windows: ${state.windows.length}`,
    );
  }

  // The user's own tabs, opened just after the agent's page asked for a window Chrome blocked.
  // From here on the test acts as the user, who may well bring Chrome to the front.
  clearInterval(sampler);
  const devtools = await browserDevTools(browser.profile);
  try {
    for (const [name, url, fromAgentTab] of [
      ['a page you open yourself', `${base}/yours`, false],
      ['a new tab page (Cmd+T)', 'chrome://newtab/', false],
      ["a page you open while the agent's tab is in front", `${base}/yours-too`, true],
    ]) {
      await bridge.request('navigate', { tabId, url: `${base}/blocked-popup` });
      if (fromAgentTab) {
        const { targetInfos } = await devtools.send('Target.getTargets');
        const agentTarget = targetInfos.find((target) => target.type === 'page' && target.url.endsWith('/blocked-popup'));
        await devtools.send('Target.activateTarget', { targetId: agentTarget.targetId });
      }
      const before = (await bridge.request('diagnostics')).sessionTabs;
      const { targetId } = await devtools.send('Target.createTarget', { url });
      await sleep(1500);
      const after = (await bridge.request('diagnostics')).sessionTabs;
      check(`${name}: stays yours`, after === before, `agent tabs before: ${before}, after: ${after}`);
      await devtools.send('Target.closeTarget', { targetId });
    }
  } finally {
    devtools.close();
  }
} catch (error) {
  check('test run', false, error.message);
} finally {
  clearInterval(sampler);
  const stolen = [...focus].some((app) => /Chrome for Testing/.test(app));
  check('the browser never came to the front', !stolen, [...focus].join(', '));
  bridge.close();
  server.close();
  await browser.close();
  process.exit(results.every(Boolean) ? 0 : 1);
}
