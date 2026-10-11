// The agent cursor: a themed pointer with a name tag that shows the user where an agent acts.
//
// tabhandCursor runs inside the page, in an isolated world, so it is serialized with toString()
// and must not use anything from this module's scope. It builds the overlay from DOM calls only
// (no innerHTML, no <style> tags, no style attributes), so pages with strict CSP or Trusted Types
// still show it. The overlay never takes clicks and is hidden from the accessibility tree.

export function tabhandCursor({ action, x, y, label, theme, animate, click, typing, greet }) {
  let state = window.__tabhandCursor;
  const alive = Boolean(state?.host.isConnected);
  // If the extension stops talking to this page (worker gone, debugger detached), leave on our own.
  const LEASE_MS = 3 * 60_000;

  const wiggle = () =>
    state.arrow.animate(
      [{ rotate: '0deg' }, { rotate: '-14deg' }, { rotate: '10deg' }, { rotate: '-6deg' }, { rotate: '2deg' }, { rotate: '0deg' }],
      { duration: 900, easing: 'ease-in-out' },
    );
  const leave = () => {
    if (!state?.host.isConnected) return;
    const { host, timer } = state;
    clearInterval(timer);
    window.__tabhandCursor = null;
    host.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 350, easing: 'ease-out', fill: 'forwards' }).finished.then(
      () => host.remove(),
      () => host.remove(),
    );
  };

  if (action === 'hide' || action === 'show') {
    if (alive) state.host.style.setProperty('visibility', action === 'hide' ? 'hidden' : 'visible', 'important');
    return;
  }
  if (action === 'typing') {
    if (alive) state.tag.classList.toggle('typing', Boolean(typing));
    return;
  }
  if (action === 'greet') {
    if (alive) {
      state.expiresAt = Date.now() + LEASE_MS;
      wiggle();
    }
    return;
  }
  if (action === 'leave') {
    leave();
    return;
  }

  const NS = 'http://www.w3.org/2000/svg';
  const SCALE = 1.15;
  const TIP = { x: 5 * SCALE, y: 4 * SCALE }; // the arrow's hotspot, scaled from its 28x30 drawing
  const svgEl = (name, attributes = {}, children = []) => {
    const element = document.createElementNS(NS, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    element.append(...children);
    return element;
  };

  // Small original marks that hint at each harness.
  const glyphs = {
    spark: () =>
      svgEl(
        'g',
        { stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round' },
        Array.from({ length: 10 }, (_, i) => {
          const angle = (i * Math.PI) / 5 + 0.2;
          const inner = i % 2 ? 2.4 : 1.8;
          const outer = i % 2 ? 6.2 : 7.2;
          return svgEl('line', {
            x1: 8 + Math.cos(angle) * inner,
            y1: 8 + Math.sin(angle) * inner,
            x2: 8 + Math.cos(angle) * outer,
            y2: 8 + Math.sin(angle) * outer,
          });
        }),
      ),
    prompt: () =>
      svgEl('g', { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [
        svgEl('path', { d: 'M2.5 4.2 L6.3 8 L2.5 11.8' }),
        svgEl('path', { d: 'M8.6 12 H13.6' }),
      ]),
    pixel: () =>
      svgEl(
        'g',
        { fill: 'currentColor' },
        [
          [1.5, 1.5], [6.2, 1.5], [10.9, 1.5],
          [1.5, 6.2], [10.9, 6.2],
          [1.5, 10.9], [6.2, 10.9], [10.9, 10.9],
        ].map(([px, py]) => svgEl('rect', { x: px, y: py, width: 3.6, height: 3.6, rx: 0.6 })),
      ),
    cube: () =>
      svgEl('g', { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linejoin': 'round' }, [
        svgEl('path', { d: 'M8 1.6 L14 5 L14 11 L8 14.4 L2 11 L2 5 Z' }),
        svgEl('path', { d: 'M2 5 L8 8.4 L14 5 M8 8.4 L8 14.4' }),
      ]),
    sparkle: () =>
      svgEl('path', {
        fill: 'currentColor',
        d: 'M8 0.8 C8.6 5 11 7.4 15.2 8 C11 8.6 8.6 11 8 15.2 C7.4 11 5 8.6 0.8 8 C5 7.4 7.4 5 8 0.8 Z',
      }),
    orbit: () =>
      svgEl('g', {}, [
        svgEl('circle', { cx: 8, cy: 8, r: 2.6, fill: 'currentColor' }),
        svgEl('ellipse', { cx: 8, cy: 8, rx: 6.6, ry: 3.4, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3, transform: 'rotate(-28 8 8)' }),
      ]),
  };

  if (!state || !state.host.isConnected || state.themeKey !== theme.key) {
    // Another isolated world (e.g. from before a worker restart) may have left its own overlay.
    for (const stale of document.querySelectorAll('tabhand-cursor')) stale.remove();
    const host = document.createElement('tabhand-cursor');
    host.setAttribute('aria-hidden', 'true');
    const reset = {
      all: 'initial',
      position: 'fixed',
      inset: '0',
      width: '100vw',
      height: '100vh',
      margin: '0',
      padding: '0',
      border: '0',
      background: 'transparent',
      overflow: 'visible',
      display: 'block',
      'pointer-events': 'none',
      'z-index': '2147483647',
      visibility: 'visible',
    };
    for (const [property, value] of Object.entries(reset)) host.style.setProperty(property, value, 'important');
    const vars = { '--pill': theme.pill, '--text': theme.text, '--glyph': theme.glyphColor, '--glow': theme.glow, '--ring': theme.arrow[1] };
    for (const [property, value] of Object.entries(vars)) host.style.setProperty(property, value);

    const root = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      .pointer, .tag { position: absolute; left: 0; top: 0; }
      .arrow {
        display: block; overflow: visible; transform-origin: ${TIP.x}px ${TIP.y}px;
        filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.28)) drop-shadow(0 6px 10px var(--glow));
      }
      .tag {
        display: inline-flex; align-items: center; gap: 5px; white-space: nowrap;
        padding: 4px 10px 4px 7px; border-radius: 999px; transform-origin: 0 0;
        font: 600 12px/16px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
        letter-spacing: 0.01em; color: var(--text); background: var(--pill);
        box-shadow: 0 8px 18px -6px var(--glow), 0 1px 2px rgba(0, 0, 0, 0.22),
          inset 0 1px 0 rgba(255, 255, 255, 0.24), inset 0 0 0 1px rgba(255, 255, 255, 0.16);
      }
      .glyph { width: 14px; height: 14px; display: block; color: var(--glyph); overflow: visible; }
      .dots { display: none; align-items: center; gap: 2.5px; margin-left: 1px; height: 16px; }
      .typing .dots { display: inline-flex; }
      .dots i { width: 3.5px; height: 3.5px; border-radius: 50%; background: currentColor; animation: dot 1s infinite ease-in-out; }
      .dots i:nth-child(2) { animation-delay: 0.15s; }
      .dots i:nth-child(3) { animation-delay: 0.3s; }
      @keyframes dot { 0%, 80%, 100% { opacity: 0.35; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-2.5px); } }
      .ring {
        position: absolute; width: 36px; height: 36px; margin: -18px 0 0 -18px; border-radius: 50%;
        border: 2px solid var(--ring); box-sizing: border-box;
      }
    `);
    root.adoptedStyleSheets = [sheet];

    const pointer = document.createElement('div');
    pointer.className = 'pointer';
    // A rounded arrowhead: the same outline drawn three times (white rim, colored body, gloss).
    const points = '5,4 5.8,23.2 10.6,18.4 19.6,17.8';
    const arrow = svgEl('svg', { class: 'arrow', width: 28 * SCALE, height: 30 * SCALE, viewBox: '0 0 28 30' }, [
      svgEl('defs', {}, [
        svgEl('linearGradient', { id: 'fill', x1: 0, y1: 0, x2: 0.55, y2: 1 }, [
          svgEl('stop', { offset: 0, 'stop-color': theme.arrow[0] }),
          svgEl('stop', { offset: 1, 'stop-color': theme.arrow[1] }),
        ]),
      ]),
      svgEl('polygon', { points, fill: '#fff', stroke: '#fff', 'stroke-width': 4.6, 'stroke-linejoin': 'round' }),
      svgEl('polygon', { points, fill: 'url(#fill)', stroke: 'url(#fill)', 'stroke-width': 1.4, 'stroke-linejoin': 'round' }),
      svgEl('path', { d: 'M6.4 7.2 L6.9 19.2', stroke: 'rgba(255,255,255,0.5)', 'stroke-width': 1.1, 'stroke-linecap': 'round' }),
    ]);
    pointer.append(arrow);

    const tag = document.createElement('div');
    tag.className = 'tag';
    const glyph = svgEl('svg', { class: 'glyph', viewBox: '0 0 16 16' }, [(glyphs[theme.glyph] ?? glyphs.orbit)()]);
    const name = document.createElement('span');
    const dots = document.createElement('span');
    dots.className = 'dots';
    dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
    tag.append(glyph, name, dots);

    root.append(pointer, tag);
    document.documentElement.append(host);
    state = window.__tabhandCursor = { host, root, pointer, arrow, tag, name, themeKey: theme.key, pos: null };
    state.timer = setInterval(() => {
      if (Date.now() > state.expiresAt) leave();
    }, 5_000);
  }
  state.expiresAt = Date.now() + LEASE_MS;

  // Stay above modal dialogs, which live in the top layer.
  if (typeof state.host.showPopover === 'function') {
    try {
      if (!state.host.hasAttribute('popover')) state.host.setAttribute('popover', 'manual');
      if (state.host.matches(':popover-open')) state.host.hidePopover();
      state.host.showPopover();
    } catch {}
  }

  state.name.textContent = label || 'Agent';
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) animate = false;

  const pointerAt = (p) => `${p.x - TIP.x}px ${p.y - TIP.y}px`;
  const tagAt = (p) => `${p.x + 15}px ${p.y + 23}px`;
  const target = { x, y };
  const first = !state.pos;
  const from = state.pos ?? { x: x + 70, y: y + 90 };
  state.pos = target;

  const settle = () => {
    state.pointer.style.translate = pointerAt(target);
    state.tag.style.translate = tagAt(target);
    // Drop finished or superseded glides; leave pop-in and press effects running.
    for (const animation of [...state.pointer.getAnimations(), ...state.tag.getAnimations()]) {
      if (animation.effect?.getKeyframes().some((frame) => 'translate' in frame)) animation.cancel();
    }
  };

  const clickEffect = () => {
    if (!click) return;
    state.arrow.animate([{ scale: 1 }, { scale: 0.8 }, { scale: 1 }], { duration: 280, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' });
    for (const delay of [0, 130]) {
      const ring = document.createElement('div');
      ring.className = 'ring';
      ring.style.left = `${x}px`;
      ring.style.top = `${y}px`;
      ring.style.opacity = '0';
      state.root.append(ring);
      const pulse = ring.animate(
        [
          { scale: 0.3, opacity: 0.85 },
          { scale: 1.9, opacity: 0 },
        ],
        { duration: 640, delay, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
      );
      pulse.onfinish = pulse.oncancel = () => ring.remove();
    }
  };

  if (!animate) {
    settle();
    if (greet) wiggle();
    return;
  }

  if (first) {
    const pop = { duration: 340, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' };
    state.arrow.animate([{ scale: 0.4, opacity: 0 }, { scale: 1, opacity: 1 }], pop);
    state.tag.animate([{ scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1 }], { ...pop, delay: 60, fill: 'backwards' });
  }

  const distance = Math.hypot(target.x - from.x, target.y - from.y);
  const duration = Math.max(260, Math.min(820, 300 + distance * 0.45));
  const easing = 'cubic-bezier(0.22, 1, 0.36, 1)';
  const glide = state.pointer.animate([{ translate: pointerAt(from) }, { translate: pointerAt(target) }], { duration, easing, fill: 'forwards' });
  // The tag trails a little behind the arrow, like a real hand-held label.
  state.tag.animate([{ translate: tagAt(from) }, { translate: tagAt(target) }], { duration: duration + 110, delay: 35, easing, fill: 'both' });
  const tilt = Math.max(-10, Math.min(10, (target.x - from.x) * -0.04));
  state.arrow.animate([{ rotate: '0deg' }, { rotate: `${tilt}deg`, offset: 0.35 }, { rotate: '0deg' }], { duration, easing: 'ease-in-out' });

  return glide.finished.then(
    () => {
      settle();
      clickEffect();
      // Let the press start before the real click lands.
      return new Promise((resolve) => setTimeout(resolve, 110));
    },
    () => {},
  );
}
