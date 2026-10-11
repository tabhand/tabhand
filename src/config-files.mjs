// Careful edits to other programs' config files: JSON (with comments) and TOML. Edits keep the
// rest of the file as it was, write atomically, and keep a copy of the file from before Tabhand
// first changed it.

import fs from 'node:fs';
import path from 'node:path';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { installDir } from './paths.mjs';

const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/** Keeps the file as it was before Tabhand first touched it, in installDir/backups. */
function backUp(file, text) {
  if (text === null) return;
  const copy = path.join(installDir(), 'backups', file.replace(/^\/+/, '').replaceAll('/', '__'));
  if (fs.existsSync(copy)) return;
  fs.mkdirSync(path.dirname(copy), { recursive: true, mode: 0o700 });
  fs.writeFileSync(copy, text, { mode: 0o600 });
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  const temp = `${file}.tabhand-${process.pid}`;
  fs.writeFileSync(temp, text, { mode });
  fs.renameSync(temp, file);
}

/** The value at keyPath in a JSON (or JSONC) file, or undefined. */
export function readJson(file, keyPath) {
  const text = read(file);
  if (text === null) return undefined;
  let value = parse(text, [], { allowTrailingComma: true });
  for (const key of keyPath) value = value?.[key];
  return value;
}

/** Sets (or, with value undefined, removes) the value at keyPath, keeping comments and layout. */
export function writeJson(file, keyPath, value) {
  const text = read(file);
  if (value === undefined && text === null) return;
  const errors = [];
  parse(text ?? '{}', errors, { allowTrailingComma: true });
  if (errors.length) throw new Error(`${file} isn't valid JSON, so Tabhand left it alone.`);
  backUp(file, text);
  const edits = modify(text ?? '{}', keyPath, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
  });
  let next = applyEdits(text ?? '{}', edits);
  if (!next.endsWith('\n')) next += '\n';
  write(file, next);
}

/** Splits TOML into lines, noting the [table] each line belongs to (quotes around keys dropped). */
function tomlLines(text) {
  let table = '';
  return text.split('\n').map((line) => {
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/.exec(line)?.[1];
    if (header) table = header.split('.').map((part) => part.trim().replace(/^["']|["']$/g, '')).join('.');
    return { line, table, header: Boolean(header) };
  });
}

const inTable = (table, name) => table === name || table.startsWith(`${name}.`);

/** The key = value lines of a TOML table, as raw strings by key, or undefined if it's absent. */
export function readTomlTable(file, name) {
  const text = read(file);
  if (text === null) return undefined;
  const lines = tomlLines(text).filter(({ table, header }) => table === name && !header);
  if (!tomlLines(text).some(({ table, header }) => header && table === name)) return undefined;
  return Object.fromEntries(
    lines
      .map(({ line }) => /^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/.exec(line))
      .filter(Boolean)
      .map(([, key, value]) => [key, value]),
  );
}

export const tomlString = (value) => JSON.stringify(value);

/**
 * Replaces a TOML table (and its sub-tables) with the given key = value lines, or removes it when
 * lines is undefined. Everything else in the file stays as it was.
 */
export function writeTomlTable(file, name, lines) {
  const text = read(file);
  if (lines === undefined && text === null) return;
  backUp(file, text);
  const kept = tomlLines(text ?? '')
    .filter(({ table }) => !inTable(table, name))
    .map(({ line }) => line)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
  const table = lines ? `[${name}]\n${lines.join('\n')}\n` : '';
  write(file, [kept, table].filter(Boolean).join('\n\n') + (table ? '' : '\n'));
}
