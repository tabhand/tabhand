// Chrome's "started debugging this browser" bar belongs to all of Chrome, not one profile: when it
// goes away Chrome detaches with canceled_by_user, which used to pause that whole profile. This
// opens two profiles in one Chrome (the user's Work and Personal) and works across them in one
// agent session: a tab in the first profile, then a tab in the second, which must stay on and keep
// working.
//
// Chrome for Testing does not take the bar away on its own here, so this covers the real two-profile
// case end to end; test/cancel.mjs closes the bar itself and checks what a close must leave behind.
//
//   node test/debugger-bar.mjs

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { extensionDir, install, status } from '../src/install.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WINDOWS = process.platform === 'win32';
const browserApp =
  process.env.TABHAND_TEST_BROWSER ??
  path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app');
if (WINDOWS && !process.env.TABHAND_TEST_BROWSER) throw new Error("Set TABHAND_TEST_BROWSER to Chrome for Testing's chrome.exe");
// The agents here are this test's own, not part of a conversation that may be running the test.
delete process.env.CLAUDE_CODE_SESSION_ID;
process.env.TABHAND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tabhand-bar-data-'));
process.env.TABHAND_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tabhand-bar-home-'));
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabhand-bar-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

// On Windows Chrome finds the bridge in the registry, not in the user data folder.
const CFT_KEY = 'HKCU\\Software\\Chromium\\NativeMessagingHosts\\dev.tabhand.bridge';
const registryValue = () => {
  try {
    return /REG_SZ\s+(.+)$/m.exec(execFileSync('reg.exe', ['query', CFT_KEY, '/ve'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
};
const before = WINDOWS ? registryValue() : null;

const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  const where = request.url.includes('personal') ? 'Personal' : 'Work';
  response.end(`<!doctype html><title>${where}</title><h1>Hello from ${where}</h1>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

/** Starts Chrome, or asks the running one for a window: each call is a fresh process. */
const launched = [];
function launch(profile, extra = []) {
  const args = [`--user-data-dir=${userDataDir}`, `--profile-directory=${profile}`, '--no-first-run', '--no-default-browser-check', ...extra, 'about:blank'];
  if (WINDOWS) {
    const browser = spawn(browserApp, args, { detached: true, stdio: 'ignore', windowsHide: true });
    browser.on('error', () => {});
    browser.unref();
    launched.push(browser.pid);
  } else {
    execFileSync('open', ['-g', '-n', '-a', browserApp, '--args', ...args]);
  }
}
function closeBrowsers() {
  if (WINDOWS) {
    for (const pid of launched.splice(0)) {
      try {
        execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
      } catch {}
    }
    return;
  }
  try {
    for (const pid of execFileSync('pgrep', ['-f', `user-data-dir=${userDataDir}`], { encoding: 'utf8' }).trim().split('\n')) {
      try {
        process.kill(Number(pid));
      } catch {}
    }
  } catch {}
}

/** Waits until the profile's Tabhand is on the bridge. */
async function connected() {
  for (let i = 0; i < 120 && !(await status()).connected; i++) await sleep(500);
  return (await status()).connected;
}

/** Waits until the bridge is gone, so the next profile starts its own. */
async function stopped() {
  for (let i = 0; i < 40 && (await status()).connected; i++) await sleep(250);
}

async function agent(label) {
  const client = new Client({ name: 'tabhand-debugger-bar', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'bin/tabhand.mjs'), 'mcp', '--label', label], env: { ...process.env } }));
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { error: Boolean(result.isError), text: result.content.map((c) => c.text ?? '').join('\n') };
  };
  return { client, call };
}

let one = null;
try {
  await install({ userDataDir });
  if (WINDOWS) await install({ browser: 'chrome-for-testing' });

  // A command line extension reaches the profile Chrome starts with, and stays installed there. Get
  // it into the second profile first, then run the first one, which serves the bridge.
  launch('Profile 1', [`--load-extension=${extensionDir}`, `--disable-extensions-except=${extensionDir}`]);
  check('profile B connects', await connected());
  closeBrowsers();
  await stopped();

  launch('Default', [`--load-extension=${extensionDir}`, `--disable-extensions-except=${extensionDir}`]);
  check('profile A connects', await connected());
  // The second profile's window: it stands by, and its tabs are reachable through profile A.
  launch('Profile 1', ['--new-window']);
  await sleep(1000);

  one = await agent('One');
  let r = await one.call('browser_list_profiles');
  for (let i = 0; i < 60 && (r.text.match(/id [a-f0-9]{8}/g) ?? []).length !== 2; i++) {
    await sleep(500);
    r = await one.call('browser_list_profiles');
  }
  const ids = [...r.text.matchAll(/id ([a-f0-9]{8})/g)].map((match) => match[1]);
  const a = /id ([a-f0-9]{8})[^\n]*Your new tabs open here/.exec(r.text)?.[1];
  const b = ids.find((id) => id !== a);
  check('both profiles are on, work in A and Personal in B', ids.length === 2 && Boolean(a) && Boolean(b), r.text);

  r = await one.call('browser_open_tab', { url: `${base}/work` });
  const tabA = Number(/^Tab (\d+):/m.exec(r.text)?.[1]);
  check('a tab opens in profile A', !r.error && Boolean(tabA) && new RegExp(`^Tab ${tabA}: Work`).test(r.text), r.text);
  r = await one.call('browser_snapshot', { tabId: tabA });
  check('and its page reads', /Hello from Work/.test(r.text), r.text.split('\n')[0]);

  // The bug: while A's tab is live, the session opens a tab in B, and B must not be paused by it.
  r = await one.call('browser_open_tab', { url: `${base}/personal`, profile: b });
  const tabB = Number(/^Tab (\d+):/m.exec(r.text)?.[1]);
  check('the same session opens a tab in profile B', !r.error && Boolean(tabB) && new RegExp(`\\(in the unnamed profile ${b}\\)`).test(r.text), r.text);
  r = await one.call('browser_list_profiles');
  check('profile B is still on, not paused', new RegExp(`id ${b}\\): on\\b`).test(r.text) && !/paused/.test(r.text), r.text);
  r = await one.call('browser_snapshot', { tabId: tabB });
  check("and the next step in profile B's tab works", !r.error && /Hello from Personal/.test(r.text), r.text.split('\n')[0]);
  r = await one.call('browser_list_tabs');
  check('profile B is where the tab lives', new RegExp(`Tab ${tabB}: Personal[^\n]*\\(in the unnamed profile ${b}\\)`).test(r.text), r.text);
  r = await one.call('browser_snapshot', { tabId: tabA });
  check('profile A still works too', !r.error && /Hello from Work/.test(r.text), r.text.split('\n')[0]);
} catch (error) {
  check('runs without throwing', false, error.stack);
} finally {
  await one?.client.close().catch(() => {});
  closeBrowsers();
  server.close();
  await sleep(1000);
  if (WINDOWS) {
    if (before) execFileSync('reg.exe', ['add', CFT_KEY, '/ve', '/t', 'REG_SZ', '/d', before, '/f'], { stdio: 'ignore' });
    else execFileSync('reg.exe', ['delete', CFT_KEY, '/f'], { stdio: 'ignore' });
  }
  for (const dir of [userDataDir, process.env.TABHAND_DATA_DIR, process.env.TABHAND_HOME]) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
