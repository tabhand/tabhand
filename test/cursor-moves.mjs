// The agent's cursor goes where each step happens, also for steps that don't click there: choosing
// a dropdown option puts it on the dropdown, and pressing a key puts it on the field the key goes to.
//
//   node test/cursor-moves.mjs

import crypto from 'node:crypto';
import http from 'node:http';
import { BridgeClient } from '../src/bridge-client.mjs';
import { launchTestBrowser } from './harness.mjs';

const boxes = {};
const page = `<!doctype html><title>Cursor moves</title>
<body style="font: 16px sans-serif; margin: 0">
  <input id="first" aria-label="First field" style="position: absolute; left: 40px; top: 40px; width: 200px">
  <select id="size" aria-label="Size" style="position: absolute; left: 600px; top: 400px; width: 160px">
    <option>Small</option><option>Large</option>
  </select>
  <button id="elsewhere" style="position: absolute; left: 600px; top: 40px">Elsewhere</button>
  <script>
    // The button far away puts the focus back in the first field, where the next key goes.
    const first = document.getElementById('first');
    document.getElementById('elsewhere').addEventListener('click', () => first.focus());
    const box = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom].map(Math.round).join(','); };
    setInterval(() => fetch('/report?first=' + box('first') + '&size=' + box('size')), 250);
  </script>
</body>`;
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/report') {
    for (const [name, value] of url.searchParams) boxes[name] = value.split(',').map(Number);
    response.end();
    return;
  }
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
const inside = (point, box) => Boolean(point && box) && point.x >= box[0] && point.x <= box[2] && point.y >= box[1] && point.y <= box[3];
const cursor = async (tabId) => (await bridge.request('diagnostics', { tabId })).cursor;

try {
  if (!browser.connected) throw new Error('The test browser did not connect.');
  const { tabId } = await bridge.request('open_tab', { url: `http://127.0.0.1:${server.address().port}/` });
  const { snapshot } = await bridge.request('snapshot', { tabId });
  const ref = (pattern) => pattern.exec(snapshot)?.[1];

  await bridge.request('type', { tabId, ref: ref(/textbox "First field" \[ref=(e\d+)\]/), text: 'hello' });
  let at = await cursor(tabId);
  check('typing puts the cursor on the field', inside(at, boxes.first), `cursor ${JSON.stringify(at)}, field ${boxes.first}`);

  const chosen = await bridge.request('click', { tabId, ref: ref(/option "Large" \[ref=(e\d+)\]/) });
  at = await cursor(tabId);
  check('choosing a dropdown option puts the cursor on the dropdown', chosen.chose === 'Large' && inside(at, boxes.size), `chose ${chosen.chose}, cursor ${JSON.stringify(at)}, dropdown ${boxes.size}`);

  await bridge.request('click', { tabId, ref: ref(/button "Elsewhere" \[ref=(e\d+)\]/) });
  await bridge.request('press_key', { tabId, key: 'End' });
  at = await cursor(tabId);
  check('pressing a key puts the cursor on the field it goes to', inside(at, boxes.first), `cursor ${JSON.stringify(at)}, field ${boxes.first}`);
} catch (error) {
  check('test run', false, error.message);
} finally {
  bridge.close();
  server.close();
  await browser.close();
  process.exit(results.every(Boolean) ? 0 : 1);
}
