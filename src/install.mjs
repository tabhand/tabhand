// Installs Tabhand's own copy (see installDir) and registers its bridge with Chrome, so the
// extension can start it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOST_NAME,
  STORE_EXTENSION_ID,
  appPath,
  dataDir,
  hostLauncherPath,
  installDir,
  installedExtensionDir,
  launcherPath,
  logPath,
  nativeHostDirs,
  socketPath,
} from './paths.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const extensionDir = path.join(root, 'extension');
/** Running from a clone of the repository, where the extension gets loaded by hand. */
export const fromCheckout = fs.existsSync(path.join(root, '.git'));

/** Chrome derives an unpacked extension's id from the public key in its manifest. */
export function extensionId() {
  const { key } = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
  const hash = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return hash.replace(/[0-9a-f]/g, (char) => 'abcdefghijklmnop'[parseInt(char, 16)]);
}

const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
// Where versions before 0.7 kept the bridge.
const oldHostFiles = () => [path.join(dataDir(), 'tabhand-host'), path.join(dataDir(), 'host')];

/**
 * The single-file build that gets installed: this very file when running from the npm package
 * (or an installed copy), a fresh build when running from a checkout.
 */
async function bundlePath() {
  if (process.env.TABHAND_BUNDLED) return fileURLToPath(import.meta.url);
  const buildScript = path.join(root, 'scripts', 'build.mjs');
  const { buildBundle } = await import(buildScript);
  return buildBundle();
}

/** Copies the code and the extension into installDir and writes the launchers. */
async function installCopy() {
  const bundle = await bundlePath();
  fs.mkdirSync(path.dirname(appPath()), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(launcherPath()), { recursive: true, mode: 0o700 });
  if (path.resolve(bundle) !== path.resolve(appPath())) fs.copyFileSync(bundle, appPath());
  if (path.resolve(extensionDir) !== path.resolve(installedExtensionDir())) {
    fs.rmSync(installedExtensionDir(), { recursive: true, force: true });
    fs.cpSync(extensionDir, installedExtensionDir(), { recursive: true });
  }
  // Agents and Chrome both start Tabhand through the launcher. It pins the node binary that ran
  // setup, since agent apps and Chrome don't get your shell's PATH, and drops Node settings meant
  // for other tools (a stale NODE_OPTIONS preload crashes node before our code runs).
  const fallbacks = ['"$(command -v node)"', '/opt/homebrew/bin/node', '/usr/local/bin/node', '"$HOME/.local/bin/node"', '"$HOME/.volta/bin/node"', '"$HOME"/.nvm/versions/node/*/bin/node'];
  fs.writeFileSync(
    launcherPath(),
    [
      '#!/bin/sh',
      '# Starts Tabhand. Written by `tabhand setup`; run that again to update it.',
      'unset NODE_OPTIONS NODE_PATH',
      `export TABHAND_HOME=${quote(installDir())} TABHAND_DATA_DIR=${quote(dataDir())}`,
      `node=${quote(process.execPath)}`,
      '# If that Node.js has been removed since, use another one.',
      `[ -x "$node" ] || for candidate in ${fallbacks.join(' ')}; do`,
      '  if [ -x "$candidate" ]; then node=$candidate; break; fi',
      'done',
      `exec "$node" ${quote(appPath())} "$@"`,
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  // Chrome starts this one. Startup errors go to the log; stdout is for talking to the extension.
  const log = quote(logPath());
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    hostLauncherPath(),
    [
      '#!/bin/sh',
      `echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [wrapper $$] started by the browser" >> ${log}`,
      `exec ${quote(launcherPath())} host "$@" 2>> ${log}`,
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  for (const old of oldHostFiles()) fs.rmSync(old, { recursive: true, force: true });
}

function targetDirs({ browser, userDataDir }) {
  if (userDataDir) return [path.join(path.resolve(userDataDir), 'NativeMessagingHosts')];
  const dirs = nativeHostDirs();
  if (!dirs[browser]) throw new Error(`Unknown browser "${browser}". Use one of: ${Object.keys(dirs).join(', ')}`);
  return [dirs[browser]];
}

/** Installs Tabhand's own copy and registers its bridge with a browser (or one profile of it). */
export async function install({ browser = 'chrome', userDataDir } = {}) {
  await installCopy();
  const manifest = {
    name: HOST_NAME,
    description: 'Tabhand bridge between AI agents and Chrome',
    path: hostLauncherPath(),
    type: 'stdio',
    allowed_origins: [...new Set([extensionId(), STORE_EXTENSION_ID])].map((id) => `chrome-extension://${id}/`),
  };
  const written = [];
  for (const dir of targetDirs({ browser, userDataDir })) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${HOST_NAME}.json`);
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
    written.push(file);
  }
  return { written, extensionId: extensionId(), extensionDir: installedExtensionDir(), launcher: launcherPath() };
}

export function uninstall({ userDataDir } = {}) {
  const removed = [];
  const dirs = [...Object.values(nativeHostDirs())];
  if (userDataDir) dirs.push(path.join(path.resolve(userDataDir), 'NativeMessagingHosts'));
  for (const dir of dirs) {
    const file = path.join(dir, `${HOST_NAME}.json`);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      removed.push(file);
    }
  }
  for (const target of [installDir(), dataDir(), ...oldHostFiles()]) {
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(target);
    }
  }
  return removed;
}

export async function status() {
  const registered = Object.entries(nativeHostDirs())
    .filter(([, dir]) => fs.existsSync(path.join(dir, `${HOST_NAME}.json`)))
    .map(([browser]) => browser);
  const connected = await new Promise((resolve) => {
    const probe = net.connect(socketPath());
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
  return { registered, connected, extensionId: extensionId(), extensionDir: installedExtensionDir(), launcher: launcherPath(), installed: fs.existsSync(launcherPath()) };
}
