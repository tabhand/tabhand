// Does text an agent types reach the page's own state, not just the field on screen? Some forms
// only read a field when a key goes up (the Product Hunt profile form saved stale values). And
// when a page changes or refuses the text, the agent should hear about it.
//
//   node test/typing.mjs

import crypto from 'node:crypto';
import http from 'node:http';
import { BridgeClient } from '../src/bridge-client.mjs';
import { launchTestBrowser } from './harness.mjs';

const page = `<!doctype html><title>Typing</title><body style="font: 16px sans-serif; padding: 40px">
  <p><label>Headline <input id="headline"></label></p>
  <p><label>Code <input id="code"></label></p>
  <p><button onclick="document.getElementById('saved').textContent = 'Saved: ' + saved">Save</button></p>
  <p id="saved"></p>
  <script>
    // The page keeps its own copy of the headline, updated only when a key goes up.
    let saved = '';
    const headline = document.getElementById('headline');
    headline.addEventListener('keyup', () => { saved = headline.value; });
    // The code field takes five characters at most, and trims the rest as you type.
    const code = document.getElementById('code');
    code.addEventListener('input', () => { code.value = code.value.slice(0, 5); });
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
const ref = (snapshot, pattern) => pattern.exec(snapshot)?.[1];

try {
  if (!browser.connected) throw new Error('The test browser did not connect.');
  const { tabId } = await bridge.request('open_tab', { url: `http://127.0.0.1:${server.address().port}/` });
  const { snapshot } = await bridge.request('snapshot', { tabId });

  const headline = 'Building Tabhand · AI engineer';
  const typed = await bridge.request('type', { tabId, ref: ref(snapshot, /textbox "Headline" \[ref=(e\d+)\]/), text: headline });
  await bridge.request('click', { tabId, ref: ref(snapshot, /button "Save" \[ref=(e\d+)\]/) });
  const after = await bridge.request('snapshot', { tabId });
  const savedLine = /Saved: [^\n]*/.exec(after.snapshot)?.[0] ?? '(nothing saved)';
  check('a form that reads the field on key up gets all of the text', savedLine.includes(headline), savedLine);
  check('text that went in as typed comes with no note', !typed.notes?.length, JSON.stringify(typed.notes ?? []));

  const trimmed = await bridge.request('type', { tabId, ref: ref(snapshot, /textbox "Code" \[ref=(e\d+)\]/), text: 'ABCDEFGHIJ' });
  check(
    'when the page trims the text, the agent hears what the field says',
    trimmed.notes?.some((note) => note.includes('"ABCDE"')),
    JSON.stringify(trimmed.notes ?? []),
  );
} catch (error) {
  check('test run', false, error.message);
} finally {
  bridge.close();
  server.close();
  await browser.close();
  process.exit(results.every(Boolean) ? 0 : 1);
}
