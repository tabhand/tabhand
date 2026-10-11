// What happens when an agent clicks something that opens a new tab or window? Checks that the
// user's tab stays active, Chrome stays in the background, and the agent can reach the new tab.
//
//   node test/new-tabs.mjs

import crypto from 'node:crypto';
import http from 'node:http';
import { BridgeClient } from '../src/bridge-client.mjs';
import { frontmostApp, launchTestBrowser, sleep } from './harness.mjs';

const page = `<!doctype html><title>Opener</title><body style="font: 16px sans-serif; padding: 40px">
  <p><a href="/target?via=link" target="_blank">Open in new tab</a></p>
  <p><button onclick="window.open('/target?via=script')">Open with script</button></p>
  <p><button onclick="window.open('/target?via=popup', 'popup', 'width=520,height=420')">Open popup window</button></p>
</body>`;
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(request.url.startsWith('/target') ? `<!doctype html><title>Target ${request.url}</title><h1>Target</h1>` : page);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const browser = await launchTestBrowser();
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
  const { tabId } = await bridge.request('open_tab', { url: `http://127.0.0.1:${server.address().port}/` });
  let expectedTabs = 1;
  for (const [name, pattern, windows] of [
    ['link with target=_blank', /link "Open in new tab" \[ref=(e\d+)\]/, 1],
    ['window.open() tab', /button "Open with script" \[ref=(e\d+)\]/, 1],
    ['popup window', /button "Open popup window" \[ref=(e\d+)\]/, 2],
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
