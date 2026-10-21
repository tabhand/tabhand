// Can an agent click controls a page builds from plain elements (a div with a click handler), like
// Product Hunt's launch tags, radio cards and date tiles? They have no role, so Chrome's
// accessibility tree, and a snapshot made from it, gives them no ref.
//
//   node test/clickables.mjs

import crypto from 'node:crypto';
import http from 'node:http';
import { BridgeClient } from '../src/bridge-client.mjs';
import { launchTestBrowser } from './harness.mjs';

const page = `<!doctype html><title>Div controls</title>
<style>
  body { font: 16px sans-serif; padding: 40px }
  .control { cursor: pointer; display: inline-block; margin: 6px; padding: 8px 12px; border: 1px solid #ccc; border-radius: 8px }
</style>
<body>
  <div class="control" data-pick="tag"><span>Chrome Extensions</span></div>
  <div class="control" data-pick="radio"><span class="dot"></span> I worked on this product</div>
  <div class="control" data-pick="date"><b>19</b> <small>Oct</small></div>
  <div class="control" data-pick="icon"><img alt="Developer Tools" width="16" height="16" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="> Developer Tools</div>
  <div class="control" data-pick="svg" tabindex="-1"><svg width="60" height="16"><title>logo_google</title><rect width="60" height="16" fill="#4285f4"/></svg></div>
  <div data-pick="image" style="margin: 6px"><img alt="Upload photo" width="24" height="24" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></div>
  <menu-item data-pick="shadow" style="display: block; margin: 6px"></menu-item>
  <div data-pick="generated" class="generated" role="button" style="margin: 6px"></div>
  <style>.generated::before { content: "Made by CSS" }</style>
  <div data-pick="plain" style="margin: 6px">Plain click target</div>
  <p>Picked: <span id="picked">nothing</span></p>
  <script>
    // A web component whose label lives in its shadow root, like Bing Webmaster Tools' menu.
    customElements.define('menu-item', class extends HTMLElement {
      constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<span role="treeitem">Shadow item</span>'; }
    });
    for (const control of document.querySelectorAll('[data-pick]')) {
      control.addEventListener('click', () => { document.getElementById('picked').textContent = control.dataset.pick; });
    }
  </script>
</body>`;
const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(page);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const browser = await launchTestBrowser();
const bridge = new BridgeClient({ sessionId: crypto.randomUUID(), label: 'Claude', theme: 'claude' });
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
};
const picked = async (tabId) => /Picked:\s*(?:- text: )?(\w+)/.exec((await bridge.request('snapshot', { tabId })).snapshot.replace(/\n\s*/g, ' '))?.[1];

try {
  if (!browser.connected) throw new Error('The test browser did not connect.');
  const { tabId } = await bridge.request('open_tab', { url: `http://127.0.0.1:${server.address().port}/` });
  const { snapshot } = await bridge.request('snapshot', { tabId });

  for (const [name, label, pick] of [
    ['a launch-tag row', 'Chrome Extensions', 'tag'],
    ['a custom radio card', 'I worked on this product', 'radio'],
    ['a date tile', '19 Oct', 'date'],
    ['a row whose icon repeats its label (named once)', 'Developer Tools', 'icon'],
    ['a focusable card named only by its SVG (Bing sign-in)', 'logo_google', 'svg'],
  ]) {
    const ref = new RegExp(`clickable "${label}" \\[ref=(e\\d+)\\]`).exec(snapshot)?.[1];
    if (ref) await bridge.request('click', { tabId, ref });
    const now = await picked(tabId);
    check(`${name} gets a ref, and clicking it works`, Boolean(ref) && now === pick, `ref: ${ref ?? 'none'}, picked: ${now}`);
  }

  const result = await bridge.request('click', { tabId, text: 'Plain click target' });
  const now = await picked(tabId);
  check('an element with no ref can be clicked by its text', now === 'plain', `picked: ${now}, notes: ${JSON.stringify(result.notes ?? [])}`);

  await bridge.request('click', { tabId, text: 'Shadow item' }).catch(() => {});
  const inShadow = await picked(tabId);
  check('text inside a web component (shadow DOM) can be clicked', inShadow === 'shadow', `picked: ${inShadow}`);

  await bridge.request('click', { tabId, text: 'Made by CSS' }).catch(() => {});
  const generated = await picked(tabId);
  check('a label only CSS draws can be clicked by its text (from the accessibility tree)', generated === 'generated', `picked: ${generated}`);

  await bridge.request('click', { tabId, text: 'Upload photo' });
  const byAlt = await picked(tabId);
  check('an image can be clicked by its alt text', byAlt === 'image', `picked: ${byAlt}`);

  const missing = await bridge.request('click', { tabId, text: 'Nothing says this' }).then(
    () => 'clicked',
    (error) => error.message,
  );
  check('text that is nowhere on the page is an error, not a click', /no element/i.test(missing), missing);
} catch (error) {
  check('test run', false, error.message);
} finally {
  bridge.close();
  server.close();
  await browser.close();
  process.exit(results.every(Boolean) ? 0 : 1);
}
