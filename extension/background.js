// Tabhand extension service worker.
//
// Agents never touch the user's tabs: each agent session gets its own tabs, opened in the
// background (active: false) inside a tab group named after the agent. All control goes through
// chrome.debugger on those tabs only, which works without raising Chrome or switching tabs.
// Focus emulation keeps background tabs rendering, so screenshots and input work there.

import { badgeImage, tabhandBadge } from './badge.js';
import { tabhandCursor } from './cursor.js';
import { renderSnapshot } from './snapshot.js';
import { themeFor } from './themes.js';

const HOST_NAME = 'dev.tabhand.bridge';
const VERSION = chrome.runtime.getManifest().version;
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/** @type {chrome.runtime.Port | null} */
let port = null;
let paused = false;

/** sessionId -> { label, groupId, windowId, tabIds: number[] } (persisted across worker restarts) */
let sessions = {};
const ready = chrome.storage.session.get(['sessions', 'paused']).then((stored) => {
  sessions = stored.sessions ?? {};
  paused = stored.paused ?? false;
  updateBadge();
});
const save = () => chrome.storage.session.set({ sessions, paused });

// ---------------------------------------------------------------- host connection

function connect() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch {
    port = null;
    return;
  }
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    port = null;
  });
  port.postMessage({ type: 'hello', version: VERSION });
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create('tabhand-tick', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  connect();
  detachIdleTabs();
});
connect();

async function onHostMessage(message) {
  await ready;
  if (message.type === 'session-ended') {
    await endSession(message.sessionId);
    return;
  }
  if (message.type !== 'request') return;
  const handler = handlers[message.cmd];
  try {
    if (!handler) throw new Error(`Unknown command: ${message.cmd}`);
    if (paused && message.cmd !== 'reload_extension') {
      throw new Error('The user paused Tabhand in Chrome. Ask them to click the Tabhand toolbar icon to resume.');
    }
    const result = await handler(message.sessionId, message.label, message.params ?? {}, message.theme);
    port?.postMessage({ type: 'response', id: message.id, ok: true, result });
  } catch (error) {
    port?.postMessage({ type: 'response', id: message.id, ok: false, error: String(error?.message ?? error) });
  }
}

// ---------------------------------------------------------------- pause switch

function updateBadge() {
  chrome.action.setBadgeText({ text: paused ? 'OFF' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
  chrome.action.setTitle({ title: paused ? 'Tabhand is paused. Click to resume.' : 'Tabhand is on. Click to pause.' });
}

async function setPaused(value) {
  paused = value;
  if (paused) {
    for (const session of Object.values(sessions)) {
      for (const tabId of session.tabIds) await detach(tabId);
    }
  }
  await save();
  updateBadge();
}

chrome.action.onClicked.addListener(async () => {
  await ready;
  await setPaused(!paused);
});

// ---------------------------------------------------------------- debugger plumbing

const attached = new Set();
/** Recent problems (load timeouts, dropped debugger connections), newest last, for diagnostics. */
const issues = [];
const noteIssue = (issue) => {
  issues.push({ at: new Date().toISOString(), ...issue });
  if (issues.length > 30) issues.shift();
};
/** tabId -> main-frame load counters, used to wait for navigations (including ones a click starts) */
const loads = new Map();
/** tabId -> last time an agent used it. Idle tabs are detached so Chrome's debugging bar goes away. */
const lastUsed = new Map();
const IDLE_DETACH_MS = 2 * 60_000;
/**
 * Tabs where another extension's frame (a password manager's autofill menu) has turned up; see
 * pastForeignFrames. They get no focus emulation: switching it on as the debugger re-attaches
 * would focus the page, and its focused field would bring the menu straight back.
 */
const quietTabs = new Set();
/** tabId -> how often the debugger has been knocked off the tab, and why, most recently */
const drops = new Map();
/** tabId -> recent automatic re-attaches, to give up on an extension that keeps coming back */
const reattaches = new Map();

async function detachIdleTabs() {
  for (const tabId of attached) {
    if (Date.now() - (lastUsed.get(tabId) ?? 0) > IDLE_DETACH_MS) await detach(tabId);
  }
}

/** Steps waiting for a debugger event from a tab (see waitForEvent) */
const eventWaiters = new Set();

/** Resolves with the event's params, or null after timeoutMs. */
function waitForEvent(tabId, method, timeoutMs) {
  return new Promise((resolve) => {
    const waiter = { tabId, method, resolve };
    eventWaiters.add(waiter);
    setTimeout(() => {
      eventWaiters.delete(waiter);
      resolve(null);
    }, timeoutMs);
  });
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  for (const waiter of eventWaiters) {
    if (waiter.tabId === source.tabId && waiter.method === method) {
      eventWaiters.delete(waiter);
      waiter.resolve(params);
    }
  }
  if (method === 'Page.windowOpen') expectedOpens.push({ openerTabId: source.tabId, at: Date.now() });
  // A new page has no cursor yet: put it back where the agent left it.
  if (method === 'Page.domContentEventFired') void presentCursor(source.tabId);
  const state = loads.get(source.tabId);
  if (!state) return;
  if (method === 'Page.domContentEventFired') {
    state.interactive = state.started;
    return;
  }
  if (params?.frameId !== state.mainFrameId) return;
  if (method === 'Page.frameStartedLoading') state.started++;
  else if (method === 'Page.frameStoppedLoading') state.stopped = state.started;
  else if (method === 'Page.navigatedWithinDocument') state.sameDocument++;
});

chrome.debugger.onDetach.addListener(async (source, reason) => {
  const { tabId } = source;
  if (tabId === undefined) return;
  noteIssue({ kind: 'detached', tabId, reason });
  drops.set(tabId, { count: (drops.get(tabId)?.count ?? 0) + 1, reason });
  attached.delete(tabId);
  loads.delete(tabId);
  cursorWorlds.delete(tabId);
  if (reason === 'canceled_by_user') {
    // The user clicked "Cancel" on Chrome's debugging bar: treat it as a stop button.
    await ready;
    await setPaused(true);
  } else if (reason === 'target_closed' && sessionOfTab(tabId) && !tooManyReattaches(tabId)) {
    // The tab is still the agent's, so another extension's frame most likely turned up (see
    // pastForeignFrames). Get straight back on, so a page load or step in progress can finish.
    quietTabs.add(tabId);
    reattaches.get(tabId).push(Date.now());
    attach(tabId).catch(() => {});
  }
});

// ---------------------------------------------------------------- tabs that pages open

/** windowId -> recently active tabs, newest last, so a stolen activation can be handed back */
const activeHistory = new Map();
/** The Chrome window that had focus before the current one (WINDOW_ID_NONE: another app had it). */
let focusedWindow = chrome.windows.WINDOW_ID_NONE;
let previousFocusedWindow = chrome.windows.WINDOW_ID_NONE;
/** Page.windowOpen events from agent tabs, waiting to be matched with the tab Chrome creates */
const expectedOpens = [];
/** opener tabId -> tabs it opened since the agent last asked, reported with the next result */
const openedBy = new Map();
const OPEN_MATCH_MS = 3_000;
const ADOPT_WINDOW_MS = 10_000;

const sessionOfTab = (tabId) => Object.values(sessions).find((session) => session.tabIds.includes(tabId));

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (cursorPresent(tabId)) inCursorWorld(tabId, { action: 'greet' }).catch(() => {});
  const history = (activeHistory.get(windowId) ?? []).filter((id) => id !== tabId);
  history.push(tabId);
  activeHistory.set(windowId, history.slice(-10));
});

/** Notes which tab the user has open in a window, so it can be handed back if a page steals it. */
async function rememberUserTab(windowId) {
  try {
    const [active] = await chrome.tabs.query({ active: true, windowId });
    if (!active || sessionOfTab(active.id)) return;
    const history = (activeHistory.get(windowId) ?? []).filter((id) => id !== active.id);
    history.push(active.id);
    activeHistory.set(windowId, history.slice(-10));
  } catch {}
}

chrome.windows.onFocusChanged.addListener((windowId) => {
  previousFocusedWindow = focusedWindow;
  focusedWindow = windowId;
});

/** Which agent tab opened this new tab, if any. Chrome's openerTabId is unreliable for background
 * tabs (it often names the user's active tab), so the debugger's windowOpen event decides first. */
function agentOpener(tab) {
  const now = Date.now();
  while (expectedOpens.length && now - expectedOpens[0].at > OPEN_MATCH_MS) expectedOpens.shift();
  const expected = expectedOpens.shift();
  if (expected && sessionOfTab(expected.openerTabId)) return expected.openerTabId;
  const opener = tab.openerTabId;
  if (opener !== undefined && sessionOfTab(opener) && now - (lastUsed.get(opener) ?? 0) < ADOPT_WINDOW_MS) return opener;
  return undefined;
}

// Links, window.open() and popups from an agent's tab belong to that agent: they join its tab
// group, and they must never take the user's place.
chrome.tabs.onCreated.addListener(async (tab) => {
  await ready;
  const openerTabId = agentOpener(tab);
  if (openerTabId === undefined) return;
  const session = sessionOfTab(openerTabId);
  session.tabIds.push(tab.id);
  lastUsed.set(tab.id, Date.now());
  openedBy.set(openerTabId, [...(openedBy.get(openerTabId) ?? []), tab.id]);
  chrome.tabs.update(tab.id, { muted: true }).catch(() => {});
  await save();
  try {
    const window = await chrome.windows.get(tab.windowId);
    if (window.type === 'normal') {
      if (tab.active) {
        // Hand the window back to the tab the user had before this one appeared.
        const previous = (activeHistory.get(tab.windowId) ?? []).filter((id) => id !== tab.id && !sessionOfTab(id)).at(-1);
        if (previous !== undefined) await chrome.tabs.update(previous, { active: true });
      }
      await addToGroup(session, tab.id, tab.windowId);
      await save();
    } else {
      // A popup window. If it took focus from a window the user was in, give it back. If the user
      // was in another app, leave Chrome alone: focusing a window would bring Chrome forward.
      await sleep(250);
      const userWindow = focusedWindow === tab.windowId ? previousFocusedWindow : chrome.windows.WINDOW_ID_NONE;
      if (userWindow !== chrome.windows.WINDOW_ID_NONE) await chrome.windows.update(userWindow, { focused: true });
    }
  } catch {}
});

/** Tabs the page opened since the last call, for the agent to know about. */
async function takeOpened(tabId) {
  const opened = openedBy.get(tabId) ?? [];
  openedBy.delete(tabId);
  const described = [];
  for (const id of opened) {
    try {
      const tab = await chrome.tabs.get(id);
      described.push({ tabId: id, url: tab.url || tab.pendingUrl || '', title: tab.title ?? '' });
    } catch {}
  }
  return described;
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  attached.delete(tabId);
  quietTabs.delete(tabId);
  drops.delete(tabId);
  cursorPos.delete(tabId);
  badged.delete(tabId);
  await ready;
  let changed = false;
  for (const session of Object.values(sessions)) {
    const index = session.tabIds.indexOf(tabId);
    if (index >= 0) {
      session.tabIds.splice(index, 1);
      changed = true;
    }
  }
  if (changed) await save();
});

/** Sends a debugger command, getting past other extensions' frames (see pastForeignFrames). */
async function send(tabId, method, params = {}) {
  const dropsBefore = drops.get(tabId)?.count ?? 0;
  try {
    return await sendNow(tabId, method, params);
  } catch (error) {
    // The debugger got knocked off mid-step: a password manager's menu appeared, most likely
    // because the step before focused a text field. Get back on, then send the command again if
    // it never went out or is harmless to repeat.
    const message = String(error?.message ?? error);
    const unsent = message.includes('is not attached');
    if (!unsent && !message.includes('Detached while handling command')) throw error;
    // The detach event can still be on its way; until it's handled, attach() thinks it's attached.
    await waitUntil(() => (drops.get(tabId)?.count ?? 0) > dropsBefore || !attached.has(tabId), 2_000);
    if (drops.get(tabId)?.reason !== 'target_closed' || !sessionOfTab(tabId) || tooManyReattaches(tabId)) throw error;
    await attach(tabId);
    if (!unsent && !repeatable(method, params)) throw new Interrupted();
    return sendNow(tabId, method, params);
  }
}

const sendNow = (tabId, method, params) =>
  pastForeignFrames(tabId, () => chrome.debugger.sendCommand({ tabId }, method, params));

/** A step cut short by another extension's frame; it may or may not have gone through. */
class Interrupted extends Error {
  constructor() {
    super(
      "A password manager's autofill menu (another extension) interrupted this step, so it may or may not have gone through. Take a new snapshot to check.",
    );
  }
}

/** False for commands that would do something twice if they had already gone through once. */
function repeatable(method, params) {
  if (method === 'Input.dispatchMouseEvent') return params.type !== 'mousePressed';
  if (method === 'Input.dispatchKeyEvent') return params.type === 'keyUp';
  return method !== 'Input.insertText' && method !== 'Page.navigate';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
  return true;
}

/** tabId -> attach in progress, so a step and an automatic re-attach don't trip over each other */
const attaching = new Map();

function attach(tabId) {
  if (attached.has(tabId)) return Promise.resolve();
  if (!attaching.has(tabId)) attaching.set(tabId, attachNow(tabId).finally(() => attaching.delete(tabId)));
  return attaching.get(tabId);
}

async function attachNow(tabId) {
  try {
    await pastForeignFrames(tabId, () => chrome.debugger.attach({ tabId }, '1.3'));
  } catch (error) {
    if (!String(error?.message ?? error).includes('Another debugger is already attached')) throw error;
  }
  attached.add(tabId);
  // sendNow, not send: send recovers from drops by attaching, which would wait on this.
  await sendNow(tabId, 'Page.enable');
  const { frameTree } = await sendNow(tabId, 'Page.getFrameTree');
  loads.set(tabId, { mainFrameId: frameTree.frame.id, started: 0, stopped: 0, interactive: 0, sameDocument: 0 });
  // Pages behave as if focused and keep rendering while the tab stays in the background (except in
  // quiet tabs, see there).
  if (!quietTabs.has(tabId)) await sendNow(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true });
}

/** True once another extension keeps knocking the debugger off a tab: time to give up on it. */
function tooManyReattaches(tabId) {
  const recent = (reattaches.get(tabId) ?? []).filter((at) => Date.now() - at < 30_000);
  reattaches.set(tabId, recent);
  return recent.length > 5;
}

/**
 * Chrome refuses every debugger call on a page that shows another extension's frame, such as a
 * password manager's autofill menu, and knocks the debugger off when one starts loading (see
 * onDetach). Agent tabs can do without those frames: take them out and try again.
 */
async function pastForeignFrames(tabId, call) {
  let extensions;
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (!String(error?.message ?? error).includes('different extension')) throw error;
      if (attempt === 4) {
        const which = extensions?.length ? ` (${extensions.join(', ')})` : '';
        throw new Error(
          `Another extension${which} shows its own frame in this page, and Chrome won't let Tabhand control a page while it does. Ask the user to turn that extension off for this site.`,
        );
      }
      if (!extensions) {
        quietTabs.add(tabId);
        extensions = await removeForeignFrames(tabId);
        noteIssue({ kind: 'foreign-frames', tabId, extensions });
      } else {
        // A removed frame can take a moment to go away, and the extension may have added another.
        await sleep(150);
        await removeForeignFrames(tabId);
      }
    }
  }
}

/** Removes other extensions' frames from every frame of a page; returns those extensions' ids. */
async function removeForeignFrames(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      args: [chrome.runtime.id],
      func: (ownId) => {
        const ids = new Set();
        // Runs as a content script, which (unlike the debugger) can see into closed shadow roots,
        // where password managers keep their menus.
        const visit = (root) => {
          for (const element of root.querySelectorAll('*')) {
            const id = /^chrome-extension:\/\/([a-p]{32})/.exec(element.src || element.data || '')?.[1];
            if (id && id !== ownId && /^(IFRAME|FRAME|EMBED|OBJECT)$/.test(element.tagName)) {
              ids.add(id);
              element.remove();
              continue;
            }
            // Only HTML elements can host shadow roots; asking about an SVG element throws.
            const shadow = element instanceof HTMLElement ? chrome.dom?.openOrClosedShadowRoot?.(element) : null;
            if (shadow) visit(shadow);
          }
        };
        visit(document);
        return [...ids];
      },
    });
    return [...new Set(results.flatMap((frame) => frame.result ?? []))];
  } catch {
    return [];
  }
}

/** Lets go of a tab. The cursor fades out first, unless the tab is about to close anyway. */
async function detach(tabId, { keepCursor = false } = {}) {
  if (!attached.has(tabId)) {
    if (!keepCursor) await removeCursorWithoutDebugger(tabId);
    return;
  }
  if (!keepCursor) await dismissCursor(tabId);
  attached.delete(tabId);
  loads.delete(tabId);
  cursorWorlds.delete(tabId);
  try {
    await pastForeignFrames(tabId, () => chrome.debugger.detach({ tabId }));
  } catch {}
}

// ---------------------------------------------------------------- agent cursor

const CURSOR_SOURCE = tabhandCursor.toString();
/** tabId -> isolated world running the cursor overlay, tied to the current main-frame document */
const cursorWorlds = new Map();

const BADGE_SOURCE = tabhandBadge.toString();
const inCursorWorld = (tabId, options) => inWorld(tabId, CURSOR_SOURCE, options);

/** Runs one of our page functions in the tab's isolated world (made once per document). */
async function inWorld(tabId, source, options) {
  const expression = `(${source})(${JSON.stringify(options)})`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = loads.get(tabId);
    if (!state) return;
    let world = cursorWorlds.get(tabId);
    if (!world || world.started !== state.started) {
      const { executionContextId } = await send(tabId, 'Page.createIsolatedWorld', {
        frameId: state.mainFrameId,
        worldName: 'tabhand',
      });
      world = { contextId: executionContextId, started: state.started };
      cursorWorlds.set(tabId, world);
    }
    try {
      const response = await send(tabId, 'Runtime.evaluate', { expression, contextId: world.contextId, awaitPromise: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
      return;
    } catch (error) {
      cursorWorlds.delete(tabId);
      if (attempt === 1) throw error;
    }
  }
}

/** True when the user can see the tab, which is the only time the cursor animates. */
async function watched(tabId) {
  try {
    return (await chrome.tabs.get(tabId)).active;
  } catch {
    return false;
  }
}

/** tabId -> where the agent's cursor last was, so it can sit there across page loads */
const cursorPos = new Map();

const cursorPresent = (tabId) => {
  const world = cursorWorlds.get(tabId);
  return Boolean(world) && attached.has(tabId) && world.started === loads.get(tabId)?.started;
};

/** Shows the cursor sitting where the agent left it (or a little right of center). Cosmetic. */
async function presentCursor(tabId, { greet = false } = {}) {
  const session = sessionOfTab(tabId);
  if (!session || !attached.has(tabId)) return;
  try {
    let position = cursorPos.get(tabId);
    if (!position) {
      const { cssVisualViewport: viewport } = await send(tabId, 'Page.getLayoutMetrics');
      position = { x: Math.round(viewport.clientWidth * 0.6), y: Math.round(viewport.clientHeight * 0.55) };
      cursorPos.set(tabId, position);
    }
    await inCursorWorld(tabId, {
      action: 'move',
      ...position,
      click: false,
      animate: false,
      greet: greet && (await watched(tabId)),
      label: session.label,
      theme: themeFor(session.theme),
    });
  } catch {}
  if (badged.get(tabId) !== loads.get(tabId)?.started) void applyBadge(tabId);
}

// ---------------------------------------------------------------- tab badge

/** tabId -> the document (load count) whose icon currently carries the badge */
const badged = new Map();
/** Marks the tab's icon with the agent's arrow while the agent works there. Cosmetic: never fails. */
async function applyBadge(tabId) {
  const session = sessionOfTab(tabId);
  if (!session || !attached.has(tabId)) return;
  const page = loads.get(tabId)?.started;
  try {
    await inWorld(tabId, BADGE_SOURCE, { action: 'set', href: badgeImage(themeFor(session.theme)) });
    badged.set(tabId, page);
  } catch {}
}

async function clearBadge(tabId) {
  if (badged.get(tabId) !== loads.get(tabId)?.started) return;
  badged.delete(tabId);
  try {
    await inWorld(tabId, BADGE_SOURCE, { action: 'clear' });
  } catch {}
}

/** Fades the cursor out while the debugger can still reach the page. */
async function dismissCursor(tabId) {
  await clearBadge(tabId);
  if (!cursorPresent(tabId)) return;
  try {
    await inCursorWorld(tabId, { action: 'leave' });
    await sleep(380);
  } catch {}
  cursorWorlds.delete(tabId);
}

/** After the user cancels debugging the debugger is gone; remove the overlay another way. */
async function removeCursorWithoutDebugger(tabId) {
  badged.delete(tabId);
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.querySelectorAll('tabhand-cursor').forEach((element) => element.remove()),
    });
    await chrome.scripting.executeScript({ target: { tabId }, func: tabhandBadge, args: [{ action: 'clear' }] });
  } catch {}
}

/** Moves the agent cursor to x, y. Cosmetic: never fails the action. */
async function showCursor(tabId, sessionId, x, y, { click = false, animate } = {}) {
  const session = sessions[sessionId];
  cursorPos.set(tabId, { x, y });
  try {
    await inCursorWorld(tabId, {
      action: 'move',
      x,
      y,
      click,
      label: session?.label,
      theme: themeFor(session?.theme),
      animate: animate ?? (await watched(tabId)),
    });
  } catch {}
}

async function setTyping(tabId, typing) {
  const world = cursorWorlds.get(tabId);
  if (!world || world.started !== loads.get(tabId)?.started) return;
  try {
    await inCursorWorld(tabId, { action: 'typing', typing });
  } catch {}
}

/** Types text; while the user watches, at a readable pace with the cursor's typing dots. */
async function insertText(tabId, text) {
  if (!(await watched(tabId)) || text.length > 400) {
    await insertChunk(tabId, text);
    return;
  }
  await setTyping(tabId, true);
  try {
    const chunk = Math.max(1, Math.ceil(text.length / 45));
    for (let i = 0; i < text.length; i += chunk) {
      await insertChunk(tabId, text.slice(i, i + chunk));
      await sleep(28);
    }
  } finally {
    await setTyping(tabId, false);
  }
}

/** The text of the focused field (looking into shadow roots), to tell whether typing landed. */
const FOCUSED_TEXT = `(() => {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element ? String(element.value ?? element.textContent ?? '') : '';
})()`;

/** Types into the focused field; if a password manager's menu cuts it short, types it again only
 * if it didn't land. */
async function insertChunk(tabId, text) {
  const before = await send(tabId, 'Runtime.evaluate', { expression: FOCUSED_TEXT, returnByValue: true }).catch(() => null);
  try {
    await send(tabId, 'Input.insertText', { text });
  } catch (error) {
    if (!(error instanceof Interrupted) || !before) throw error;
    const after = await send(tabId, 'Runtime.evaluate', { expression: FOCUSED_TEXT, returnByValue: true });
    if (after.result.value === before.result.value) await send(tabId, 'Input.insertText', { text });
  }
}

async function setCursorHidden(tabId, hidden) {
  const world = cursorWorlds.get(tabId);
  if (!world || world.started !== loads.get(tabId)?.started) return;
  try {
    await inCursorWorld(tabId, { action: hidden ? 'hide' : 'show' });
  } catch {}
}

// ---------------------------------------------------------------- sessions and tabs

function sessionFor(sessionId, label, theme) {
  sessions[sessionId] ??= { label, theme: theme ?? 'agent', groupId: null, windowId: null, tabIds: [] };
  return sessions[sessionId];
}

/** Every tab command goes through here: agents can only reach tabs their own session opened. */
async function ownedTab(sessionId, tabId, { debug = true } = {}) {
  const session = sessions[sessionId];
  if (!session || !session.tabIds.includes(tabId)) {
    throw new Error(`Tab ${tabId} is not one of this session's tabs. Use browser_open_tab or browser_list_tabs.`);
  }
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error(`Tab ${tabId} was closed.`);
  }
  if (!debug) return tabId;
  await rememberUserTab(tab.windowId);
  lastUsed.set(tabId, Date.now());
  await attach(tabId);
  if (!cursorPresent(tabId)) await presentCursor(tabId);
  return tabId;
}

async function pickWindow(session) {
  if (session.windowId !== null) {
    try {
      const window = await chrome.windows.get(session.windowId);
      if (window.type === 'normal' && !window.incognito) return window.id;
    } catch {}
  }
  try {
    const window = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (!window.incognito) return window.id;
  } catch {}
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const existing = windows.find((window) => !window.incognito);
  if (existing) return existing.id;
  const created = await chrome.windows.create({ focused: false, url: 'about:blank' });
  return created.id;
}

async function retry(fn, attempts = 5) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (error) {
      // Tab strip edits fail while the user is dragging a tab.
      if (i >= attempts || !String(error?.message ?? error).includes('cannot be edited')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

async function addToGroup(session, tabId, windowId) {
  if (session.groupId !== null) {
    try {
      const group = await chrome.tabGroups.get(session.groupId);
      if (group.windowId === windowId) {
        await retry(() => chrome.tabs.group({ groupId: session.groupId, tabIds: [tabId] }));
        return;
      }
    } catch {}
  }
  session.groupId = await retry(() => chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } }));
  await chrome.tabGroups.update(session.groupId, { title: session.label, color: themeFor(session.theme).group });
}

async function endSession(sessionId) {
  const session = sessions[sessionId];
  if (!session) return;
  for (const tabId of session.tabIds) await detach(tabId);
  if (session.groupId !== null) {
    try {
      await chrome.tabGroups.update(session.groupId, { title: `${session.label} (done)`, color: 'grey' });
    } catch {}
  }
  delete sessions[sessionId];
  await save();
}

function normalizeUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('A URL is required.');
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw)
    ? raw
    : /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(raw)
      ? `http://${raw}`
      : `https://${raw}`;
  const url = new URL(withScheme);
  if (!ALLOWED_SCHEMES.has(url.protocol)) throw new Error(`Only http and https pages are allowed, not ${url.protocol}`);
  return url.href;
}

async function describe(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return { tabId, url: tab.url ?? '', title: tab.title ?? '' };
}

const loadState = (tabId) => loads.get(tabId) ?? { started: 0, stopped: 0, interactive: 0, sameDocument: 0 };
// After DOMContentLoaded, how long to wait for the rest (images, video) before handing back.
// Heavy feeds like X keep loading media for many seconds after they're usable.
const LOAD_GRACE_MS = 3_000;

/** Waits until the navigation that started after `before` is usable: its DOM is ready, and then
 * either it finished loading or the grace period ran out. */
async function waitForPage(tabId, before, timeoutMs) {
  const tracked = loads.get(tabId);
  const dropped = () => loads.get(tabId) !== tracked;
  const ready = await waitUntil(() => {
    const state = loadState(tabId);
    return dropped() || (state.started > before && (state.interactive >= state.started || state.stopped >= state.started));
  }, timeoutMs);
  if (ready && dropped()) {
    // Knocked off mid-load (see pastForeignFrames), so the load events were missed.
    await documentReady(tabId, timeoutMs);
    return;
  }
  if (!ready) {
    const state = loadState(tabId);
    noteIssue({ kind: 'load-timeout', tabId, before, ...state, attached: attached.has(tabId) });
    return;
  }
  await waitUntil(() => dropped() || loadState(tabId).stopped >= loadState(tabId).started, LOAD_GRACE_MS);
}

/** Waits until the debugger is back on the tab and its page has parsed. */
async function documentReady(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await attach(tabId);
      const { result } = await send(tabId, 'Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      if (result.value !== 'loading') return;
    } catch {}
    await sleep(200);
  }
}

async function navigate(tabId, url) {
  const before = loadState(tabId).started;
  const result = await send(tabId, 'Page.navigate', { url });
  if (result.errorText) throw new Error(`Could not open ${url}: ${result.errorText}`);
  if (result.loaderId) await waitForPage(tabId, before, 20_000);
}

/** Call before an input event, then settle() after it: waits for any navigation it started. */
function watchNavigation(tabId) {
  const { started, sameDocument } = loadState(tabId);
  return async () => {
    await sleep(400);
    const state = loadState(tabId);
    const loading = state.started > started;
    if (loading) await waitForPage(tabId, started, 15_000);
    return loading || state.sameDocument > sameDocument;
  };
}

// ---------------------------------------------------------------- input helpers

const backgroundTabModifier = chrome.runtime.getPlatformInfo().then(({ os }) => (os === 'mac' ? 4 : 2));

/** True when clicking the element follows a link into a new tab or window (target=_blank etc.). */
async function opensNewTab(tabId, backendNodeId) {
  try {
    const { object } = await send(tabId, 'DOM.resolveNode', { backendNodeId });
    const { result } = await send(tabId, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      returnByValue: true,
      functionDeclaration: `function () {
        const link = this.closest?.('a[href], area[href]');
        if (!link) return false;
        const target = (link.getAttribute('target') || document.querySelector('base[target]')?.getAttribute('target') || '').toLowerCase();
        return target !== '' && !['_self', '_parent', '_top'].includes(target);
      }`,
    });
    return result.value === true;
  } catch {
    return false;
  }
}

/** A left click at x, y, as the user would make it. */
async function pressAt(tabId, x, y, modifiers = 0) {
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  const press = { x, y, button: 'left', clickCount: 1, modifiers };
  // A press cut short by a password manager's menu went through: its focus is what brought it up.
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...press }).catch((error) => {
    if (!(error instanceof Interrupted)) throw error;
  });
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...press });
}

/** uploadId -> the session sending it and each file's base64 pieces, until upload_files */
const uploads = new Map();

async function isFileField(tabId, backendNodeId) {
  const { node } = await send(tabId, 'DOM.describeNode', { backendNodeId });
  const attributes = node.attributes ?? [];
  const type = attributes[attributes.indexOf('type') + 1];
  return node.nodeName === 'INPUT' && attributes.includes('type') && type?.toLowerCase() === 'file';
}

/** Clicks something that opens a file picker, with the picker intercepted; returns its field. */
async function fileFieldFromPicker(tabId, sessionId, backendNodeId) {
  await send(tabId, 'Page.setInterceptFileChooserDialog', { enabled: true });
  try {
    const opened = waitForEvent(tabId, 'Page.fileChooserOpened', 5_000);
    const { x, y } = await elementCenter(tabId, backendNodeId);
    await showCursor(tabId, sessionId, x, y, { click: true });
    await pressAt(tabId, x, y);
    const chooser = await opened;
    if (!chooser?.backendNodeId) {
      throw new Error("Clicking that didn't open a file picker. Pass the ref of the file field, or of the button that opens the picker.");
    }
    return chooser.backendNodeId;
  } finally {
    await send(tabId, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
  }
}

/** Runs on the file field in the page: hands it the files as if the user had picked them. */
const ATTACH_FILES = `function (files) {
  if (files.length > 1 && !this.multiple) throw new Error('That field takes one file at a time.');
  const transfer = new DataTransfer();
  for (const { name, type, base64 } of files) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    transfer.items.add(new File([bytes], name, { type }));
  }
  this.files = transfer.files;
  this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
}`;

function refToNodeId(ref) {
  const match = /^e(\d+)$/.exec(String(ref ?? '').trim());
  if (!match) throw new Error(`"${ref}" is not a ref from browser_snapshot (they look like e123).`);
  return Number(match[1]);
}

async function elementCenter(tabId, backendNodeId) {
  try {
    await send(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
  } catch {}
  let quads;
  try {
    ({ quads } = await send(tabId, 'DOM.getContentQuads', { backendNodeId }));
  } catch {
    throw new Error('That element no longer exists. Take a new browser_snapshot.');
  }
  if (!quads?.length) throw new Error('That element is not visible on the page. Take a new browser_snapshot.');
  const quad = quads[0];
  return { x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4, y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4 };
}

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Space: { code: 'Space', keyCode: 32, text: ' ', key: ' ' },
};
const MODIFIERS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Command: 4, Shift: 8 };

async function pressKey(tabId, combo) {
  const parts = String(combo).split('+');
  const name = parts.pop();
  let modifiers = 0;
  for (const part of parts) {
    if (!(part in MODIFIERS)) throw new Error(`Unknown modifier "${part}". Use Alt, Control, Meta or Shift.`);
    modifiers |= MODIFIERS[part];
  }
  let event;
  if (KEYS[name]) {
    const { code, keyCode, text, key } = KEYS[name];
    event = { key: key ?? name, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, text };
  } else if (name.length === 1) {
    const upper = name.toUpperCase();
    const isLetter = upper >= 'A' && upper <= 'Z';
    event = {
      key: name,
      code: isLetter ? `Key${upper}` : undefined,
      windowsVirtualKeyCode: isLetter ? upper.charCodeAt(0) : name.charCodeAt(0),
      text: modifiers & ~8 ? undefined : name,
    };
  } else {
    throw new Error(`Unknown key "${name}".`);
  }
  await send(tabId, 'Input.dispatchKeyEvent', { type: event.text ? 'keyDown' : 'rawKeyDown', modifiers, ...event });
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...event, text: undefined });
}

// ---------------------------------------------------------------- commands

const PAGE_TIMING = `(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  return {
    domContentLoaded: Math.round(nav?.domContentLoadedEventEnd ?? -1),
    load: Math.round(nav?.loadEventEnd ?? -1),
    readyState: document.readyState,
    visibility: document.visibilityState,
    pendingImages: [...document.images].filter((image) => !image.complete).length,
    videos: [...document.querySelectorAll('video')].map((video) => video.readyState + '/' + video.networkState + (video.paused ? '' : ' playing')),
    iframes: document.querySelectorAll('iframe').length,
  };
})()`;

const handlers = {
  async open_tab(sessionId, label, { url }, theme) {
    const target = url ? normalizeUrl(url) : null;
    const session = sessionFor(sessionId, label, theme);
    const windowId = await pickWindow(session);
    session.windowId = windowId;
    // Time each step; a slow open gets recorded in diagnostics with the step that stalled.
    const timings = {};
    let mark = Date.now();
    const timed = async (name, work) => {
      const result = await work();
      timings[name] = Date.now() - mark;
      mark = Date.now();
      return result;
    };
    const tab = await timed('create', () => chrome.tabs.create({ windowId, url: 'about:blank', active: false }));
    // Pages think the user is watching (so they keep rendering) and may autoplay; keep them quiet.
    chrome.tabs.update(tab.id, { muted: true }).catch(() => {});
    session.tabIds.push(tab.id);
    lastUsed.set(tab.id, Date.now());
    await save();
    await timed('group', async () => {
      await addToGroup(session, tab.id, windowId);
      await save();
    });
    await timed('attach', () => attach(tab.id));
    if (target) await timed('load', () => navigate(tab.id, target));
    if (!cursorPresent(tab.id)) await timed('cursor', () => presentCursor(tab.id));
    const total = Object.values(timings).reduce((sum, ms) => sum + ms, 0);
    if (total > 5_000) noteIssue({ kind: 'slow-open', tabId: tab.id, timings });
    return describe(tab.id);
  },

  async navigate(sessionId, _label, { tabId, url }) {
    await ownedTab(sessionId, tabId);
    await navigate(tabId, normalizeUrl(url));
    return describe(tabId);
  },

  async snapshot(sessionId, _label, { tabId }) {
    await ownedTab(sessionId, tabId);
    const { nodes } = await send(tabId, 'Accessibility.getFullAXTree');
    return { ...(await describe(tabId)), snapshot: renderSnapshot(nodes) };
  },

  async click(sessionId, _label, { tabId, ref, debugCursor }) {
    await ownedTab(sessionId, tabId);
    const backendNodeId = refToNodeId(ref);
    const { x, y } = await elementCenter(tabId, backendNodeId);
    await showCursor(tabId, sessionId, x, y, { click: true, animate: debugCursor || undefined });
    // Links that open a new tab get the Cmd/Ctrl-click treatment: Chrome then opens them in the
    // background instead of switching the user's window to them.
    const newTab = await opensNewTab(tabId, backendNodeId);
    if (newTab) expectedOpens.push({ openerTabId: tabId, at: Date.now() });
    const modifiers = newTab ? await backgroundTabModifier : 0;
    const settle = watchNavigation(tabId);
    await pressAt(tabId, x, y, modifiers);
    const navigated = await settle();
    return { ...(await describe(tabId)), navigated, opened: await takeOpened(tabId) };
  },

  // Files arrive in pieces: messages to an extension are capped at 1 MB.
  async upload_part(sessionId, _label, { uploadId, file, data }) {
    for (const [id, upload] of uploads) if (Date.now() - upload.at > 10 * 60_000) uploads.delete(id);
    const upload = uploads.get(uploadId) ?? { sessionId, at: Date.now(), files: [] };
    if (upload.sessionId !== sessionId) throw new Error('Unknown upload.');
    (upload.files[file] ??= []).push(data);
    uploads.set(uploadId, upload);
    return {};
  },

  async upload_files(sessionId, _label, { tabId, ref, uploadId, files }) {
    const upload = uploads.get(uploadId);
    uploads.delete(uploadId);
    if (upload && upload.sessionId !== sessionId) throw new Error('Unknown upload.');
    await ownedTab(sessionId, tabId);
    const backendNodeId = refToNodeId(ref);
    const settle = watchNavigation(tabId);
    // A file field takes the files directly. Anything else is a button that opens a file picker:
    // click it with the picker intercepted (no system dialog) and use the field it was for.
    const field = (await isFileField(tabId, backendNodeId)) ? backendNodeId : await fileFieldFromPicker(tabId, sessionId, backendNodeId);
    const { object } = await send(tabId, 'DOM.resolveNode', { backendNodeId: field });
    const payload = files.map((file, index) => ({ ...file, base64: (upload?.files[index] ?? []).join('') }));
    const { exceptionDetails } = await send(tabId, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: ATTACH_FILES,
      arguments: [{ value: payload }],
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description?.split('\n')[0] ?? exceptionDetails.text);
    const navigated = await settle();
    return { ...(await describe(tabId)), navigated, opened: await takeOpened(tabId) };
  },

  async type(sessionId, _label, { tabId, ref, text, submit, clear }) {
    await ownedTab(sessionId, tabId);
    const settle = watchNavigation(tabId);
    if (ref !== undefined && ref !== null && ref !== '') {
      const backendNodeId = refToNodeId(ref);
      const { x, y } = await elementCenter(tabId, backendNodeId);
      await showCursor(tabId, sessionId, x, y, { click: true });
      await send(tabId, 'DOM.focus', { backendNodeId });
      if (clear) {
        const { object } = await send(tabId, 'DOM.resolveNode', { backendNodeId });
        await send(tabId, 'Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: `function () {
            if (typeof this.select === 'function') { this.select(); return; }
            const range = document.createRange();
            range.selectNodeContents(this);
            const selection = getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
          }`,
        });
        if (!text) await pressKey(tabId, 'Backspace');
      }
    }
    if (text) await insertText(tabId, String(text));
    if (submit) await pressKey(tabId, 'Enter');
    const navigated = await settle();
    return { ...(await describe(tabId)), navigated, opened: await takeOpened(tabId) };
  },

  async press_key(sessionId, _label, { tabId, key }) {
    await ownedTab(sessionId, tabId);
    const settle = watchNavigation(tabId);
    await pressKey(tabId, key);
    const navigated = await settle();
    return { ...(await describe(tabId)), navigated, opened: await takeOpened(tabId) };
  },

  async scroll(sessionId, _label, { tabId, direction = 'down', amount = 600 }) {
    await ownedTab(sessionId, tabId);
    const { cssVisualViewport } = await send(tabId, 'Page.getLayoutMetrics');
    const x = cssVisualViewport.clientWidth / 2;
    const y = cssVisualViewport.clientHeight / 2;
    const delta = Math.max(1, Math.min(Number(amount) || 600, 10_000));
    await send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX: 0,
      deltaY: direction === 'up' ? -delta : delta,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const scrolled = await send(tabId, 'Runtime.evaluate', {
      expression: '({ y: Math.round(scrollY), max: Math.round(document.documentElement.scrollHeight - innerHeight) })',
      returnByValue: true,
    });
    return { ...(await describe(tabId)), scroll: scrolled.result.value };
  },

  async screenshot(sessionId, _label, { tabId, fullPage, keepCursor }) {
    await ownedTab(sessionId, tabId);
    const params = { format: 'jpeg', quality: 80 };
    if (fullPage) {
      const { cssContentSize } = await send(tabId, 'Page.getLayoutMetrics');
      params.captureBeyondViewport = true;
      params.clip = {
        x: 0,
        y: 0,
        width: Math.ceil(cssContentSize.width),
        height: Math.min(Math.ceil(cssContentSize.height), 8000),
        scale: 1,
      };
    }
    if (!keepCursor) await setCursorHidden(tabId, true);
    try {
      const { data } = await send(tabId, 'Page.captureScreenshot', params);
      return { ...(await describe(tabId)), mimeType: 'image/jpeg', data };
    } finally {
      if (!keepCursor) await setCursorHidden(tabId, false);
    }
  },

  async diagnostics(sessionId) {
    // For tests: who owns the active tab in each window. No URLs or titles.
    const session = sessions[sessionId];
    const agentTabs = new Set(Object.values(sessions).flatMap((s) => s.tabIds));
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal', 'popup'] });
    return {
      windows: windows.map((window) => {
        const active = window.tabs.find((tab) => tab.active);
        const owner = !active
          ? 'none'
          : session?.tabIds.includes(active.id)
            ? 'this-session'
            : agentTabs.has(active.id)
              ? 'other-agent'
              : 'user';
        return { type: window.type, focused: window.focused, tabs: window.tabs.length, activeTab: owner };
      }),
      sessionTabs: session?.tabIds.length ?? 0,
      issues,
      version: chrome.runtime.getManifest().version,
    };
  },

  async timing(sessionId, _label, { tabId }) {
    // For tests: the page's own load timing, to tell a slow page from a slow bridge.
    await ownedTab(sessionId, tabId);
    const { result } = await send(tabId, 'Runtime.evaluate', { expression: PAGE_TIMING, returnByValue: true });
    return result.value;
  },

  async baseline_timing(_sessionId, _label, { url }) {
    // For tests: load a page in a plain background tab with no debugger, cursor or badge.
    const started = Date.now();
    const tab = await chrome.tabs.create({ url: normalizeUrl(url), active: false });
    try {
      await new Promise((resolve) => {
        const done = (tabId, change) => {
          if (tabId === tab.id && change.status === 'complete') finish();
        };
        const finish = () => {
          chrome.tabs.onUpdated.removeListener(done);
          resolve();
        };
        chrome.tabs.onUpdated.addListener(done);
        setTimeout(finish, 30_000);
      });
      const elapsed = Date.now() - started;
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const nav = performance.getEntriesByType('navigation')[0];
          return { domContentLoaded: Math.round(nav?.domContentLoadedEventEnd ?? -1), load: Math.round(nav?.loadEventEnd ?? -1) };
        },
      });
      return { elapsed, ...result };
    } finally {
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
  },

  async list_tabs(sessionId) {
    const session = sessions[sessionId];
    if (!session) return { tabs: [] };
    const tabs = [];
    for (const tabId of session.tabIds) {
      try {
        tabs.push(await describe(tabId));
      } catch {}
    }
    return { tabs };
  },

  async reload_extension() {
    // Lets `tabhand reload` pick up new code from disk without a trip to chrome://extensions.
    setTimeout(() => chrome.runtime.reload(), 200);
    return { reloading: true };
  },

  async close_tab(sessionId, _label, { tabId }) {
    await ownedTab(sessionId, tabId, { debug: false });
    await detach(tabId, { keepCursor: true });
    await chrome.tabs.remove(tabId);
    return { closed: tabId };
  },
};
