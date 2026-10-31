// Cursor looks per agent harness. The MCP server works out which harness is driving it and sends
// the key; anything unknown falls back to `agent`. Arrows are always colored so they can't be
// mistaken for the user's own (black and white) pointer.

export const THEMES = {
  claude: {
    arrow: ['#F0A07F', '#C4603E'],
    pill: 'linear-gradient(135deg, #E48A66 0%, #C15F3C 100%)',
    text: '#FFFFFF',
    glyph: 'spark',
    glyphColor: '#FFFFFF',
    glow: 'rgba(214, 112, 76, 0.45)',
    group: 'orange',
  },
  codex: {
    arrow: ['#8FB2FF', '#3D67DE'],
    pill: 'linear-gradient(135deg, #353A44 0%, #101216 100%)',
    text: '#FFFFFF',
    glyph: 'prompt',
    glyphColor: '#9DBBFF',
    glow: 'rgba(61, 103, 222, 0.42)',
    group: 'blue',
  },
  opencode: {
    arrow: ['#FDD2AE', '#F29A5A'],
    pill: 'linear-gradient(135deg, #222222 0%, #0A0A0A 100%)',
    text: '#EEEEEE',
    glyph: 'pixel',
    glyphColor: '#FAB283',
    glow: 'rgba(242, 154, 90, 0.40)',
    group: 'yellow',
  },
  cursor: {
    arrow: ['#C3CDDB', '#5D6B82'],
    pill: 'linear-gradient(135deg, #26272B 0%, #050505 100%)',
    text: '#F4F4F5',
    glyph: 'cube',
    glyphColor: '#E4E4E7',
    glow: 'rgba(93, 107, 130, 0.42)',
    group: 'grey',
  },
  gemini: {
    arrow: ['#79AEFF', '#8E6CEF'],
    pill: 'linear-gradient(120deg, #4796E3 0%, #9177C7 55%, #CA6673 100%)',
    text: '#FFFFFF',
    glyph: 'sparkle',
    glyphColor: '#FFFFFF',
    glow: 'rgba(145, 119, 199, 0.45)',
    group: 'pink',
  },
  copilot: {
    arrow: ['#7CC0FF', '#1F7FE0'],
    pill: 'linear-gradient(135deg, #1A7FD6 0%, #0A4F8C 100%)',
    text: '#FFFFFF',
    glyph: 'orbit',
    glyphColor: '#FFFFFF',
    glow: 'rgba(31, 127, 224, 0.42)',
    group: 'cyan',
  },
  agent: {
    arrow: ['#B9A2FF', '#7C3AED'],
    pill: 'linear-gradient(135deg, #8B5CF6 0%, #6D28D9 100%)',
    text: '#FFFFFF',
    glyph: 'orbit',
    glyphColor: '#FFFFFF',
    glow: 'rgba(124, 58, 237, 0.42)',
    group: 'purple',
  },
};

/** A color the user picked for their agents' cursor, like a team's brand color: #rrggbb. */
export const isColor = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

const rgbOf = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
const hexOf = (rgb) => `#${rgb.map((part) => Math.round(part).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
/** Moves a color part of the way toward another: toward white to lighten, black to darken. */
const mix = (rgb, toward, amount) => rgb.map((part, i) => part + (toward[i] - part) * amount);
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

/** Tab groups only come in Chrome's nine colors, so a picked color takes the nearest one. */
function groupColor([r, g, b]) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const lightness = (max + min) / 2;
  const chroma = max - min;
  if (chroma < 0.12 || lightness < 0.1 || lightness > 0.94) return 'grey';
  let hue;
  if (max === r / 255) hue = (((g - b) / 255 / chroma) % 6) * 60;
  else if (max === g / 255) hue = ((b - r) / 255 / chroma + 2) * 60;
  else hue = ((r - g) / 255 / chroma + 4) * 60;
  hue = (hue + 360) % 360;
  const hues = { red: 0, orange: 28, yellow: 52, green: 125, cyan: 185, blue: 220, purple: 268, pink: 318 };
  const distance = (a) => Math.min(Math.abs(hue - a), 360 - Math.abs(hue - a));
  return Object.keys(hues).reduce((best, name) => (distance(hues[name]) < distance(hues[best]) ? name : best));
}

/** A whole cursor look from one color: the arrow, the name tag, its glow and the tab group. */
function themeOfColor(hex) {
  const rgb = rgbOf(hex);
  const [r, g, b] = rgb.map((part) => {
    const c = part / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // Black on light colors, white on the rest: the name and its icon stay readable either way.
  const text = luminance > 0.45 ? '#161817' : '#FFFFFF';
  return {
    key: hex.toLowerCase(),
    // A pale color would vanish on a white page, so its arrow darkens toward the tip instead.
    arrow: luminance > 0.7 ? [hexOf(rgb), hexOf(mix(rgb, BLACK, 0.4))] : [hexOf(mix(rgb, WHITE, 0.38)), hexOf(rgb)],
    pill: `linear-gradient(135deg, ${hexOf(mix(rgb, WHITE, 0.12))} 0%, ${hexOf(mix(rgb, BLACK, 0.22))} 100%)`,
    text,
    glyph: 'sparkle',
    glyphColor: text,
    // What shows through a filled icon, like the letter on a monogram: the color itself.
    ink: hexOf(rgb),
    glow: `rgba(${rgb.join(', ')}, 0.42)`,
    group: groupColor(rgb),
  };
}

// ---------------------------------------------------------------- the name tag's icon

/**
 * The small marks on the name tag, drawn in a 16 by 16 box. They're data (an element, its
 * attributes, its children), so the page and the toolbar panel draw exactly the same thing, and
 * the page needs no markup to parse. currentColor is the tag's text color, black or white.
 */
const burst = Array.from({ length: 10 }, (_, i) => {
  const angle = (i * Math.PI) / 5 + 0.2;
  const inner = i % 2 ? 2.4 : 1.8;
  const outer = i % 2 ? 6.2 : 7.2;
  const at = (radius) => (8 + Math.cos(angle) * radius).toFixed(2);
  const atY = (radius) => (8 + Math.sin(angle) * radius).toFixed(2);
  return ['line', { x1: at(inner), y1: atY(inner), x2: at(outer), y2: atY(outer) }];
});
const star = Array.from({ length: 10 }, (_, i) => {
  const angle = -Math.PI / 2 + (i * Math.PI) / 5;
  const radius = i % 2 ? 3.1 : 7.2;
  return `${(8 + Math.cos(angle) * radius).toFixed(2)},${(8.4 + Math.sin(angle) * radius).toFixed(2)}`;
}).join(' ');

export const GLYPHS = {
  spark: ['g', { stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round' }, burst],
  prompt: ['g', { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [
    ['path', { d: 'M2.5 4.2 L6.3 8 L2.5 11.8' }],
    ['path', { d: 'M8.6 12 H13.6' }],
  ]],
  pixel: ['g', { fill: 'currentColor' }, [[1.5, 1.5], [6.2, 1.5], [10.9, 1.5], [1.5, 6.2], [10.9, 6.2], [1.5, 10.9], [6.2, 10.9], [10.9, 10.9]].map(([x, y]) => ['rect', { x, y, width: 3.6, height: 3.6, rx: 0.6 }])],
  cube: ['g', { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linejoin': 'round' }, [
    ['path', { d: 'M8 1.6 L14 5 L14 11 L8 14.4 L2 11 L2 5 Z' }],
    ['path', { d: 'M2 5 L8 8.4 L14 5 M8 8.4 L8 14.4' }],
  ]],
  sparkle: ['path', { fill: 'currentColor', d: 'M8 0.8 C8.6 5 11 7.4 15.2 8 C11 8.6 8.6 11 8 15.2 C7.4 11 5 8.6 0.8 8 C5 7.4 7.4 5 8 0.8 Z' }],
  orbit: ['g', {}, [
    ['circle', { cx: 8, cy: 8, r: 2.6, fill: 'currentColor' }],
    ['ellipse', { cx: 8, cy: 8, rx: 6.6, ry: 3.4, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3, transform: 'rotate(-28 8 8)' }],
  ]],
  bolt: ['path', { fill: 'currentColor', 'stroke-linejoin': 'round', stroke: 'currentColor', 'stroke-width': 0.6, d: 'M9.6 1 L3.2 9.1 H7.4 L6.4 15 L12.8 6.9 H8.6 Z' }],
  star: ['polygon', { fill: 'currentColor', stroke: 'currentColor', 'stroke-width': 0.9, 'stroke-linejoin': 'round', points: star }],
  heart: ['path', { fill: 'currentColor', d: 'M8 14.2 C3.2 10.9 1.2 8.4 1.2 5.8 C1.2 3.7 2.8 2.1 4.8 2.1 C6.1 2.1 7.3 2.8 8 3.9 C8.7 2.8 9.9 2.1 11.2 2.1 C13.2 2.1 14.8 3.7 14.8 5.8 C14.8 8.4 12.8 10.9 8 14.2 Z' }],
  diamond: ['path', { fill: 'currentColor', stroke: 'currentColor', 'stroke-width': 1, 'stroke-linejoin': 'round', d: 'M8 1.4 L14.6 8 L8 14.6 L1.4 8 Z' }],
  dot: ['circle', { cx: 8, cy: 8, r: 4.2, fill: 'currentColor' }],
  check: ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', d: 'M2.6 8.6 L6.3 12.2 L13.4 4.4' }],
};

/**
 * The icons someone can pick for their agents' name tag, in the order the panel shows them.
 * `initial` is the name's first letter on a disc, like an avatar; `none` leaves just the name.
 */
export const ICONS = ['initial', 'sparkle', 'bolt', 'star', 'heart', 'diamond', 'dot', 'check', 'prompt', 'cube', 'none'];

/** The first letter or digit of a name, for a monogram. */
const initialOf = (label) => [...String(label ?? '')].find((char) => /[\p{L}\p{N}]/u.test(char))?.toLocaleUpperCase() ?? '';

/** What a theme's icon draws, as data (see GLYPHS); null for no icon. */
export function glyphShape(theme, label) {
  if (theme.glyph === 'none') return null;
  if (theme.glyph === 'initial') {
    const letter = initialOf(label);
    if (!letter) return GLYPHS.sparkle;
    return ['g', {}, [
      ['circle', { cx: 8, cy: 8, r: 7.6, fill: 'currentColor' }],
      ['text', { x: 8, y: 11.3, 'text-anchor': 'middle', 'font-size': 9.6, 'font-weight': 800, fill: theme.ink ?? theme.arrow[1], 'font-family': '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif' }, [letter]],
    ]];
  }
  return GLYPHS[theme.glyph] ?? GLYPHS.orbit;
}

/**
 * A cursor look by its key: an agent's (claude, codex…) or one built from a #rrggbb color. `icon`
 * swaps the name tag's icon for one from ICONS; `label` is the name it shows, for a monogram.
 */
export function themeFor(key, { icon, label } = {}) {
  const base = isColor(key) ? themeOfColor(key) : { key: THEMES[key] ? key : 'agent', ...(THEMES[key] ?? THEMES.agent) };
  const theme = ICONS.includes(icon) ? { ...base, glyph: icon } : base;
  const glyph = glyphShape(theme, label);
  // The page redraws its cursor when the key changes, so the icon (and a monogram's letter) count.
  const letter = theme.glyph === 'initial' ? initialOf(label) : '';
  return { ...theme, key: `${base.key}:${theme.glyph}${letter ? `:${letter}` : ''}`, glyphShape: glyph };
}

/**
 * A cursor look someone chose (in the toolbar panel, or with `tabhand cursor`), cleaned up:
 * { name, color, icon } with any part left out when unset, or null when nothing is set.
 */
export function cleanLook(look) {
  if (!look || typeof look !== 'object') return null;
  const name = typeof look.name === 'string' ? look.name.replace(/[^\p{L}\p{N} ._&'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 24) : '';
  const color = isColor(look.color) ? look.color.toLowerCase() : '';
  const icon = ICONS.includes(look.icon) ? look.icon : '';
  if (!name && !color && !icon) return null;
  return { ...(name && { name }), ...(color && { color }), ...(icon && { icon }) };
}
