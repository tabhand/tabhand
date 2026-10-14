// Packs the extension for the Chrome Web Store: tabhand-extension-<version>.zip, next to package.json
// (outside dist, which goes into the npm package).
// The store gives its copy an id of its own and rejects the manifest's "key", which only pins the
// id of the copy loaded by hand, so the zip leaves it out.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'tabhand-store-'));
fs.cpSync(path.join(root, 'extension'), staging, { recursive: true });
const manifestPath = path.join(staging, 'manifest.json');
const { key, ...manifest } = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

const zip = path.join(root, `tabhand-extension-${manifest.version}.zip`);
fs.rmSync(zip, { force: true });
execFileSync('zip', ['-r', '-X', '-q', zip, '.', '-x', '*.DS_Store'], { cwd: staging });
fs.rmSync(staging, { recursive: true, force: true });
console.log(`Packed ${path.relative(root, zip)}`);
