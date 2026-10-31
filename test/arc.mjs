// A bridge that Arc starts stays out of agents' way. Arc reads Chrome's helper folder, so adding the
// extension there connects it, but making a tab group and taking a screenshot never finish in Arc.
// The bridge stays connected (or the extension would start a new one every 30 seconds), runs no
// bridge and joins none, and says why in the log. macOS only; Arc is stood in for by bash, started
// under Arc's name, since the bridge goes by the command that started it.
//
//   node test/arc.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tabhand-arc-'));
const dataDir = path.join(work, 'data');
const logOf = () => {
  try {
    return fs.readFileSync(path.join(dataDir, 'host.log'), 'utf8');
  } catch {
    return '';
  }
};

// "; exit" keeps bash from replacing itself with node, so "Arc" stays the bridge's parent.
const browser = spawn('/bin/bash', ['-c', '"$0" "$1" host; exit 0', process.execPath, path.join(root, 'bin', 'tabhand.mjs')], {
  argv0: '/Applications/Arc.app/Contents/MacOS/Arc',
  env: { ...process.env, TABHAND_DATA_DIR: dataDir },
  stdio: ['pipe', 'ignore', 'ignore'],
});
browser.stdin.on('error', () => {});
const exited = new Promise((resolve) => browser.on('exit', resolve));

try {
  await sleep(2500);
  check('the bridge Arc starts stays connected', browser.exitCode === null);
  check('it runs no bridge for agents', !fs.existsSync(path.join(dataDir, 'bridge.sock')));
  check('the log says why', /started by Arc, which Tabhand doesn't support/.test(logOf()), logOf().trim().split('\n').at(-1));
  browser.stdin.end();
  check('it exits when Arc lets go', await Promise.race([exited.then(() => true), sleep(3000).then(() => false)]));
} catch (error) {
  check('runs without throwing', false, error.stack);
} finally {
  browser.kill('SIGKILL');
  fs.rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
