// The toolbar panel: what agents are doing in this Chrome profile, one switch that pauses them all,
// the profile's name, and the name and color agents' cursors wear here. The service worker keeps the
// state; the panel asks for it while it's open.

import { ICONS, cleanLook, glyphShape, isColor, themeFor } from './themes.js';
import { parseGlyphSvg } from './glyph-svg.js';

const $ = (id) => document.getElementById(id);
const SETUP_COMMAND = 'npx tabhand setup';
// Chrome closes a toolbar popup when it asks for a permission or opens a file chooser, so both
// happen in this same page opened as a small window of its own.
const openedAs = location.hash.slice(1);
const inWindow = openedAs === 'name' || openedAs === 'cursor';

let state = null;
let naming = openedAs === 'name';
/** The cursor view (behind the gear): open or not, and the look being tried in it. */
let looking = false;
/** "#cursor" opens straight into the cursor view, where the file chooser can't take the page away. */
let opening = openedAs === 'cursor';
let draft = { mode: 'own', name: '', color: '#e0573c', icon: 'initial', iconShape: undefined, iconColors: 'one' };
// A few colors that read well on any page; any other comes from the color picker or as #RRGGBB.
const SWATCHES = ['#E0573C', '#F97316', '#EAB308', '#16A34A', '#0891B2', '#2563EB', '#7C3AED', '#DB2777', '#1F2937'];
const ICON_NAMES = { initial: 'First letter of the name', sparkle: 'Sparkle', bolt: 'Bolt', star: 'Star', heart: 'Heart', diamond: 'Diamond', dot: 'Dot', check: 'Check', prompt: 'Prompt', cube: 'Cube', none: 'No icon' };
let dismissed = false;
let saidSomething = 0;

const ask = (message) => chrome.runtime.sendMessage(message);

/**
 * Where the panel is open, for what it says when the helper is missing: the computer, and the
 * browser when it says which it is. Brave and Edge do; any other gets "your browser".
 */
const where = { os: 'mac', browser: null };
Promise.all([
  chrome.runtime.getPlatformInfo().then(({ os }) => (where.os = os)),
  Promise.resolve(navigator.brave?.isBrave?.()).then((brave) => {
    if (brave) where.browser = 'Brave';
    else if (navigator.userAgentData?.brands?.some(({ brand }) => brand === 'Microsoft Edge')) where.browser = 'Edge';
  }),
])
  .catch(() => {})
  .then(() => render());
const computer = () => (where.os === 'mac' ? 'your Mac' : 'your computer');
const terminal = () => (where.os === 'win' ? 'PowerShell' : 'Terminal');

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
    // Named, it's most likely a browser installed after Tabhand was set up with an older version.
    const browser = where.browser;
    if (browser) headline('Not set up in', `${browser} yet.`);
    else headline('One more', 'step.');
    show('lede', `Agents reach ${browser ?? 'your browser'} through a small helper on ${computer()}. Run this once in ${terminal()}:`);
    if (Date.now() > saidSomething) {
      show('note', browser ? `Set Tabhand up before you had ${browser}? Run it again to add ${browser}.` : 'It finds your agents, adds Tabhand to them and backs up their settings first.');
    }
  } else if (kind === 'standby') {
    headline('Standing', 'by.');
    show('lede', 'Agents are using Tabhand in another Chrome profile. Name this one, and you can ask an agent to use it.');
    show('note', null);
  } else {
    headline('One', 'moment.');
    show('lede', `Tabhand lost touch with its helper on ${computer()} and tries again every 30 seconds. If it doesn’t come back, run this in ${terminal()}:`);
    if (Date.now() > saidSomething) show('note', null);
  }

  // The cursor view takes the panel's body over.
  document.body.dataset.view = looking ? 'cursor' : 'main';
  for (const id of ['agents', 'lede', 'command', 'toggle', 'note']) if (looking) $(id).hidden = true;
  if (looking) headline('Make it', 'yours.');
  $('customize').hidden = !looking;

  // Naming opens by itself where a name matters most: another profile has the agents.
  const form = $('naming');
  const open = !looking && (naming || (kind === 'standby' && !name && !dismissed));
  if (open && form.hidden) {
    $('name').value = name;
    form.hidden = false;
    $('name').focus();
  } else if (!open) {
    form.hidden = true;
  }
  const editing = open || looking;
  $('footer-text').replaceChildren(...(editing ? [`Tabhand ${version}`] : ['This profile: ', Object.assign(document.createElement('b'), { textContent: name || 'not named' })]));
  $('footer-link').textContent = looking ? 'Back' : editing ? (inWindow ? 'Close' : 'Cancel') : name ? 'Rename' : 'Name it';
  $('settings').hidden = inWindow;
}

// ---------------------------------------------------------------- the cursor look

const SVG = 'http://www.w3.org/2000/svg';
/** Draws an icon from its data (see GLYPHS in themes.js), the way pages draw it. */
function drawn(spec) {
  if (typeof spec === 'string') return document.createTextNode(spec);
  const [name, attributes = {}, children = []] = spec;
  const element = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  element.append(...children.map(drawn));
  return element;
}
const iconSvg = (shape, className) => {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  if (className) svg.setAttribute('class', className);
  if (shape) svg.append(drawn(shape));
  return svg;
};
/** For "no icon": a circle struck through, only in the picker. */
const NO_ICON = ['g', { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round' }, [['circle', { cx: 8, cy: 8, r: 6 }], ['path', { d: 'M3.8 12.2 L12.2 3.8' }]]];
/** For an icon of your own: a plus, which opens the file chooser. */
const PLUS = ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', d: 'M8 3.4 V12.6 M3.4 8 H12.6' }];

const colorVars = (element, theme) => {
  for (const [property, value] of Object.entries({ '--pill': theme.pill, '--text': theme.text, '--glyph': theme.glyphColor, '--glow': theme.glow })) element.style.setProperty(property, value);
};

/** An agent's cursor at the size and in the colors pages show it: the arrow and its name tag. */
function sample(theme, label, x, y) {
  const box = document.createElement('div');
  box.className = 'sample';
  box.style.left = `${x}px`;
  box.style.top = `${y}px`;
  colorVars(box, theme);
  const id = `fill-${Math.random().toString(36).slice(2, 8)}`;
  const points = '5,4 5.8,23.2 10.6,18.4 19.6,17.8';
  const arrow = drawn(['svg', { class: 'arrow', width: 32.2, height: 34.5, viewBox: '0 0 28 30' }, [
    ['defs', {}, [['linearGradient', { id, x1: 0, y1: 0, x2: 0.55, y2: 1 }, [['stop', { offset: 0, 'stop-color': theme.arrow[0] }], ['stop', { offset: 1, 'stop-color': theme.arrow[1] }]]]]],
    ['polygon', { points, fill: '#fff', stroke: '#fff', 'stroke-width': 4.6, 'stroke-linejoin': 'round' }],
    ['polygon', { points, fill: `url(#${id})`, stroke: `url(#${id})`, 'stroke-width': 1.4, 'stroke-linejoin': 'round' }],
    ['path', { d: 'M6.4 7.2 L6.9 19.2', stroke: 'rgba(255,255,255,0.5)', 'stroke-width': 1.1, 'stroke-linecap': 'round' }],
  ]]);
  const tag = document.createElement('div');
  tag.className = theme.glyphShape ? 'tag' : 'tag plain';
  if (theme.glyphShape) tag.append(iconSvg(theme.glyphShape, 'glyph'));
  tag.append(Object.assign(document.createElement('span'), { textContent: label }));
  box.append(arrow, tag);
  return box;
}

const customTheme = () =>
  themeFor(draft.color, { icon: draft.icon, label: draft.name || 'Claude', iconShape: draft.iconShape, iconColors: draft.iconColors });

function renderSamples() {
  const samples =
    draft.mode === 'own'
      ? [sample(themeFor('claude', { label: 'Claude' }), 'Claude', 34, 4), sample(themeFor('codex', { label: 'Codex' }), 'Codex', 150, 28)]
      : [sample(customTheme(), draft.name || 'Claude', 70, 12)];
  $('samples').replaceChildren(...samples);
}

function renderSwatches() {
  const picked = draft.color.toLowerCase();
  const preset = SWATCHES.some((color) => color.toLowerCase() === picked);
  const buttons = SWATCHES.map((color) => {
    const button = Object.assign(document.createElement('button'), { type: 'button', className: 'swatch', title: color });
    button.style.setProperty('--c', color);
    button.dataset.color = color.toLowerCase();
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(button.dataset.color === picked));
    button.addEventListener('click', () => setColor(button.dataset.color));
    return button;
  });
  // Any other color, from the system's color picker.
  const any = document.createElement('label');
  any.className = 'swatch any';
  any.title = 'Any color';
  any.setAttribute('role', 'radio');
  any.setAttribute('aria-checked', String(!preset));
  if (!preset) any.style.setProperty('--c', picked);
  const picker = Object.assign(document.createElement('input'), { type: 'color', value: picked });
  picker.setAttribute('aria-label', 'Any color');
  picker.addEventListener('input', () => setColor(picker.value));
  any.append(picker);
  $('swatches').replaceChildren(...buttons, any);
}

function renderIcons() {
  const theme = customTheme();
  const tiles = ICONS.map((icon) => {
    const tile = Object.assign(document.createElement('button'), { type: 'button', className: 'icon', title: ICON_NAMES[icon] ?? icon });
    tile.dataset.icon = icon;
    tile.setAttribute('role', 'radio');
    tile.setAttribute('aria-checked', String(icon === draft.icon));
    colorVars(tile, theme);
    // Each tile shows its icon as it would look on the tag; a monogram shows the name's letter.
    const shape = icon === 'none' ? NO_ICON : glyphShape({ ...theme, glyph: icon }, draft.name || 'Aa');
    tile.append(iconSvg(shape));
    tile.addEventListener('click', () => {
      draft.icon = icon;
      renderLook();
    });
    return tile;
  });
  $('icons').replaceChildren(...tiles, iconTile(theme));
  const custom = draft.icon === 'custom' && Boolean(draft.iconShape);
  $('icon-options').hidden = !custom;
  for (const button of document.querySelectorAll('#icon-options [data-colors]')) {
    button.setAttribute('aria-checked', String(button.dataset.colors === (draft.iconColors ?? 'one')));
  }
}

/** The tile after the built-in marks: the icon you uploaded, or a plus that starts an upload. */
function iconTile(theme) {
  if (draft.iconShape) {
    const tile = Object.assign(document.createElement('button'), { type: 'button', className: 'icon', title: 'Your own icon' });
    tile.dataset.icon = 'custom';
    tile.setAttribute('role', 'radio');
    tile.setAttribute('aria-checked', String(draft.icon === 'custom'));
    const custom = themeFor(draft.color, { icon: 'custom', iconShape: draft.iconShape, iconColors: draft.iconColors });
    colorVars(tile, custom);
    tile.append(iconSvg(custom.glyphShape));
    tile.addEventListener('click', () => {
      draft.icon = 'custom';
      renderLook();
    });
    return tile;
  }
  const tile = Object.assign(document.createElement('button'), { type: 'button', className: 'icon add', title: 'Upload your own icon (SVG)' });
  tile.setAttribute('aria-label', 'Upload your own icon');
  tile.append(iconSvg(PLUS));
  tile.addEventListener('click', uploadIcon);
  return tile;
}

/**
 * Chrome closes a toolbar popup as a native file chooser opens, taking the chosen file with it, so
 * from the popup the plus hands the look being tried to this view in a window of its own, where the
 * chooser can run.
 */
async function uploadIcon() {
  if (inWindow) {
    $('icon-file').click();
    return;
  }
  await chrome.storage.session.set({ iconDraft: { ...draft, mode: 'custom' } }).catch(() => {});
  await chrome.windows
    .create({ url: `${chrome.runtime.getURL('panel.html')}#cursor`, type: 'popup', width: 300, height: 720, focused: true })
    .catch(() => {});
  window.close();
}

function renderLook() {
  for (const button of document.querySelectorAll('.seg button[data-mode]')) button.setAttribute('aria-checked', String(button.dataset.mode === draft.mode));
  $('custom').hidden = draft.mode !== 'custom';
  $('own-note').hidden = draft.mode !== 'own';
  if (document.activeElement !== $('look-hex')) $('look-hex').value = draft.color.toUpperCase();
  renderSamples();
  renderSwatches();
  renderIcons();
}

function setColor(color) {
  draft.color = color.toLowerCase();
  renderLook();
}

const lookStatus = (message, error = false) => {
  const status = $('look-status');
  status.textContent = message;
  status.classList.toggle('error', error);
};

/**
 * Opens the cursor view with the look that's saved, or with the one a popup handed over when its
 * plus sent the user here for an upload.
 */
function startLooking(carried) {
  const base = carried ?? state?.look;
  // "#cursor" is here for an upload, so it starts with the choices showing even before a look exists.
  const custom = Boolean(base) || openedAs === 'cursor';
  draft = {
    mode: custom ? 'custom' : 'own',
    name: base?.name ?? '',
    color: base?.color ?? '#e0573c',
    icon: base?.icon ?? 'initial',
    iconShape: base?.iconShape,
    iconColors: base?.iconColors ?? 'one',
  };
  looking = true;
  naming = false;
  $('look-name').value = draft.name;
  $('look-save').textContent = 'Save';
  lookStatus(openedAs === 'cursor' ? 'Pick your SVG with the + tile. This window stays open while Chrome shows the file chooser.' : '');
  renderLook();
  render();
}

function stopLooking() {
  looking = false;
  render();
}

$('settings').addEventListener('click', () => (looking ? stopLooking() : startLooking()));
for (const button of document.querySelectorAll('.seg button[data-mode]')) {
  button.addEventListener('click', () => {
    draft.mode = button.dataset.mode;
    renderLook();
    if (draft.mode === 'custom') $('look-name').focus();
  });
}
$('look-name').addEventListener('input', () => {
  draft.name = $('look-name').value;
  renderSamples();
  renderIcons();
});
$('look-hex').addEventListener('input', () => {
  const typed = $('look-hex').value.trim();
  const hex = typed.startsWith('#') ? typed : `#${typed}`;
  if (isColor(hex)) setColor(hex);
});

// A file becomes icon data here, once: nothing from it is ever pasted into a page as markup.
$('icon-file').addEventListener('change', async () => {
  const [file] = $('icon-file').files ?? [];
  $('icon-file').value = '';
  if (!file) return;
  try {
    draft.iconShape = parseGlyphSvg(await file.text());
    draft.icon = 'custom';
    lookStatus(`“${file.name}” is in. Save to put it on every agent in this profile.`);
    renderLook();
  } catch (error) {
    lookStatus(error.message, true);
  }
});

for (const button of document.querySelectorAll('#icon-options [data-colors]')) {
  button.addEventListener('click', () => {
    draft.iconColors = button.dataset.colors;
    renderLook();
  });
}

$('icon-remove').addEventListener('click', () => {
  draft.iconShape = undefined;
  draft.icon = 'initial';
  lookStatus('Back to the name’s first letter. Save to keep it.');
  renderLook();
});

$('look-save').addEventListener('click', async () => {
  const look =
    draft.mode === 'custom'
      ? cleanLook({ name: draft.name, color: draft.color, icon: draft.icon, iconShape: draft.iconShape, iconColors: draft.iconColors })
      : null;
  if (look) await chrome.storage.local.set({ cursorLook: look });
  else await chrome.storage.local.remove('cursorLook');
  $('look-save').textContent = 'Saved';
  lookStatus(look ? 'Every agent in this profile wears it now, in the tabs it already has open too.' : 'Every agent wears its own look again.');
  setTimeout(() => {
    // The window that was opened for the upload has done its job.
    if (inWindow) return window.close();
    stopLooking();
    refresh();
  }, 1300);
});

async function refresh() {
  try {
    state = await ask({ type: 'panel' });
    if (opening) {
      opening = false;
      const carried = await chrome.storage.session
        .get('iconDraft')
        .then((stored) => stored.iconDraft)
        .catch(() => null);
      await chrome.storage.session.remove('iconDraft').catch(() => {});
      startLooking(carried);
      return;
    }
    render();
  } catch {}
}

$('toggle').addEventListener('click', async () => {
  state = await ask({ type: 'set-paused', paused: !state.paused });
  render();
});

$('command').addEventListener('click', async () => {
  await navigator.clipboard.writeText(SETUP_COMMAND).catch(() => {});
  show('note', `Copied. Paste it in ${terminal()}, then come back here.`);
  saidSomething = Date.now() + 4000;
});

const startNaming = () => {
  naming = true;
  looking = false;
  render();
};
$('chip').addEventListener('click', startNaming);
$('footer-link').addEventListener('click', () => {
  if (looking) return stopLooking();
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
