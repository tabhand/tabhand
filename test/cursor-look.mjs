// The cursor look, in a throwaway Chrome for Testing profile: a name and color set with
// `tabhand cursor` reach the agent's tab group and tab icon; the toolbar panel's own choice puts a
// look on every agent in the profile at once, tabs already open included, while the panel keeps
// naming each agent for what it is; and resetting gives each agent its own look back. Screenshots
// of a page with the cursor on it and of the panel go to /tmp/tabhand-cursor-look-*.png.
//
//   node test/cursor-look.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { browserDevTools, launchTestBrowser, sleep } from './harness.mjs';

/** Where the screenshots go: /tmp, or the temp folder on Windows. */
const shots = process.platform === 'win32' ? os.tmpdir() : '/tmp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_ID = 'hbfnkakpdogiidhdmhhcifeegekkoaep';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

// Each page reports the tab icon it carries, which holds the agent's arrow in its colors.
const icons = {};
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/report') {
    icons[url.searchParams.get('page')] = decodeURIComponent(url.searchParams.get('icon') ?? '');
    response.end();
    return;
  }
  const name = url.pathname.slice(1) || 'page';
  response.setHeader('content-type', 'text/html');
  response.end(`<!doctype html><title>${name}</title><link rel="icon" href="data:,">
    <body style="font: 18px/1.5 sans-serif; padding: 48px; background: #fbfaf7">
    <h1>Quarterly report</h1><p>Revenue, churn and the rest, for the cursor to sit on.</p>
    <script>setInterval(() => fetch('/report?page=${name}&icon=' + encodeURIComponent(document.querySelector('link[rel~="icon"]')?.href ?? '')), 250);</script>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

async function agent(label, theme) {
  const client = new Client({ name: 'tabhand-cursor-look', version: '0' });
  const args = [path.join(root, 'bin/tabhand.mjs'), 'mcp', '--label', label, ...(theme ? ['--theme', theme] : [])];
  await client.connect(new StdioClientTransport({ command: process.execPath, args, env: { ...process.env } }));
  const call = async (name, params = {}) => {
    const result = await client.callTool({ name, arguments: params });
    return { error: Boolean(result.isError), text: result.content.map((c) => c.text ?? '').join('\n') };
  };
  return { client, call };
}

let browser = null;
let cdp = null;
const agents = [];
try {
  browser = await launchTestBrowser({ args: ['--remote-debugging-port=0'] });
  check('extension connects to the bridge', browser.connected);
  cdp = await browserDevTools(browser.profile);
  const attach = async (targetId) => (await cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  const evaluate = async (session, expression) => {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  const { targetInfos } = await cdp.send('Target.getTargets');
  const sw = await attach(targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${EXTENSION_ID}/`)).targetId);
  const groups = async () =>
    Object.fromEntries((await evaluate(sw, `chrome.tabGroups.query({}).then((all) => all.map((g) => [g.title, g.color]))`)).sort());
  const until = async (test, tries = 30) => {
    let value;
    for (let i = 0; i < tries; i++) {
      value = await test();
      if (value.ok) break;
      await sleep(200);
    }
    return value;
  };

  // `tabhand cursor` on the computer: Alpha's session starts with it, Beta's after it's cleared.
  execFileSafe(['cursor', '--name', 'Acme', '--color', '#FF5A1F']);
  const alpha = await agent('Alpha');
  agents.push(alpha);
  let r = await alpha.call('browser_open_tab', { url: `${origin}/alpha` });
  check('Alpha opens a tab', !r.error, r.text);
  execFileSafe(['cursor', '--reset']);
  const beta = await agent('Beta', 'codex');
  agents.push(beta);
  r = await beta.call('browser_open_tab', { url: `${origin}/beta` });
  check('Beta opens a tab', !r.error, r.text);

  let seen = await until(async () => {
    const g = await groups();
    return { ok: g.Acme === 'orange' && g.Beta === 'blue' && /FF5A1F/i.test(icons.alpha ?? '') && /3D67DE/i.test(icons.beta ?? ''), g, icon: icons.alpha };
  });
  check('the machine-wide look names and colors the tab group', seen.g?.Acme === 'orange', JSON.stringify(seen.g));
  check('and colors the tab icon', /FF5A1F/i.test(seen.icon ?? ''));
  check('an agent without it keeps its own', seen.g?.Beta === 'blue' && /3D67DE/i.test(icons.beta ?? ''), JSON.stringify(seen.g));

  // A picture of the page with Alpha's cursor on it.
  const shoot = async (session, file) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, session);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  };
  const pageTarget = async (name) => (await cdp.send('Target.getTargets')).targetInfos.find((t) => t.type === 'page' && t.url === `${origin}/${name}`);
  const alphaTab = Number((await alpha.call('browser_list_tabs')).text.match(/^Tab (\d+)/)?.[1]);
  await alpha.call('browser_click', { tabId: alphaTab, text: 'Quarterly report' });
  await sleep(800);
  await shoot(await attach((await pageTarget('alpha')).targetId), path.join(shots, 'tabhand-cursor-look-machine.png'));

  // The panel's choice for this profile, made the way the user would.
  const panel = await attach((await cdp.send('Target.createTarget', { url: `chrome-extension://${EXTENSION_ID}/panel.html`, background: true })).targetId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 300, height: 560, deviceScaleFactor: 2, mobile: false }, panel);
  await until(async () => ({ ok: await evaluate(panel, `document.body.dataset.state === 'working'`).catch(() => false) }));
  // The gear opens the cursor view; "Custom", a name, a color and an icon.
  await shoot(panel, path.join(shots, 'tabhand-cursor-look-panel-main.png'));
  await evaluate(panel, `document.getElementById('settings').click(); true`);
  await sleep(200);
  await shoot(panel, path.join(shots, 'tabhand-cursor-look-panel-own.png'));
  await evaluate(panel, `(() => {
    document.querySelector('.seg [data-mode="custom"]').click();
    const name = document.getElementById('look-name');
    name.value = 'Brainforge';
    name.dispatchEvent(new Event('input'));
    document.querySelector('.swatch[data-color="#2563eb"]').click();
    document.querySelector('.icon[data-icon="initial"]').click();
    return true;
  })()`);
  await sleep(300);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 300, height: 600, deviceScaleFactor: 2, mobile: false }, panel);
  await shoot(panel, path.join(shots, 'tabhand-cursor-look-panel.png'));
  const tall = await evaluate(panel, `document.documentElement.scrollHeight`);
  check("the cursor view fits Chrome's popup, 600 px tall at most", tall <= 600, `${tall} px`);
  const preview = await evaluate(panel, `document.querySelector('#samples .tag span').textContent + ' ' + document.querySelector('#samples .tag text')?.textContent`);
  check('the panel previews the cursor, monogram included', preview === 'Brainforge B', preview);
  await evaluate(panel, `document.getElementById('look-save').click(); true`);

  seen = await until(async () => {
    const g = await groups();
    return { ok: g.Brainforge === 'blue' && Object.keys(g).length === 1 && /2563EB/i.test(icons.alpha ?? '') && /2563EB/i.test(icons.beta ?? ''), g };
  });
  check('the panel look goes on every agent at once', seen.ok, JSON.stringify(seen.g));
  const rows = await until(async () => {
    const names = await evaluate(panel, `[...document.querySelectorAll('.agent b')].map((b) => b.textContent).sort().join(',')`).catch(() => '');
    return { ok: names === 'Alpha,Beta', names };
  });
  check('the panel still names each agent for what it is', rows.ok, rows.names);
  await alpha.call('browser_click', { tabId: alphaTab, text: 'Revenue, churn and the rest, for the cursor to sit on.' });
  await sleep(800);
  await shoot(await attach((await pageTarget('alpha')).targetId), path.join(shots, 'tabhand-cursor-look-panel-choice.png'));

  // A new agent session in this profile wears it too.
  const gamma = await agent('Gamma', 'claude');
  agents.push(gamma);
  r = await gamma.call('browser_open_tab', { url: `${origin}/gamma` });
  seen = await until(async () => ({ ok: /2563EB/i.test(icons.gamma ?? ''), icon: icons.gamma }));
  check('a new agent wears it from its first tab', !r.error && seen.ok);

  // Back to each agent's own look.
  await until(async () => ({ ok: await evaluate(panel, `document.getElementById('customize').hidden`).catch(() => false) }));
  await evaluate(panel, `document.getElementById('settings').click(); document.querySelector('.seg [data-mode="own"]').click(); document.getElementById('look-save').click(); true`);
  seen = await until(async () => {
    const g = await groups();
    return { ok: g.Alpha === undefined && g.Beta === 'blue' && g.Gamma === 'orange' && /3D67DE/i.test(icons.beta ?? ''), g };
  });
  check('resetting gives each agent its own look back', seen.ok, JSON.stringify(seen.g));
  // Alpha started with the machine-wide look, which it keeps until it restarts.
  check('an agent started with the machine-wide look keeps it', seen.g?.Acme === 'orange', JSON.stringify(seen.g));
} catch (error) {
  check('runs without throwing', false, error.stack);
} finally {
  for (const each of agents) await each.client.close().catch(() => {});
  cdp?.close();
  await browser?.close();
  server.close();
}

/** Runs `tabhand <args>` the way a user would, in this test's own install. */
function execFileSafe(args) {
  execFileSync(process.execPath, [path.join(root, 'bin/tabhand.mjs'), ...args], { stdio: 'pipe', env: process.env });
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
