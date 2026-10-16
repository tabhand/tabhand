// Native messaging host. Chrome starts this process when the Tabhand extension connects,
// and stops it when the extension disconnects. It relays requests from local agent sessions
// (MCP servers, over a Unix socket) to the extension, and responses back.
//
// There is no TCP listener: web pages and other machines cannot reach it. The socket lives in a
// directory only the current user can read, and every client must present a token from that
// directory. The log records lifecycle events only, never page content, URLs or typed text.

import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import { readMessages, writeMessage } from './native-messaging.mjs';
import { dataDir, logPath, socketPath, tokenPath } from './paths.mjs';
import { VERSION } from './version.mjs';

const SESSION_GRACE_MS = Number(process.env.TABHAND_SESSION_GRACE_MS) || 30_000;
/** What the extension answers while the user has paused Tabhand in that Chrome profile. */
const PAUSED = /^The user paused Tabhand/;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
/** Lines between hosts carry answers too (a full-page screenshot can be several MB). */
const MAX_RELAY_BYTES = 64 * 1024 * 1024;
/** How long after an agent's action finishes Chrome may still come forward for a tab it opened. */
const FOCUS_WATCH_MS = 1_500;
/** After giving the front back, how long to keep it from Chrome while a popup finishes showing. */
const FOCUS_GUARD_MS = 1_500;
/** Actions that can make a page open a tab or a popup. */
const OPENING_ACTIONS = new Set(['click', 'press_key', 'type']);

/** The extension that started this host: Chrome passes its origin as an argument. */
const extensionId = /chrome-extension:\/\/([a-p]{32})/.exec(process.argv.join(' '))?.[1] ?? null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
  try {
    fs.appendFileSync(logPath(), `${new Date().toISOString()} [host ${process.pid}] ${message}\n`, { mode: 0o600 });
  } catch {}
}

function isSocketLive(path) {
  return new Promise((resolve) => {
    const probe = net.connect(path);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
}

/** The pid of the app in front (macOS only), or null. */
function frontPid() {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('lsappinfo', ['front'], { timeout: 2000 }, (error, asn) => {
      if (error || !asn.trim()) return resolve(null);
      execFile('lsappinfo', ['info', '-only', 'pid', asn.trim()], { timeout: 2000 }, (infoError, info) => {
        resolve(infoError ? null : Number(/pid"?\s*=\s*(\d+)/.exec(info)?.[1]) || null);
      });
    });
  });
}

/**
 * Brings apps back to the front, through AppKit (so macOS asks for no permission). Starting
 * osascript takes a few hundred milliseconds, so one stays running and takes a pid per line.
 */
const ACTIVATOR = `ObjC.import('AppKit');
const input = $.NSFileHandle.fileHandleWithStandardInput;
let pending = '';
for (;;) {
  const data = input.availableData;
  if (data.length === 0) break;
  pending += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
  let end;
  while ((end = pending.indexOf('\\n')) >= 0) {
    const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(pending.slice(0, end)));
    pending = pending.slice(end + 1);
    if (app.js) app.activateWithOptions($.NSApplicationActivateAllWindows);
  }
}`;
let activator = null;

function startActivator() {
  if (process.platform !== 'darwin' || activator) return;
  activator = spawn('osascript', ['-l', 'JavaScript', '-e', ACTIVATOR], { stdio: ['pipe', 'ignore', 'ignore'] });
  activator.on('exit', () => (activator = null));
  activator.on('error', () => (activator = null));
  activator.stdin.on('error', () => {});
}

function activate(pid) {
  startActivator();
  if (activator) activator.stdin.write(`${pid}\n`);
}

/** The slower way, through Launch Services, for when activating directly didn't hold. */
function openApp(pid) {
  execFile('lsappinfo', ['info', '-only', 'bundlepath', `#${pid}`], { timeout: 2000 }, (error, info) => {
    const bundle = !error && /"([^"]+\.app)"/.exec(info)?.[1];
    if (bundle) execFile('open', ['-a', bundle], { timeout: 5000 }, () => {});
  });
}

/** When the extension last said a page in an agent's tab opened a tab or a popup. */
let lastOpenedAt = 0;

/**
 * Chrome brings itself forward when a page opens a tab or a popup, even from a background tab.
 * When an agent's action did that while the user was in another app, give that app the front back,
 * as soon as it happens. Chrome started this process, so it is our parent.
 */
async function keepUserInFront(entry) {
  const user = await entry.frontBefore;
  if (!user || user === process.ppid) return;
  // Chrome can come forward a second time as it finishes showing a popup, so keep watching a
  // little while after giving the front back.
  let guardUntil = 0;
  let handedBack = 0;
  for (;;) {
    const now = Date.now();
    if (guardUntil ? now > guardUntil : (entry.respondedAt && now > entry.respondedAt + FOCUS_WATCH_MS) || now > entry.startedAt + REQUEST_TIMEOUT_MS) return;
    const opened = lastOpenedAt >= entry.startedAt || entry.responseOpened;
    if (opened && (await frontPid()) === process.ppid) {
      // A few times at most: past that, it's more likely the user went to Chrome on purpose.
      if (handedBack === 3) return;
      if (handedBack < 2) activate(user);
      else openApp(user);
      if (!handedBack++) log('a page opened a tab and brought Chrome forward; gave the front back');
      guardUntil = Date.now() + FOCUS_GUARD_MS;
      // Give the switch a moment to land before looking again.
      await sleep(200);
    }
    await sleep(25);
  }
}

/**
 * Another Chrome profile (or another copy of the extension) already runs the bridge. Exiting would
 * make this extension start a new host every 30 seconds, so stay connected instead: tell the running
 * bridge this extension is here (for `tabhand status`), and resolve once that bridge goes away.
 * While standing by, the bridge can hand this profile work (when its own profile is paused): each
 * line it sends goes to `onLine`. `relay: true` tells it this host knows how.
 */
function standBy(version, onLine) {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath());
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      let token = '';
      try {
        token = fs.readFileSync(tokenPath(), 'utf8');
      } catch {}
      socket.write(JSON.stringify({ type: 'standby', token, extensionId, version: version(), relay: true }) + '\n');
    });
    socket.on('data', (data) => {
      buffer += data;
      if (buffer.length > MAX_RELAY_BYTES) {
        socket.destroy();
        return;
      }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          onLine(socket, JSON.parse(line));
        } catch {}
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => resolve());
  });
}

export async function runHost() {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir(), 0o700);
  try {
    if (fs.statSync(logPath()).size > 1_000_000) fs.truncateSync(logPath(), 0);
  } catch {}

  let extensionVersion = null;
  let sayHello;
  const hello = new Promise((resolve) => (sayHello = resolve));
  /** Handles messages from the extension other than its hello, once this host runs the bridge. */
  let onExtensionMessage = () => {};
  readMessages(process.stdin, (message) => {
    if (message.type === 'hello') {
      extensionVersion = String(message.version ?? '?');
      log(`extension ${extensionVersion} connected`);
      sayHello();
    } else {
      onExtensionMessage(message);
    }
  });

  let server = null;
  let token = null;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log('stopping');
    server?.close();
    activator?.kill();
    try {
      if (token && fs.readFileSync(tokenPath(), 'utf8') === token) {
        fs.unlinkSync(tokenPath());
        fs.unlinkSync(socketPath());
      }
    } catch {}
    process.exit(0);
  };
  process.stdin.on('end', stop);
  process.stdin.on('close', stop);
  process.stdout.on('error', stop);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  // Standing by, this profile still does work the bridge hands it while the bridge's own profile
  // is paused: requests go to this extension, and its answers go back over the same line.
  /** @type {Map<string, {socket: net.Socket, rid: number}>} */
  const relayed = new Map();
  let nextRelayed = 1;
  let bridgeLine = null;
  const toBridge = (socket, message) => {
    if (socket && !socket.destroyed) socket.write(JSON.stringify(message) + '\n');
  };
  onExtensionMessage = (message) => {
    if (message.type === 'opened') toBridge(bridgeLine, { type: 'relay-opened' });
    if (message.type !== 'response') return;
    const entry = relayed.get(message.id);
    if (!entry) return;
    relayed.delete(message.id);
    toBridge(entry.socket, { type: 'relay-response', rid: entry.rid, ok: message.ok, result: message.result, error: message.error });
  };
  const onBridgeLine = (socket, message) => {
    bridgeLine = socket;
    if (message.type === 'relay') {
      const id = `relay-${nextRelayed++}`;
      relayed.set(id, { socket, rid: message.rid });
      writeMessage(process.stdout, {
        type: 'request',
        id,
        sessionId: message.sessionId,
        label: message.label,
        theme: message.theme,
        cmd: message.cmd,
        params: message.params ?? {},
        userInChrome: message.userInChrome,
      });
    } else if (message.type === 'relay-end') {
      writeMessage(process.stdout, { type: 'session-ended', sessionId: message.sessionId });
    }
  };

  while (await isSocketLive(socketPath())) {
    await Promise.race([hello, sleep(2000)]);
    log('another Chrome profile runs the bridge; standing by');
    writeMessage(process.stdout, { type: 'standby' });
    await standBy(() => extensionVersion, onBridgeLine);
    relayed.clear();
    bridgeLine = null;
    // Several profiles may be standing by; staggered, they don't all take over at once.
    await sleep(1000 + Math.random() * 1000);
  }
  try {
    fs.unlinkSync(socketPath());
  } catch {}

  startActivator();
  token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenPath(), token, { mode: 0o600 });
  const tokenBuffer = Buffer.from(token);
  const authorized = (given) => {
    const buffer = Buffer.from(String(given ?? ''));
    return buffer.length === tokenBuffer.length && crypto.timingSafeEqual(buffer, tokenBuffer);
  };

  /** @type {Map<string, {socket: net.Socket, sessionId: string}>} sessionId -> live client */
  const sessions = new Map();
  /** @type {Map<string, NodeJS.Timeout>} sessionId -> pending end-of-session timer */
  const endTimers = new Map();
  /** @type {Map<number, {socket: net.Socket, id: unknown, cmd: string, timer: NodeJS.Timeout, frontBefore?: Promise<number | null>}>} */
  const pending = new Map();
  /** Hosts of other profiles (or copies of the extension), standing by. */
  const standbys = new Set();
  // When this profile is paused, an agent's new work goes to another profile where Tabhand is on.
  /** sessionId -> the standing-by host the session's new work goes to now. */
  const routes = new Map();
  /** tabId -> where that tab lives (a standing-by host, or null for this profile), so work on a tab
   *  always goes to the profile that has it. Chrome's tab ids are unique across profiles. */
  const homes = new Map();
  /** sessionId -> standing-by hosts that did work for the session, told when it ends. */
  const touched = new Map();
  const live = (target) => Boolean(target && !target.socket.destroyed);
  /** The tab a request is about. Upload chunks name theirs as forTab, so they go where the tab is. */
  const tabOf = (params) => (Number.isInteger(params.tabId) ? params.tabId : Number.isInteger(params.forTab) ? params.forTab : null);
  let nextId = 1;

  const toExtension = (message) => writeMessage(process.stdout, message);

  const send = (socket, message) => {
    if (!socket.destroyed) socket.write(JSON.stringify(message) + '\n');
  };

  function onClientLine(client, line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.type === 'hello') {
      const sessionId = String(message.sessionId ?? '');
      if (!authorized(message.token) || !/^[A-Za-z0-9-]{8,64}$/.test(sessionId)) {
        send(client.socket, { type: 'error', error: 'Unauthorized' });
        client.socket.destroy();
        return;
      }
      client.sessionId = sessionId;
      client.label = String(message.label ?? 'Agent').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 40) || 'Agent';
      client.theme = /^[a-z]{1,16}$/.test(message.theme) ? message.theme : 'agent';
      clearTimeout(endTimers.get(sessionId));
      endTimers.delete(sessionId);
      const previous = sessions.get(sessionId);
      if (previous && previous.socket !== client.socket) previous.socket.destroy();
      sessions.set(sessionId, client);
      send(client.socket, { type: 'welcome' });
      log('session connected');
      return;
    }

    if (message.type === 'standby') {
      if (!authorized(message.token)) {
        client.socket.destroy();
        return;
      }
      client.standby = {
        extensionId: /^[a-p]{32}$/.test(message.extensionId) ? message.extensionId : null,
        version: message.version ? String(message.version).slice(0, 20) : null,
        relay: message.relay === true,
      };
      standbys.add(client);
      log('another Chrome profile is standing by');
      return;
    }

    if (message.type === 'relay-response' && client.standby) {
      if (pending.get(message.rid)?.via === client) answered(message.rid, message);
      return;
    }
    if (message.type === 'relay-opened' && client.standby) {
      lastOpenedAt = Date.now();
      return;
    }

    if (message.type === 'request') {
      if (!client.sessionId) {
        send(client.socket, { type: 'response', id: message.id, ok: false, error: 'Unauthorized' });
        return;
      }
      const id = nextId++;
      const cmd = String(message.cmd ?? '');
      const timer = setTimeout(() => {
        pending.delete(id);
        // It may have done something over there before going quiet: that profile hears when the session ends.
        if (entry.via) {
          if (!touched.has(entry.sessionId)) touched.set(entry.sessionId, new Set());
          touched.get(entry.sessionId).add(entry.via);
        }
        send(client.socket, { type: 'response', id: message.id, ok: false, error: 'Chrome did not answer in time.' });
      }, REQUEST_TIMEOUT_MS);
      const params = message.params ?? {};
      const entry = { socket: client.socket, id: message.id, cmd, params, timer, startedAt: Date.now(), sessionId: client.sessionId, label: client.label, theme: client.theme, tried: new Set() };
      pending.set(id, entry);
      const forward = (userInChrome) => {
        entry.userInChrome = userInChrome;
        // Work on a tab goes where the tab is; new work goes where the session's new work moved, if it did.
        const tabId = tabOf(params);
        const home = tabId === null ? undefined : homes.get(tabId);
        const target = home ? home.target : routes.get(client.sessionId);
        if (live(target)) relay(target, id, entry);
        else toHere(id, entry);
      };
      if (OPENING_ACTIONS.has(cmd)) {
        // The extension needs to know where the user is: it only hands a Chrome window the focus
        // back when the user was in Chrome, since focusing one brings Chrome to the front.
        entry.frontBefore = frontPid();
        keepUserInFront(entry).catch(() => {});
        entry.frontBefore.then((pid) => forward(pid === null ? undefined : pid === process.ppid));
      } else {
        forward();
      }
    }
  }

  function onClientClosed(client) {
    if (standbys.delete(client)) {
      // That profile went away, with its tabs; work out with it won't come back.
      for (const [sessionId, target] of routes) if (target === client) routes.delete(sessionId);
      for (const [tabId, home] of homes) if (home.target === client) homes.delete(tabId);
      for (const hosts of touched.values()) hosts.delete(client);
      for (const [id, entry] of pending) if (entry.via === client) answered(id, { ok: false, error: 'The Chrome profile doing this was closed. Try again.' });
    }
    const { sessionId } = client;
    if (!sessionId || sessions.get(sessionId) !== client) return;
    sessions.delete(sessionId);
    // Agents reconnect after hiccups; only end the session if it stays away.
    endTimers.set(
      sessionId,
      setTimeout(() => {
        endTimers.delete(sessionId);
        toExtension({ type: 'session-ended', sessionId });
        for (const target of touched.get(sessionId) ?? []) send(target.socket, { type: 'relay-end', sessionId });
        touched.delete(sessionId);
        routes.delete(sessionId);
        for (const [tabId, home] of homes) if (home.sessionId === sessionId) homes.delete(tabId);
        log('session ended');
      }, SESSION_GRACE_MS),
    );
  }

  server = net.createServer((socket) => {
    const client = { socket, sessionId: '', label: '', theme: 'agent' };
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (data) => {
      buffer += data;
      if (buffer.length > (client.standby ? MAX_RELAY_BYTES : MAX_LINE_BYTES)) {
        socket.destroy();
        return;
      }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) onClientLine(client, line);
      }
    });
    socket.on('close', () => onClientClosed(client));
    socket.on('error', () => {});
  });

  /** Sends a request to this profile's extension. */
  function toHere(id, entry) {
    entry.via = null;
    entry.triedHere = true;
    toExtension({ type: 'request', id, sessionId: entry.sessionId, label: entry.label, theme: entry.theme, cmd: entry.cmd, params: entry.params, userInChrome: entry.userInChrome });
  }

  /** Hands a request to a standing-by host, whose extension does it in that profile. */
  function relay(target, id, entry) {
    entry.via = target;
    entry.tried.add(target);
    send(target.socket, { type: 'relay', rid: id, sessionId: entry.sessionId, label: entry.label, theme: entry.theme, cmd: entry.cmd, params: entry.params, userInChrome: entry.userInChrome });
  }

  /** The tabs an answer names: the one acted on, any it opened, or the session's list. */
  const tabsIn = (result) =>
    [result?.tabId, ...(result?.opened ?? []).map((t) => t?.tabId), ...(result?.tabs ?? []).map((t) => t?.tabId)].filter(Number.isInteger);

  /** A profile answered a request: this one's extension, or a standing-by host it went to. */
  function answered(id, message) {
    const entry = pending.get(id);
    if (!entry) return;
    // Paused in that profile. Work on a tab waits for it (the tab isn't anywhere else); new work
    // can go to this profile or to another one standing by, wherever Tabhand is on.
    if (!message.ok && PAUSED.test(String(message.error ?? '')) && tabOf(entry.params) === null) {
      if (entry.via && routes.get(entry.sessionId) === entry.via) routes.delete(entry.sessionId);
      if (!entry.triedHere) {
        toHere(id, entry);
        return;
      }
      const next = [...standbys].find((s) => s.standby?.relay && live(s) && !entry.tried.has(s));
      if (next) {
        relay(next, id, entry);
        return;
      }
    }
    pending.delete(id);
    clearTimeout(entry.timer);
    if (entry.via) {
      if (!touched.has(entry.sessionId)) touched.set(entry.sessionId, new Set());
      touched.get(entry.sessionId).add(entry.via);
      if (message.ok && routes.get(entry.sessionId) !== entry.via) {
        routes.set(entry.sessionId, entry.via);
        log('this profile is paused; a session moved to another profile');
      }
    }
    if (message.ok) for (const tabId of tabsIn(message.result)) homes.set(tabId, { target: entry.via ?? null, sessionId: entry.sessionId });
    let result = message.result;
    if (entry.cmd === 'diagnostics' && message.ok) {
      // Which copy of the extension is connected, and which others are standing by.
      result = { ...result, bridge: { version: VERSION, extensionId, others: [...standbys].map((client) => client.standby) } };
    }
    entry.responseOpened = Boolean(message.ok && message.result?.opened?.length);
    entry.respondedAt = Date.now();
    send(entry.socket, { type: 'response', id: entry.id, ok: message.ok, result, error: message.error });
  }

  onExtensionMessage = (message) => {
    if (message.type === 'opened') lastOpenedAt = Date.now();
    if (message.type === 'response') answered(message.id, message);
  };

  server.listen(socketPath(), () => {
    fs.chmodSync(socketPath(), 0o600);
    log('listening');
    toExtension({ type: 'active' });
  });
}
