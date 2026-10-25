// The toolbar panel: what agents are doing in this Chrome profile, one switch that pauses them all,
// and the profile's name. The service worker keeps the state; the panel asks for it while it's open.

import { themeFor } from './themes.js';

const $ = (id) => document.getElementById(id);
const SETUP_COMMAND = 'npx tabhand setup';
// Chrome closes a toolbar popup when it asks for a permission, so asking for the email happens in
// this same page opened as a small window of its own.
const inWindow = location.hash === '#name';

let state = null;
let naming = inWindow;
let dismissed = false;
let saidSomething = 0;

const ask = (message) => chrome.runtime.sendMessage(message);

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const host = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** The agent's own cursor, as it shows in its tabs. */
function arrow(theme) {
  const [from, to] = themeFor(theme).arrow;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '3 2 19 23');
  svg.setAttribute('width', '17');
  svg.setAttribute('height', '20');
  svg.setAttribute('aria-hidden', 'true');
  const id = `arrow-${Math.random().toString(36).slice(2, 8)}`;
  svg.innerHTML = `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0.55" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><polygon points="5,4 5.8,23.2 10.6,18.4 19.6,17.8" fill="url(#${id})" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/>`;
  return svg;
}

function headline(lead, word) {
  const h1 = $('headline');
  const mark = document.createElement('em');
  mark.className = 'mark';
  mark.textContent = word;
  h1.replaceChildren(`${lead} `, mark);
}

function show(id, text) {
  const element = $(id);
  element.hidden = text === undefined || text === null;
  if (typeof text === 'string') element.textContent = text;
}

function agentRow(agent) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'agent';
  row.title = 'Show its tabs';
  const who = document.createElement('div');
  who.className = 'who';
  const name = document.createElement('b');
  name.textContent = agent.label;
  const tabs = document.createElement('span');
  const hosts = [...new Set(agent.tabs.map((tab) => host(tab.url)).filter(Boolean))];
  tabs.textContent = state.paused ? `${plural(agent.tabs.length, 'tab')}, on hold` : [plural(agent.tabs.length, 'tab'), hosts.join(', ')].filter(Boolean).join(' · ');
  who.append(name, tabs);
  const live = document.createElement('i');
  live.className = 'live';
  row.append(arrow(agent.theme), who, live);
  row.addEventListener('click', async () => {
    const [tab] = agent.tabs;
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    window.close();
  });
  return row;
}

function render() {
  if (!state) return;
  const { paused, helper, agents, name, version } = state;
  const kind = paused ? 'paused' : helper === 'missing' ? 'setup' : helper === 'standby' ? 'standby' : helper === 'off' ? 'away' : agents.length ? 'working' : 'ready';
  document.body.dataset.state = kind;

  $('chip').textContent = name || 'Not named';
  show('agents', agents.length && (kind === 'working' || kind === 'paused') ? true : null);
  $('agents-label').textContent = paused ? 'Waiting' : 'Working now';
  $('agents-count').textContent = String(agents.length);
  $('agent-list').replaceChildren(...agents.map(agentRow));

  const toggle = $('toggle');
  toggle.className = paused ? 'pill hot' : 'pill';
  toggle.textContent = paused ? 'Resume' : kind === 'standby' ? 'Pause Tabhand here' : 'Pause every agent';
  toggle.hidden = kind === 'setup' || kind === 'away';
  $('command').hidden = !(kind === 'setup' || kind === 'away');

  if (kind === 'working') {
    headline('Agents are', 'working.');
    show('lede', null);
    show('note', 'They only see the tabs they opened. Yours stay yours.');
  } else if (kind === 'ready') {
    headline('Agents are', 'ready.');
    show('lede', 'No agent has a tab open. Ask one to look something up, and its tabs show up here.');
    show('note', 'They only see the tabs they opened. Yours stay yours.');
  } else if (kind === 'paused') {
    headline('Agents are', 'paused.');
    show('lede', null);
    show('note', 'No agent can open or use a tab until you resume.');
  } else if (kind === 'setup') {
    headline('One more', 'step.');
    show('lede', 'Agents reach Chrome through a small helper on your Mac. Run this once in Terminal:');
    if (Date.now() > saidSomething) show('note', 'It finds your agents, adds Tabhand to them and backs up their settings first.');
  } else if (kind === 'standby') {
    headline('Standing', 'by.');
    show('lede', 'Agents are using Tabhand in another Chrome profile. Name this one, and you can ask an agent to use it.');
    show('note', null);
  } else {
    headline('One', 'moment.');
    show('lede', 'Tabhand lost touch with its helper on your Mac and tries again every 30 seconds. If it doesn’t come back, run this in Terminal:');
    if (Date.now() > saidSomething) show('note', null);
  }

  // Naming opens by itself where a name matters most: another profile has the agents.
  const form = $('naming');
  const open = naming || (kind === 'standby' && !name && !dismissed);
  if (open && form.hidden) {
    $('name').value = name;
    form.hidden = false;
    $('name').focus();
  } else if (!open) {
    form.hidden = true;
  }
  $('footer-text').replaceChildren(...(open ? [`Tabhand ${version}`] : ['This profile: ', Object.assign(document.createElement('b'), { textContent: name || 'not named' })]));
  $('footer-link').textContent = open ? (inWindow ? 'Close' : 'Cancel') : name ? 'Rename' : 'Name it';
}

async function refresh() {
  try {
    state = await ask({ type: 'panel' });
    render();
  } catch {}
}

$('toggle').addEventListener('click', async () => {
  state = await ask({ type: 'set-paused', paused: !state.paused });
  render();
});

$('command').addEventListener('click', async () => {
  await navigator.clipboard.writeText(SETUP_COMMAND).catch(() => {});
  show('note', 'Copied. Paste it in Terminal, then come back here.');
  saidSomething = Date.now() + 4000;
});

const startNaming = () => {
  naming = true;
  render();
};
$('chip').addEventListener('click', startNaming);
$('footer-link').addEventListener('click', () => {
  if (!naming && $('naming').hidden) return startNaming();
  if (inWindow) return window.close();
  naming = false;
  dismissed = true;
  $('naming').hidden = true;
  render();
});

const nameStatus = (message, error = false) => {
  const status = $('name-status');
  status.textContent = message;
  status.classList.toggle('error', error);
};

$('naming').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('name').value.replace(/\s+/g, ' ').trim().slice(0, 100);
  await chrome.storage.local.set({ profileName: name });
  nameStatus(name ? `Saved. Agents now see this profile as “${name}”.` : 'Saved. This profile has no name now.');
  setTimeout(() => {
    if (inWindow) return window.close();
    naming = false;
    $('naming').hidden = true;
    refresh();
  }, 1200);
});

// The email takes a permission Tabhand doesn't otherwise need: asked for here, used once to fill in
// the field, and given straight back.
const EMAIL = { permissions: ['identity', 'identity.email'] };
$('email').addEventListener('click', async () => {
  if (!inWindow) {
    await chrome.windows.create({ url: chrome.runtime.getURL('panel.html#name'), type: 'popup', width: 300, height: 470, focused: true }).catch(() => {});
    window.close();
    return;
  }
  try {
    if (!(await chrome.permissions.request(EMAIL))) {
      nameStatus('Chrome didn’t let Tabhand read the email, so nothing was filled in. Type a name instead.', true);
      return;
    }
    const { email } = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' });
    if (email) {
      $('name').value = email;
      $('name').focus();
      nameStatus('Filled in. Save to use it.');
    } else {
      nameStatus('This profile isn’t signed in to Chrome with a Google account. Type a name instead.', true);
    }
  } catch (error) {
    nameStatus(String(error?.message ?? error), true);
  } finally {
    chrome.permissions.remove(EMAIL).catch(() => {});
  }
});

refresh();
setInterval(refresh, 1500);
