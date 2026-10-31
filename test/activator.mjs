// The window helper: an osascript the bridge starts on macOS to hand the front back to the app the
// user was in. It has to go away with its bridge, however the bridge goes. From 0.8.0 to 0.11.0 it
// missed the end of its input and kept a CPU core busy once its bridge was gone, so the bridge also
// stops helpers an older Tabhand left running, and nothing else. macOS only; no browser needed.
//
//   node test/activator.mjs

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVATOR, LEAKY_ACTIVATOR } from '../src/host.mjs';

if (process.platform !== 'darwin') {
  console.log('macOS only; skipped');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Waits up to `ms` for a process to be gone. */
async function goneWithin(pid, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(50);
  }
  return !alive(pid);
}
/** The osascript children of a process. */
function helpersOf(pid) {
  try {
    return execFileSync('pgrep', ['-P', String(pid), 'osascript'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
}
async function helperOf(pid, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const [helper] = helpersOf(pid);
    if (helper) return helper;
    await sleep(50);
  }
  return null;
}
const ppidOf = (pid) => {
  try {
    return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
  } catch {
    return null;
  }
};

/** Starts a bridge in a throwaway data folder, the way the browser does, with its input left open. */
function startBridge() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabhand-activator-'));
  const host = spawn(process.execPath, [path.join(root, 'bin', 'tabhand.mjs'), 'host'], {
    env: { ...process.env, TABHAND_DATA_DIR: dataDir },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  host.stdin.on('error', () => {});
  return { host, dataDir };
}
const logOf = (dataDir) => {
  try {
    return fs.readFileSync(path.join(dataDir, 'host.log'), 'utf8');
  } catch {
    return '';
  }
};

const cleanup = [];
try {
  // The helper on its own.
  {
    const helper = spawn('osascript', ['-l', 'JavaScript', '-e', ACTIVATOR], { stdio: ['pipe', 'ignore', 'ignore'] });
    cleanup.push(() => helper.kill('SIGKILL'));
    helper.stdin.write('99999999\n');
    await sleep(800);
    check('the helper keeps running while its input is open, after a line', alive(helper.pid));
    helper.stdin.end();
    check('and exits at the end of its input', await goneWithin(helper.pid, 3000));
  }

  // A bridge killed outright (no chance to clean up): the end of input is all the helper gets.
  {
    const { host } = startBridge();
    cleanup.push(() => host.kill('SIGKILL'));
    const helper = await helperOf(host.pid, 5000);
    check('the bridge starts its helper', Boolean(helper));
    host.kill('SIGKILL');
    check('a bridge killed outright leaves no helper running', helper && (await goneWithin(helper, 3000)));
    if (helper && alive(helper)) process.kill(helper, 'SIGKILL');
  }

  // A bridge whose browser goes away: its input closes and it stops.
  {
    const { host } = startBridge();
    cleanup.push(() => host.kill('SIGKILL'));
    const helper = await helperOf(host.pid, 5000);
    host.stdin.end();
    check('a bridge that stops takes its helper with it', helper && (await goneWithin(host.pid, 3000)) && (await goneWithin(helper, 3000)));
    if (helper && alive(helper)) process.kill(helper, 'SIGKILL');
  }

  // A helper an older Tabhand left behind: launchd adopted it, and it spins. Another one that an
  // older bridge still runs (its parent is alive) must be left alone, and so must an osascript
  // running anything else.
  {
    const orphan = Number(
      execFileSync('/bin/sh', ['-c', 'osascript -l JavaScript -e "$1" </dev/null >/dev/null 2>&1 & echo $!', 'sh', LEAKY_ACTIVATOR], { encoding: 'utf8' }).trim(),
    );
    cleanup.push(() => alive(orphan) && process.kill(orphan, 'SIGKILL'));
    const owned = spawn('osascript', ['-l', 'JavaScript', '-e', LEAKY_ACTIVATOR], { stdio: ['pipe', 'ignore', 'ignore'] });
    cleanup.push(() => owned.kill('SIGKILL'));
    const other = Number(
      execFileSync('/bin/sh', ['-c', 'osascript -l JavaScript -e "$1" </dev/null >/dev/null 2>&1 & echo $!', 'sh', 'delay(30)'], { encoding: 'utf8' }).trim(),
    );
    cleanup.push(() => alive(other) && process.kill(other, 'SIGKILL'));
    await sleep(300);
    check('a leftover helper is adopted by launchd', ppidOf(orphan) === 1, String(ppidOf(orphan)));

    const { host, dataDir } = startBridge();
    cleanup.push(() => host.kill('SIGKILL'));
    check('a new bridge stops the leftover helper', await goneWithin(orphan, 5000));
    await sleep(500);
    check('it leaves a helper whose bridge is still running alone', alive(owned.pid));
    check('it leaves other osascripts alone', alive(other));
    check('the log says so', /stopped 1 window helper an older Tabhand left running/.test(logOf(dataDir)), logOf(dataDir).trim().split('\n').slice(-3).join(' | '));
    for (const helper of helpersOf(host.pid)) cleanup.push(() => alive(helper) && process.kill(helper, 'SIGKILL'));
    host.kill('SIGKILL');
  }
} catch (error) {
  check('runs without throwing', false, error.stack);
} finally {
  for (const undo of cleanup) {
    try {
      undo();
    } catch {}
  }
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
