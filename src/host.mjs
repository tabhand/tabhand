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

const SESSION_GRACE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
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
 */
function standBy(version) {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath());
    socket.on('connect', () => {
      let token = '';
      try {
        token = fs.readFileSync(tokenPath(), 'utf8');
      } catch {}
      socket.write(JSON.stringify({ type: 'standby', token, extensionId, version: version() }) + '\n');
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

  while (await isSocketLive(socketPath())) {
    await Promise.race([hello, sleep(2000)]);
    log('another Chrome profile runs the bridge; standing by');
    writeMessage(process.stdout, { type: 'standby' });
    await standBy(() => extensionVersion);
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
      };
      standbys.add(client);
      log('another Chrome profile is standing by');
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
        send(client.socket, { type: 'response', id: message.id, ok: false, error: 'Chrome did not answer in time.' });
      }, REQUEST_TIMEOUT_MS);
      const entry = { socket: client.socket, id: message.id, cmd, timer, startedAt: Date.now() };
      pending.set(id, entry);
      const forward = (userInChrome) =>
        toExtension({
          type: 'request',
          id,
          sessionId: client.sessionId,
          label: client.label,
          theme: client.theme,
          cmd,
          params: message.params ?? {},
          userInChrome,
        });
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
    standbys.delete(client);
    const { sessionId } = client;
    if (!sessionId || sessions.get(sessionId) !== client) return;
    sessions.delete(sessionId);
    // Agents reconnect after hiccups; only end the session if it stays away.
    endTimers.set(
      sessionId,
      setTimeout(() => {
        endTimers.delete(sessionId);
        toExtension({ type: 'session-ended', sessionId });
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
      if (buffer.length > MAX_LINE_BYTES) {
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

  onExtensionMessage = (message) => {
    if (message.type === 'opened') lastOpenedAt = Date.now();
    if (message.type !== 'response') return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    let result = message.result;
    if (entry.cmd === 'diagnostics' && message.ok) {
      // Which copy of the extension is connected, and which others are standing by.
      result = { ...result, bridge: { version: VERSION, extensionId, others: [...standbys].map((client) => client.standby) } };
    }
    entry.responseOpened = Boolean(message.ok && message.result?.opened?.length);
    entry.respondedAt = Date.now();
    send(entry.socket, { type: 'response', id: entry.id, ok: message.ok, result, error: message.error });
  };

  server.listen(socketPath(), () => {
    fs.chmodSync(socketPath(), 0o600);
    log('listening');
    toExtension({ type: 'active' });
  });
}
