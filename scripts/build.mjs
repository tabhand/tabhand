// Bundles Tabhand's CLI, MCP server and bridge into one file with nothing to install,
// dist/tabhand.mjs. The npm package runs it, and `tabhand setup` copies it.
//
//   node scripts/build.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { VERSION } from '../src/version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

export async function buildBundle() {
  const versions = { 'src/version.mjs': VERSION, 'package.json': readJson('package.json').version, 'extension/manifest.json': readJson('extension/manifest.json').version };
  if (new Set(Object.values(versions)).size > 1) throw new Error(`Versions disagree: ${JSON.stringify(versions)}`);

  const outfile = path.join(root, 'dist', 'tabhand.mjs');
  const { metafile } = await build({
    absWorkingDir: root,
    entryPoints: ['bin/tabhand.mjs'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    // Prefer packages' ES module builds: some (jsonc-parser) ship UMD as "main", whose require()
    // calls can't be bundled.
    mainFields: ['module', 'main'],
    define: { 'process.env.TABHAND_BUNDLED': '"1"' },
    // Bundled CommonJS dependencies call require(), which ES modules don't have.
    banner: { js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
    legalComments: 'none',
    metafile: true,
    logLevel: 'warning',
  });
  fs.chmodSync(outfile, 0o755);
  writeNotices(metafile, path.join(root, 'dist', 'THIRD_PARTY_NOTICES.txt'));
  return outfile;
}

/** Collects the licenses of the bundled dependencies, which their terms ask copies to carry. */
function writeNotices(metafile, file) {
  const packages = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const dir = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input)?.[1];
    if (dir) packages.set(dir, true);
  }
  const notices = [...packages.keys()].sort().map((dir) => {
    const { name, version, license } = JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8'));
    const licenseFile = fs.readdirSync(path.join(root, dir)).find((entry) => /^licen[cs]e/i.test(entry));
    const text = licenseFile ? fs.readFileSync(path.join(root, dir, licenseFile), 'utf8').trim() : `License: ${license}`;
    return `${name}@${version}\n\n${text}\n`;
  });
  fs.writeFileSync(file, `Tabhand bundles the following packages.\n\n${notices.join(`\n${'-'.repeat(72)}\n\n`)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`Built ${path.relative(root, await buildBundle())}`);
}
