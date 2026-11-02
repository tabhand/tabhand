import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const HOST_NAME = 'dev.tabhand.bridge';
/** Windows does several things its own way: see windows.mjs, and the Windows section below. */
export const WINDOWS = process.platform === 'win32';

/** The Chrome Web Store gives its copy of the extension an id of its own; the bridge accepts both. */
export const STORE_EXTENSION_ID = 'gcpbhianocgipfljeephofdmbpahkmei';
export const STORE_URL = `https://chromewebstore.google.com/detail/tabhand/${STORE_EXTENSION_ID}`;

/** Per-user directory for the socket, token and logs. Only the current user can read it. */
export function dataDir() {
  if (process.env.TABHAND_DATA_DIR) return process.env.TABHAND_DATA_DIR;
  if (WINDOWS) return windowsDataDir();
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'tabhand');
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'tabhand');
}

/**
 * Where `tabhand setup` puts its own copy of Tabhand: the launcher agents and Chrome run, the code,
 * and the extension to load. No spaces, since some agent apps split commands on them, and outside
 * Documents, which macOS keeps processes that Chrome starts from reading.
 */
export function installDir() {
  return process.env.TABHAND_HOME || path.join(os.homedir(), '.tabhand');
}

export const launcherPath = () => (WINDOWS ? path.join(installDir(), 'bin', 'tabhand.cmd') : path.join(installDir(), 'bin', 'tabhand'));
export const hostLauncherPath = () => (WINDOWS ? path.join(installDir(), 'bin', 'tabhand-host.cmd') : path.join(installDir(), 'bin', 'tabhand-host'));
export const appPath = () => path.join(installDir(), 'app', 'tabhand.mjs');
export const installedExtensionDir = () => path.join(installDir(), 'extension');

export const socketPath = () => (WINDOWS ? windowsPipe(dataDir()) : path.join(dataDir(), 'bridge.sock'));
/** The socket (or Windows pipe) for a given data folder, for tests that run bridges of their own. */
export const socketPathFor = (dir) => (WINDOWS ? windowsPipe(dir) : path.join(dir, 'bridge.sock'));
export const tokenPath = () => path.join(dataDir(), 'token');
export const logPath = () => path.join(dataDir(), 'host.log');

/** Where each Chromium browser looks for per-user native messaging host manifests. */
export function nativeHostDirs() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    const base = path.join(home, 'Library', 'Application Support');
    return {
      chrome: path.join(base, 'Google', 'Chrome', 'NativeMessagingHosts'),
      'chrome-beta': path.join(base, 'Google', 'Chrome Beta', 'NativeMessagingHosts'),
      'chrome-canary': path.join(base, 'Google', 'Chrome Canary', 'NativeMessagingHosts'),
      'chrome-for-testing': path.join(base, 'Google', 'Chrome for Testing', 'NativeMessagingHosts'),
      chromium: path.join(base, 'Chromium', 'NativeMessagingHosts'),
      brave: path.join(base, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
      edge: path.join(base, 'Microsoft Edge', 'NativeMessagingHosts'),
      // Arc and Dia (The Browser Company's) keep their profiles, and the helpers their extensions
      // talk to, under "User Data".
      arc: path.join(base, 'Arc', 'User Data', 'NativeMessagingHosts'),
      dia: path.join(base, 'Dia', 'User Data', 'NativeMessagingHosts'),
    };
  }
  const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return {
    chrome: path.join(config, 'google-chrome', 'NativeMessagingHosts'),
    'chrome-beta': path.join(config, 'google-chrome-beta', 'NativeMessagingHosts'),
    chromium: path.join(config, 'chromium', 'NativeMessagingHosts'),
    brave: path.join(config, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
    edge: path.join(config, 'microsoft-edge', 'NativeMessagingHosts'),
  };
}

// ------------------------------------------------------------------ Windows only

/** Per-user data folder on Windows: the token and the logs, in the user's own Local AppData. */
const windowsDataDir = () => path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'tabhand');

/**
 * On Windows agents reach the bridge over a named pipe, named from the data folder, so each user
 * (and each test run) gets one of its own.
 */
const windowsPipe = (dir) => `\\\\.\\pipe\\tabhand-bridge-${crypto.createHash('sha256').update(dir.toLowerCase()).digest('hex').slice(0, 16)}`;

/** On Windows: the Node.js that ran setup, which agents start Tabhand with. */
export const nodePathFile = () => path.join(installDir(), 'bin', 'node-path');
/** On Windows: the bridge's manifest, which each browser's registry key points to. */
export const hostManifestPath = () => path.join(installDir(), 'native', `${HOST_NAME}.json`);

/**
 * Where each Chromium browser on Windows looks up native messaging hosts: a registry key per
 * browser, under HKEY_CURRENT_USER, whose default value is the manifest's path. Tests point
 * TABHAND_REGISTRY_ROOT somewhere of their own, so they never touch a real registration.
 */
export function nativeHostKeys() {
  const root = process.env.TABHAND_REGISTRY_ROOT || 'HKCU\\Software';
  return {
    chrome: `${root}\\Google\\Chrome\\NativeMessagingHosts`,
    // Chrome for Testing reads Chromium's key on Windows.
    'chrome-for-testing': `${root}\\Chromium\\NativeMessagingHosts`,
    chromium: `${root}\\Chromium\\NativeMessagingHosts`,
    brave: `${root}\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts`,
    edge: `${root}\\Microsoft\\Edge\\NativeMessagingHosts`,
  };
}
