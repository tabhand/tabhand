// The agent harnesses Tabhand can add itself to, globally (every project, every session). Each
// entry knows how to tell the harness is installed, where it keeps its MCP servers, and its own
// CLI for adding one where it has one. Formats come from each harness's docs or source (2026-10).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, readTomlTable, tomlString, writeJson, writeTomlTable } from './config-files.mjs';

export const SERVER_NAME = 'tabhand';

const home = (...parts) => path.join(os.homedir(), ...parts);
const appSupport = (...parts) => home('Library', 'Application Support', ...parts);
const exists = (file) => fs.existsSync(file);
const hasApp = (name) => exists(`/Applications/${name}.app`) || exists(home('Applications', `${name}.app`));

function onPath(command) {
  if (process.env.TABHAND_NO_HARNESS_CLIS) return false;
  try {
    execFileSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A server entry in the common { mcpServers: { name: { command, args } } } shape. */
function mcpServersFile(file, { key = 'mcpServers', extra = {} } = {}) {
  return {
    file,
    read: () => {
      const entry = readJson(file(), [key, SERVER_NAME]);
      return entry && { command: entry.command, args: entry.args ?? [] };
    },
    write: (server) => writeJson(file(), [key, SERVER_NAME], server && { ...extra, command: server.command, args: server.args }),
  };
}

const codexHome = () => process.env.CODEX_HOME || home('.codex');
const codexConfig = () => path.join(codexHome(), 'config.toml');
const opencodeConfig = () => {
  const dir = path.join(process.env.XDG_CONFIG_HOME || home('.config'), 'opencode');
  return ['opencode.jsonc', 'opencode.json'].map((name) => path.join(dir, name)).find(exists) ?? path.join(dir, 'opencode.json');
};
const vscodeUser = (...parts) =>
  process.platform === 'darwin' ? appSupport('Code', 'User', ...parts) : home('.config', 'Code', 'User', ...parts);
const zedSettings = () => path.join(process.env.XDG_CONFIG_HOME || home('.config'), 'zed', 'settings.json');

export const HARNESSES = [
  {
    key: 'claude',
    name: 'Claude Code',
    label: 'Claude',
    theme: 'claude',
    installed: () => onPath('claude') || exists(home('.claude')),
    // Claude Code rewrites ~/.claude.json while it runs, so prefer its own CLI for changes.
    cli: {
      command: 'claude',
      add: (server) => ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', SERVER_NAME, '--', server.command, ...server.args],
      remove: ['mcp', 'remove', SERVER_NAME, '--scope', 'user'],
    },
    ...mcpServersFile(() => home('.claude.json'), { extra: { type: 'stdio' } }),
  },
  {
    key: 'codex',
    name: 'Codex',
    label: 'Codex',
    theme: 'codex',
    // The CLI, IDE extension and desktop app share ~/.codex/config.toml.
    installed: () => onPath('codex') || exists(codexHome()),
    cli: {
      command: 'codex',
      add: (server) => ['mcp', 'add', SERVER_NAME, '--', server.command, ...server.args],
      remove: ['mcp', 'remove', SERVER_NAME],
    },
    file: codexConfig,
    read: () => {
      const table = readTomlTable(codexConfig(), `mcp_servers.${SERVER_NAME}`);
      if (!table) return undefined;
      try {
        return { command: JSON.parse(table.command), args: JSON.parse(table.args ?? '[]') };
      } catch {
        return { command: null, args: [] };
      }
    },
    write: (server) =>
      writeTomlTable(
        codexConfig(),
        `mcp_servers.${SERVER_NAME}`,
        server && [`command = ${tomlString(server.command)}`, `args = [${server.args.map(tomlString).join(', ')}]`],
      ),
  },
  {
    key: 'opencode',
    name: 'OpenCode',
    label: 'OpenCode',
    theme: 'opencode',
    installed: () => onPath('opencode') || exists(path.dirname(opencodeConfig())),
    file: opencodeConfig,
    read: () => {
      const entry = readJson(opencodeConfig(), ['mcp', SERVER_NAME]);
      return entry && { command: entry.command?.[0], args: entry.command?.slice(1) ?? [] };
    },
    write: (server) =>
      writeJson(opencodeConfig(), ['mcp', SERVER_NAME], server && { type: 'local', command: [server.command, ...server.args], enabled: true }),
  },
  {
    key: 'cursor',
    name: 'Cursor',
    label: 'Cursor',
    theme: 'cursor',
    installed: () => hasApp('Cursor') || exists(home('.cursor')),
    ...mcpServersFile(() => home('.cursor', 'mcp.json'), { extra: { type: 'stdio' } }),
  },
  {
    key: 'gemini',
    name: 'Gemini CLI',
    label: 'Gemini',
    theme: 'gemini',
    // Not ~/.gemini alone: Antigravity keeps its settings in there too.
    installed: () => onPath('gemini') || exists(home('.gemini', 'oauth_creds.json')),
    cli: {
      command: 'gemini',
      add: (server) => ['mcp', 'add', '-s', 'user', SERVER_NAME, '--', server.command, ...server.args],
      remove: ['mcp', 'remove', '-s', 'user', SERVER_NAME],
    },
    ...mcpServersFile(() => path.join(process.env.GEMINI_CLI_HOME || os.homedir(), '.gemini', 'settings.json')),
  },
  {
    key: 'qwen',
    name: 'Qwen Code',
    label: 'Qwen',
    theme: 'agent',
    installed: () => onPath('qwen') || exists(home('.qwen')),
    cli: {
      command: 'qwen',
      add: (server) => ['mcp', 'add', '-s', 'user', SERVER_NAME, '--', server.command, ...server.args],
      remove: ['mcp', 'remove', '-s', 'user', SERVER_NAME],
    },
    ...mcpServersFile(() => path.join(process.env.QWEN_HOME || home('.qwen'), 'settings.json')),
  },
  {
    key: 'vscode',
    name: 'VS Code (Copilot)',
    label: 'Copilot',
    theme: 'copilot',
    installed: () => hasApp('Visual Studio Code') || exists(vscodeUser()),
    ...mcpServersFile(() => vscodeUser('mcp.json'), { key: 'servers', extra: { type: 'stdio' } }),
  },
  {
    key: 'copilot',
    name: 'Copilot CLI',
    label: 'Copilot',
    theme: 'copilot',
    installed: () => onPath('copilot') || exists(home('.copilot')),
    cli: {
      command: 'copilot',
      add: (server) => ['mcp', 'add', SERVER_NAME, '--', server.command, ...server.args],
      remove: ['mcp', 'remove', SERVER_NAME],
    },
    ...mcpServersFile(() => path.join(process.env.COPILOT_HOME || home('.copilot'), 'mcp-config.json'), {
      extra: { type: 'local', tools: ['*'] },
    }),
  },
  {
    key: 'kiro',
    name: 'Kiro',
    label: 'Kiro',
    theme: 'agent',
    installed: () => onPath('kiro-cli') || hasApp('Kiro') || exists(home('.kiro')),
    ...mcpServersFile(() => home('.kiro', 'settings', 'mcp.json')),
  },
  {
    key: 'amp',
    name: 'Amp',
    label: 'Amp',
    theme: 'agent',
    installed: () => onPath('amp') || exists(home('.config', 'amp')),
    ...mcpServersFile(
      () => ['settings.jsonc', 'settings.json'].map((name) => home('.config', 'amp', name)).find(exists) ?? home('.config', 'amp', 'settings.json'),
      { key: 'amp.mcpServers' },
    ),
  },
  {
    key: 'droid',
    name: 'Factory Droid',
    label: 'Droid',
    theme: 'agent',
    installed: () => onPath('droid') || exists(home('.factory')),
    ...mcpServersFile(() => home('.factory', 'mcp.json'), { extra: { type: 'stdio' } }),
  },
  {
    key: 'warp',
    name: 'Warp',
    label: 'Warp',
    theme: 'agent',
    installed: () => hasApp('Warp') || exists(home('.warp')),
    ...mcpServersFile(() => home('.warp', '.mcp.json')),
  },
  {
    key: 'junie',
    name: 'Junie',
    label: 'Junie',
    theme: 'agent',
    installed: () => onPath('junie') || exists(home('.junie')),
    ...mcpServersFile(() => home('.junie', 'mcp', 'mcp.json')),
  },
  {
    key: 'antigravity',
    name: 'Antigravity',
    label: 'Antigravity',
    theme: 'gemini',
    installed: () => hasApp('Antigravity') || exists(home('.gemini', 'config')),
    ...mcpServersFile(() => home('.gemini', 'config', 'mcp_config.json')),
  },
  {
    // Windsurf became Devin Desktop in June 2026, which reads this file and the old one below.
    key: 'devin',
    name: 'Devin Desktop',
    label: 'Devin',
    theme: 'agent',
    installed: () => hasApp('Devin') || exists(path.join(process.env.XDG_CONFIG_HOME || home('.config'), 'devin')),
    ...mcpServersFile(() => path.join(process.env.XDG_CONFIG_HOME || home('.config'), 'devin', 'mcp_config.json')),
  },
  {
    key: 'windsurf',
    name: 'Windsurf',
    label: 'Windsurf',
    theme: 'agent',
    installed: () => hasApp('Windsurf') || exists(home('.codeium', 'windsurf')),
    ...mcpServersFile(() => home('.codeium', 'windsurf', 'mcp_config.json')),
  },
  {
    key: 'claude-desktop',
    name: 'Claude Desktop',
    label: 'Claude',
    theme: 'claude',
    installed: () => hasApp('Claude') || exists(appSupport('Claude')),
    ...mcpServersFile(() => appSupport('Claude', 'claude_desktop_config.json')),
  },
  {
    // Cline 4 and its CLI share ~/.cline; older versions of the VS Code extension keep their own.
    key: 'cline',
    name: 'Cline',
    label: 'Cline',
    theme: 'agent',
    installed: () => exists(home('.cline')) || exists(vscodeUser('globalStorage', 'saoudrizwan.claude-dev')),
    ...mcpServersFile(() =>
      exists(home('.cline'))
        ? home('.cline', 'data', 'settings', 'cline_mcp_settings.json')
        : vscodeUser('globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
    ),
  },
  {
    key: 'zed',
    name: 'Zed',
    label: 'Zed',
    theme: 'agent',
    installed: () => hasApp('Zed') || exists(path.dirname(zedSettings())),
    ...mcpServersFile(zedSettings, { key: 'context_servers' }),
  },
];

/** What each harness runs: the launcher, with flags naming the harness for its cursor colors. */
export const serverFor = (harness, launcher) => ({
  command: launcher,
  args: ['mcp', '--label', harness.label, '--theme', harness.theme],
});

const sameServer = (a, b) => a?.command === b.command && JSON.stringify(a?.args ?? []) === JSON.stringify(b.args);

/** 'set up', 'outdated' (points somewhere else) or 'missing'. */
export function harnessStatus(harness, launcher) {
  let current;
  try {
    current = harness.read();
  } catch {
    return 'unreadable';
  }
  if (!current) return 'missing';
  return sameServer(current, serverFor(harness, launcher)) ? 'set up' : 'outdated';
}

function runCli(harness, args) {
  execFileSync(harness.cli.command, args, { stdio: 'pipe', timeout: 60_000 });
}

/** Adds (or updates) Tabhand in a harness. Returns how: 'cli' or 'file'. */
export function addTo(harness, launcher) {
  const server = serverFor(harness, launcher);
  if (harness.cli && onPath(harness.cli.command)) {
    try {
      if (harness.read()) runCli(harness, harness.cli.remove);
      runCli(harness, harness.cli.add(server));
      if (sameServer(harness.read(), server)) return 'cli';
    } catch {}
  }
  harness.write(server);
  return 'file';
}

/** Takes Tabhand out of a harness, if it's there. */
export function removeFrom(harness) {
  if (!harness.read()) return false;
  if (harness.cli && onPath(harness.cli.command)) {
    try {
      runCli(harness, harness.cli.remove);
      if (!harness.read()) return true;
    } catch {}
  }
  harness.write(undefined);
  return true;
}
