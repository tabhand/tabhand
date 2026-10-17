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
