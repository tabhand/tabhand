// The tab badge: while an agent works in a tab, the tab's icon becomes the agent's cursor, so the
// user can spot agent tabs in the tab strip.
//
// tabhandBadge runs inside the page (serialized with toString(), so it must not use this module's
// scope). It keeps everything it needs to undo itself in DOM attributes, so it can be undone from
// any script world, even after the debugger is gone.

export function tabhandBadge({ action, href }) {
  const ICONS = 'link[rel~="icon" i], link[rel="shortcut icon" i]';
  const OURS = 'link[data-tabhand-badge]';
  const watchOptions = { subtree: true, childList: true, attributes: true, attributeFilter: ['href', 'rel'] };
  const root = () => document.head ?? document.documentElement;

  if (action === 'clear') {
    window.__tabhandBadgeObserver?.disconnect();
    window.__tabhandBadgeObserver = null;
    document.documentElement.removeAttribute('data-tabhand-badge-generation');
    for (const link of document.querySelectorAll(OURS)) {
      if (link.hasAttribute('data-tabhand-created')) {
        link.remove();
        continue;
      }
      const original = link.getAttribute('data-tabhand-original-href');
      if (original) link.setAttribute('href', original);
      else link.removeAttribute('href');
      link.removeAttribute('data-tabhand-badge');
      link.removeAttribute('data-tabhand-original-href');
    }
    return;
  }

  const apply = () => {
    const links = [...document.querySelectorAll(ICONS)];
    if (links.length === 0) {
      const link = document.createElement('link');
      link.rel = 'icon';
      link.setAttribute('data-tabhand-created', '');
      root().append(link);
      links.push(link);
    }
    for (const link of links) {
      if (!link.hasAttribute('data-tabhand-badge')) {
        link.setAttribute('data-tabhand-original-href', link.getAttribute('href') ?? '');
        link.setAttribute('data-tabhand-badge', '');
      }
      if (link.getAttribute('href') !== href) link.setAttribute('href', href);
    }
  };

  window.__tabhandBadgeObserver?.disconnect();
  // Only the newest call keeps watching; older watchers (from other script worlds) step aside
  // instead of fighting over the icon.
  const generation = String(Math.random());
  document.documentElement.setAttribute('data-tabhand-badge-generation', generation);
  apply();
  // Pages swap their icons (unread counts and such). Remember the page's new icon for later and
  // keep showing ours. Once the badge is cleared from anywhere, stop watching.
  const observer = new MutationObserver((mutations) => {
    if (!document.querySelector(OURS) || document.documentElement.getAttribute('data-tabhand-badge-generation') !== generation) {
      observer.disconnect();
      return;
    }
    for (const mutation of mutations) {
      const link = mutation.target;
      if (mutation.type === 'attributes' && link.hasAttribute?.('data-tabhand-badge') && link.getAttribute('href') !== href) {
        link.setAttribute('data-tabhand-original-href', link.getAttribute('href') ?? '');
      }
    }
    observer.disconnect();
    apply();
    observer.observe(root(), watchOptions);
  });
  observer.observe(root(), watchOptions);
  window.__tabhandBadgeObserver = observer;
}

/** The badge image: the agent's arrow, filling the tab icon. */
export function badgeImage(theme) {
  const arrow = '5,4 5.8,23.2 10.6,18.4 19.6,17.8'; // the cursor's arrowhead, in its 28x30 drawing
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" data-tabhand-badge="1" width="32" height="32" viewBox="0 0 32 32">` +
    `<defs><linearGradient id="fill" x1="0" y1="0" x2="0.55" y2="1">` +
    `<stop offset="0" stop-color="${theme.arrow[0]}"/><stop offset="1" stop-color="${theme.arrow[1]}"/>` +
    `</linearGradient></defs>` +
    `<g transform="translate(0 -1.7) scale(1.3)">` +
    `<polygon points="${arrow}" fill="#fff" stroke="#fff" stroke-width="4.2" stroke-linejoin="round"/>` +
    `<polygon points="${arrow}" fill="url(#fill)" stroke="url(#fill)" stroke-width="1.4" stroke-linejoin="round"/>` +
    `</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
