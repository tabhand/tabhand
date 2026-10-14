import os from 'node:os';
import path from 'node:path';

export const HOST_NAME = 'dev.tabhand.bridge';

/** The Chrome Web Store gives its copy of the extension an id of its own; the bridge accepts both. */
export const STORE_EXTENSION_ID = 'gcpbhianocgipfljeephofdmbpahkmei';
export const STORE_URL = `https://chromewebstore.google.com/detail/tabhand/${STORE_EXTENSION_ID}`;

/** Per-user directory for the socket, token and logs. Only the current user can read it. */
export function dataDir() {
  if (process.env.TABHAND_DATA_DIR) return process.env.TABHAND_DATA_DIR;
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

export const launcherPath = () => path.join(installDir(), 'bin', 'tabhand');
export const hostLauncherPath = () => path.join(installDir(), 'bin', 'tabhand-host');
export const appPath = () => path.join(installDir(), 'app', 'tabhand.mjs');
export const installedExtensionDir = () => path.join(installDir(), 'extension');

export const socketPath = () => path.join(dataDir(), 'bridge.sock');
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
