// The toolbar panel, in a throwaway Chrome for Testing profile (never your real Chrome): the name
// saved there reaches agents and shows in the toolbar icon's tooltip, the panel lists an agent's
// tabs, and its switch pauses and resumes every agent.

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

  // The service worker: the toolbar opens the panel, and the optional permissions are there.
  const { targetInfos } = await cdp.send('Target.getTargets');
  const worker = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${EXTENSION_ID}/`));
  check('the extension is running', Boolean(worker));
  const sw = await cdp.attach(worker.targetId);
  const popup = await cdp.evaluate(sw, `chrome.action.getPopup({})`);
  check('the toolbar icon opens the panel', popup.endsWith('/panel.html'), popup);
  const menus = await cdp.evaluate(sw, `chrome.runtime.getManifest().permissions.includes('contextMenus')`);
  check('no right-click menu permission', menus === false);
  const granted = await cdp.evaluate(sw, `chrome.permissions.contains({ permissions: ['identity', 'identity.email'] })`);
  check('the email permission is not granted up front', granted === false);

  // Name the profile in the panel, as the user would. "#name" opens it with the name field showing,
  // the way it opens as a window for the email.
  const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${EXTENSION_ID}/panel.html#name`, background: true });
  const page = await cdp.attach(targetId);
  for (let i = 0; i < 40 && !(await cdp.evaluate(page, `document.readyState === 'complete' && !document.getElementById('naming').hidden`).catch(() => false)); i++) await sleep(100);

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
  for (let i = 0; i < 40 && !(await cdp.evaluate(page, `document.readyState === 'complete' && !document.getElementById('naming').hidden`).catch(() => false)); i++) await sleep(100);
  const ready = await cdp.evaluate(page, `document.getElementById('headline').textContent`);
  check('the panel says agents are ready', ready === 'Agents are ready.', ready);
  await cdp.evaluate(page, `document.getElementById('name').value = '  Work  '; document.getElementById('naming').requestSubmit(); true`);
  await sleep(600);
  const saved = await cdp.evaluate(page, `document.getElementById('name-status').textContent`).catch(() => '(page closed)');
  check('the page says it saved', /Agents now see this profile as “Work”/.test(saved), saved);

  r = await one.call('browser_list_profiles');
  check('agents see the new name', !r.error && /"Work" \(id [a-f0-9-]{8}\): on/.test(r.text), r.text);
  const title = await cdp.evaluate(sw, `chrome.action.getTitle({})`);
  check('the toolbar tooltip names the profile', title === 'Tabhand is on in “Work”.', title);
  r = await one.call('browser_open_tab', { profile: 'work' });
  check('an agent can ask for it by name', !r.error && /^Tab \d+:/.test(r.text) && !/\(in /.test(r.text), r.text);

  // The panel, opened fresh: the agent and its tab, then the switch.
  const panel = await cdp.attach((await cdp.send('Target.createTarget', { url: `chrome-extension://${EXTENSION_ID}/panel.html`, background: true })).targetId);
  const read = () => cdp.evaluate(panel, `({ state: document.body.dataset.state, headline: document.getElementById('headline').textContent, chip: document.getElementById('chip').textContent, agents: [...document.querySelectorAll('.agent')].map((row) => row.innerText.replace(/\\s+/g, ' ').trim()), toggle: document.getElementById('toggle').textContent })`).catch(() => ({}));
  let seen = {};
  for (let i = 0; i < 30 && seen.state !== 'working'; i++) {
    await sleep(200);
    seen = await read();
  }
  check('the panel shows the agent working', seen.state === 'working' && seen.headline === 'Agents are working.' && seen.chip === 'Work', JSON.stringify(seen));
  check('with its name and tab', seen.agents?.length === 1 && /^One 1 tab/.test(seen.agents[0]), JSON.stringify(seen.agents));
  await cdp.evaluate(panel, `document.getElementById('toggle').click(); true`);
  for (let i = 0; i < 20 && seen.state !== 'paused'; i++) {
    await sleep(150);
    seen = await read();
  }
  check('its switch pauses every agent', seen.state === 'paused' && seen.toggle === 'Resume', JSON.stringify(seen));
  r = await one.call('browser_open_tab');
  check('and the agent hears how to resume', r.error && /press Resume/.test(r.text), r.text);
  check('the tooltip says it is paused', (await cdp.evaluate(sw, `chrome.action.getTitle({})`)) === 'Tabhand is paused in “Work”.');
  await cdp.evaluate(panel, `document.getElementById('toggle').click(); true`);
  for (let i = 0; i < 20 && seen.state === 'paused'; i++) {
    await sleep(150);
    seen = await read();
  }
  r = await one.call('browser_open_tab');
  check('Resume lets agents work again', seen.state === 'working' && !r.error, `${seen.state}; ${r.text}`);

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
