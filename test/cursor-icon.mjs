// An uploaded icon, in a throwaway Chrome for Testing profile (never your real Chrome): the panel's
// "+" tile opens the cursor view in a window of its own (Chrome closes a toolbar popup when a native
// file chooser opens), an SVG chosen there becomes icon data, Save puts it on every agent in the
// profile, and the agent's name tag on a real page draws it, one color or the file's own. A look
// stored with a hostile drawing, bypassing the panel, is cleaned before it can reach a page.
//
//   node test/cursor-icon.mjs
//   TABHAND_SHOTS=/some/folder node test/cursor-icon.mjs   (screenshots go to /tmp by default)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { browserDevTools, launchTestBrowser, sleep } from './harness.mjs';

/** Where the screenshots go: /tmp, the temp folder on Windows, or TABHAND_SHOTS. */
const shots = process.env.TABHAND_SHOTS ?? (process.platform === 'win32' ? os.tmpdir() : '/tmp');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_ID = 'hbfnkakpdogiidhdmhhcifeegekkoaep';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

// A made-up team logo: an orange triangle and a white disc, two shapes that read the same in one
// color and in their own, and wide enough that fitting it in the 16 by 16 tag takes a transform.
const LABEL = 'M5 20 L12 4 L19 20 Z';
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 24">
  <title>Acme</title>
  <path d="${LABEL}" fill="#FF5A1F"/>
  <circle cx="25" cy="15" r="5" fill="#FFFFFF"/>
</svg>`;
fs.mkdirSync(shots, { recursive: true });
const logoFile = path.join(os.tmpdir(), `tabhand-logo-${process.pid}.svg`);
fs.writeFileSync(logoFile, LOGO);
const scriptFile = path.join(os.tmpdir(), `tabhand-no-icon-${process.pid}.svg`);
fs.writeFileSync(scriptFile, '<svg viewBox="0 0 16 16"><script>alert(1)</script></svg>');

// The pages report whether the agent's cursor is on them, which needs no access to the extension.
const reports = {};
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/report') {
    reports[url.searchParams.get('page')] = { cursor: Number(url.searchParams.get('cursor')), at: Date.now() };
    response.end();
    return;
  }
  const name = url.pathname.slice(1) || 'page';
  response.setHeader('content-type', 'text/html');
  response.end(`<!doctype html><title>${name}</title><link rel="icon" href="data:,">
    <body style="font: 18px/1.5 -apple-system, BlinkMacSystemFont, sans-serif; padding: 48px; background: #fbfaf7; color: #16181a">
    <h1 style="margin:0 0 8px; letter-spacing:-0.02em">Quarterly report</h1>
    <p>Revenue, churn and the rest, for the cursor to sit on.</p>
    <p style="margin-top:180px"><a href="#">Renewals</a></p>
    <script>setInterval(() => fetch('/report?page=${name}&cursor=' + document.querySelectorAll('tabhand-cursor').length), 250);</script>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

async function agent(label) {
  const client = new Client({ name: 'tabhand-cursor-icon', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'bin/tabhand.mjs'), 'mcp', '--label', label], env: { ...process.env } }));
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
  const until = async (test, tries = 40) => {
    let value;
    for (let i = 0; i < tries; i++) {
      value = await test();
      if (value.ok) break;
      await sleep(200);
    }
    return value;
  };
  const { targetInfos } = await cdp.send('Target.getTargets');
  const worker = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${EXTENSION_ID}/`));
  const sw = await attach(worker.targetId);
  const shoot = async (session, file) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, session);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  };

  // ---------------------------------------------------------------- the toolbar panel
  const panel = await attach((await cdp.send('Target.createTarget', { url: `chrome-extension://${EXTENSION_ID}/panel.html`, background: true })).targetId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 300, height: 600, deviceScaleFactor: 2, mobile: false }, panel);
  await until(async () => ({ ok: await evaluate(panel, `document.body.dataset.state !== 'away' && !document.getElementById('headline').textContent.startsWith('One')`).catch(() => false) }));
  await evaluate(panel, `document.getElementById('settings').click(); document.querySelector('.seg [data-mode="custom"]').click(); true`);
  await evaluate(panel, `document.querySelector('.swatch[data-color="#1f2937"]').click(); true`);
  await evaluate(panel, `document.getElementById('look-name').value = 'Acme'; document.getElementById('look-name').dispatchEvent(new Event('input')); true`);
  await sleep(250);
  const tiles = await evaluate(panel, `({ count: document.querySelectorAll('#icons .icon').length, plus: Boolean(document.querySelector('#icons .icon.add')), checked: document.querySelector('#icons [aria-checked="true"]')?.dataset.icon })`);
  check('the icon picker ends with a plus tile', tiles.count === 12 && tiles.plus, JSON.stringify(tiles));
  const shotPanel = path.join(shots, 'tab53-1-panel-plus.png');
  await shoot(panel, shotPanel);
  console.log(`      panel with the plus tile: ${shotPanel}`);

  // The plus in the popup opens the cursor view as a window of its own, where a file chooser can't
  // take the page away.
  await evaluate(panel, `document.querySelector('#icons .icon.add').click(); true`);
  const opened = await until(async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const target = targetInfos.find((t) => t.type === 'page' && t.url.endsWith('/panel.html#cursor'));
    return { ok: Boolean(target), target };
  });
  check('the plus opens the cursor view in a window of its own', Boolean(opened.target), opened.target?.url ?? 'no window');

  const upload = await attach(opened.target.targetId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 300, height: 700, deviceScaleFactor: 2, mobile: false }, upload);
  const ready = await until(async () => ({
    ok: await evaluate(upload, `document.body.dataset.view === 'cursor' && Boolean(document.querySelector('#icons .icon.add'))`).catch(() => false),
  }));
  check('and it opens straight into the cursor view', ready.ok);
  const carried = await evaluate(upload, `document.getElementById('look-name').value`);
  check('carrying the look being tried in the popup', carried === 'Acme', carried);

  // As if the user had picked the file in the chooser.
  const { root: uploadDOM } = await cdp.send('DOM.getDocument', {}, upload);
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: uploadDOM.nodeId, selector: '#icon-file' }, upload);
  await cdp.send('DOM.setFileInputFiles', { files: [logoFile], nodeId }, upload);
  const loaded = await until(async () => ({
    ok: await evaluate(upload, `Boolean(document.querySelector('#icons .icon[data-icon="custom"]'))`).catch(() => false),
    status: await evaluate(upload, `document.getElementById('look-status').textContent`).catch(() => ''),
  }));
  check('the chosen SVG becomes the selected icon tile', loaded.ok, loaded.status);
  check('the panel says the file is in', /is in/.test(loaded.status ?? ''), loaded.status);

  const preview = () =>
    evaluate(
      upload,
      `(() => {
        const glyph = document.querySelector('#samples .tag svg.glyph');
        if (!glyph) return null;
        return {
          d: glyph.querySelector('path')?.getAttribute('d'),
          fills: [...glyph.querySelectorAll('*')].flatMap((el) => [el.getAttribute('fill'), el.getAttribute('stroke')]).filter((value) => value && value !== 'none'),
        };
      })()`,
    );
  const one = await preview();
  check('the preview draws the uploaded icon on the tag', one?.d === LABEL, JSON.stringify(one));
  check('in one color, taking the tag’s white or black', one?.fills.length > 0 && one.fills.every((value) => value === 'currentColor'), JSON.stringify(one?.fills));
  await evaluate(upload, `document.getElementById('look-name').value = 'Acme'; document.getElementById('look-name').dispatchEvent(new Event('input')); true`);
  await sleep(200);
  const shotOne = path.join(shots, 'tab53-2-preview-one-color.png');
  await shoot(upload, shotOne);
  console.log(`      preview in one color: ${shotOne}`);

  await evaluate(upload, `document.querySelector('#icon-options [data-colors="own"]').click(); true`);
  await sleep(200);
  const own = await preview();
  check('and in its own colors when asked', own?.fills.includes('#ff5a1f') && own?.fills.includes('#ffffff'), JSON.stringify(own?.fills));
  const shotOwn = path.join(shots, 'tab53-2-preview-own-colors.png');
  await shoot(upload, shotOwn);
  console.log(`      preview in its own colors: ${shotOwn}`);

  await evaluate(upload, `document.getElementById('look-save').click(); true`);
  const stored = await until(async () => {
    const look = await evaluate(sw, `chrome.storage.local.get('cursorLook').then((stored) => stored.cursorLook)`);
    return { ok: look?.icon === 'custom', look };
  });
  check('Save stores the drawing as data, not markup', stored.look?.icon === 'custom' && JSON.stringify(stored.look?.iconShape ?? []).includes(LABEL), JSON.stringify({ ...stored.look, iconShape: '…' }));
  check('with the colors the user chose', stored.look?.iconColors === 'own' && stored.look?.name === 'Acme', JSON.stringify({ ...stored.look, iconShape: '…' }));

  // The toolbar popup has to stay inside Chrome's 600 px, with the custom icon's extra choices.
  const popup = await attach((await cdp.send('Target.createTarget', { url: `chrome-extension://${EXTENSION_ID}/panel.html`, background: true })).targetId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 300, height: 600, deviceScaleFactor: 2, mobile: false }, popup);
  await until(async () => ({ ok: await evaluate(popup, `document.body.dataset.state !== 'away'`).catch(() => false) }));
  await evaluate(popup, `document.getElementById('settings').click(); true`);
  await sleep(300);
  const tall = await evaluate(popup, `Math.ceil(document.body.getBoundingClientRect().height)`);
  const shown = await evaluate(popup, `({ custom: document.querySelector('#icons .icon[data-icon="custom"]')?.getAttribute('aria-checked'), options: !document.getElementById('icon-options').hidden })`);
  check("the cursor view still fits Chrome's popup with an uploaded icon", tall <= 600, `${tall} px`);
  check('and shows the uploaded icon as the selected tile', shown.custom === 'true' && shown.options, JSON.stringify(shown));

  // ---------------------------------------------------------------- the tag on a page
  const alpha = await agent('Alpha');
  agents.push(alpha);
  let r = await alpha.call('browser_open_tab', { url: `${origin}/alpha` });
  check('Alpha opens a tab', !r.error, r.text);
  const alphaTab = Number((await alpha.call('browser_list_tabs')).text.match(/^Tab (\d+)/)?.[1]);
  await until(async () => ({ ok: reports.alpha?.cursor === 1 }));

  /** Every node the cursor's (closed) shadow root holds, as CDP sees it, and its icon on its own. */
  const tagNodes = async (session) => {
    const { root: pageDOM } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true }, session);
    const hosts = [];
    const walk = (node) => {
      if (!node) return;
      if (String(node.nodeName).toLowerCase() === 'tabhand-cursor') hosts.push(node);
      for (const child of node.children ?? []) walk(child);
      for (const shadow of node.shadowRoots ?? []) walk(shadow);
    };
    walk(pageDOM);
    const host = hosts.at(-1);
    if (!host) return { hosts: 0, names: [], paths: [], attributes: [], texts: [], glyphNames: [], glyphAttributes: [] };
    const collect = (node) => ({
      name: String(node.nodeName).toLowerCase(),
      attributes: node.attributes ?? [],
      text: node.nodeValue ?? '',
      children: (node.children ?? []).map(collect),
    });
    const flat = (node) => [node, ...node.children.flatMap(flat)];
    const pairs = (node) => Array.from({ length: node.attributes.length / 2 }, (_, i) => [node.attributes[i * 2], node.attributes[i * 2 + 1]]);
    const attribute = (node, key) => pairs(node).find(([name]) => name === key)?.[1] ?? null;
    const nodes = flat(collect(host.shadowRoots?.[0] ?? host));
    const glyph = nodes.find((node) => node.name === 'svg' && attribute(node, 'class') === 'glyph');
    const icon = glyph ? flat(glyph) : [];
    return {
      hosts: hosts.length,
      names: nodes.map((node) => node.name),
      attributes: nodes.flatMap(pairs),
      texts: nodes.map((node) => node.text).filter(Boolean),
      paths: icon.filter((node) => node.name === 'path').map((node) => attribute(node, 'd')).filter(Boolean),
      glyphNames: icon.map((node) => node.name),
      glyphAttributes: icon.flatMap(pairs),
    };
  };
  const pageTarget = async () => (await cdp.send('Target.getTargets')).targetInfos.find((t) => t.type === 'page' && t.url === `${origin}/alpha`);
  const page = await attach((await pageTarget()).targetId);
  const seen = await until(async () => {
    const nodes = await tagNodes(page);
    return { ok: nodes.paths?.includes(LABEL), nodes };
  });
  check('the name tag on the page draws the uploaded icon', Boolean(seen.ok), seen.nodes?.paths?.join(' '));
  check('and shows the name saved with it', seen.nodes?.texts?.includes('Acme'), JSON.stringify(seen.nodes?.texts?.slice(0, 4)));
  check('with no script, foreignObject or href anywhere in it', seen.nodes && !seen.nodes.names.some((name) => ['script', 'foreignobject', 'image', 'use', 'a', 'text', 'style'].includes(name)) && !seen.nodes.attributes.some(([key, value]) => /^on/i.test(key) || /javascript:/i.test(String(value))), JSON.stringify(seen.nodes?.names?.slice(0, 12)));
  check('and nothing in the icon points at a URL', seen.nodes && !seen.nodes.glyphAttributes.some(([key, value]) => /^on|href/i.test(key) || /javascript:|url\(/i.test(String(value))), JSON.stringify(seen.nodes?.glyphAttributes?.slice(0, 10)));

  await alpha.call('browser_click', { tabId: alphaTab, text: 'Renewals' });
  await sleep(700);
  const link = await evaluate(page, `(() => { const r = document.querySelector('a').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  const clip = { x: Math.max(0, link.x - 40), y: Math.max(0, link.y - 30), width: 260, height: 140, scale: 3 };
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip }, page);
  const shotPage = path.join(shots, 'tab53-3-tag-on-page.png');
  fs.writeFileSync(shotPage, Buffer.from(data, 'base64'));
  await shoot(page, path.join(shots, 'tab53-3-tag-on-page-full.png'));
  console.log(`      the cursor tag on a page: ${shotPage}`);

  // ---------------------------------------------------------------- a look that bypasses the panel
  const hostileShape = ['g', {}, [
    ['script', { src: 'https://evil.example/x.js' }],
    ['foreignObject', { width: '16', height: '16' }, [['div', {}, []]]],
    ['path', { d: 'M1 1 H15 V15 H1 Z', onclick: 'alert(1)', fill: 'url(#x)', 'xlink:href': 'javascript:alert(2)' }],
  ]];
  await evaluate(sw, `chrome.storage.local.set({ cursorLook: ${JSON.stringify({ name: 'Mallory', color: '#2563eb', icon: 'custom', iconShape: hostileShape, iconColors: 'own' })} }).then(() => true)`);
  const hostile = await until(async () => {
    const nodes = await tagNodes(page);
    return { ok: nodes.texts?.includes('Mallory'), nodes };
  });
  check('a look stored with a hostile drawing still reaches the page as a look', hostile.nodes?.texts?.includes('Mallory'), JSON.stringify(hostile.nodes?.texts?.slice(0, 4)));
  check('cleanLook dropped the drawing before the page saw it', hostile.nodes && !hostile.nodes.paths?.includes('M1 1 H15 V15 H1 Z'), JSON.stringify(hostile.nodes?.paths?.map((d) => d.slice(0, 24))));
  check('and none of it survived', hostile.nodes && !hostile.nodes.glyphNames.some((name) => ['script', 'foreignobject'].includes(name)) && !hostile.nodes.glyphAttributes.some(([key, value]) => /^on|href|xlink/i.test(key) || /javascript:|url\(/i.test(String(value))), JSON.stringify(hostile.nodes?.glyphNames?.slice(0, 12)));
  await evaluate(sw, `chrome.storage.local.remove('cursorLook').then(() => true)`);
  await sleep(400);

  // ---------------------------------------------------------------- the command line
  const cli = execFileSafe(['cursor', '--name', 'Acme', '--icon-file', logoFile, '--keep-colors']);
  check('the CLI takes the same file', /your own icon/.test(cli), cli.trim().split('\n')[0]);
  const settings = JSON.parse(fs.readFileSync(path.join(process.env.TABHAND_HOME, 'settings.json'), 'utf8'));
  check('and stores it in settings.json as the same data', settings.cursor?.icon === 'custom' && JSON.stringify(settings.cursor.iconShape).includes(LABEL) && settings.cursor.iconColors === 'own', JSON.stringify({ ...settings.cursor, iconShape: '…' }));

  const rejected = execFileSafe(['cursor', '--icon-file', scriptFile], true);
  check('a file with nothing drawable is refused with a clear message', rejected.status !== 0 && /nothing Tabhand can draw/.test(rejected.stderr), rejected.stderr.trim());
  check('and settings.json is left as it was', JSON.parse(fs.readFileSync(path.join(process.env.TABHAND_HOME, 'settings.json'), 'utf8')).cursor?.icon === 'custom');

  const gamma = await agent('Gamma');
  agents.push(gamma);
  r = await gamma.call('browser_open_tab', { url: `${origin}/gamma` });
  check('a new agent session wears the CLI icon', !r.error, r.text);
  const gammaTarget = (await cdp.send('Target.getTargets')).targetInfos.find((t) => t.type === 'page' && t.url === `${origin}/gamma`);
  const gammaPage = await attach(gammaTarget.targetId);
  const gammaSeen = await until(async () => {
    const nodes = await tagNodes(gammaPage);
    return { ok: nodes.paths?.includes(LABEL), nodes };
  });
  check('with the drawing from settings.json on its tag', Boolean(gammaSeen.ok), gammaSeen.nodes?.paths?.join(' '));
} catch (error) {
  check('runs without throwing', false, error.stack);
} finally {
  for (const each of agents) await each.client.close().catch(() => {});
  cdp?.close();
  await browser?.close();
  server.close();
}

/** Runs `tabhand <args>` the way a user would, in this test's own install. */
function execFileSafe(args, allowFailure = false) {
  try {
    return execFileSync(process.execPath, [path.join(root, 'bin/tabhand.mjs'), ...args], { encoding: 'utf8', stdio: 'pipe', env: process.env });
  } catch (error) {
    if (!allowFailure) throw error;
    return { status: error.status, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
