// Naming a Chrome profile, in a throwaway Chrome for Testing profile (never your real Chrome): the
// name saved on the extension's "Name this profile" page reaches agents, and shows in the toolbar
// icon's tooltip.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { frontmostApp, launchTestBrowser, sleep } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The id the manifest's key pins for the copy loaded by hand.
const EXTENSION_ID = 'hbfnkakpdogiidhdmhhcifeegekkoaep';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** A DevTools protocol connection to the whole browser, with sessions for its targets. */
async function devtools(port) {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let id = 0;
  const waiting = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) {
      waiting.get(message.id)(message);
      waiting.delete(message.id);
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const call = ++id;
      waiting.set(call, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)));
      socket.send(JSON.stringify({ id: call, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  /** Runs an expression in a target and returns its value. */
  const evaluate = async (sessionId, expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  const attach = async (targetId) => (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  return { send, evaluate, attach, close: () => socket.close() };
}

async function agent(label) {
  const client = new Client({ name: 'tabhand-profile-name', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'bin/tabhand.mjs'), 'mcp', '--label', label], env: { ...process.env } }));
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { error: Boolean(result.isError), text: result.content.map((c) => c.text ?? '').join('\n') };
  };
  return { client, call };
}

let browser = null;
let cdp = null;
let one = null;
try {
  browser = await launchTestBrowser({ args: ['--remote-debugging-port=0'] });
  check('extension connects to the bridge', browser.connected);
  const portFile = path.join(browser.profile, 'DevToolsActivePort');
  for (let i = 0; i < 40 && !fs.existsSync(portFile); i++) await sleep(250);
  cdp = await devtools(fs.readFileSync(portFile, 'utf8').split('\n')[0]);

  one = await agent('One');
  let r = await one.call('browser_list_profiles');
  check('one unnamed profile at first', !r.error && /one Chrome profile/.test(r.text) && /Unnamed \(id [a-f0-9-]{8}\): on/.test(r.text), r.text);

  // The service worker: the menu item and the optional permissions are there.
  const { targetInfos } = await cdp.send('Target.getTargets');
  const worker = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${EXTENSION_ID}/`));
  check('the extension is running', Boolean(worker));
  const sw = await cdp.attach(worker.targetId);
  const menu = await cdp.evaluate(sw, `new Promise((resolve) => chrome.contextMenus.update('name-profile', {}, () => resolve(chrome.runtime.lastError?.message ?? 'ok')))`);
  check('the toolbar icon has a "Name this profile" item', menu === 'ok', menu);
  const granted = await cdp.evaluate(sw, `chrome.permissions.contains({ permissions: ['identity', 'identity.email'] })`);
  check('the email permission is not granted up front', granted === false);

  // Name the profile on the extension's page, as the user would.
  const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${EXTENSION_ID}/profile.html`, background: true });
  const page = await cdp.attach(targetId);
  for (let i = 0; i < 40 && !(await cdp.evaluate(page, `document.readyState === 'complete' && Boolean(document.getElementById('name'))`).catch(() => false)); i++) await sleep(100);

  // Chrome refuses at once to ask for a permission the manifest doesn't list; one it does list waits
  // for the user (nobody answers here). That tells the email permission can be asked for.
  const ask = (permissions) =>
    cdp
      .send('Runtime.evaluate', {
        expression: `Promise.race([chrome.permissions.request({ permissions: ${JSON.stringify(permissions)} }).then(() => 'answered', (e) => 'refused: ' + e.message), new Promise((r) => setTimeout(() => r('asking the user'), 1500))])`,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      }, page)
      .then(({ result }) => result.value);
  const front = frontmostApp();
  const undeclared = await ask(['bookmarks']);
  check('(a permission the manifest leaves out is refused)', /^refused/.test(undeclared), undeclared);
  const email = await ask(['identity', 'identity.email']);
  check('the email permission can be asked for', email === 'asking the user', email);
  check('and asking does not bring Chrome to the front', frontmostApp() === front, `${front} → ${frontmostApp()}`);
  await cdp.send('Page.reload', {}, page).catch(() => {});
  for (let i = 0; i < 40 && !(await cdp.evaluate(page, `document.readyState === 'complete' && Boolean(document.getElementById('name'))`).catch(() => false)); i++) await sleep(100);
  await cdp.evaluate(page, `document.getElementById('name').value = '  Work  '; document.getElementById('form').requestSubmit(); true`);
  await sleep(600);
  const saved = await cdp.evaluate(page, `document.getElementById('status').textContent`).catch(() => '(page closed)');
  check('the page says it saved', /Agents now see this profile as “Work”/.test(saved), saved);

  r = await one.call('browser_list_profiles');
  check('agents see the new name', !r.error && /"Work" \(id [a-f0-9-]{8}\): on/.test(r.text), r.text);
  const title = await cdp.evaluate(sw, `chrome.action.getTitle({})`);
  check('the toolbar tooltip names the profile', title === 'Tabhand is on in “Work”. Click to pause.', title);
  r = await one.call('browser_open_tab', { profile: 'work' });
  check('an agent can ask for it by name', !r.error && /^Tab \d+:/.test(r.text) && !/\(in /.test(r.text), r.text);

  // Chrome stops an extension's service worker now and then. Once it's back, so is the name.
  await cdp.send('Target.closeTarget', { targetId: worker.targetId }).catch(() => {});
  await sleep(1000);
  const two = await agent('Two');
  // It comes back on its next alarm (every 30 s), and the bridge with it.
  for (let i = 0; i < 50; i++) {
    r = await two.call('browser_list_profiles');
    if (!r.error) break;
    await sleep(1000);
  }
  check('the name survives the service worker restarting', !r.error && /"Work" \(id [a-f0-9-]{8}\): on/.test(r.text), r.text);
  await two.client.close();
} catch (error) {
  check('runs without throwing', false, error.stack);
} finally {
  await one?.client.close().catch(() => {});
  cdp?.close();
  await browser?.close();
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
