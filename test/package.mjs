// The npm package as users get it: packs it, installs the tarball into a throwaway prefix, runs
// `tabhand setup` from there in a throwaway home folder, and talks to the MCP server through the
// launcher setup installed. Never touches your real home folder.
//
//   node test/package.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parse } from 'jsonc-parser';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tabhand-package-'));
const home = path.join(work, 'home');
const prefix = path.join(work, 'prefix');
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
const env = { ...process.env, HOME: home, TABHAND_NO_HARNESS_CLIS: '1', TABHAND_HOME: '', TABHAND_DATA_DIR: '', XDG_CONFIG_HOME: '' };
const npm = (...args) => execFileSync('npm', args, { cwd: root, env: { ...process.env, npm_config_loglevel: 'error' }, encoding: 'utf8' });

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

try {
  const tarball = path.join(work, npm('pack', '--pack-destination', work).trim().split('\n').pop());
  const files = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n');
  check(
    'the package holds the bundle, the extension and nothing else',
    files.includes('package/dist/tabhand.mjs') && files.includes('package/extension/manifest.json') && !files.some((file) => /\/(src|test|node_modules)\//.test(file)),
    `${files.length} files`,
  );

  npm('install', '--global', '--prefix', prefix, tarball);
  const bin = path.join(prefix, 'bin', 'tabhand');
  const output = execFileSync(bin, ['setup', '--yes', '--no-wait'], { env, encoding: 'utf8' });
  const launcher = path.join(home, '.tabhand', 'bin', 'tabhand');
  const installed = fs.readFileSync(path.join(home, '.tabhand', 'app', 'tabhand.mjs'));
  const packaged = fs.readFileSync(path.join(prefix, 'lib', 'node_modules', 'tabhand', 'dist', 'tabhand.mjs'));
  check('setup installs the packaged bundle as its own copy', installed.equals(packaged));
  const claude = parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  const opencode = parse(fs.readFileSync(path.join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
  check(
    'setup adds Tabhand to the agents it finds',
    claude.mcpServers?.tabhand?.command === launcher && opencode.mcp?.tabhand?.command?.[0] === launcher,
    output.split('\n').filter((line) => line.startsWith('✓')).join(' / '),
  );

  // Uninstall the package: agents run the installed copy, so they keep working.
  npm('uninstall', '--global', '--prefix', prefix, 'tabhand');
  const client = new Client({ name: 'package-test', version: '0' });
  await client.connect(new StdioClientTransport({ command: launcher, args: claude.mcpServers.tabhand.args, env: { ...env, PATH: '/usr/bin:/bin' } }));
  const { tools } = await client.listTools();
  const server = client.getServerVersion();
  const instructions = client.getInstructions() ?? '';
  await client.close();
  check(
    'agents reach the MCP server through the launcher, even with the package gone',
    tools.length === 10 && server.version === JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version && instructions.length > 0,
    `${server.name} ${server.version}, ${tools.length} tools`,
  );
} catch (error) {
  check('test run', false, error.stderr?.toString() || error.message);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} check(s) failed` : 'All checks passed');
process.exit(failed ? 1 : 0);
