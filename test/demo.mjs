// A watchable demo in your own Chrome: an agent browses Wikipedia and Hacker News at a calm pace
// so you can see the cursor, the tab badges, typing and page loads. Switch to the new tab once it
// appears; the agent waits a little before it starts.
//
//   node test/demo.mjs [secondsToWait]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = Number(process.argv[2] ?? 15);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SEARCH = /(?:searchbox|combobox|textbox) "Search Wikipedia"[^\n]*\[ref=(e\d+)\]/;

const client = new Client({ name: 'tabhand-demo', version: '0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'bin/tabhand.mjs'), 'mcp', '--label', 'Claude', '--theme', 'claude'],
  }),
);
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
  if (result.isError) throw new Error(`${name}: ${text}`);
  return text;
};
const step = (message) => console.log(`${new Date().toLocaleTimeString()}  ${message}`);

/** Clicks the first link whose name is in the list. */
async function clickLink(tabId, names) {
  const snapshot = await call('browser_snapshot', { tabId });
  for (const name of names) {
    const ref = new RegExp(`link "${name}" \\[ref=(e\\d+)\\]`).exec(snapshot)?.[1];
    if (ref) {
      step(`click "${name}"`);
      return (await call('browser_click', { tabId, ref })).split('\n')[0];
    }
  }
  step(`none of these links were on the page: ${names.join(', ')}`);
  return '';
}

try {
  const opened = await call('browser_open_tab', { url: 'https://en.wikipedia.org/wiki/Main_Page' });
  const wiki = Number(/^Tab (\d+):/.exec(opened)[1]);
  step(`opened Wikipedia in tab ${wiki}; starting in ${wait}s`);
  await sleep(wait * 1000);

  let snapshot = await call('browser_snapshot', { tabId: wiki });
  step('click the search box');
  await call('browser_click', { tabId: wiki, ref: SEARCH.exec(snapshot)?.[1] });
  await sleep(1500);
  // Wikipedia swaps in an expanded search box on click, so look the field up again.
  snapshot = await call('browser_snapshot', { tabId: wiki });
  step('type "Ada Lovelace" and press Enter');
  step((await call('browser_type', { tabId: wiki, ref: SEARCH.exec(snapshot)?.[1], text: 'Ada Lovelace', submit: true })).split('\n')[0]);
  await sleep(3000);

  step('scroll down');
  await call('browser_scroll', { tabId: wiki, direction: 'down', amount: 500 });
  await sleep(2500);
  step(await clickLink(wiki, ['Analytical Engine', 'Charles Babbage']));
  await sleep(3000);
  step('scroll down');
  await call('browser_scroll', { tabId: wiki, direction: 'down', amount: 400 });
  await sleep(2500);
  step(await clickLink(wiki, ['Charles Babbage', 'Difference engine', 'Ada Lovelace']));
  await sleep(3000);

  const second = await call('browser_open_tab', { url: 'https://news.ycombinator.com' });
  const hn = Number(/^Tab (\d+):/.exec(second)[1]);
  step(`opened Hacker News in tab ${hn} (switch to it if you like)`);
  await sleep(6000);
  step(await clickLink(hn, ['new', 'past']));
  await sleep(3000);
  step(await clickLink(hn, ['ask', 'show']));
  await sleep(3000);

  step(await clickLink(wiki, ['Ada Lovelace', 'Analytical Engine', 'Mathematician']));
  await sleep(3000);
  step('done; the cursors and badges leave about 30 seconds after this');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
