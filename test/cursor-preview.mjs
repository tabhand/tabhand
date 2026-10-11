// Renders the agent cursor in a throwaway browser and saves two screenshots: what the user sees
// (cursor on) and what the agent sees (cursor hidden).
//
//   node test/cursor-preview.mjs

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BridgeClient } from '../src/bridge-client.mjs';
import { launchTestBrowser } from './harness.mjs';

const browser = await launchTestBrowser();
const bridge = new BridgeClient({ sessionId: crypto.randomUUID(), label: 'Claude' });
const save = (name, data) => {
  const file = path.join(os.tmpdir(), name);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
};

let ok = false;
try {
  if (!browser.connected) throw new Error('The test browser did not connect.');
  const { tabId } = await bridge.request('open_tab', { url: 'https://en.wikipedia.org/wiki/Main_Page' });
  const { snapshot } = await bridge.request('snapshot', { tabId });
  const ref = /(?:searchbox|combobox|textbox) "Search Wikipedia"[^\n]*\[ref=(e\d+)\]/.exec(snapshot)?.[1];
  if (!ref) throw new Error('Search field not found in the snapshot.');

  const started = Date.now();
  await bridge.request('click', { tabId, ref, debugCursor: true });
  console.log(`Animated click: ${Date.now() - started} ms`);
  console.log(`User view:  ${save('tabhand-cursor-on.jpg', (await bridge.request('screenshot', { tabId, keepCursor: true })).data)}`);
  console.log(`Agent view: ${save('tabhand-cursor-off.jpg', (await bridge.request('screenshot', { tabId })).data)}`);

  const after = await bridge.request('snapshot', { tabId });
  console.log(`Cursor kept out of the snapshot: ${!/tabhand|Claude/.test(after.snapshot)}`);
  // Wikipedia swaps in an expanded search box on click, so look the field up again.
  const field = /(?:searchbox|combobox|textbox) "Search Wikipedia"[^\n]*\[ref=(e\d+)\]/.exec(after.snapshot)?.[1];
  await bridge.request('type', { tabId, ref: field, text: 'Ada Lovelace', submit: true });
  const result = await bridge.request('snapshot', { tabId });
  console.log(`Typing and submitting still work: ${/Ada Lovelace/.test(result.title)}`);
  ok = true;
} catch (error) {
  console.error(error.message);
} finally {
  bridge.close();
  await browser.close();
  process.exit(ok ? 0 : 1);
}
