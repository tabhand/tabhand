// Shared test setup: a throwaway Chrome for Testing profile wired to its own bridge, so tests
// never involve a real install or your own Chrome.
//
//   TABHAND_TEST_BROWSER="/path/to/Google Chrome for Testing.app" node test/e2e.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extensionDir, install, status } from '../src/install.mjs';
import { HOST_NAME, nativeHostDirs } from '../src/paths.mjs';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Agents a test starts are its own, not part of a conversation that may be running the test (an
// MCP server would otherwise take Claude Code's conversation id from the environment).
delete process.env.CLAUDE_CODE_SESSION_ID;

/** Name of the app in front on macOS. */
export function frontmostApp() {
  try {
    const asn = execFileSync('lsappinfo', ['front'], { encoding: 'utf8' }).trim();
    const info = execFileSync('lsappinfo', ['info', asn], { encoding: 'utf8' });
    return /^\s*"([^"]*)"/.exec(info)?.[1] ?? '?';
  } catch {
    return '?';
  }
}

/**
 * A DevTools connection to the whole test browser, for doing what the user would (opening a tab of
 * their own), or for looking inside the extension (send takes a target's sessionId). The browser
 * has to be started with --remote-debugging-port=0.
 */
export async function browserDevTools(profile) {
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 50 && !fs.existsSync(portFile); i++) await sleep(100);
  const [port, socketPath] = fs.readFileSync(portFile, 'utf8').split('\n');
  const socket = new WebSocket(`ws://127.0.0.1:${port}${socketPath}`);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let nextId = 0;
  const waiting = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const settle = waiting.get(message.id);
    if (!settle) return;
    waiting.delete(message.id);
    if (message.error) settle.reject(new Error(message.error.message));
    else settle.resolve(message.result);
  };
  return {
    send: (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        waiting.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      }),
    close: () => socket.close(),
  };
}

/** Starts a throwaway browser running Tabhand, plus any other unpacked extensions given. */
export async function launchTestBrowser({ extensions = [], args = [] } = {}) {
  const browserApp =
    process.env.TABHAND_TEST_BROWSER ??
    path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app');
  // Child processes (MCP servers, the host) inherit these, so the whole run uses its own install
  // and bridge.
  process.env.TABHAND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tabhand-test-data-'));
  process.env.TABHAND_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tabhand-test-home-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tabhand-test-profile-'));
  await install({ userDataDir: profile });
  await install({ browser: 'chrome-for-testing' });
  execFileSync('open', [
    '-g', '-n', '-a', browserApp, '--args',
    `--user-data-dir=${profile}`,
    `--load-extension=${[extensionDir, ...extensions].join(',')}`,
    `--disable-extensions-except=${[extensionDir, ...extensions].join(',')}`,
    '--no-first-run', '--no-default-browser-check', ...args, 'about:blank',
  ]);
  for (let i = 0; i < 60 && !(await status()).connected; i++) await sleep(500);
  const connected = (await status()).connected;

  return {
    connected,
    profile,
    async close() {
      try {
        const pids = execFileSync('pgrep', ['-f', `user-data-dir=${profile}`], { encoding: 'utf8' }).trim().split('\n');
        for (const pid of pids) {
          try {
            process.kill(Number(pid));
          } catch {}
        }
      } catch {}
      await sleep(1000);
      // Remove only what this run registered; a real install for Chrome stays untouched.
      fs.rmSync(path.join(nativeHostDirs()['chrome-for-testing'], `${HOST_NAME}.json`), { force: true });
      fs.rmSync(profile, { recursive: true, force: true });
      fs.rmSync(process.env.TABHAND_DATA_DIR, { recursive: true, force: true });
      fs.rmSync(process.env.TABHAND_HOME, { recursive: true, force: true });
    },
  };
}
