// How `tabhand setup` looks when a person runs it in a terminal: the site's painting for the time of
// day, its headline with the coral mark, numbered steps, and pickers that redraw in place. Agents,
// scripts and pipes never see any of this; setup prints plain lines for them.
//
// Colors come in 24-bit where the terminal has it and in its nearest 256 colors where it doesn't.
// With fewer colors, NO_COLOR or a dumb terminal, the painting is left out and the rest stays plain.

import readline from 'node:readline';
import { PAINTING_HEIGHT, PAINTING_WIDTH, PAINTINGS } from './paintings.mjs';

const ESC = '\x1b[';
const INK = [22, 24, 23];
const CREAM = [252, 249, 242];
const CORAL = [217, 90, 59];
const GRAY = [138, 141, 148];
const SAGE = [127, 154, 140];
/** The step numbers, in the painting's colors: lilac, amber, coral. */
const STEP_COLORS = [[163, 120, 159], [197, 136, 52], [217, 90, 59]];

const hexOf = (rgb) => rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))));
const luminance = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const visible = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** The 240 fixed xterm colors (16 to 255): the 6×6×6 cube, then the gray ramp. Terminals keep these as they are. */
const XTERM = [];
for (let i = 16; i < 256; i++) {
  if (i < 232) {
    const steps = [0, 95, 135, 175, 215, 255];
    const n = i - 16;
    XTERM.push([steps[Math.floor(n / 36)], steps[Math.floor(n / 6) % 6], steps[n % 6]]);
  } else XTERM.push(Array(3).fill(8 + (i - 232) * 10));
}

/** The nearest of those colors by perceived distance (the "redmean" weighting), as its index. */
function to256([r, g, b]) {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < XTERM.length; i++) {
    const [pr, pg, pb] = XTERM[i];
    const mean = (r + pr) / 2;
    const distance = (2 + mean / 256) * (r - pr) ** 2 + 4 * (g - pg) ** 2 + (2 + (255 - mean) / 256) * (b - pb) ** 2;
    if (distance < bestDistance) [best, bestDistance] = [i, distance];
  }
  return 16 + best;
}

/**
 * A painting in 256 colors, dithered: each pixel takes its nearest color and passes some of what it
 * missed by on to the pixels right of it and below it (Floyd–Steinberg), so the colors between the
 * fixed ones still show, the way a GIF does. Snapping alone turns a night sky flat navy.
 */
function dither(px, start, columns, height) {
  const buffer = new Float32Array(columns * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < columns; x++) buffer.set(px(start + x, y), (y * columns + x) * 3);
  const out = new Uint8Array(columns * height);
  const spread = (x, y, error, share) => {
    if (x < 0 || x >= columns || y >= height) return;
    const at = (y * columns + x) * 3;
    for (let c = 0; c < 3; c++) buffer[at + c] += error[c] * share * 0.45;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < columns; x++) {
      const at = (y * columns + x) * 3;
      const want = [0, 1, 2].map((c) => Math.max(0, Math.min(255, buffer[at + c])));
      const index = to256(want);
      out[y * columns + x] = index;
      const got = XTERM[index - 16];
      const error = want.map((v, c) => v - got[c]);
      spread(x + 1, y, error, 7 / 16);
      spread(x - 1, y + 1, error, 3 / 16);
      spread(x, y + 1, error, 5 / 16);
      spread(x + 1, y + 1, error, 1 / 16);
    }
  }
  return (x, y) => out[y * columns + x];
}

/** Which painting and what to call the hour, from the clock (TABHAND_TIME=HH:MM tries another). */
export function now() {
  const date = new Date();
  const forced = /^(\d{1,2}):(\d{2})$/.exec(process.env.TABHAND_TIME ?? '');
  if (forced) date.setHours(Number(forced[1]), Number(forced[2]));
  return date;
}

function sky(date) {
  const hour = date.getHours() + date.getMinutes() / 60;
  if (hour >= 5 && hour < 8) return ['dawn', 'Dawn'];
  if (hour >= 8 && hour < 11) return ['midday', 'Morning'];
  if (hour >= 11 && hour < 14) return ['midday', 'Midday'];
  if (hour >= 14 && hour < 16.5) return ['midday', 'Afternoon'];
  if (hour >= 16.5 && hour < 19) return ['golden', 'Golden hour'];
  if (hour >= 19 && hour < 21) return ['dusk', 'Dusk'];
  return ['night', 'Night'];
}

const clock = (date) => `${date.getHours() % 12 || 12}:${String(date.getMinutes()).padStart(2, '0')} ${date.getHours() < 12 ? 'am' : 'pm'}`;

const decoded = {};
function painting(name) {
  decoded[name] ??= Buffer.from(PAINTINGS[name], 'base64');
  const data = decoded[name];
  return (x, y) => {
    const at = (y * PAINTING_WIDTH + x) * 3;
    return [data[at], data[at + 1], data[at + 2]];
  };
}

export class Terminal {
  constructor(stream = process.stdout, env = process.env) {
    this.stream = stream;
    let depth = stream.getColorDepth?.(env) ?? 1;
    // Node rates macOS Terminal at 256 colors before it reads COLORTERM, so a terminal that says it
    // has 24-bit color is taken at its word here.
    if (depth >= 8 && /^(truecolor|24bit)$/i.test(env.COLORTERM ?? '')) depth = 24;
    // macOS Terminal has had 24-bit color since macOS 26 (Terminal 2.15; macOS 15's was build 455).
    if (depth >= 8 && env.TERM_PROGRAM === 'Apple_Terminal' && Number.parseFloat(env.TERM_PROGRAM_VERSION) >= 460) depth = 24;
    const forced = { 24: 24, 256: 8, none: 0 }[env.TABHAND_COLORS];
    // 24-bit, the 256 colors, or none (16 colors can't show the painting or the brand's coral).
    this.depth = forced ?? (depth >= 24 ? 24 : depth >= 8 ? 8 : 0);
    this.width = Math.max(20, stream.columns || 80);
    this.windows = process.platform === 'win32';
  }

  /** Hides the cursor while setup draws, and makes sure it comes back however setup ends. */
  start() {
    this.stream.write(`${ESC}?25l`);
    this.restore = () => this.stream.write(`${ESC}?25h`);
    process.once('exit', this.restore);
  }

  stop() {
    this.restore?.();
    process.off('exit', this.restore);
  }

  fg(rgb) {
    return this.depth === 24 ? `${ESC}38;2;${hexOf(rgb).join(';')}m` : this.depth === 8 ? `${ESC}38;5;${to256(rgb)}m` : '';
  }

  bg(rgb) {
    return this.depth === 24 ? `${ESC}48;2;${hexOf(rgb).join(';')}m` : this.depth === 8 ? `${ESC}48;5;${to256(rgb)}m` : '';
  }

  /** Text in a style: { fg, bg, bold, italic }. Plain text when the terminal has no colors. */
  paint(text, { fg, bg, bold, italic } = {}) {
    if (!this.depth) return text;
    const codes = `${bold ? `${ESC}1m` : ''}${italic ? `${ESC}3m` : ''}${fg ? this.fg(fg) : ''}${bg ? this.bg(bg) : ''}`;
    return codes ? `${codes}${text}${ESC}0m` : text;
  }

  gray = (text) => this.paint(text, { fg: GRAY });
  italic = (text) => this.paint(text, { fg: GRAY, italic: true });
  bold = (text) => this.paint(text, { bold: true });
  coral = (text, more = {}) => this.paint(text, { fg: CORAL, ...more });
  sage = (text) => this.paint(text, { fg: SAGE });

  /** The coral mark from the site and the panel: italic cream on coral, with half-cell ends. */
  mark(text, edge = null) {
    if (!this.depth) return text.trim();
    const end = (glyph) => this.paint(glyph, { fg: CORAL, bg: edge ?? undefined });
    return `${end('▐')}${this.paint(text, { fg: CREAM, bg: CORAL, italic: true })}${end('▌')}`;
  }

  /** How many columns of the painting fit: all 72, or the right-hand part, where the sun is. */
  get paintingColumns() {
    return Math.min(PAINTING_WIDTH, this.width - 2);
  }

  /**
   * Rows [from, to) of a painting, each terminal row two pixels (▀: the top one in front, the bottom
   * one behind), with text laid over cells: { row, col, text, bold, italic } (col 'right' aligns it
   * to the end) or { row, col, mark }. Text takes one color per item, ink or cream, whichever reads
   * on the paint under it; its cells show the two pixels' average.
   */
  painting(name, from, to, overlay = []) {
    const px = painting(name);
    const columns = this.paintingColumns;
    const start = PAINTING_WIDTH - columns;
    const index = this.depth === 8 ? dither(px, start, columns, PAINTING_HEIGHT) : null;
    const pixel = (x, y) => (index ? `${ESC}38;5;${index(x, y)}m` : this.fg(px(start + x, y)));
    const behind = (x, y) => (index ? `${ESC}48;5;${index(x, y)}m` : this.bg(px(start + x, y)));
    const average = (x, row) => {
      const a = px(start + x, 2 * row);
      const b = px(start + x, 2 * row + 1);
      return a.map((v, i) => (v + b[i]) / 2);
    };
    const lines = [];
    for (let row = from; row < Math.min(to, PAINTING_HEIGHT / 2); row++) {
      const cells = new Map();
      for (const item of overlay.filter((each) => each.row === row)) {
        if (item.mark) {
          const chars = [...item.mark];
          cells.set(item.col, { kind: 'start' });
          chars.forEach((ch, k) => cells.set(item.col + 1 + k, { kind: 'mark', ch }));
          cells.set(item.col + 1 + chars.length, { kind: 'end' });
          continue;
        }
        const chars = [...item.text];
        const col = item.col === 'right' ? columns - 2 - chars.length : item.col;
        if (col < 0) continue;
        const light = chars.reduce((sum, _, k) => sum + luminance(average(col + k, row)), 0) / chars.length;
        const fg = light > 0.5 ? INK : CREAM;
        chars.forEach((ch, k) => cells.set(col + k, { kind: 'text', ch, fg, item }));
      }
      let line = ' ';
      for (let x = 0; x < columns; x++) {
        const cell = cells.get(x);
        if (!cell) line += `${pixel(x, 2 * row)}${behind(x, 2 * row + 1)}▀`;
        else if (cell.kind === 'text') line += `${cell.item.bold ? `${ESC}1m` : ''}${cell.item.italic ? `${ESC}3m` : ''}${this.fg(cell.fg)}${this.bg(average(x, row))}${cell.ch}${ESC}22;23m`;
        else if (cell.kind === 'mark') line += `${ESC}3m${this.fg(CREAM)}${this.bg(CORAL)}${cell.ch}${ESC}23m`;
        else line += `${this.fg(CORAL)}${this.bg(average(x, row))}${cell.kind === 'start' ? '▐' : '▌'}`;
      }
      lines.push(`${line}${ESC}0m`);
    }
    return lines;
  }

  /** The top: the painting for this hour with the wordmark and the time on it, then the headline. */
  header(date, version) {
    const [name, hourName] = sky(date);
    const lines = [];
    if (this.depth && this.width >= 40) {
      lines.push(...this.painting(name, 0, 7, [{ row: 1, col: 2, text: 'Tabhand', bold: true }, { row: 1, col: 'right', text: `${clock(date)} · ${hourName}`, italic: true }]), '');
    }
    const head = ` ${this.bold('Give every agent ')}${this.mark(' a tab of its own. ')}`;
    const room = Math.min(PAINTING_WIDTH, this.width - 2) - visible(head).length - version.length;
    lines.push(this.depth ? `${head}${' '.repeat(Math.max(2, room))}${this.gray(version)}` : ` Tabhand ${version}: give every agent a tab of its own.`);
    return lines;
  }

  /** The end, as the toolbar panel opens: a slice of the painting with "Agents are ready." on it. */
  ending(date, [lead, word]) {
    const [name] = sky(date);
    if (!this.depth || this.width < 40) return [` ${lead} ${word}`];
    return this.painting(name, 0, 3, [
      { row: 1, col: 2, text: `${lead} `, bold: true },
      { row: 1, col: 2 + lead.length + 1, mark: ` ${word} ` },
    ]);
  }

  number(step) {
    return this.paint(String(step), { fg: STEP_COLORS[step - 1], bold: true });
  }

  rule() {
    return ` ${this.gray('─'.repeat(Math.min(PAINTING_WIDTH, this.width - 2)))}`;
  }

  /** A finished step, its text wrapped at commas and spaces, its notes under it, lined up with the text. */
  done(step, title, text, notes = []) {
    const room = Math.max(20, Math.min(PAINTING_WIDTH, this.width - 2) - 16);
    const lines = [];
    let line = '';
    // A list breaks only after its commas, so a name like "Factory Droid" stays on one line.
    for (const word of text.includes(', ') ? text.split(/(?<=,) /) : text.split(' ')) {
      if (line && visible(`${line} ${word}`).length > room) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
    const indent = ' '.repeat(16);
    return [` ${this.number(step)}  ${title.padEnd(12)}${lines[0]}`, ...lines.slice(1).map((more) => `${indent}${more}`), ...notes.map((note) => `${indent}${note}`)];
  }

  /** Cuts a line to the terminal's width, so a redraw never wraps. */
  fit(line) {
    const max = this.width - 1;
    if (visible(line).length <= max) return line;
    let out = '';
    let seen = 0;
    for (let i = 0; i < line.length && seen < max - 1; i++) {
      const code = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(line.slice(i));
      if (code) {
        out += code[0];
        i += code[0].length - 1;
      } else {
        out += line[i];
        seen++;
      }
    }
    return `${out}…${ESC}0m`;
  }
}

/** Lines that redraw in place: each draw replaces the last one. */
export class Region {
  constructor(terminal) {
    this.terminal = terminal;
    this.count = 0;
  }

  draw(lines) {
    const up = this.count ? `${ESC}${this.count}A\r` : '';
    this.terminal.stream.write(`${up}${ESC}0J${lines.map((line) => this.terminal.fit(line)).join('\n')}\n`);
    this.count = lines.length;
  }

  clear() {
    if (this.count) this.terminal.stream.write(`${ESC}${this.count}A\r${ESC}0J`);
    this.count = 0;
  }
}

export class Interrupted extends Error {}

/** Listens to keys in raw mode until the returned function is called. Ctrl-C calls onInterrupt. */
function listen(onKey, onInterrupt) {
  const input = process.stdin;
  readline.emitKeypressEvents(input);
  input.setRawMode?.(true);
  input.resume();
  const handler = (text, key = {}) => {
    if (key.ctrl && key.name === 'c') onInterrupt();
    else onKey(text, key);
  };
  input.on('keypress', handler);
  return () => {
    input.off('keypress', handler);
    input.setRawMode?.(false);
    input.pause();
  };
}

/**
 * A list to tick: ↑/↓ (or k/j) move, space ticks, a ticks all (or none), enter goes on.
 * items: [{ on, disabled }]. render(state) returns the lines for { items, cursor }.
 * Resolves with each item's tick; rejects with Interrupted on Ctrl-C.
 */
export function pick(region, items, render) {
  const state = { items: items.map((item) => ({ ...item })), cursor: Math.max(0, items.findIndex((item) => !item.disabled)) };
  const reachable = state.items.map((item, i) => (item.disabled ? -1 : i)).filter((i) => i >= 0);
  return new Promise((resolve, reject) => {
    const redraw = () => region.draw(render(state));
    const stop = listen(
      (text, key) => {
        const at = reachable.indexOf(state.cursor);
        if (key.name === 'up' || text === 'k') state.cursor = reachable[(at - 1 + reachable.length) % reachable.length];
        else if (key.name === 'down' || text === 'j') state.cursor = reachable[(at + 1) % reachable.length];
        else if (key.name === 'space' && reachable.length) state.items[state.cursor].on = !state.items[state.cursor].on;
        else if (text === 'a') {
          const all = reachable.every((i) => state.items[i].on);
          for (const i of reachable) state.items[i].on = !all;
        } else if (key.name === 'return' || key.name === 'enter') {
          stop();
          resolve(state.items.map((item) => Boolean(item.on && !item.disabled)));
          return;
        } else return;
        redraw();
      },
      () => {
        stop();
        reject(new Interrupted());
      },
    );
    redraw();
  });
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Redraws render(frame) every so often while poll() runs; ends when poll() says so, when enter is
 * pressed, or at the timeout. Resolves with 'done', 'enter' or 'timeout'; rejects on Ctrl-C.
 */
export function waitFor(region, render, poll, { every = 1000, timeout = 5 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    let frame = 0;
    let finished = false;
    const deadline = Date.now() + timeout;
    const end = (how, error) => {
      if (finished) return;
      finished = true;
      clearInterval(spin);
      stop();
      if (error) reject(error);
      else resolve(how);
    };
    const stop = listen(
      (text, key) => {
        if (key.name === 'return' || key.name === 'enter') end('enter');
      },
      () => end(null, new Interrupted()),
    );
    const spin = setInterval(() => !finished && region.draw(render(SPINNER[++frame % SPINNER.length])), 120);
    region.draw(render(SPINNER[0]));
    (async () => {
      while (!finished && Date.now() < deadline) {
        if (await poll()) return end('done');
        await new Promise((r) => setTimeout(r, every));
      }
      end('timeout');
    })();
  });
}
