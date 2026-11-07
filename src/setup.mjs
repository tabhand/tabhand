// `tabhand setup`, `status` and `remove`: install Tabhand, connect it to Chrome, and add it to the
// agent harnesses on this machine globally, so every session in them can use the browser.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { BridgeClient } from './bridge-client.mjs';
import { HARNESSES, addTo, harnessStatus, removeFrom } from './harnesses.mjs';
import { fromCheckout, install, status, uninstall } from './install.mjs';
import { STORE_EXTENSION_ID, STORE_URL, WINDOWS, installDir, installedExtensionDir, launcherPath, nativeHostDirs } from './paths.mjs';
import * as windows from './windows.mjs';
import { VERSION } from './version.mjs';
import { Interrupted, Region, Terminal, now, pick, waitFor } from './livery.mjs';

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
      profile: diagnostics.bridge?.profile ?? null,
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
  const profiles = [extension, ...others.filter((other) => other.extensionId === extension.id)].map((copy) => copy.profile ?? {});
  if (profiles.length > 1) {
    const name = (profile) => (profile.name ? `"${profile.name}"` : 'an unnamed one');
    log(`✓ Tabhand is in ${profiles.length} Chrome profiles: ${profiles.map(name).join(', ')}. Agents use ${profiles[0].name ? `"${profiles[0].name}"` : 'the first one'} unless you ask for another profile or pause Tabhand there.`);
    if (profiles.some((profile) => !profile.name)) log('  To ask for a profile by name, click the Tabhand icon in it and give it a name at the top of the panel.');
    if (others.some((other) => other.extensionId === extension.id && !other.relay)) log('! One profile runs an older Tabhand helper. Quit Chrome and open it again to update it.');
  }
}

const BROWSER_APPS = {
  chrome: 'Google Chrome',
  'chrome-beta': 'Google Chrome Beta',
  'chrome-canary': 'Google Chrome Canary',
  'chrome-for-testing': 'Google Chrome for Testing',
  chromium: 'Chromium',
  brave: 'Brave Browser',
  edge: 'Microsoft Edge',
  arc: 'Arc',
  dia: 'Dia',
};

/** What to call each browser in setup's messages. */
const BROWSER_NAMES = {
  chrome: 'Chrome',
  'chrome-beta': 'Chrome Beta',
  'chrome-canary': 'Chrome Canary',
  'chrome-for-testing': 'Chrome for Testing',
  chromium: 'Chromium',
  brave: 'Brave',
  edge: 'Edge',
  arc: 'Arc',
  dia: 'Dia',
};
const browserName = (browser) => BROWSER_NAMES[browser] ?? browser;
/** "Chrome", "Chrome and Brave", "Chrome, Brave and Arc" (or "Brave or Arc"). */
const listNames = (names, word = 'and') => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} ${word} ${names.at(-1)}`);

/** Opens a page in the browser (macOS). The new tab also wakes an installed extension, so it connects sooner. */
function openInBrowser(browser, url) {
  if (WINDOWS) return windows.openInBrowser(browser, url);
  if (process.platform !== 'darwin' || !BROWSER_APPS[browser]) return;
  try {
    execFileSync('open', ['-a', BROWSER_APPS[browser], url], { stdio: 'ignore' });
  } catch {}
}

/** Whether a browser's app is on this Mac. */
const hasApp = (browser) =>
  WINDOWS ? Boolean(windows.browserProgram(browser)) :
  process.platform === 'darwin' &&
  Boolean(BROWSER_APPS[browser]) &&
  ['/Applications', path.join(os.homedir(), 'Applications')].some((folder) => fs.existsSync(path.join(folder, `${BROWSER_APPS[browser]}.app`)));

/**
 * Browsers setup doesn't register with unless asked by name. Chrome for Testing is for tests. In
 * Arc, making a tab group and taking a screenshot never finish (found with 0.11.0), so an agent
 * sent there would wait two minutes for nothing; Arc shuts down on December 22, 2026 anyway.
 */
const NOT_BY_DEFAULT = new Set(['chrome', 'chrome-for-testing', 'arc']);

/**
 * The browsers Tabhand supports besides Chrome. Setup registers the bridge with each of them whether
 * or not it's installed, the way it always has with Chrome. Registering is one small file (a
 * registry key on Windows) that does nothing until the extension is added, so a browser installed
 * after setup works as soon as the extension is added to it, without running setup again.
 */
const SUPPORTED = WINDOWS ? ['brave', 'edge'] : ['brave', 'edge', 'dia'];

/** All the browsers this system has a place to register with. */
const knownBrowsers = () => (WINDOWS ? windows.browsers() : Object.keys(nativeHostDirs()));

/**
 * The other Chromium browsers setup registers the bridge with, besides Chrome, so the extension
 * from the Chrome Web Store works in whichever of them the user adds it to: the supported ones, and
 * the other Chrome channels and Chromium when they're installed. A browser's folder is no sign it's
 * installed: other apps' helpers (password managers, agents) create one for every Chromium browser.
 */
const otherBrowsers = () => knownBrowsers().filter((browser) => !NOT_BY_DEFAULT.has(browser) && (SUPPORTED.includes(browser) || hasApp(browser)));

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

/** How many copies of the extension the bridge knows of: each Chrome profile or browser it's in. */
const connectedCount = (extension) => (extension ? (extension.known ? 1 + (extension.others?.length ?? 0) : 1) : 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Setup for a person at a terminal: the livery (see livery.mjs) and three steps, the helper, the
 * agents and the browsers, the last two as lists to tick. With dryRun it shows all of it and
 * changes nothing: no install, no agent settings, no Store pages.
 */
async function setupLive({ keys, browserGiven, dryRun }) {
  const t = new Terminal();
  const out = (...lines) => {
    for (const line of lines) process.stdout.write(`${t.fit(line)}\n`);
  };
  const region = new Region(t);
  const date = now();
  const computer = WINDOWS ? 'this computer' : 'this Mac';
  t.start();
  try {
    out('', ...t.header(date, VERSION), '');

    // 1. The helper: no question.
    const browser = browserGiven ?? 'chrome';
    const others = browserGiven ? [] : otherBrowsers();
    if (!dryRun) await install({ browser: [browser, ...others] });
    out(...t.done(1, 'Helper', `${dryRun ? 'would install in' : 'installed in'} ${tilde(installDir())}`));

    // 2. The agents: every one found starts ticked; unticking one that has Tabhand takes it out.
    const launcher = launcherPath();
    const found = pickHarnesses(keys);
    const before = new Map(found.map((harness) => [harness, harnessStatus(harness, launcher)]));
    const has = (harness) => ['set up', 'outdated'].includes(before.get(harness));
    let ticks = found.map(() => true);
    if (!keys && found.length) {
      ticks = await pick(region, found.map((harness) => ({ on: true, harness })), ({ items, cursor }) => [
        t.rule(),
        ` ${t.number(2)}  ${t.bold('Agents')}`,
        `    Which agents should use your browser? ${t.italic(`Found ${found.length} on ${computer}.`)}`,
        '',
        ...items.map((item, i) => {
          const here = i === cursor;
          const name = item.harness.name.padEnd(22);
          const note = has(item.harness) ? t.gray(item.on ? 'has Tabhand' : 'untick takes Tabhand out') : '';
          return `  ${here ? t.coral('›', { bold: true }) : ' '} ${item.on ? t.coral('●') : t.gray('○')} ${here ? t.bold(name) : name}${note}`;
        }),
        '',
        t.gray('    space ticks · a ticks all · enter goes on'),
        t.rule(),
        ` ${t.gray('3')}  ${t.gray('Browsers')}`,
      ]);
      region.clear();
    }
    const added = [];
    const kept = [];
    const removed = [];
    const failed = [];
    found.forEach((harness, i) => {
      try {
        if (ticks[i] && before.get(harness) === 'set up') kept.push(harness);
        else if (ticks[i]) {
          if (!dryRun) addTo(harness, launcher);
          added.push(harness);
        } else if (has(harness)) {
          if (!dryRun) removeFrom(harness);
          removed.push(harness);
        }
      } catch (error) {
        failed.push(`${harness.name}: ${error.message}`);
      }
    });
    const using = found.filter((harness, i) => ticks[i] && !failed.some((line) => line.startsWith(`${harness.name}:`)));
    const leftAlone = found.filter((harness, i) => !ticks[i] && !removed.includes(harness));
    out(
      ...t.done(2, 'Agents', using.length ? using.map((harness) => harness.name).join(', ') : found.length ? 'none ticked' : 'none found', [
        ...(!found.length ? [t.italic('Add one later: tabhand setup --harness claude,codex')] : []),
        ...(added.length && dryRun ? [t.italic(`would add Tabhand to ${added.map((harness) => harness.name).join(', ')}`)] : []),
        ...(removed.length ? [t.italic(`${dryRun ? 'would take Tabhand out of' : 'took Tabhand out of'} ${removed.map((harness) => harness.name).join(', ')}`)] : []),
        ...(leftAlone.length ? [t.italic(`${leftAlone.map((harness) => harness.name).join(', ')} left alone`)] : []),
        ...failed.map((line) => t.coral(`✗ ${line}`)),
      ]),
    );

    // 3. The browsers: where to add the extension, and each one connecting.
    let extension = await extensionInfo();
    if (!dryRun && extension && (!extension.known || extension.bridgeVersion !== VERSION)) extension = (await reloadExtension()) ?? extension;
    if (!dryRun && extension?.known && !extension.store && extension.version !== VERSION) extension = (await reloadExtension()) ?? extension;
    const connected = connectedCount(extension);
    const list = (browserGiven ? [browserGiven] : ['chrome', ...SUPPORTED]).filter(hasApp);
    const unsupported = !browserGiven && hasApp('arc') ? ['arc'] : [];
    let chosen = [];
    if (list.length) {
      const firstTicks = connected ? [] : [list[0]];
      const items = [...list.map((name) => ({ name, on: firstTicks.includes(name) })), ...unsupported.map((name) => ({ name, disabled: true }))];
      const tickedAt = await pick(region, items, ({ items: rows, cursor }) => [
        t.rule(),
        ` ${t.number(3)}  ${t.bold('Browsers')}`,
        `    Which browsers should agents work in? ${t.italic(connected ? `Tabhand is in ${plural(connected, 'profile')} already.` : 'Tick one to add the extension there.')}`,
        '',
        ...rows.map((row, i) => {
          if (row.disabled) return `      ${t.gray(browserName(row.name).padEnd(12))}${t.gray('isn’t supported')}`;
          const here = i === cursor;
          const name = browserName(row.name).padEnd(12);
          return `  ${here ? t.coral('›', { bold: true }) : ' '} ${row.on ? t.coral('●') : t.gray('○')} ${here ? t.bold(name) : name}${row.on ? t.gray(dryRun ? 'would open the Chrome Web Store here' : 'opens the Chrome Web Store here') : ''}`;
        }),
        '',
        t.gray(`    space ticks · enter ${connected ? 'goes on' : 'opens the Store'}`),
      ]);
      region.clear();
      chosen = list.filter((_, i) => tickedAt[i]);
    }

    let now_ = connected;
    if (chosen.length && !dryRun) {
      if (fromCheckout) {
        const folder = installedExtensionDir();
        out(
          t.gray('    This is a checkout, so load the extension by hand:'),
          t.gray('    1. Open chrome://extensions and turn on Developer mode.'),
          t.gray(`    2. Click "Load unpacked" and pick ${folder}`),
        );
      } else for (const name of chosen) openInBrowser(name, STORE_URL);
      const names = chosen.map(browserName);
      const how = await waitFor(
        region,
        (spinner) => [
          '',
          ...chosen.map((name) => `    ${t.coral('●')} ${browserName(name).padEnd(12)}${t.gray(fromCheckout ? 'load the extension there' : 'opened the Chrome Web Store · add Tabhand there')}`),
          '',
          `    ${t.coral(spinner)} ${t.gray(`Waiting for the extension. Enter finishes; ${listNames(names, 'and')} can connect later on ${names.length === 1 ? 'its' : 'their'} own.`)}`,
        ],
        async () => {
          now_ = connectedCount(await extensionInfo());
          return now_ >= connected + chosen.length;
        },
      );
      region.clear();
      extension = (await extensionInfo()) ?? extension;
      now_ = connectedCount(extension);
      const waiting = Math.max(0, connected + chosen.length - now_);
      out(
        ...t.done(3, 'Browsers', now_ ? `connected in ${plural(now_, 'profile')}${extension?.profile?.name ? `, including "${extension.profile.name}"` : ''}` : 'not connected yet', [
          ...(waiting ? [t.italic(`${waiting === chosen.length ? listNames(names, 'and') : 'The rest'} connect${waiting === 1 && chosen.length === 1 ? 's' : ''} on ${waiting === 1 ? 'its' : 'their'} own once you add the extension${how === 'timeout' ? ' (stopped waiting after 5 minutes)' : ''}`)] : []),
        ]),
      );
    } else {
      out(
        ...t.done(3, 'Browsers', connected ? `connected in ${plural(connected, 'profile')}` : list.length ? 'none ticked' : 'no supported browser found', [
          ...(dryRun && chosen.length ? [t.italic(`would open the Chrome Web Store in ${listNames(chosen.map(browserName), 'and')}`)] : []),
          ...(!connected && !chosen.length ? [t.italic(`Add the extension when you're ready: ${STORE_URL}`)] : []),
        ]),
      );
    }
    if (extension && !dryRun) adviseOnCopies(extension, (line) => out(...line.split('\n').map((part) => `    ${t.gray(part)}`)));

    // The end, as the toolbar panel opens.
    out('', ...t.ending(date, now_ ? ['Agents are', 'ready.'] : ['One more', 'step.']), '');
    if (!now_) out(t.gray(' Add the extension, and it connects on its own.'));
    if (added.length && !dryRun) out(t.gray(' Sessions that were already open pick it up after a restart.'));
    if (dryRun) out(t.gray(' Dry run: nothing was changed.'));
  } catch (error) {
    region.clear();
    if (!(error instanceof Interrupted)) throw error;
    out('', t.gray(' Stopped. Nothing after this point was changed.'));
    process.exitCode = 130;
  } finally {
    t.stop();
  }
}

export async function setup({ harnesses: keys, yes = false, wait = true, browser: browserGiven, dryRun = false, log = console.log } = {}) {
  // A person at a terminal gets the livery and the lists to tick; agents, scripts and --yes get
  // the plain lines below.
  if (!yes && wait && log === console.log && process.stdin.isTTY && process.stdout.isTTY) return setupLive({ keys, browserGiven, dryRun });
  if (dryRun) throw new Error('--dry-run shows the setup you get in a terminal, so run it in one (and without --yes or --no-wait).');
  const browser = browserGiven ?? 'chrome';
  const chosen = pickHarnesses(keys);
  log(`Tabhand ${VERSION}\n`);
  // Asked for one browser by name: just that one. Otherwise Chrome and every other one here.
  const others = browserGiven ? [] : otherBrowsers();
  await install({ browser: [browser, ...others] });
  log(`✓ Installed in ${tilde(installDir())} and registered with ${listNames([browser, ...others].map(browserName))}`);

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
    // Only for a person at a terminal: tests and agents run setup too, and the clipboard is the
    // user's (a VM can even share it with the Mac around it).
    const clip = Boolean(process.stdout.isTTY);
    if (clip && WINDOWS) windows.copyToClipboard(folder);
    else if (clip) try {
      execFileSync('pbcopy', { input: folder });
    } catch {}
    log(`
One last step: load the extension in Chrome (once).
  1. Open chrome://extensions and turn on Developer mode (top right).
  2. Click "Load unpacked", ${WINDOWS ? windows.PICK_FOLDER : 'press ⌘⇧G and paste this folder'}${clip ? " (it's on your clipboard)" : ''}:
     ${folder}`);
    if (!wait) return;
    log('\nWaiting for Chrome…');
    log((await waitForChrome(5 * 60_000)) ? '✓ Chrome extension connected. All set.' : 'Not connected yet. Check with `tabhand status` once the extension is loaded.');
  } else {
    // Name only the browsers that are here; the others are registered for when they are.
    const elsewhere = others.filter(hasApp).map(browserName);
    log(`
One last step: add the Tabhand extension to ${browserName(browser)}${elsewhere.length ? ` (or ${listNames(elsewhere, 'or')})` : ''}. Opening it in the Chrome Web Store:
  ${STORE_URL}
Already added it? Then it connects on its own in a moment.`);
    // Chrome isn't on this Mac: open the page in the first other browser that is.
    openInBrowser(hasApp(browser) ? browser : (others.find(hasApp) ?? browser), STORE_URL);
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
  log(state.registered.length ? `✓ Bridge registered with ${listNames(state.registered.map(browserName))}` : '✗ Bridge not registered with any browser');
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
