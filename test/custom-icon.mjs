// The uploaded-icon sanitiser, without a browser: a clean logo becomes icon data that fills the
// 16 by 16 box, and everything an SVG can carry that a page could act on is left out of the tree
// that reaches a page. Run it against a validator that passes everything through and the hostile
// checks below fail, which is how this test earns its place.
//
//   node test/custom-icon.mjs

import { cleanGlyphShape, parseGlyphSvg, paintGlyphShape } from '../extension/glyph-svg.js';
import { cleanLook, themeFor } from '../extension/themes.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const throws = (fn, pattern) => {
  try {
    fn();
    return false;
  } catch (error) {
    return pattern.test(error.message);
  }
};

// The allowlist as the product states it, written out again here so this file doesn't just ask the
// implementation whether it agrees with itself.
const ELEMENTS = new Set(['g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']);
const ATTRIBUTES = new Set([
  'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height', 'x1', 'y1', 'x2', 'y2', 'points', 'transform',
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill-rule', 'clip-rule',
  'opacity', 'fill-opacity', 'stroke-opacity',
]);
const NAMED = new Set([
  'black', 'white', 'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'pink', 'gray', 'grey',
  'silver', 'maroon', 'navy', 'teal', 'aqua', 'lime', 'olive', 'fuchsia', 'magenta', 'cyan', 'brown',
  'gold', 'transparent',
]);
const SAFE_PAINT = /^(?:none|currentcolor|#[0-9a-f]{3,8}|rgba?\([\d\s.,/%]+\))$/i;
const HOSTILE = /script|foreignobject|javascript:|url\(|xlink|href|on[a-z]+\s*=|<|&/i;

/** Everything in the tree a page could act on, as a list of complaints. */
function problems(tree) {
  const found = [];
  const walk = (node, at) => {
    if (!Array.isArray(node) || typeof node[0] !== 'string') {
      found.push(`${at}: not an element`);
      return;
    }
    const [name, attributes = {}, children = []] = node;
    if (!ELEMENTS.has(name)) found.push(`${at}: element <${name}>`);
    if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) found.push(`${at}: attributes are not an object`);
    if (!Array.isArray(children)) found.push(`${at}: children are not a list`);
    for (const [key, value] of Object.entries(attributes ?? {})) {
      if (!ATTRIBUTES.has(key)) found.push(`${at}: attribute ${key}`);
      const text = String(value);
      if (HOSTILE.test(text)) found.push(`${at}: value ${key}="${text}"`);
      if (key === 'fill' || key === 'stroke') {
        if (!SAFE_PAINT.test(text) && !NAMED.has(text.toLowerCase())) found.push(`${at}: paint ${text}`);
      }
    }
    for (const child of children) walk(child, `${at}/<${name}>`);
  };
  walk(tree, '');
  return found;
}

/** The box a drawing covers once the wrapper's transform has placed it in the 16 by 16 tag. */
function placed(shape, box) {
  const transform = shape[1].transform ?? '';
  const translate = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(transform);
  const scale = /scale\(([-\d.]+)\)/.exec(transform);
  const s = scale ? Number(scale[1]) : 1;
  const [dx, dy] = translate ? [Number(translate[1]), Number(translate[2])] : [0, 0];
  return {
    left: dx + box.x * s,
    right: dx + (box.x + box.width) * s,
    top: dy + box.y * s,
    bottom: dy + (box.y + box.height) * s,
  };
}
const near = (a, b) => Math.abs(a - b) < 0.001;
const inside = (box) => box.left >= -0.001 && box.top >= -0.001 && box.right <= 16.001 && box.bottom <= 16.001;

const LABEL = 'M2 2 H30 V22 H2 Z';
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 24">
  <title>Acme</title>
  <desc>A made-up team logo</desc>
  <g fill="#FF5A1F" stroke="none">
    <path d="${LABEL}"/>
    <circle cx="16" cy="12" r="6" fill="#FFFFFF"/>
  </g>
</svg>`;

// ---------------------------------------------------------------- a clean logo
const shape = parseGlyphSvg(LOGO);
check('a logo becomes icon data: one wrapper, the shapes inside it', shape[0] === 'g' && Array.isArray(shape[2]) && shape[2].length === 1, JSON.stringify(shape[1]));
check('and carries nothing a page could act on', problems(shape).length === 0, problems(shape).join('; '));
check('the path keeps its drawing', JSON.stringify(shape).includes(LABEL));
check('the dropped title and desc are gone', !JSON.stringify(shape).includes('Acme') && !JSON.stringify(shape).includes('made-up'));
check('colors come out as lowercase #hex', JSON.stringify(shape).includes('#ff5a1f') && JSON.stringify(shape).includes('#ffffff'));

const box = placed(shape, { x: 0, y: 0, width: 32, height: 24 });
check('the 32 by 24 drawing fits the 16 by 16 box', inside(box), JSON.stringify(box));
check('keeping its aspect ratio and centering it', near(box.left, 0) && near(box.right, 16) && near(box.top, 2) && near(box.bottom, 14), JSON.stringify(box));
check('a 16 by 16 drawing needs no transform', parseGlyphSvg(`<svg viewBox="0 0 16 16"><path d="M0 0 L16 16"/></svg>`)[1].transform === undefined);

const square = parseGlyphSvg('<svg width="64" height="64"><path d="M0 0 L64 64"/></svg>');
check('width and height stand in for a viewBox', square[1].transform === 'scale(0.25)', square[1].transform);
const wide = parseGlyphSvg('<svg viewBox="0 0 40 20"><path d="M0 0 L40 20"/></svg>');
check('a wide drawing is centered on its short side', wide[1].transform === 'translate(0 4) scale(0.4)', wide[1].transform);

// ---------------------------------------------------------------- one color, or its own
const one = paintGlyphShape(shape, 'one');
check('one color paints every fill and stroke in the tag’s color', JSON.stringify(one).indexOf('"#') === -1 && JSON.stringify(one).includes('"fill":"currentColor"'), JSON.stringify(one[1]));
check('and leaves none alone', paintGlyphShape(parseGlyphSvg('<svg viewBox="0 0 16 16"><g fill="none" stroke="#123456"><path d="M1 1 L15 15"/></g></svg>'), 'one')[2][0][1].fill === 'none');
const own = paintGlyphShape(shape, 'own');
check('its own colors keep the ones in the file', own[2][0][1].fill === '#ff5a1f' && own[2][0][2][1][1].fill === '#ffffff', JSON.stringify(own[2][0][1]));
check('painting copies the drawing rather than changing it', shape[2][0][1].fill === '#ff5a1f' && own !== shape);
check('a painted drawing still passes the validator', cleanGlyphShape(one) !== null);

// ---------------------------------------------------------------- hostile files
const wrap = (inner, attributes = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 24"${attributes}><path d="${LABEL}" fill="#FF5A1F"/>${inner}</svg>`;
const HOSTILE_FILES = {
  '<script>': wrap('<script>alert(document.cookie)</script>'),
  'onload=': wrap('', ' onload="alert(1)"'),
  'onclick=': wrap('<path d="M1 1 L2 2" onclick="alert(1)"/>'),
  '<foreignObject>': wrap('<foreignObject width="32" height="24"><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject>'),
  '<use href>': wrap('<use href="#logo"/>'),
  '<image href="https://…">': wrap('<image href="https://example.com/track.png" width="32" height="24"/>'),
  'style="background:url(…)"': wrap('<path d="M1 1 L2 2" style="background:url(https://example.com/x)"/>'),
  'fill="url(#g)"': '<svg viewBox="0 0 32 24"><defs><linearGradient id="g"><stop stop-color="red"/></linearGradient></defs><path d="M1 1 L2 2" fill="url(#g)"/><path d="' + LABEL + '"/></svg>',
  'xlink:href="javascript:…"': wrap('<path d="M1 1 L2 2" xlink:href="javascript:alert(1)"/>'),
  'fill="javascript:…"': wrap('<path d="M1 1 L2 2" fill="javascript:alert(1)"/>'),
  '<a href>': wrap('<a href="https://example.com"><path d="M1 1 L2 2"/></a>'),
  '<animate>': wrap('<animate attributeName="fill" values="red;blue"/>'),
  '<text>': wrap('<text x="1" y="2">Acme</text>'),
  'an entity': wrap('<path d="&lt;script&gt;"/>'),
};
for (const [name, markup] of Object.entries(HOSTILE_FILES)) {
  let tree = null;
  let error = '';
  try {
    tree = parseGlyphSvg(markup);
  } catch (thrown) {
    error = thrown.message;
  }
  const found = tree ? problems(tree) : ['threw: ' + error];
  check(`${name} is neutralized`, tree !== null && found.length === 0, found.join('; '));
  check(`  and the logo beside it still draws`, tree !== null && JSON.stringify(tree).includes(LABEL));
}

// Keyword attributes take only their listed words, not names an object inherits.
const inherited = parseGlyphSvg('<svg viewBox="0 0 16 16"><path d="M0 0 L16 16" stroke-linecap="toString" stroke-linejoin="constructor" fill-rule="__proto__"/></svg>');
check('a keyword attribute keeps only its listed words', !['stroke-linecap', 'stroke-linejoin', 'fill-rule'].some((key) => key in inherited[2][0][1]), JSON.stringify(inherited[2][0][1]));

// ---------------------------------------------------------------- size caps
const manyPaths = `<svg viewBox="0 0 16 16">${'<path d="M0 0 L1 1"/>'.repeat(220)}</svg>`;
check('a tree over 200 elements is refused', throws(() => parseGlyphSvg(manyPaths), /more than 200 elements/), `${manyPaths.length} bytes`);
const longPath = `<svg viewBox="0 0 16 16"><path d="${'M0 0 '.repeat(1300)}"/></svg>`;
check('a drawing over 6,000 characters is refused', throws(() => parseGlyphSvg(longPath), /over 6000 characters/), `${longPath.length} bytes`);
const bigFile = `<svg viewBox="0 0 16 16">${'<path d="M0 0 L9 9"/>\n'.repeat(500)}</svg>`;
check('a file over 8 KB is refused', throws(() => parseGlyphSvg(bigFile), /8 KB/), `${bigFile.length} bytes`);
const deepFile = `<svg viewBox="0 0 16 16">${'<g>'.repeat(202)}<path d="M0 0"/>${'</g>'.repeat(202)}</svg>`;
check('a deeply nested file is refused', throws(() => parseGlyphSvg(deepFile), /nests its shapes more than 64/));
const nested = `<svg viewBox="0 0 16 16">${'<g>'.repeat(10)}<path d="M0 0 L16 16"/>${'</g>'.repeat(10)}</svg>`;
check('a drawing with groups nested ten deep is fine', parseGlyphSvg(nested)[2].length === 1);
check('a file with nothing to draw says so', throws(() => parseGlyphSvg('<svg viewBox="0 0 16 16"><script>alert(1)</script></svg>'), /nothing Tabhand can draw/));
check('a file that is not an SVG says so', throws(() => parseGlyphSvg('<html><body>hi</body></html>'), /isn't an SVG/));
check('a cut-off file says so', throws(() => parseGlyphSvg('<svg viewBox="0 0 16 16"><g><path d="M0 0"/>'), /cut off/));

// ---------------------------------------------------------------- a look in storage
const look = cleanLook({ name: 'Acme', color: '#FF5A1F', icon: 'custom', iconShape: shape, iconColors: 'own' });
check('cleanLook keeps an uploaded icon as data', look?.icon === 'custom' && JSON.stringify(look.iconShape).includes(LABEL) && look.iconColors === 'own', JSON.stringify({ ...look, iconShape: '…' }));
check('and defaults its colors to one', cleanLook({ color: '#ff5a1f', icon: 'custom', iconShape: shape }).iconColors === 'one');

const HOSTILE_TREES = {
  '<script>': ['g', {}, [['script', { src: 'https://evil.example/x.js' }], ['path', { d: 'M1 1 L9 9' }]]],
  '<foreignObject>': ['g', {}, [['foreignObject', {}, [['path', { d: 'M1 1 L9 9' }]]], ['path', { d: 'M1 1 L9 9' }]]],
  'onclick=': ['g', { onclick: 'alert(1)' }, [['path', { d: 'M1 1 L9 9' }]]],
  'a child with onclick': ['g', {}, [['path', { d: 'M1 1 L9 9', onclick: 'alert(1)' }]]],
  'href': ['g', {}, [['path', { d: 'M1 1 L9 9', href: 'javascript:alert(1)' }]]],
  'fill="url(#g)"': ['g', {}, [['path', { d: 'M1 1 L9 9', fill: 'url(#g)' }]]],
  'a style attribute': ['g', {}, [['path', { d: 'M1 1 L9 9', style: 'background:url(https://example.com/x)' }]]],
  'a text node': ['g', {}, ['alert(1)', ['path', { d: 'M1 1 L9 9' }]]],
  'a bad element name': ['g', {}, [['script ', { d: 'M1 1 L9 9' }]]],
  'too many elements': ['g', {}, Array.from({ length: 210 }, () => ['path', { d: 'M1 1 L9 9' }])],
  'too much drawing': ['g', {}, [['path', { d: 'M0 0 '.repeat(1300) }]]],
};
for (const [name, tree] of Object.entries(HOSTILE_TREES)) {
  const cleaned = cleanLook({ name: 'Mallory', color: '#2563eb', icon: 'custom', iconShape: tree });
  const said = JSON.stringify(cleaned);
  check(`a stored drawing with ${name} is dropped`, Boolean(cleaned) && cleaned.icon === undefined && !HOSTILE.test(said) && !said.includes('alert'), said.slice(0, 160));
}

const theme = themeFor('claude', { icon: 'custom', iconShape: shape, iconColors: 'one', label: 'Acme' });
check('themeFor draws the uploaded icon on the tag', Boolean(theme.glyphShape) && JSON.stringify(theme.glyphShape).includes(LABEL) && theme.key.includes(':custom:'), theme.key);
check('and repaints it in the tag’s color', JSON.stringify(theme.glyphShape).indexOf('"#') === -1);
const fallback = themeFor('claude', { icon: 'custom', iconShape: HOSTILE_TREES['<script>'], label: 'Acme' });
check('a hostile drawing never becomes a theme', !JSON.stringify(fallback.glyphShape).includes('script') && !fallback.key.includes('custom'), fallback.key);
check('the page redraws when the drawing changes', themeFor('claude', { icon: 'custom', iconShape: shape, iconColors: 'own' }).key !== theme.key);

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
