// How long the agent waits for pages, next to the same pages in a plain tab with no debugger,
// cursor or badge. Runs in a throwaway test browser; pass --real to use the Chrome you have open
// (with your logins, so sites like X show their full logged-in feed).
//
//   node test/load-speed.mjs [--real]

import crypto from 'node:crypto';
import { BridgeClient } from '../src/bridge-client.mjs';
import { launchTestBrowser } from './harness.mjs';

const real = process.argv.includes('--real');
const urls = ['https://x.com/home', 'https://github.com', 'https://en.wikipedia.org/wiki/Main_Page', 'https://www.youtube.com'];
const browser = real ? null : await launchTestBrowser();
const bridge = new BridgeClient({ sessionId: crypto.randomUUID(), label: 'Speed test', theme: 'agent' });
const pad = (value, width) => String(value).padStart(width);
try {
  if (browser && !browser.connected) throw new Error('The test browser did not connect.');
  console.log(`${'page'.padEnd(42)} ${pad('plain tab loaded', 16)} ${pad('agent waited', 13)}`);
  for (const url of urls) {
    const plain = await bridge.request('baseline_timing', { url });
    const started = Date.now();
    const { tabId } = await bridge.request('open_tab', { url });
    const waited = Date.now() - started;
    await bridge.request('close_tab', { tabId });
    console.log(`${url.padEnd(42)} ${pad(`${plain.elapsed} ms`, 16)} ${pad(`${waited} ms`, 13)}`);
  }
  const { issues } = await bridge.request('diagnostics');
  if (issues.length) console.log('issues:', JSON.stringify(issues));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  bridge.close();
  await browser?.close();
}
