// Shared test setup: a throwaway Chrome for Testing profile wired to its own bridge, so tests
// never involve a real install or your own Chrome.
//
//   TABHAND_TEST_BROWSER="/path/to/Google Chrome for Testing.app" node test/e2e.mjs
//   On Windows: TABHAND_TEST_BROWSER=C:\path\to\chrome-win64\chrome.exe (see the Windows section below)

import { execFileSync, spawn } from 'node:child_process';
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
  if (process.platform === 'win32') return windowsFrontmostApp();
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
  if (process.platform === 'win32') return launchWindowsTestBrowser({ extensions, args });
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

// ------------------------------------------------------------------ Windows only

/**
 * Which program's window is in front: one PowerShell reports the product name ("Google Chrome
 * for Testing", say) ten times a second, and this hands back the latest.
 */
let windowsFront = null;
function windowsFrontmostApp() {
  if (!windowsFront) {
    windowsFront = { latest: '?' };
    const script = [
      'Add-Type -Namespace Tabhand -Name Front -MemberDefinition \'[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);\'',
      // No window in front (as in an SSH session) reads as "?", like an unknown app on macOS.
      'while ($true) { $id = 0; [void][Tabhand.Front]::GetWindowThreadProcessId([Tabhand.Front]::GetForegroundWindow(), [ref]$id); $p = if ($id) { Get-Process -Id $id -ErrorAction SilentlyContinue }; [Console]::Out.WriteLine($(if ($p.Product) { $p.Product } elseif ($p) { $p.ProcessName } else { "?" })); [Console]::Out.Flush(); Start-Sleep -Milliseconds 100 }',
    ].join('; ');
    const sampler = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    sampler.stdout.setEncoding('utf8');
    sampler.stdout.on('data', (data) => {
      const lines = data.split(/\r?\n/).filter(Boolean);
      if (lines.length) windowsFront.latest = lines.at(-1);
    });
    sampler.on('error', () => {});
    sampler.unref();
    sampler.stdout.unref?.();
    process.on('exit', () => sampler.kill());
  }
  return windowsFront.latest;
}

// Start sampling as the harness loads, so tests get real answers from their first look.
if (process.platform === 'win32') windowsFrontmostApp();

/** The registry key Chrome for Testing finds the bridge by on Windows: Chromium's. */
const CFT_KEY = 'HKCU\\Software\\Chromium\\NativeMessagingHosts\\dev.tabhand.bridge';
function registryValue(key) {
  try {
    return /REG_SZ\s+(.+)$/m.exec(execFileSync('reg.exe', ['query', key, '/ve'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * launchTestBrowser on Windows. Chrome for Testing runs emulated on Windows on Arm, so it gets a
 * minute to connect; TABHAND_TEST_BROWSER_ARGS adds switches (--disable-gpu, say). Its registry key
 * is Chromium's, so whatever was there is put back afterwards.
 */
async function launchWindowsTestBrowser({ extensions = [], args = [] } = {}) {
  const browserApp = process.env.TABHAND_TEST_BROWSER;
  if (!browserApp) throw new Error("Set TABHAND_TEST_BROWSER to Chrome for Testing's chrome.exe");
  process.env.TABHAND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tabhand-test-data-'));
  process.env.TABHAND_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tabhand-test-home-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tabhand-test-profile-'));
  const before = registryValue(CFT_KEY);
  await install({ userDataDir: profile });
  await install({ browser: 'chrome-for-testing' });
  const browser = spawn(
    browserApp,
    [
      `--user-data-dir=${profile}`,
      `--load-extension=${[extensionDir, ...extensions].join(',')}`,
      `--disable-extensions-except=${[extensionDir, ...extensions].join(',')}`,
      // Wide enough for desktop layouts: Wikipedia folds its search box away in narrow windows.
      '--window-size=1400,1000',
      '--no-first-run', '--no-default-browser-check', ...args,
      ...(process.env.TABHAND_TEST_BROWSER_ARGS?.split(/\s+/).filter(Boolean) ?? []),
      'about:blank',
    ],
    { detached: true, stdio: 'ignore' },
  );
  browser.on('error', () => {});
  browser.unref();
  for (let i = 0; i < 120 && !(await status()).connected; i++) await sleep(500);
  const connected = (await status()).connected;

  return {
    connected,
    profile,
    async close() {
      // The browser and everything it started: its helpers, and the bridge through cmd.exe.
      try {
        execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(browser.pid)], { stdio: 'ignore' });
      } catch {}
      await sleep(1000);
      if (before) execFileSync('reg.exe', ['add', CFT_KEY, '/ve', '/t', 'REG_SZ', '/d', before, '/f'], { stdio: 'ignore' });
      else execFileSync('reg.exe', ['delete', CFT_KEY, '/f'], { stdio: 'ignore' });
      // Windows can hold a file a moment after its process ends.
      for (const dir of [profile, process.env.TABHAND_DATA_DIR, process.env.TABHAND_HOME]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    },
  };
}
