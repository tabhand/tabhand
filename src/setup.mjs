// `tabhand setup`, `status` and `remove`: install Tabhand, connect it to Chrome, and add it to the
// agent harnesses on this machine globally, so every session in them can use the browser.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import readline from 'node:readline/promises';
import { BridgeClient } from './bridge-client.mjs';
import { HARNESSES, addTo, harnessStatus, removeFrom } from './harnesses.mjs';
import { install, status, uninstall } from './install.mjs';
import { installDir, installedExtensionDir, launcherPath } from './paths.mjs';
import { VERSION } from './version.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tilde = (file) => file.replace(os.homedir(), '~');

function pickHarnesses(keys) {
  if (!keys) return HARNESSES.filter((harness) => harness.installed());
  const unknown = keys.filter((key) => !HARNESSES.some((harness) => harness.key === key));
  if (unknown.length) {
    throw new Error(`Unknown harness: ${unknown.join(', ')}. Choose from: ${HARNESSES.map((harness) => harness.key).join(', ')}`);
  }
  return HARNESSES.filter((harness) => keys.includes(harness.key));
}

async function confirm(question, { yes }) {
  if (yes) return true;
  if (!process.stdin.isTTY) return false;
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return !/^n/i.test((await prompt.question(`${question} [Y/n] `)).trim());
  } finally {
    prompt.close();
  }
}

/** The extension's version, if Chrome is connected (asks the extension itself). */
async function extensionVersion() {
  const bridge = new BridgeClient({ sessionId: crypto.randomUUID(), label: 'Setup' });
  try {
    return (await bridge.request('diagnostics')).version ?? 'unknown';
  } catch {
    return null;
  } finally {
    bridge.close();
  }
}

async function waitForChrome(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await status()).connected) return true;
    await sleep(1000);
  }
  return false;
}

export async function setup({ harnesses: keys, yes = false, wait = true, browser = 'chrome', log = console.log } = {}) {
  const chosen = pickHarnesses(keys);
  log(`Tabhand ${VERSION}\n`);
  await install({ browser });
  log(`✓ Installed in ${tilde(installDir())}, and connected to ${browser === 'chrome' ? 'Chrome' : browser}'s extension bridge`);

  // Agents
  const launcher = launcherPath();
  const missing = chosen.filter((harness) => harnessStatus(harness, launcher) !== 'set up');
  let added = 0;
  if (!chosen.length) {
    log('– No agent apps found. Run `tabhand setup --harness <name>` to pick one.');
  } else if (missing.length && !(await confirm(`\nAdd Tabhand to ${missing.map((harness) => harness.name).join(', ')}?`, { yes }))) {
    log(`– Left your agents alone. To add Tabhand: tabhand setup --yes${keys ? ` --harness ${keys.join(',')}` : ''}`);
  } else {
    for (const harness of chosen) {
      if (!missing.includes(harness)) {
        log(`✓ ${harness.name}`);
        continue;
      }
      try {
        addTo(harness, launcher);
        added++;
        log(`✓ ${harness.name}: added`);
      } catch (error) {
        log(`✗ ${harness.name}: ${error.message}`);
      }
    }
    if (added) log('  Sessions that were already open pick it up after a restart.');
  }

  // Chrome
  const version = await extensionVersion();
  if (version && version !== VERSION) {
    // The new files are in place; have Chrome load them.
    const bridge = new BridgeClient({ sessionId: crypto.randomUUID(), label: 'Setup' });
    await bridge.request('reload_extension').catch(() => {});
    bridge.close();
    log(`✓ Updated the Chrome extension from ${version}`);
    await waitForChrome(15_000);
  } else if (version) {
    log('✓ Chrome extension connected');
  } else {
    const folder = installedExtensionDir();
    try {
      execFileSync('pbcopy', { input: folder });
    } catch {}
    log(`
One last step: load the extension in Chrome (once).
  1. Open chrome://extensions and turn on Developer mode (top right).
  2. Click "Load unpacked", press ⌘⇧G and paste this folder (it's on your clipboard):
     ${folder}`);
    if (!wait) return;
    log('\nWaiting for Chrome…');
    log((await waitForChrome(5 * 60_000)) ? '✓ Chrome extension connected. All set.' : 'Not connected yet. Check with `tabhand status` once the extension is loaded.');
  }
}

export async function report({ log = console.log } = {}) {
  const state = await status();
  const version = state.connected ? await extensionVersion() : null;
  log(`Tabhand ${VERSION}\n`);
  log(state.installed ? `✓ Installed in ${tilde(installDir())}` : '✗ Not installed. Run `npx tabhand setup`.');
  log(state.registered.length ? `✓ Bridge registered with ${state.registered.join(', ')}` : '✗ Bridge not registered with any browser');
  log(
    version
      ? `✓ Chrome extension connected (${version}${version === VERSION ? '' : `; run \`tabhand setup\` to update it to ${VERSION}`})`
      : `✗ Chrome extension not connected. Is Chrome open with the extension on? (folder: ${state.extensionDir})`,
  );
  log('\nAgents:');
  for (const harness of HARNESSES) {
    const installed = harness.installed();
    const result = harnessStatus(harness, launcherPath());
    if (!installed && result === 'missing') continue;
    const line = {
      'set up': `✓ ${harness.name}`,
      outdated: `! ${harness.name}: points at another Tabhand. Run \`tabhand setup\` to fix.`,
      missing: `– ${harness.name}: not added. Run \`tabhand setup\`.`,
      unreadable: `! ${harness.name}: couldn't read its config`,
    }[result];
    log(`  ${line}`);
  }
}

export async function remove({ yes = false, log = console.log } = {}) {
  const present = HARNESSES.filter((harness) => harnessStatus(harness, launcherPath()) !== 'missing');
  const names = present.map((harness) => harness.name);
  if (!(await confirm(`Remove Tabhand${names.length ? ` from ${names.join(', ')} and` : ''} from this machine?`, { yes }))) {
    log('Nothing removed.');
    return;
  }
  for (const harness of present) {
    try {
      removeFrom(harness);
      log(`✓ Removed from ${harness.name}`);
    } catch (error) {
      log(`✗ ${harness.name}: ${error.message}`);
    }
  }
  for (const file of uninstall()) log(`✓ Removed ${tilde(file)}`);
  log('\nTo finish, remove the extension at chrome://extensions.');
}
