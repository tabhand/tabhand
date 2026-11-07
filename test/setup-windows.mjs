// `tabhand setup`, `status` and `remove` on Windows, in a throwaway user folder with existing agent
// configs: the bridge gets registered in the registry for each browser here, agents get Tabhand
// with the rest of their configs kept, a second run changes nothing, the command agents run serves
// the MCP server, and `remove` takes it all back out. Registrations go under a registry key of the
// test's own, so a real install is never touched.
//
//   node test/setup-windows.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parse } from 'jsonc-parser';

if (process.platform !== 'win32') {
  console.log('SKIP  Windows only');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const json = (file) => parse(fs.readFileSync(file, 'utf8'), [], { allowTrailingComma: true });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const testRoot = `HKCU\\Software\\TabhandTest\\${process.pid}`;
const regValue = (key) => {
  try {
    return /REG_SZ\s+(.+)$/m.exec(execFileSync('reg.exe', ['query', key, '/ve'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
};

/** A throwaway user: its own profile and AppData folders. */
function makeUser() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tabhand-setup-win-'));
  const at = (...parts) => path.join(home, ...parts);
  const env = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    APPDATA: at('AppData', 'Roaming'),
    LOCALAPPDATA: at('AppData', 'Local'),
    // Windows hands every program the real ProgramFiles whatever its parent says, so only these two
    // folders are the test's own: Chrome, if it's installed, gets found where it really is.
    'ProgramFiles(x86)': at('Program Files (x86)'),
    TABHAND_REGISTRY_ROOT: testRoot,
    TABHAND_NO_OPEN: '1',
    TABHAND_NO_HARNESS_CLIS: '1',
    TABHAND_HOME: '',
    TABHAND_DATA_DIR: '',
    XDG_CONFIG_HOME: '',
    CODEX_HOME: '',
    GEMINI_CLI_HOME: '',
  };
  return { home, at, env };
}

const user = makeUser();
const { at, env } = user;
const tabhand = (...args) => execFileSync(process.execPath, [path.join(root, 'bin', 'tabhand.mjs'), ...args], { env, encoding: 'utf8' });

const files = {
  claude: at('.claude.json'),
  codex: at('.codex', 'config.toml'),
  cursor: at('.cursor', 'mcp.json'),
  gemini: at('.gemini', 'settings.json'),
  vscode: at('AppData', 'Roaming', 'Code', 'User', 'mcp.json'),
};
fs.mkdirSync(at('.claude'), { recursive: true });
write(files.claude, JSON.stringify({ numStartups: 7, mcpServers: { other: { command: 'other-server' } } }, null, 2));
write(files.codex, 'model = "gpt-6"\n\n[mcp_servers.other]\ncommand = "other-server"\n\n[profiles.fast]\nmodel = "gpt-6-mini"\n');
write(files.cursor, JSON.stringify({ mcpServers: { other: { command: 'other-server' } } }, null, 2));
write(files.gemini, JSON.stringify({ theme: 'GitHub' }, null, 2));
write(files.vscode, '{\n  // mine\n  "servers": {}\n}\n');
// Edge comes with Windows; Brave isn't installed yet.
write(at('Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'), '');

try {
  const said = tabhand('setup', '--yes', '--no-wait', '--harness', 'claude,codex,cursor,gemini,vscode');
  const tabhandHome = at('.tabhand');
  const app = path.join(tabhandHome, 'app', 'tabhand.mjs');
  const node = process.execPath;
  const args = (label, theme) => [app, 'mcp', '--label', label, '--theme', theme];

  check(
    'installs its own copy, with .cmd launchers that pin this Node.js',
    fs.existsSync(app) &&
      fs.existsSync(path.join(tabhandHome, 'extension', 'manifest.json')) &&
      fs.readFileSync(path.join(tabhandHome, 'bin', 'tabhand.cmd'), 'utf8').includes(`set "TABHAND_NODE=${node}"`) &&
      fs.readFileSync(path.join(tabhandHome, 'bin', 'node-path'), 'utf8').trim() === node,
  );
  const manifestFile = path.join(tabhandHome, 'native', 'dev.tabhand.bridge.json');
  const manifest = json(manifestFile);
  check(
    'writes the bridge manifest, for the unpacked and the Chrome Web Store extension',
    manifest.path === path.join(tabhandHome, 'bin', 'tabhand-host.cmd') && manifest.allowed_origins.length === 2,
    manifest.allowed_origins.join(' '),
  );
  const key = (browser) => `${testRoot}\\${browser}\\NativeMessagingHosts\\dev.tabhand.bridge`;
  check('registers it with Chrome in the registry', regValue(key('Google\\Chrome')) === manifestFile, regValue(key('Google\\Chrome')) ?? 'no value');
  const registeredLine = said.split('\n').find((line) => line.includes('registered with')) ?? '';
  check(
    "and with Edge, and with Brave though it isn't installed, so adding the extension to it later just works",
    regValue(key('Microsoft\\Edge')) === manifestFile && regValue(key('BraveSoftware\\Brave-Browser')) === manifestFile && /registered with Chrome, Brave and Edge/.test(registeredLine),
    registeredLine.trim(),
  );
  check('not with Chromium, which is not installed', regValue(key('Chromium')) === null);
  check('status lists them', /Bridge registered with Chrome, Brave and Edge/.test(tabhand('status')));

  const host = fs.readFileSync(path.join(tabhandHome, 'bin', 'tabhand-host.cmd'), 'utf8');
  check(
    "the browser's launcher runs the bridge, logging to AppData through %LOCALAPPDATA% and printing nothing",
    host.startsWith('@echo off\r\n') &&
      host.includes('"%USERPROFILE%\\.tabhand\\app\\tabhand.mjs" host %* 2>nul') &&
      // A file it sent stderr to would stay locked, and a second browser's bridge couldn't start.
      !host.includes('2>>') &&
      host.includes('>>"%LOCALAPPDATA%\\tabhand\\host.log" echo ') &&
      !/^echo /m.test(host),
  );

  const claude = json(files.claude);
  check('Claude Code: added with Node.js and the code, the rest kept', same(claude.mcpServers.tabhand, { type: 'stdio', command: node, args: args('Claude', 'claude') }) && claude.numStartups === 7 && claude.mcpServers.other);
  const codex = fs.readFileSync(files.codex, 'utf8');
  check(
    'Codex: added, the rest kept',
    codex.includes(`[mcp_servers.tabhand]\ncommand = ${JSON.stringify(node)}\nargs = [${args('Codex', 'codex').map((arg) => JSON.stringify(arg)).join(', ')}]`) &&
      codex.startsWith('model = "gpt-6"\n\n[mcp_servers.other]\ncommand = "other-server"\n\n[profiles.fast]\nmodel = "gpt-6-mini"'),
    codex.split('\n').filter((line) => line.startsWith('command') || line.startsWith('args')).join(' | '),
  );
  check('Cursor: added, the rest kept', same(json(files.cursor).mcpServers.tabhand, { type: 'stdio', command: node, args: args('Cursor', 'cursor') }) && json(files.cursor).mcpServers.other);
  check('Gemini CLI: added, the rest kept', same(json(files.gemini).mcpServers.tabhand, { command: node, args: args('Gemini', 'gemini') }) && json(files.gemini).theme === 'GitHub');
  check(
    'VS Code: added in Roaming AppData, comments kept',
    same(json(files.vscode).servers.tabhand, { type: 'stdio', command: node, args: args('Copilot', 'copilot') }) && fs.readFileSync(files.vscode, 'utf8').includes('// mine'),
  );
  check(
    'backs up the configs it changed, under flat names',
    fs.existsSync(path.join(tabhandHome, 'backups')) && fs.readdirSync(path.join(tabhandHome, 'backups')).some((name) => name.endsWith('__.claude.json') && !name.includes(':')),
    fs.existsSync(path.join(tabhandHome, 'backups')) ? fs.readdirSync(path.join(tabhandHome, 'backups')).join(', ') : 'none',
  );

  const status = tabhand('status');
  check('status shows each agent set up', ['Claude Code', 'Codex', 'Cursor', 'Gemini CLI', 'VS Code'].every((name) => status.includes(`✓ ${name}`)), status.split('\n').filter((line) => line.includes('✓ ')).length + ' ✓');

  const before = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, fs.readFileSync(file, 'utf8')]));
  tabhand('setup', '--yes', '--no-wait', '--harness', 'claude,codex,cursor,gemini,vscode');
  const changed = Object.keys(files).filter((name) => fs.readFileSync(files[name], 'utf8') !== before[name]);
  check('running setup again changes nothing', changed.length === 0, changed.join(', '));

  // The agents' view: start the server exactly as their config says, with a bare PATH.
  const entry = json(files.claude).mcpServers.tabhand;
  const client = new Client({ name: 'setup-test', version: '0' });
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: { ...env, PATH: system32 } }));
  const { tools } = await client.listTools();
  const instructions = client.getInstructions() ?? '';
  await client.close();
  check(
    "the command agents run serves the MCP server, even without node on PATH",
    tools.some((tool) => tool.name === 'browser_open_tab') && instructions.includes("user's own Chrome"),
    `${tools.length} tools, ${instructions.length} chars of instructions`,
  );

  // You can run tabhand.cmd yourself.
  const version = execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', path.join(tabhandHome, 'bin', 'tabhand.cmd'), 'version'], { env: { ...env, PATH: system32 }, encoding: 'utf8' }).trim();
  check('tabhand.cmd runs Tabhand', /^\d+\.\d+\.\d+$/.test(version), version);

  tabhand('remove', '--yes');
  check(
    'remove takes Tabhand out of every agent and keeps the rest',
    !json(files.claude).mcpServers.tabhand &&
      json(files.claude).mcpServers.other &&
      !fs.readFileSync(files.codex, 'utf8').includes('tabhand') &&
      fs.readFileSync(files.codex, 'utf8').includes('[profiles.fast]') &&
      !json(files.cursor).mcpServers.tabhand &&
      !json(files.gemini).mcpServers?.tabhand &&
      !json(files.vscode).servers?.tabhand,
  );
  check(
    'remove deletes the install and the registry entries',
    !fs.existsSync(tabhandHome) && regValue(key('Google\\Chrome')) === null && regValue(key('Microsoft\\Edge')) === null && regValue(key('BraveSoftware\\Brave-Browser')) === null,
  );
} catch (error) {
  check('test run', false, error.stderr?.toString() || error.stack || error.message);
} finally {
  // Windows can hold a file a moment longer (a process just ending, a virus scan): try again.
  fs.rmSync(user.home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

// Agents with their own `mcp add` command get it called, with the documented arguments. On Windows
// npm installs those CLIs as .cmd files, which need cmd.exe; the paths in them have spaces.
const cliUser = makeUser();
try {
  const bin = path.join(cliUser.home, 'fake bin');
  const log = path.join(cliUser.home, 'calls.log');
  for (const name of ['claude', 'codex', 'gemini']) write(path.join(bin, `${name}.cmd`), '@echo off\r\n>>"%CALLS%" echo %~n0 %*\r\n');
  const cliEnv = { ...cliUser.env, PATH: `${bin};${system32}`, CALLS: log, TABHAND_NO_HARNESS_CLIS: '' };
  const run = (...args) => execFileSync(process.execPath, [path.join(root, 'bin', 'tabhand.mjs'), ...args], { env: cliEnv, encoding: 'utf8' });
  run('setup', '--yes', '--no-wait', '--harness', 'claude,codex,gemini');
  run('remove', '--yes');
  const app = path.join(cliUser.home, '.tabhand', 'app', 'tabhand.mjs');
  const quoted = (arg) => (/\s/.test(arg) ? `"${arg}"` : arg);
  const command = `${quoted(process.execPath)} ${quoted(app)}`;
  const expected = [
    `claude mcp add --scope user --transport stdio tabhand -- ${command} mcp --label Claude --theme claude`,
    `codex mcp add tabhand -- ${command} mcp --label Codex --theme codex`,
    `gemini mcp add -s user tabhand -- ${command} mcp --label Gemini --theme gemini`,
    'claude mcp remove tabhand --scope user',
    'codex mcp remove tabhand',
    'gemini mcp remove -s user tabhand',
  ];
  const calls = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).map((line) => line.trim());
  const missing = expected.filter((call) => !calls.includes(call));
  check("uses each agent's own CLI where it has one, through cmd.exe", missing.length === 0, missing.join(' | ') || `${calls.length} calls`);
  if (missing.length) console.log(calls.join('\n'));
} catch (error) {
  check('CLI test run', false, error.stderr?.toString() || error.message);
} finally {
  fs.rmSync(cliUser.home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  try {
    execFileSync('reg.exe', ['delete', testRoot, '/f'], { stdio: 'ignore' });
  } catch {}
}

const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} check(s) failed` : 'All checks passed');
process.exit(failed ? 1 : 0);
