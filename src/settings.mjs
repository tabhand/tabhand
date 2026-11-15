// Choices that apply to every agent on this computer, kept in ~/.tabhand/settings.json next to
// Tabhand's own copy. Today that's the cursor look `tabhand cursor` sets: a name, color and icon
// every agent's cursor and tab group show, like a team's name, brand color and logo.

import fs from 'node:fs';
import path from 'node:path';
import { parseGlyphSvg } from '../extension/glyph-svg.js';
import { ICONS, cleanLook } from '../extension/themes.js';
import { installDir } from './paths.mjs';

export const settingsPath = () => path.join(installDir(), 'settings.json');

export function readSettings() {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return settings && typeof settings === 'object' ? settings : {};
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  fs.mkdirSync(installDir(), { recursive: true });
  fs.writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`);
}

/** The cursor look set on this computer, cleaned up, or null. */
export const cursorLook = () => cleanLook(readSettings().cursor);

/** An SVG file on this computer as the icon data settings.json holds. */
export function iconShapeFromFile(file) {
  let markup;
  try {
    markup = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`Couldn't read ${file}: ${error.code === 'ENOENT' ? 'no such file' : error.message}`);
  }
  return parseGlyphSvg(markup);
}

/**
 * Sets the cursor look, or clears it with `reset`. Takes a color with or without its #, an icon
 * from ICONS, or an uploaded one as `iconShape` (see iconShapeFromFile) with `iconColors` 'one'
 * (the default) or 'own'. Choosing an ICONS icon puts an uploaded drawing away.
 * @returns {{ name?: string, color?: string, icon?: string, iconShape?: Array, iconColors?: string } | null} what's set now
 */
export function setCursorLook({ name, color, icon, iconShape, iconColors, reset = false }) {
  const settings = readSettings();
  if (reset) {
    delete settings.cursor;
  } else {
    const wanted = typeof color === 'string' && color ? (color.startsWith('#') ? color : `#${color}`) : undefined;
    if (wanted !== undefined && !/^#[0-9a-f]{6}$/i.test(wanted)) {
      throw new Error(`"${color}" isn't a color Tabhand can use. Give one like #FF5A1F.`);
    }
    if (icon !== undefined && icon !== 'custom' && !ICONS.includes(icon)) throw new Error(`"${icon}" isn't an icon Tabhand has. Choose one of: ${ICONS.join(', ')}.`);
    if (icon === 'custom' && !iconShape) throw new Error('A custom icon needs its drawing. Pass --icon-file logo.svg.');
    const merged = {
      ...settings.cursor,
      ...(name !== undefined && { name }),
      ...(wanted && { color: wanted }),
      ...(icon !== undefined && { icon }),
      ...(iconShape && { icon: 'custom', iconShape, iconColors: iconColors === 'own' ? 'own' : 'one' }),
    };
    if (icon !== undefined && icon !== 'custom') {
      delete merged.iconShape;
      delete merged.iconColors;
    }
    const next = cleanLook(merged);
    if (name !== undefined && name.trim() && !next?.name) throw new Error(`"${name}" has no letters or numbers Tabhand can show.`);
    if (next) settings.cursor = next;
    else delete settings.cursor;
  }
  writeSettings(settings);
  return cleanLook(settings.cursor);
}
