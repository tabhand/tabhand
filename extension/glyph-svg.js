// An uploaded SVG, turned into the same data the built-in icons are (see GLYPHS in themes.js): an
// element tree in a 16 by 16 box that pages and the panel build with createElementNS, never as
// markup. A file is untrusted, so everything here is an allowlist: an element or attribute that
// isn't named below is left out, a value that isn't plainly a number, a color or a path is
// dropped, and a stored drawing goes through the same checks again on its way to a page
// (cleanGlyphShape), since settings.json and chrome.storage can be edited by hand.
//
// This runs in the extension and in Node, where there is no DOMParser, so it reads the small XML
// subset an icon needs itself.

export const MAX_ICON_BYTES = 8 * 1024;
export const MAX_ICON_NODES = 200;
export const MAX_ICON_PATH = 6000;
/** Groups nested deeper than this aren't a mark any more, and keep the parser's stack shallow. */
const MAX_ICON_DEPTH = 64;

/** Elements an icon may use. The file's <svg> root is read for its viewBox and never stored. */
const ELEMENTS = new Set(['g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']);
/** What a tag can draw with: geometry and paint. No hrefs, no style, no ids, nothing to resolve. */
const ATTRIBUTES = new Set([
  'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height', 'x1', 'y1', 'x2', 'y2', 'points', 'transform',
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill-rule', 'clip-rule',
  'opacity', 'fill-opacity', 'stroke-opacity',
]);
const NUMBER = String.raw`-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?`;
const NUMBER_ONLY = new RegExp(`^${NUMBER}$`, 'i');
const LENGTH = new RegExp(`^${NUMBER}(?:px|%)?$`, 'i');
const VIEWBOX = new RegExp(`^\\s*(${NUMBER})[\\s,]+(${NUMBER})[\\s,]+(${NUMBER})[\\s,]+(${NUMBER})\\s*$`, 'i');
const SIDED_LENGTH = new RegExp(`^\\s*(${NUMBER})(?:px)?\\s*$`, 'i');
/** Transform functions only: a matrix can move a drawing, but can't point anywhere. */
const TRANSFORM = /^(?:\s*(?:matrix|translate|scale|rotate|skewX|skewY)\s*\([-+0-9.eE,\s]*\)\s*)+$/;
/** Path commands, digits and separators. No letters beyond these, so nothing can spell a URL. */
const PATH = /^[\s,0-9.eE+\-.MmZzLlHhVvCcSsQqTtAa]*$/;
const POINTS = /^[\s,0-9.eE+\-.]*$/;
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*(?:[,/]\s*(?:0|1|0?\.\d+|\d{1,3}%)\s*)?\)$/i;
/** The named colors an icon may keep; `none` and `currentColor` are handled beside them. */
const NAMED = new Set([
  'black', 'white', 'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'pink', 'gray', 'grey',
  'silver', 'maroon', 'navy', 'teal', 'aqua', 'lime', 'olive', 'fuchsia', 'magenta', 'cyan', 'brown',
  'gold', 'transparent',
]);
const CAPS = new Set(['butt', 'round', 'square']);
const JOINS = new Set(['miter', 'round', 'bevel']);
const RULES = new Set(['nonzero', 'evenodd']);
const DRAWN = new Set(['path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']);

/**
 * An SVG file as icon data: a `g` holding the file's shapes, moved into the 16 by 16 box.
 * Throws an Error saying why when the file isn't one Tabhand can use.
 * @returns {Array} ['g', { transform?, fill?, … }, children]
 */
export function parseGlyphSvg(markup) {
  const text = String(markup ?? '');
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_ICON_BYTES) {
    throw new Error(`That SVG is ${Math.ceil(bytes / 1024)} KB. Tabhand takes icons up to 8 KB, which is more than a 14 px tag can show.`);
  }
  const root = new Parser(text).document();
  const budget = { nodes: 0, drawn: 0 };
  const children = [];
  for (const child of root.children) {
    const node = imported(child, budget);
    if (node) children.push(node);
  }
  if (!children.length) throw new Error('That SVG has nothing Tabhand can draw. It takes paths, circles, ellipses, rects, lines, polylines and polygons.');
  const attributes = paintOf(root.attributes);
  const fit = fitOf(boxOf(root.attributes));
  if (fit) attributes.transform = fit;
  return ['g', attributes, children];
}

/** A stored drawing, checked against the same allowlist; null when any part of it fails. */
export function cleanGlyphShape(shape) {
  const budget = { nodes: 0, drawn: 0 };
  const clean = stored(shape, budget);
  return clean && draws(clean) ? clean : null;
}

/**
 * A drawing in the colors the tag shows: `one` paints everything that isn't `none` in the tag's
 * own text color, `own` keeps the colors the file has. Returns a copy, never the input.
 */
export function paintGlyphShape(shape, colors) {
  const one = colors !== 'own';
  const repaint = (node) => {
    const [name, attributes = {}, children = []] = node;
    const painted = {};
    for (const [key, value] of Object.entries(attributes)) {
      painted[key] = one && (key === 'fill' || key === 'stroke') && value !== 'none' ? 'currentColor' : value;
    }
    return children.length ? [name, painted, children.map(repaint)] : [name, painted];
  };
  const painted = repaint(shape);
  // A shape with no fill paints SVG's black; on the tag it takes the name's color instead.
  if (one && !('fill' in painted[1])) painted[1].fill = 'currentColor';
  return painted;
}

// ---------------------------------------------------------------- the file

/** Reads an attribute the importing side keeps, with its value normalised, or null. */
function attributeOf(rawName, rawValue) {
  const name = String(rawName).toLowerCase();
  if (!ATTRIBUTES.has(name)) return null;
  const value = String(rawValue).trim();
  if (!value || /url\(|javascript:|expression\(|[<>&]/i.test(value)) return null;
  if (name === 'fill' || name === 'stroke') {
    const paint = paintValue(value);
    return paint ? [name, paint] : null;
  }
  if (name === 'd') return PATH.test(value) && /\d/.test(value) ? [name, value] : null;
  if (name === 'points') return POINTS.test(value) && /\d/.test(value) ? [name, value] : null;
  if (name === 'transform') return TRANSFORM.test(value) ? [name, value.replace(/\s+/g, ' ').trim()] : null;
  if (name === 'stroke-linecap') return CAPS.has(value) ? [name, value] : null;
  if (name === 'stroke-linejoin') return JOINS.has(value) ? [name, value] : null;
  if (name === 'fill-rule' || name === 'clip-rule') return RULES.has(value) ? [name, value] : null;
  if (name === 'opacity' || name === 'fill-opacity' || name === 'stroke-opacity') {
    return NUMBER_ONLY.test(value) && Number(value) >= 0 && Number(value) <= 1 ? [name, value] : null;
  }
  if (name === 'stroke-width') {
    const width = SIDED_LENGTH.exec(value);
    return width && Number(width[1]) >= 0 ? [name, value] : null;
  }
  return LENGTH.test(value) ? [name, value] : null;
}

/** A paint as #hex, rgb() numbers, a named color, none or currentColor. */
function paintValue(value) {
  if (/^none$/i.test(value)) return 'none';
  if (/^currentcolor$/i.test(value)) return 'currentColor';
  if (HEX.test(value)) return value.toLowerCase();
  const rgb = RGB.exec(value);
  if (rgb && [rgb[1], rgb[2], rgb[3]].every((part) => Number(part) <= 255)) return value.replace(/\s+/g, '');
  const named = value.toLowerCase();
  return NAMED.has(named) ? named : undefined;
}

/** The `<svg>`'s own paint, which its shapes inherit, moved onto the wrapper. */
function paintOf(attributes) {
  const paint = {};
  for (const [name, value] of attributes) {
    const kept = attributeOf(name, value);
    if (kept && !ROOT_ONLY.has(kept[0])) paint[kept[0]] = kept[1];
  }
  return paint;
}

/** The root's size and place belong to the fit, not to the shapes inside it. */
const ROOT_ONLY = new Set(['width', 'height', 'transform']);

/** The drawing's own box, from its viewBox or else its width and height. */
function boxOf(attributes) {
  const value = (name) => attributes.find(([key]) => key.toLowerCase() === name)?.[1] ?? '';
  const viewBox = VIEWBOX.exec(value('viewbox'));
  if (viewBox) {
    const [minX, minY, width, height] = viewBox.slice(1).map(Number);
    if (width > 0 && height > 0) return { minX, minY, width, height };
  }
  const width = SIDED_LENGTH.exec(value('width'));
  const height = SIDED_LENGTH.exec(value('height'));
  const w = width ? Number(width[1]) : height ? Number(height[1]) : 16;
  const h = height ? Number(height[1]) : width ? Number(width[1]) : 16;
  return w > 0 && h > 0 ? { minX: 0, minY: 0, width: w, height: h } : { minX: 0, minY: 0, width: 16, height: 16 };
}

/** Moves that box into 16 by 16, keeping its aspect ratio and centering it. */
function fitOf({ minX, minY, width, height }) {
  const round = (number) => Math.round(number * 1e4) / 1e4;
  const scale = 16 / Math.max(width, height);
  const x = (16 - width * scale) / 2 - minX * scale;
  const y = (16 - height * scale) / 2 - minY * scale;
  const steps = [];
  if (x || y) steps.push(`translate(${round(x)} ${round(y)})`);
  if (scale !== 1) steps.push(`scale(${round(scale)})`);
  return steps.join(' ');
}

/** One parsed element as icon data, or null for one that isn't allowed (with all inside it). */
function imported(element, budget) {
  if (!ELEMENTS.has(element.name)) return null;
  if (++budget.nodes > MAX_ICON_NODES) {
    throw new Error(`That SVG has more than ${MAX_ICON_NODES} elements. Tabhand takes up to ${MAX_ICON_NODES}, which is all a 14 px tag has room for.`);
  }
  const attributes = {};
  for (const [name, value] of element.attributes) {
    const kept = attributeOf(name, value);
    if (!kept) continue;
    attributes[kept[0]] = kept[1];
    if (kept[0] === 'd' || kept[0] === 'points') {
      budget.drawn += kept[1].length;
      if (budget.drawn > MAX_ICON_PATH) {
        throw new Error(`That SVG's outlines are over ${MAX_ICON_PATH} characters. Tabhand takes simpler drawings, so the icon stays sharp at tag size.`);
      }
    }
  }
  const children = element.children.map((child) => imported(child, budget)).filter(Boolean);
  return children.length ? [element.name, attributes, children] : [element.name, attributes];
}

/** A stored node, checked the way an imported one is. Anything unexpected fails the whole icon. */
function stored(node, budget) {
  if (!Array.isArray(node) || node.length < 2 || node.length > 3) return null;
  const [name, attributes, children = []] = node;
  if (!ELEMENTS.has(name) || !plain(attributes) || !Array.isArray(children)) return null;
  if (++budget.nodes > MAX_ICON_NODES) return null;
  const clean = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const kept = attributeOf(key, value);
    if (!kept) return null;
    clean[kept[0]] = kept[1];
    if (kept[0] === 'd' || kept[0] === 'points') {
      budget.drawn += kept[1].length;
      if (budget.drawn > MAX_ICON_PATH) return null;
    }
  }
  const kept = [];
  for (const child of children) {
    const cleanChild = stored(child, budget);
    if (!cleanChild) return null;
    kept.push(cleanChild);
  }
  return kept.length ? [name, clean, kept] : [name, clean];
}

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const draws = (node) => DRAWN.has(node[0]) || (node[2] ?? []).some(draws);

/**
 * The XML an icon is: elements with attributes, comments, the XML declaration and a doctype.
 * Text is read and dropped, since nothing an icon draws is text.
 */
class Parser {
  constructor(text) {
    this.text = text;
    this.at = 0;
  }

  fail(reason) {
    throw new Error(reason);
  }

  /** The file's root element, which has to be <svg>. */
  document() {
    this.skipMisc();
    if (this.text[this.at] !== '<' || this.text[this.at + 1] === '/' || this.text[this.at + 1] === '!') {
      this.fail("That file isn't an SVG: it doesn't start with <svg>.");
    }
    const root = this.element();
    if (root.name !== 'svg') this.fail(`That file isn't an SVG: its root element is <${root.name}>.`);
    this.skipMisc();
    if (this.text.slice(this.at).trim()) this.fail("That file isn't an SVG: it has more than one root element.");
    return root;
  }

  /** Skips what sits between elements and never draws: comments, <?xml?>, a doctype. */
  skipMisc() {
    for (;;) {
      this.skipSpace();
      if (this.text.startsWith('<!--', this.at)) {
        this.at = this.past('-->', this.at + 4);
        continue;
      }
      if (this.text.startsWith('<?', this.at)) {
        this.at = this.past('?>', this.at + 2);
        continue;
      }
      if (this.text.startsWith('<!', this.at)) {
        this.declaration();
        continue;
      }
      return;
    }
  }

  past(marker, from) {
    const found = this.text.indexOf(marker, from);
    if (found < 0) this.fail('That SVG is cut off in the middle.');
    return found + marker.length;
  }

  /** A doctype, internal subset included. Nothing in it is ever read. */
  declaration() {
    let depth = 0;
    for (let i = this.at + 2; i < this.text.length; i++) {
      const char = this.text[i];
      if (char === '[') depth++;
      else if (char === ']') depth--;
      else if (char === '>' && depth <= 0) {
        this.at = i + 1;
        return;
      }
    }
    this.fail('That SVG is cut off in the middle.');
  }

  skipSpace() {
    while (this.at < this.text.length && /\s/.test(this.text[this.at])) this.at++;
  }

  readName() {
    const start = this.at;
    while (this.at < this.text.length && !/[\s/>=]/.test(this.text[this.at])) this.at++;
    return this.text.slice(start, this.at);
  }

  /** An element at this.at, which is on its '<'. */
  element(depth = 0) {
    if (depth > MAX_ICON_DEPTH) this.fail(`That SVG nests its shapes more than ${MAX_ICON_DEPTH} groups deep. Flatten it, or use fewer groups.`);
    this.at++;
    const name = this.readName().toLowerCase();
    if (!name) this.fail('That SVG is malformed near "<".');
    const attributes = [];
    let selfClosing = false;
    for (;;) {
      this.skipSpace();
      const char = this.text[this.at];
      if (char === undefined) this.fail(`That SVG is cut off: <${name}> never closes.`);
      if (char === '>') {
        this.at++;
        break;
      }
      if (char === '/') {
        if (this.text[this.at + 1] !== '>') this.fail(`That SVG is malformed inside <${name}>.`);
        this.at += 2;
        selfClosing = true;
        break;
      }
      const attribute = this.readName().toLowerCase();
      if (!attribute) this.fail(`That SVG is malformed inside <${name}>.`);
      this.skipSpace();
      if (this.text[this.at] !== '=') {
        attributes.push([attribute, '']);
        continue;
      }
      this.at++;
      this.skipSpace();
      attributes.push([attribute, this.readValue()]);
    }
    return { name, attributes, children: selfClosing ? [] : this.children(name, depth) };
  }

  readValue() {
    const quote = this.text[this.at];
    if (quote === '"' || quote === "'") {
      const end = this.text.indexOf(quote, this.at + 1);
      if (end < 0) this.fail('That SVG is cut off in the middle of an attribute.');
      const value = this.text.slice(this.at + 1, end);
      this.at = end + 1;
      return value;
    }
    const start = this.at;
    while (this.at < this.text.length && !/[\s>]/.test(this.text[this.at])) this.at++;
    if (this.at === start) this.fail('That SVG is malformed: an attribute has no value.');
    return this.text.slice(start, this.at);
  }

  /** Everything inside an element, up to its closing tag. */
  children(name, depth) {
    const children = [];
    for (;;) {
      this.skipMisc();
      if (this.at >= this.text.length) this.fail(`That SVG is cut off: <${name}> never closes.`);
      if (this.text.startsWith('</', this.at)) {
        this.at += 2;
        const closing = this.readName().toLowerCase();
        this.skipSpace();
        if (this.text[this.at] !== '>') this.fail(`That SVG is malformed: </${closing} has no ">".`);
        this.at++;
        if (closing !== name) this.fail(`That SVG is malformed: <${name}> closes with </${closing}>.`);
        return children;
      }
      if (this.text[this.at] === '<') {
        children.push(this.element(depth + 1));
        continue;
      }
      const next = this.text.indexOf('<', this.at);
      this.at = next < 0 ? this.text.length : next;
    }
  }
}
