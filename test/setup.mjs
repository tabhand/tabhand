// `tabhand setup`, `status` and `remove` in a throwaway home folder with existing agent configs
// (comments, other MCP servers, other settings): Tabhand gets added to each agent, everything else
// in their configs stays as it was, a second run changes nothing, the installed launcher serves the
// MCP server, and `remove` takes it all back out. Never touches your real home folder.
//
//   node test/setup.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parse } from 'jsonc-parser';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tabhand-setup-home-'));
const env = {
  ...process.env,
  HOME: home,
  TABHAND_NO_HARNESS_CLIS: '1',
  TABHAND_HOME: '',
  TABHAND_DATA_DIR: '',
  XDG_CONFIG_HOME: '',
  CODEX_HOME: '',
  GEMINI_CLI_HOME: '',
};
const at = (...parts) => path.join(home, ...parts);
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const tabhand = (...args) => execFileSync(process.execPath, [path.join(root, 'bin', 'tabhand.mjs'), ...args], { env, encoding: 'utf8' });
const json = (file) => parse(fs.readFileSync(file, 'utf8'), [], { allowTrailingComma: true });

// Agents already set up the way people have them.
const files = {
  claude: at('.claude.json'),
  codex: at('.codex', 'config.toml'),
  opencode: at('.config', 'opencode', 'opencode.jsonc'),
  cursor: at('.cursor', 'mcp.json'),
  gemini: at('.gemini', 'settings.json'),
  zed: at('.config', 'zed', 'settings.json'),
};
fs.mkdirSync(at('.claude'), { recursive: true });
write(files.claude, JSON.stringify({ numStartups: 7, mcpServers: { other: { command: 'other-server' } } }, null, 2));
write(files.codex, 'model = "gpt-6"\n\n[mcp_servers.other]\ncommand = "other-server"\n\n[profiles.fast]\nmodel = "gpt-6-mini"\n');
write(files.opencode, '{\n  // my theme\n  "theme": "tokyonight",\n  "mcp": {\n    "other": { "type": "local", "command": ["other-server"] },\n  },\n}\n');
write(files.cursor, JSON.stringify({ mcpServers: { other: { command: 'other-server' } } }, null, 2));
write(files.gemini, JSON.stringify({ theme: 'GitHub' }, null, 2));
write(files.zed, '// Zed settings\n{\n  "vim_mode": true,\n}\n');

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

try {
  tabhand('setup', '--yes', '--no-wait', '--harness', 'claude,codex,opencode,cursor,gemini,zed');
  const launcher = at('.tabhand', 'bin', 'tabhand');
  const args = (label, theme) => ['mcp', '--label', label, '--theme', theme];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  check('installs its own copy, with a launcher', fs.statSync(launcher).mode & 0o100 && fs.existsSync(at('.tabhand', 'extension', 'manifest.json')));
  const host = json(at('Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', 'dev.tabhand.bridge.json'));
  check('registers the bridge with Chrome', host.path === at('.tabhand', 'bin', 'tabhand-host'), host.path);

  const claude = json(files.claude);
  check(
    'Claude Code: added, the rest kept',
    same(claude.mcpServers.tabhand, { type: 'stdio', command: launcher, args: args('Claude', 'claude') }) && claude.numStartups === 7 && claude.mcpServers.other,
  );
  const codex = fs.readFileSync(files.codex, 'utf8');
  check(
    'Codex: added, the rest kept',
    codex.includes(`[mcp_servers.tabhand]\ncommand = ${JSON.stringify(launcher)}\nargs = ["mcp", "--label", "Codex", "--theme", "codex"]`) &&
      codex.startsWith('model = "gpt-6"\n\n[mcp_servers.other]\ncommand = "other-server"\n\n[profiles.fast]\nmodel = "gpt-6-mini"'),
  );
  const opencodeText = fs.readFileSync(files.opencode, 'utf8');
  check(
    'OpenCode: added, comments and the rest kept',
    same(json(files.opencode).mcp.tabhand, { type: 'local', command: [launcher, ...args('OpenCode', 'opencode')], enabled: true }) &&
      opencodeText.includes('// my theme') &&
      json(files.opencode).mcp.other,
  );
  check('Cursor: added, the rest kept', same(json(files.cursor).mcpServers.tabhand, { type: 'stdio', command: launcher, args: args('Cursor', 'cursor') }) && json(files.cursor).mcpServers.other);
  check('Gemini CLI: added, the rest kept', same(json(files.gemini).mcpServers.tabhand, { command: launcher, args: args('Gemini', 'gemini') }) && json(files.gemini).theme === 'GitHub');
  check(
    'Zed: added, comments and the rest kept',
    same(json(files.zed).context_servers.tabhand, { command: launcher, args: args('Zed', 'agent') }) && fs.readFileSync(files.zed, 'utf8').startsWith('// Zed settings') && json(files.zed).vim_mode,
  );
  check("agents that aren't installed are left alone", !fs.existsSync(at('.kiro')) && !fs.existsSync(at('.factory')));

  const status = tabhand('status');
  check('status shows each agent set up', ['Claude Code', 'Codex', 'OpenCode', 'Cursor', 'Gemini CLI', 'Zed'].every((name) => status.includes(`✓ ${name}`)), status.split('\n').filter((line) => line.includes('✓ ')).length + ' ✓');

  const before = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, fs.readFileSync(file, 'utf8')]));
  tabhand('setup', '--yes', '--no-wait', '--harness', 'claude,codex,opencode,cursor,gemini,zed');
  const changed = Object.keys(files).filter((key) => fs.readFileSync(files[key], 'utf8') !== before[key]);
  check('running setup again changes nothing', changed.length === 0, changed.join(', '));

  // The agents' view: start the server the way they do.
  const client = new Client({ name: 'setup-test', version: '0' });
  await client.connect(new StdioClientTransport({ command: launcher, args: args('Test', 'agent'), env: { ...env, PATH: '/usr/bin:/bin' } }));
  const { tools } = await client.listTools();
  const instructions = client.getInstructions() ?? '';
  await client.close();
  check(
    'the launcher serves the MCP server, with its instructions, even without node on PATH',
    tools.some((tool) => tool.name === 'browser_open_tab') && instructions.includes("user's own Chrome") && instructions.length < 2048,
    `${tools.length} tools, ${instructions.length} chars of instructions`,
  );

  tabhand('remove', '--yes');
  check(
    'remove takes Tabhand out of every agent and keeps the rest',
    !json(files.claude).mcpServers.tabhand &&
      json(files.claude).mcpServers.other &&
      !fs.readFileSync(files.codex, 'utf8').includes('tabhand') &&
      fs.readFileSync(files.codex, 'utf8').includes('[profiles.fast]') &&
      !json(files.opencode).mcp.tabhand &&
      fs.readFileSync(files.opencode, 'utf8').includes('// my theme') &&
      !json(files.cursor).mcpServers.tabhand &&
      !json(files.gemini).mcpServers?.tabhand &&
      !json(files.zed).context_servers?.tabhand,
  );
  check('remove deletes the install and the bridge registration', !fs.existsSync(at('.tabhand')) && !fs.existsSync(at('Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', 'dev.tabhand.bridge.json')));
} catch (error) {
  check('test run', false, error.stderr?.toString() || error.message);
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

// Agents with their own `mcp add` command get it called, with the documented arguments.
const cliHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tabhand-setup-home-'));
try {
  const bin = path.join(cliHome, 'fake-bin');
  const log = path.join(cliHome, 'calls.log');
  for (const name of ['claude', 'codex', 'gemini']) {
    write(path.join(bin, name), '#!/bin/sh\nprintf \'%s\\n\' "$(basename "$0") $*" >> "$CALLS"\n');
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  const cliEnv = { ...env, HOME: cliHome, PATH: `${bin}:/usr/bin:/bin`, CALLS: log, TABHAND_NO_HARNESS_CLIS: '' };
  const run = (...args) => execFileSync(process.execPath, [path.join(root, 'bin', 'tabhand.mjs'), ...args], { env: cliEnv, encoding: 'utf8' });
  run('setup', '--yes', '--no-wait', '--harness', 'claude,codex,gemini');
  run('remove', '--yes');
  const launcher = path.join(cliHome, '.tabhand', 'bin', 'tabhand');
  const expected = [
    `claude mcp add --scope user --transport stdio tabhand -- ${launcher} mcp --label Claude --theme claude`,
    `codex mcp add tabhand -- ${launcher} mcp --label Codex --theme codex`,
    `gemini mcp add -s user tabhand -- ${launcher} mcp --label Gemini --theme gemini`,
    'claude mcp remove tabhand --scope user',
    'codex mcp remove tabhand',
    'gemini mcp remove -s user tabhand',
  ];
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
  const missing = expected.filter((call) => !calls.includes(call));
  check("uses each agent's own CLI where it has one", missing.length === 0, missing.join(' | ') || `${calls.length} calls`);
} catch (error) {
  check('CLI test run', false, error.stderr?.toString() || error.message);
} finally {
  fs.rmSync(cliHome, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} check(s) failed` : 'All checks passed');
process.exit(failed ? 1 : 0);
