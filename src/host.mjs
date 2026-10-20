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
/** How long a session waits for its agent to come back: while its app is still open, or for a
 *  conversation that may be resumed. A restarted agent gets the tabs back (see reclaim). */
const RECONNECT_GRACE_MS = Number(process.env.TABHAND_RECONNECT_GRACE_MS) || 10 * 60_000;
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

/** Whether a process is still running. */
function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * A Chrome profile as agents see it: an id its extension keeps for good, and the name the user gave
 * it (right-click the toolbar icon). Extensions before 0.9 send neither, so they get a passing id.
 */
const newProfileId = () => crypto.randomBytes(4).toString('hex');
const cleanProfile = (given, fallbackId) => ({
  id: /^[A-Za-z0-9-]{4,40}$/.test(given?.id ?? '') ? given.id : fallbackId,
  name: String(given?.name ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 100),
});
/** How agents read a profile's name: "Work", or an unnamed one by its id. */
const profileLabel = (profile) => (profile.name ? `"${profile.name}"` : `the unnamed profile ${profile.id}`);

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
 * While standing by, the bridge can hand this profile work (when its own profile is paused, or an
 * agent asks for this profile): each line it sends goes to `onLine`. `relay: true` tells it this
 * host knows how. `onConnect` gets the line to the bridge, for news about this profile.
 */
function standBy(info, onLine, onConnect) {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath());
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      let token = '';
      try {
        token = fs.readFileSync(tokenPath(), 'utf8');
      } catch {}
      socket.write(JSON.stringify({ type: 'standby', token, extensionId, ...info(), relay: true }) + '\n');
      onConnect(socket);
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
  /** This Chrome profile. */
  let profile = cleanProfile(null, newProfileId());
  /** The line to the bridge while standing by, to pass on a new name for this profile. */
  let standbyLine = null;
  let sayHello;
  const hello = new Promise((resolve) => (sayHello = resolve));
  /** Handles messages from the extension other than its hello, once this host runs the bridge. */
  let onExtensionMessage = () => {};
  readMessages(process.stdin, (message) => {
    if (message.type === 'hello' || message.type === 'profile') {
      // A profile message: the user renamed this profile.
      profile = cleanProfile(message.profile, profile.id);
      // Standing by already (a slow hello, or a rename): the bridge hears it too.
      if (standbyLine && !standbyLine.destroyed) standbyLine.write(JSON.stringify({ type: 'standby-profile', profile }) + '\n');
      if (message.type === 'hello') {
        extensionVersion = String(message.version ?? '?');
        log(`extension ${extensionVersion} connected`);
        sayHello();
      }
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
    await standBy(() => ({ version: extensionVersion, profile }), onBridgeLine, (socket) => (standbyLine = socket));
    relayed.clear();
    bridgeLine = null;
    standbyLine = null;
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
  /** sessionId -> a session whose agent went away, waiting for it: { conversation, parent, cwd, label, since } */
  const waiting = new Map();
  /** sessionId an MCP server says hello with -> the session it took over (see reclaim) */
  const aliases = new Map();

  /**
   * The session a restarted MCP server takes over: one still waiting for an agent of the same name
   * in the same conversation (Claude Code keeps it when it resumes one in a new process), or, when
   * the app doesn't say, run by the same app process in the same folder. Another agent, even in the
   * same folder, has another conversation or app process, so it never gets these tabs.
   */
  function reclaim(client) {
    const same = (gone) =>
      gone.label === client.label &&
      (client.conversation ? gone.conversation === client.conversation : Boolean(client.parent) && gone.parent === client.parent && gone.cwd === client.cwd);
    let found = null;
    for (const [sessionId, gone] of waiting) {
      if (same(gone) && (!found || gone.since > found.since)) found = { sessionId, since: gone.since };
    }
    return found?.sessionId ?? null;
  }
  /** @type {Map<number, {socket: net.Socket, id: unknown, cmd: string, timer: NodeJS.Timeout, frontBefore?: Promise<number | null>}>} */
  const pending = new Map();
  /** Hosts of other profiles (or copies of the extension), standing by. */
  const standbys = new Set();
  // An agent's new work goes to the profile it asked for; otherwise to this one or, while this one
  // is paused, to another profile where Tabhand is on.
  /**
   * sessionId -> where the session's new work goes now: { profileId, name, pinned, want }.
   * pinned: the agent chose that profile (`want` is what it asked for), so its work stays there and
   * it hears if that profile is paused or gone, rather than ending up signed in as someone else.
   */
  const routes = new Map();
  /** tabId -> where that tab lives (a standing-by host, or null for this profile), so work on a tab
   *  always goes to the profile that has it. Chrome's tab ids are unique across profiles. */
  const homes = new Map();
  /** sessionId -> standing-by hosts that did work for the session, told when it ends. */
  const touched = new Map();
  const live = (target) => Boolean(target && !target.socket.destroyed);
  /** The tab a request is about. Upload chunks name theirs as forTab, so they go where the tab is. */
  const tabOf = (params) => (Number.isInteger(params.tabId) ? params.tabId : Number.isInteger(params.forTab) ? params.forTab : null);
  /** The profile behind a target: a standing-by host's, or this one's (null). */
  const profileOf = (target) => (target ? target.standby.profile : profile);
  /** Where agents can work: this profile first, then each one standing by that can take work. */
  const usable = () => [null, ...[...standbys].filter((s) => s.standby.relay && live(s))];
  /** Where a profile is now: null for this one, its standing-by host, or undefined if it isn't connected. */
  const targetOf = (profileId) => (profileId === profile.id ? null : usable().find((t) => t && t.standby.profile.id === profileId));
  /** The profile's tabs this session has, as far as the bridge knows. */
  const tabsAt = (target, sessionId) => [...homes.values()].filter((home) => home.sessionId === sessionId && home.target === target).length;
  let nextId = 1;

  /** The profile an agent asked for, by name (or a part of one only it has) or by id. */
  function findProfile(query) {
    const wanted = String(query).trim().replace(/^"(.*)"$/, '$1').toLowerCase();
    const targets = usable();
    const exact = targets.filter((t) => [profileOf(t).id.toLowerCase(), profileOf(t).name.toLowerCase()].includes(wanted));
    const matches = exact.length ? exact : targets.filter((t) => Boolean(wanted) && profileOf(t).name.toLowerCase().includes(wanted));
    if (matches.length === 1) return { target: matches[0] };
    const names = (list) => list.map((t) => profileLabel(profileOf(t))).join(', ');
    if (matches.length) return { error: `More than one Chrome profile matches "${query}": ${names(matches)}. Ask the user which one they mean.` };
    return {
      error: `No Chrome profile with Tabhand is called "${query}". ${targets.length === 1 ? 'Only one profile has Tabhand' : 'The profiles with Tabhand are'}: ${names(targets)}. Ask the user which one they mean (browser_list_profiles shows them).`,
    };
  }

  /** Points a session's new work at the profile the agent chose. */
  function pin(sessionId, target, want) {
    routes.set(sessionId, { profileId: profileOf(target).id, name: profileLabel(profileOf(target)), pinned: true, want });
  }

  /**
   * The session's route, with a choice carried over from before the bridge moved looked up now, if
   * that profile has connected. `problem` says why it can't be found yet.
   */
  function routeOf(sessionId) {
    const route = routes.get(sessionId);
    if (!route?.pinned || route.profileId) return { route };
    const found = findProfile(route.want);
    if (found.error) return { route, problem: found.error };
    pin(sessionId, found.target, route.want);
    return { route: routes.get(sessionId) };
  }

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
      client.label = String(message.label ?? 'Agent').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 40) || 'Agent';
      client.theme = /^[a-z]{1,16}$/.test(message.theme) ? message.theme : 'agent';
      client.conversation = typeof message.conversation === 'string' && /^[\w-]{8,100}$/.test(message.conversation) ? message.conversation : null;
      client.parent = Number.isInteger(message.parent) && message.parent > 1 ? message.parent : null;
      client.cwd = typeof message.cwd === 'string' ? message.cwd.slice(0, 1000) : '';
      // A session coming back keeps its id; a new one may be a restarted MCP server taking over.
      const known = aliases.get(sessionId) ?? (sessions.has(sessionId) || waiting.has(sessionId) ? sessionId : null);
      const id = known ?? reclaim(client) ?? sessionId;
      if (id !== sessionId) aliases.set(sessionId, id);
      client.sessionId = id;
      clearTimeout(endTimers.get(id));
      endTimers.delete(id);
      waiting.delete(id);
      const previous = sessions.get(id);
      if (previous && previous.socket !== client.socket) previous.socket.destroy();
      sessions.set(id, client);
      // Back after the bridge moved to another profile: its choice of profile still stands. That
      // profile may not have reconnected yet, so it's looked up when the session's next tab opens.
      if (message.profile && !routes.get(id)?.pinned) {
        const want = String(message.profile).slice(0, 80);
        routes.set(id, { profileId: null, name: `"${want}"`, pinned: true, want });
      }
      send(client.socket, { type: 'welcome', version: VERSION, profiles: true });
      log(known || id === sessionId ? 'session connected' : 'session taken over by a restarted agent');
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
        profile: cleanProfile(message.profile, newProfileId()),
      };
      standbys.add(client);
      log('another Chrome profile is standing by');
      return;
    }
    if (message.type === 'standby-profile' && client.standby) {
      client.standby.profile = cleanProfile(message.profile, client.standby.profile.id);
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
      const cmd = String(message.cmd ?? '');
      let params = message.params ?? {};
      const fail = (error) => send(client.socket, { type: 'response', id: message.id, ok: false, error });
      if (Object.hasOwn(bridgeCommands, cmd)) {
        bridgeCommands[cmd](client.sessionId).then(
          (result) => send(client.socket, { type: 'response', id: message.id, ok: true, result }),
          (error) => fail(String(error?.message ?? error)),
        );
        return;
      }
      if (cmd === 'open_tab' && params.profile !== undefined) {
        const { profile: want, ...rest } = params;
        params = rest;
        if (want !== null && String(want).trim()) {
          const found = findProfile(want);
          if (found.error) return fail(found.error);
          pin(client.sessionId, found.target, String(want).slice(0, 80));
        }
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        // It may have done something over there before going quiet: that profile hears when the session ends.
        if (entry.via) {
          if (!touched.has(entry.sessionId)) touched.set(entry.sessionId, new Set());
          touched.get(entry.sessionId).add(entry.via);
        }
        send(client.socket, { type: 'response', id: message.id, ok: false, error: 'Chrome did not answer in time.' });
      }, REQUEST_TIMEOUT_MS);
      const entry = { socket: client.socket, id: message.id, cmd, params, timer, startedAt: Date.now(), sessionId: client.sessionId, label: client.label, theme: client.theme, tried: new Set() };
      pending.set(id, entry);
      const forward = (userInChrome) => {
        entry.userInChrome = userInChrome;
        // Work on a tab goes where the tab is.
        const tabId = tabOf(params);
        const home = tabId === null ? undefined : homes.get(tabId);
        if (home) {
          if (live(home.target)) relay(home.target, id, entry);
          else toHere(id, entry);
          return;
        }
        // New work goes to the profile the agent chose, or where the session's work moved, or here.
        const { route, problem } = routeOf(client.sessionId);
        // Whether the agent chose this profile, as of now: it may choose another before the answer.
        entry.pinned = Boolean(route?.pinned);
        const target = route ? targetOf(route.profileId) : null;
        if (target === undefined && route.pinned) {
          answered(id, {
            ok: false,
            error: `Tabhand can't reach ${route.name}, the Chrome profile you chose: its Chrome window may be closed, or Tabhand may be off there. Ask the user to open it, or choose another profile with browser_open_tab's profile option (browser_list_profiles shows them).${problem ? ` (${problem})` : ''}`,
          });
        } else if (target) {
          relay(target, id, entry);
        } else {
          toHere(id, entry);
        }
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
      // That profile went away, with its tabs; work out with it won't come back. A session that
      // chose it keeps its choice, and hears that it's gone.
      for (const [sessionId, route] of routes) if (!route.pinned && route.profileId === client.standby.profile.id) routes.delete(sessionId);
      for (const [tabId, home] of homes) if (home.target === client) homes.delete(tabId);
      for (const hosts of touched.values()) hosts.delete(client);
      for (const [id, entry] of pending) if (entry.via === client) answered(id, { ok: false, error: 'The Chrome profile doing this was closed. Try again.' });
    }
    const { sessionId } = client;
    if (!sessionId || sessions.get(sessionId) !== client) return;
    sessions.delete(sessionId);
    const since = Date.now();
    waiting.set(sessionId, { conversation: client.conversation, parent: client.parent, cwd: client.cwd, label: client.label, since });
    // Agents reconnect after hiccups, and an agent's app may restart its MCP server: the session only
    // ends once its agent stays away. While its app is open, or its conversation may be resumed, it
    // waits longer for the new server.
    const end = () => {
      endTimers.delete(sessionId);
      waiting.delete(sessionId);
      for (const [alias, id] of aliases) if (id === sessionId || alias === sessionId) aliases.delete(alias);
      toExtension({ type: 'session-ended', sessionId });
      for (const target of touched.get(sessionId) ?? []) send(target.socket, { type: 'relay-end', sessionId });
      touched.delete(sessionId);
      routes.delete(sessionId);
      for (const [tabId, home] of homes) if (home.sessionId === sessionId) homes.delete(tabId);
      log('session ended');
    };
    const check = () => {
      const mayReturn = client.conversation || (client.parent && running(client.parent));
      if (mayReturn && Date.now() - since < RECONNECT_GRACE_MS) endTimers.set(sessionId, setTimeout(check, SESSION_GRACE_MS));
      else end();
    };
    endTimers.set(sessionId, setTimeout(check, SESSION_GRACE_MS));
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

  /** Asks one profile something for the bridge itself; resolves with its answer, whatever it is. */
  function ask(target, sessionId, cmd, params, ms = 5_000) {
    return new Promise((resolve) => {
      const id = nextId++;
      const entry = { cmd, params, sessionId, label: 'Tabhand', theme: 'agent', tried: new Set(), asked: resolve };
      entry.timer = setTimeout(() => answered(id, { ok: false, error: 'Chrome did not answer in time.' }), ms);
      pending.set(id, entry);
      if (target) relay(target, id, entry);
      else toHere(id, entry);
    });
  }

  /** Each profile agents can use, whether Tabhand is on there, and this session's tabs in it. */
  async function survey(sessionId) {
    const targets = usable();
    const answers = await Promise.all(targets.map((target) => ask(target, sessionId, 'list_tabs', {})));
    return targets.map((target, i) => ({
      target,
      profile: profileOf(target),
      answer: answers[i],
      state: answers[i].ok ? 'on' : PAUSED.test(String(answers[i].error ?? '')) ? 'paused' : 'not answering',
    }));
  }

  /** Requests about every profile, which the bridge answers itself. */
  const bridgeCommands = {
    async profiles(sessionId) {
      const { route } = routeOf(sessionId);
      const found = await survey(sessionId);
      const routed = route && found.find((p) => p.profile.id === route.profileId);
      // Where browser_open_tab would put a new tab now (see forward and answered).
      const next = route?.pinned ? routed : [routed, ...found].find((p) => p?.state === 'on');
      const outdated = [...standbys].filter((s) => !s.standby.relay && live(s));
      return {
        profiles: [
          ...found.map((p) => ({
            id: p.profile.id,
            name: p.profile.name,
            state: p.state,
            tabs: p.answer.ok ? (p.answer.result?.tabs ?? []).length : tabsAt(p.target, sessionId),
            newTabs: p === next,
            chosen: Boolean(route?.pinned && p === routed),
          })),
          // Hosts that started before Tabhand was updated can't take work until Chrome restarts them.
          ...outdated.map((s) => ({ id: s.standby.profile.id, name: s.standby.profile.name, state: 'outdated', tabs: 0, newTabs: false, chosen: false })),
        ],
        chosenMissing: route?.pinned && !routed ? route.name : null,
      };
    },

    // A session can have tabs in several profiles: list them all.
    async list_tabs(sessionId) {
      const found = await survey(sessionId);
      const several = found.length > 1;
      const tabs = [];
      const notes = [];
      for (const p of found) {
        if (p.answer.ok) {
          for (const tab of p.answer.result?.tabs ?? []) {
            if (Number.isInteger(tab?.tabId)) homes.set(tab.tabId, { target: p.target, sessionId });
            tabs.push(several ? { ...tab, profile: profileLabel(p.profile) } : tab);
          }
          continue;
        }
        const away = tabsAt(p.target, sessionId);
        if (away) {
          notes.push(`${away === 1 ? 'One more tab is' : `${away} more tabs are`} in ${profileLabel(p.profile)}, where ${p.state === 'paused' ? 'Tabhand is paused' : "Chrome isn't answering"}.`);
        }
      }
      if (!found.some((p) => p.answer.ok)) throw new Error(String(found[0].answer.error ?? 'Chrome did not answer.'));
      return { tabs, notes };
    },
  };

  /** The tabs an answer names: the one acted on, any it opened, or the session's list. */
  const tabsIn = (result) =>
    [result?.tabId, ...(result?.opened ?? []).map((t) => t?.tabId), ...(result?.tabs ?? []).map((t) => t?.tabId)].filter(Number.isInteger);

  /** A profile answered a request: this one's extension, or a standing-by host it went to. */
  function answered(id, message) {
    const entry = pending.get(id);
    if (!entry) return;
    if (entry.asked) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.asked(message);
      return;
    }
    const paused = !message.ok && PAUSED.test(String(message.error ?? ''));
    const route = routes.get(entry.sessionId);
    const where = profileLabel(profileOf(entry.via));
    if (paused && tabOf(entry.params) === null) {
      if (entry.pinned) {
        message = {
          ...message,
          error: `Tabhand is paused in ${where}, the Chrome profile you chose. Ask the user to click the Tabhand toolbar icon in that profile to resume, or choose another profile with browser_open_tab's profile option.`,
        };
      } else {
        // Paused in that profile: new work can go to this profile or to another one standing by,
        // wherever Tabhand is on.
        if (route && !route.pinned && route.profileId === profileOf(entry.via).id) routes.delete(entry.sessionId);
        if (!entry.triedHere) {
          toHere(id, entry);
          return;
        }
        const next = usable().find((target) => target && !entry.tried.has(target));
        if (next) {
          relay(next, id, entry);
          return;
        }
      }
    } else if (paused && usable().length > 1) {
      // Work on a tab waits for its profile: the tab isn't anywhere else.
      const stuck = route?.pinned && route.profileId === profileOf(entry.via).id;
      message = {
        ...message,
        error: `${message.error} This tab is in ${where}. ${stuck ? 'To carry on without it, choose another profile with browser_open_tab\'s profile option.' : 'To carry on without it, open a new tab with browser_open_tab: it opens in another profile if Tabhand is on there.'}`,
      };
    }
    pending.delete(id);
    clearTimeout(entry.timer);
    if (entry.via) {
      if (!touched.has(entry.sessionId)) touched.set(entry.sessionId, new Set());
      touched.get(entry.sessionId).add(entry.via);
      const moved = entry.via.standby.profile;
      if (message.ok && !route?.pinned && route?.profileId !== moved.id) {
        routes.set(entry.sessionId, { profileId: moved.id, name: profileLabel(moved), pinned: false });
        log('this profile is paused; a session moved to another profile');
      }
    }
    if (message.ok) for (const tabId of tabsIn(message.result)) homes.set(tabId, { target: entry.via ?? null, sessionId: entry.sessionId });
    let result = message.result;
    if (entry.cmd === 'diagnostics' && message.ok) {
      // Which copy of the extension is connected, and which others are standing by.
      result = { ...result, bridge: { version: VERSION, extensionId, profile, others: [...standbys].map((client) => client.standby) } };
    }
    // With several profiles, the agent hears which one its new tab opened in.
    if (entry.cmd === 'open_tab' && message.ok) result = { ...result, profileId: profileOf(entry.via).id, ...(usable().length > 1 ? { profile: where } : {}) };
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
