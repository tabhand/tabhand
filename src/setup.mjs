// `tabhand setup`, `status` and `remove`: install Tabhand, connect it to Chrome, and add it to the
// agent harnesses on this machine globally, so every session in them can use the browser.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import readline from 'node:readline/promises';
import { BridgeClient } from './bridge-client.mjs';
import { HARNESSES, addTo, harnessStatus, removeFrom } from './harnesses.mjs';
import { fromCheckout, install, status, uninstall } from './install.mjs';
import { STORE_EXTENSION_ID, STORE_URL, installDir, installedExtensionDir, launcherPath } from './paths.mjs';
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

/**
 * The connected extension, if Chrome is connected: its version (asked of the extension itself),
 * whether it's the Chrome Web Store copy, and any other copies or profiles the bridge knows about.
 */
async function extensionInfo() {
  const bridge = new BridgeClient({ sessionId: crypto.randomUUID(), label: 'Setup' });
  try {
    const diagnostics = await bridge.request('diagnostics');
    const id = diagnostics.bridge?.extensionId ?? null;
    return {
      version: diagnostics.version ?? 'unknown',
      id,
      store: id === STORE_EXTENSION_ID,
      others: diagnostics.bridge?.others ?? [],
      bridgeVersion: diagnostics.bridge?.version ?? null,
      // Bridges before 0.8.0 don't say which copy of the extension started them.
      known: Boolean(diagnostics.bridge),
    };
  } catch {
    return null;
  } finally {
    bridge.close();
  }
}

/** "0.7.3, from the Chrome Web Store", or just the version when an older bridge can't tell. */
const describe = (extension) =>
  extension.known ? `${extension.version}, ${extension.store ? 'from the Chrome Web Store' : 'loaded by hand'}` : extension.version;

/** Points out a copy loaded by hand next to (or instead of) the store copy, and extra profiles. */
function adviseOnCopies(extension, log) {
  if (!extension.known) return;
  const others = extension.others ?? [];
  if (!fromCheckout && !extension.store) {
    log(`! This is a copy of the extension you loaded by hand. Switch to the Chrome Web Store version, which updates itself:
    1. Add it from ${STORE_URL}
    2. Remove the old one, marked "Unpacked", at chrome://extensions`);
  } else if (!fromCheckout && others.some((other) => other.extensionId && other.extensionId !== extension.id)) {
    log('! A copy of the extension you loaded by hand is installed too. Remove the one marked "Unpacked" at chrome://extensions.');
  }
  const profiles = others.filter((other) => other.extensionId === extension.id).length;
  if (profiles) log(`! Tabhand is on in ${profiles + 1} Chrome profiles. Agents use the one that connected first; turn it off in the others to choose.`);
}

const BROWSER_APPS = {
  chrome: 'Google Chrome',
  'chrome-beta': 'Google Chrome Beta',
  'chrome-canary': 'Google Chrome Canary',
  'chrome-for-testing': 'Google Chrome for Testing',
  chromium: 'Chromium',
  brave: 'Brave Browser',
  edge: 'Microsoft Edge',
};

/** Opens a page in the browser (macOS). The new tab also wakes an installed extension, so it connects sooner. */
function openInBrowser(browser, url) {
  if (process.platform !== 'darwin' || !BROWSER_APPS[browser]) return;
  try {
    execFileSync('open', ['-a', BROWSER_APPS[browser], url], { stdio: 'ignore' });
  } catch {}
}

/** Has Chrome reload the extension, which also restarts the bridge, and waits for it to come back. */
async function reloadExtension() {
  const bridge = new BridgeClient({ sessionId: crypto.randomUUID(), label: 'Setup' });
  await bridge.request('reload_extension').catch(() => {});
  bridge.close();
  const deadline = Date.now() + 15_000;
  await sleep(1500);
  while (Date.now() < deadline) {
    const extension = await extensionInfo();
    if (extension?.known && extension.bridgeVersion === VERSION) return extension;
    await sleep(500);
  }
  return extensionInfo();
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
  log(`✓ Installed in ${tilde(installDir())} and registered with ${browser === 'chrome' ? 'Chrome' : browser}`);

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
  let extension = await extensionInfo();
  if (extension && (!extension.known || extension.bridgeVersion !== VERSION)) {
    // The bridge of an older Tabhand is still running. Reloading the extension starts this one.
    extension = (await reloadExtension()) ?? extension;
  }
  if (extension?.known && !extension.store && extension.version !== VERSION) {
    // A copy loaded by hand runs from the files setup just updated; have Chrome load them.
    const updated = await reloadExtension();
    log(`✓ Updated the Chrome extension from ${extension.version}`);
    adviseOnCopies(updated ?? extension, log);
  } else if (extension) {
    log(`✓ Chrome extension connected (${describe(extension)})`);
    adviseOnCopies(extension, log);
  } else if (fromCheckout) {
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
  } else {
    log(`
One last step: add the Tabhand extension to Chrome. Opening it in the Chrome Web Store:
  ${STORE_URL}
Already added it? Then it connects on its own in a moment.`);
    openInBrowser(browser, STORE_URL);
    if (!wait) return;
    log('\nWaiting for Chrome…');
    if (await waitForChrome(5 * 60_000)) {
      const connected = await extensionInfo();
      log(`✓ Chrome extension connected${connected ? ` (${describe(connected)})` : ''}. All set.`);
      if (connected) adviseOnCopies(connected, log);
    } else {
      log('Not connected yet. Check with `tabhand status` once the extension is added.');
    }
  }
}

export async function report({ log = console.log } = {}) {
  const state = await status();
  const extension = state.connected ? await extensionInfo() : null;
  log(`Tabhand ${VERSION}\n`);
  log(state.installed ? `✓ Installed in ${tilde(installDir())}` : '✗ Not installed. Run `npx tabhand setup`.');
  log(state.registered.length ? `✓ Bridge registered with ${state.registered.join(', ')}` : '✗ Bridge not registered with any browser');
  if (extension) {
    const stale = extension.known && !extension.store && extension.version !== VERSION;
    log(`✓ Chrome extension connected (${describe(extension)}${stale ? `; run \`tabhand setup\` to update it to ${VERSION}` : ''})`);
    adviseOnCopies(extension, log);
  } else {
    log(`✗ Chrome extension not connected. Is Chrome open with the Tabhand extension on? Get it from ${STORE_URL}`);
  }
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
