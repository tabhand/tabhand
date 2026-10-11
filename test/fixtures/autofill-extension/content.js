// Behaves like iCloud Passwords' autofill menu: a closed shadow root made when the page loads,
// with this extension's own frame put inside it whenever a text field gets focus, right away or,
// with ?menu-delay=ms in the page's URL, a moment later (iCloud asks the Passwords app first).
// Reports what happened to its menus in the page's #autofill-status, so the test can tell.
const delay = Number(new URLSearchParams(location.search).get('menu-delay') ?? 0);
const host = document.createElement('autofill-menu');
const shadow = host.attachShadow({ mode: 'closed' });
document.documentElement.append(host);
const frames = [];
const report = () => {
  const removed = frames.filter((frame) => !frame.isConnected).length;
  const status = document.getElementById('autofill-status');
  if (status) status.textContent = `Autofill menus shown: ${frames.length}, removed: ${removed}`;
};
// Notices a menu being taken out as it happens (timers are slow in background tabs).
new MutationObserver(report).observe(shadow, { childList: true });
const show = () => {
  const frame = document.createElement('iframe');
  frame.src = chrome.runtime.getURL(`menu.html?at=${Date.now()}`);
  frame.style.cssText = 'position: fixed; left: 0; bottom: 0; width: 220px; height: 80px; border: 0';
  shadow.append(frame);
  frames.push(frame);
};
const showSoon = () => (delay ? setTimeout(show, delay) : show());
addEventListener('focusin', (event) => event.target instanceof HTMLInputElement && showSoon(), true);
if (document.activeElement instanceof HTMLInputElement) showSoon();
