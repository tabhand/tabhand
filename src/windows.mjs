// Everything Tabhand does differently on Windows, in one place. The shared modules call into this
// only behind a WINDOWS check (from paths.mjs), so their macOS and Linux code stays as it was.
//
// On Windows:
// - Chrome finds the bridge through a registry key per browser, each pointing to one manifest.
// - Chrome starts the bridge through tabhand-host.cmd. Agents run node.exe with Tabhand's code
//   directly: they start programs without a shell, and Node can't start a .cmd that way.
// - Agents reach the bridge over a named pipe instead of a Unix socket (see paths.mjs).

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appPath, dataDir, HOST_NAME, hostLauncherPath, hostManifestPath, installDir, launcherPath, logPath, nativeHostKeys, nodePathFile } from './paths.mjs';

// ------------------------------------------------------------------ launchers

/** A value for a .cmd file's `set "NAME=value"`: % would start a variable there. */
const cmdValue = (value) => value.replaceAll('%', '%%');

/**
 * A path for a .cmd file. cmd.exe reads those in the console's code page, so a name outside it (a
 * user called José) would come out garbled; Windows keeps %LOCALAPPDATA% and %USERPROFILE% in
 * Unicode, so paths under them are written through them.
 */
function cmdPath(file) {
  for (const name of ['LOCALAPPDATA', 'USERPROFILE']) {
    const base = process.env[name];
    if (base && file.toLowerCase().startsWith(`${base.toLowerCase()}\\`)) return `%${name}%${cmdValue(file.slice(base.length))}`;
  }
  return cmdValue(file);
}

/**
 * tabhand.cmd, for you (and anything else that runs commands), and tabhand-host.cmd, which Chrome
 * runs through cmd.exe. Like the shell launchers on macOS, they pin the Node.js that ran setup and
 * drop Node settings meant for other tools. Chrome talks to the bridge over stdout, so nothing
 * here may print there.
 */
export function writeLaunchers() {
  fs.writeFileSync(nodePathFile(), `${process.execPath}\n`);
  const start = (args) =>
    [
      '@echo off',
      'rem Starts Tabhand. Written by `tabhand setup`; run that again to update it.',
      'setlocal',
      'set "NODE_OPTIONS="',
      'set "NODE_PATH="',
      `set "TABHAND_HOME=${cmdPath(installDir())}"`,
      `set "TABHAND_DATA_DIR=${cmdPath(dataDir())}"`,
      `set "TABHAND_NODE=${cmdPath(process.execPath)}"`,
      'rem If that Node.js has been removed since, use the one on PATH.',
      'if not exist "%TABHAND_NODE%" set "TABHAND_NODE=node"',
      `"%TABHAND_NODE%" "${cmdPath(appPath())}" ${args}`,
      '',
    ].join('\r\n');
  fs.writeFileSync(launcherPath(), start('%*'));
  fs.mkdirSync(dataDir(), { recursive: true });
  // cmd.exe keeps a file it sends output to open in a way that stops the bridge writing its own
  // lines there, so startup errors go to a file of their own.
  const log = cmdPath(logPath());
  const errors = cmdPath(path.join(dataDir(), 'host-errors.log'));
  fs.writeFileSync(
    hostLauncherPath(),
    start(`host %* 2>>"${errors}"`).replace('setlocal\r\n', `setlocal\r\n>>"${log}" echo %DATE% %TIME% [wrapper] started by the browser\r\n`),
  );
}

/** The Node.js that ran setup, which agents start Tabhand with. */
function nodePath() {
  try {
    return fs.readFileSync(nodePathFile(), 'utf8').trim() || process.execPath;
  } catch {
    return process.execPath;
  }
}

// ------------------------------------------------------------------ registry

/** Runs reg.exe; true when it succeeds. */
function reg(args) {
  try {
    execFileSync('reg.exe', args, { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
const hostKey = (browser) => `${nativeHostKeys()[browser]}\\${HOST_NAME}`;
/** A registry key as people read it: HKEY_CURRENT_USER\... */
const longKey = (key) => key.replace(/^HKCU\\/, 'HKEY_CURRENT_USER\\');
const registered = (browser) => reg(['query', hostKey(browser), '/ve']);

/**
 * Writes the bridge's manifest and points each browser's registry key at it. Windows browsers
 * find hosts in the registry only, so a test profile (userDataDir) needs the manifest alone.
 * @returns {string[]} the registry keys written
 */
export function register(browsers, manifest, { userDataDir } = {}) {
  fs.mkdirSync(path.dirname(hostManifestPath()), { recursive: true });
  fs.writeFileSync(hostManifestPath(), JSON.stringify(manifest, null, 2) + '\n');
  if (userDataDir) return [];
  const keys = nativeHostKeys();
  const written = [];
  for (const one of [browsers].flat()) {
    if (!keys[one]) throw new Error(`Unknown browser "${one}". Use one of: ${Object.keys(keys).join(', ')}`);
    if (!reg(['add', hostKey(one), '/ve', '/t', 'REG_SZ', '/d', hostManifestPath(), '/f'])) throw new Error(`Couldn't register Tabhand with ${one} in the registry.`);
    written.push(longKey(hostKey(one)));
  }
  return written;
}

/** Takes the bridge out of every browser's registry key. @returns {string[]} the keys removed */
export function unregisterAll() {
  return Object.keys(nativeHostKeys())
    .filter((browser) => registered(browser) && reg(['delete', hostKey(browser), '/f']))
    .map((browser) => longKey(hostKey(browser)));
}

/** The browsers whose registry key points at a bridge. Chrome for Testing shares Chromium's key, so it's listed as Chromium. */
export const registeredBrowsers = () => Object.keys(nativeHostKeys()).filter((browser) => browser !== 'chrome-for-testing' && registered(browser));

/** The browsers Tabhand can register with on Windows. */
export const browsers = () => Object.keys(nativeHostKeys());

// ------------------------------------------------------------------ agents

/** The program a command runs, from PATH, with its extension (claude.exe, codex.cmd), or null. */
export function which(command) {
  try {
    const out = execFileSync('where.exe', [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    // where.exe also lists extensionless files (npm's shell scripts) that Windows can't run.
    return (
      out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((file) => /\.(exe|cmd|bat|com)$/i.test(file)) ?? null
    );
  } catch {
    return null;
  }
}

/** cmd.exe's quoting for one argument (Windows paths can't hold a double quote). */
const cmdQuote = (arg) => (/^[\w\-.:\\/=@]+$/.test(arg) ? arg : `"${arg.replaceAll('"', '""')}"`);

/** Runs an agent's CLI. npm installs CLIs on Windows as .cmd files, which only cmd.exe can run. */
export function runCli(command, args) {
  const program = which(command) ?? command;
  if (/\.(cmd|bat)$/i.test(program)) {
    const line = [program, ...args].map(cmdQuote).join(' ');
    execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { stdio: 'pipe', timeout: 60_000, windowsHide: true, windowsVerbatimArguments: true });
    return;
  }
  execFileSync(program, args, { stdio: 'pipe', timeout: 60_000, windowsHide: true });
}

/** Where apps keep their settings on Windows: Roaming AppData. */
export const appData = (...parts) => path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), ...parts);

/** Where each app's Windows installer puts it, by its macOS name. */
const APPS = {
  Cursor: ['cursor'],
  'Visual Studio Code': ['Microsoft VS Code'],
  Claude: ['AnthropicClaude'],
};

/** Whether an agent app is installed: per user first, then for everyone. */
export function hasApp(name) {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return (APPS[name] ?? [name]).some((folder) =>
    [path.join(local, 'Programs', folder), path.join(local, folder), path.join(process.env.ProgramFiles || 'C:\\Program Files', folder)].some((dir) => fs.existsSync(dir)),
  );
}

/** What an agent runs: setup's Node.js with Tabhand's code, and flags naming the agent. */
export const serverFor = (harness) => ({ command: nodePath(), args: [appPath(), 'mcp', '--label', harness.label, '--theme', harness.theme] });

/** Windows paths match whatever their case or slashes; agents' CLIs may write them either way. */
const samePath = (a, b) => path.win32.normalize(String(a)).toLowerCase() === path.win32.normalize(String(b)).toLowerCase();

/** Whether a configured server is serverFor's: the paths compared as Windows paths, the flags exactly. */
export function sameServer(a, b) {
  if (!a || !samePath(a.command, b.command) || (a.args ?? []).length !== b.args.length) return false;
  return samePath(a.args[0], b.args[0]) && b.args.slice(1).every((arg, index) => a.args[index + 1] === arg);
}

// ------------------------------------------------------------------ setup: browsers, clipboard

/** Where each browser's Windows installer puts it, under Program Files or the user's own AppData. */
const BROWSERS = {
  chrome: 'Google\\Chrome\\Application\\chrome.exe',
  chromium: 'Chromium\\Application\\chrome.exe',
  brave: 'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  edge: 'Microsoft\\Edge\\Application\\msedge.exe',
};

/** A browser's program, or null. */
export function browserProgram(browser) {
  if (!BROWSERS[browser]) return null;
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
  return roots.map((root) => path.join(root, BROWSERS[browser])).find((file) => fs.existsSync(file)) ?? null;
}

/** Opens a page in a browser by its program. Tests set TABHAND_NO_OPEN: they must never open your browser. */
export function openInBrowser(browser, url) {
  if (process.env.TABHAND_NO_OPEN) return;
  const program = browserProgram(browser);
  if (program) spawn(program, [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

export function copyToClipboard(text) {
  try {
    execFileSync('clip.exe', { input: text, windowsHide: true });
  } catch {}
}

/** How to get to a folder in Windows' folder picker. */
export const PICK_FOLDER = 'paste this folder into the address bar at the top';

// ------------------------------------------------------------------ MCP server: who started it

/** A command line's words, quotes taken off. */
const words = (line) => [...String(line).matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);

/** Our parents' program names, from their paths and command lines: no `ps` here, so ask CIM, once. */
export function launcherNames(depth, interpreters) {
  const script = `$p = ${process.ppid}; for ($i = 0; $i -lt ${depth} -and $p -gt 4; $i++) { $x = Get-CimInstance Win32_Process -Filter "ProcessId=$p"; if (-not $x) { break }; [string]$x.ExecutablePath + [char]9 + [string]$x.CommandLine; $p = $x.ParentProcessId }`;
  const names = [];
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    for (const line of out.split(/\r?\n/).filter(Boolean)) {
      const [exe, commandLine] = line.split('\t');
      const program = path.win32.basename(exe || words(commandLine)[0] || '').replace(/\.exe$/i, '');
      names.push(program);
      const second = words(commandLine)[1];
      if (second && interpreters.test(program)) names.push(path.win32.basename(second), path.win32.basename(path.win32.dirname(second)));
    }
  } catch {}
  return names;
}

// ------------------------------------------------------------------ config backups

/** One flat file name for a config file's backup: C:\Users\me\.codex\config.toml → Users__me__.codex__config.toml */
export const backupName = (file) => file.replace(/^[A-Za-z]:/, '').replace(/^[/\\]+/, '').replace(/[/\\]+/g, '__');
