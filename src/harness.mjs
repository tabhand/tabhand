// Works out which agent harness launched this MCP server, so its cursor and tab group can wear
// that harness's colors. Checks, in order: an explicit choice, the MCP client's name, then the
// programs that launched us (OpenCode, for one, reports itself only as "cli").

import { execFileSync } from 'node:child_process';
import path from 'node:path';

const HARNESSES = [
  { theme: 'claude', name: 'Claude', pattern: /claude/i },
  { theme: 'codex', name: 'Codex', pattern: /codex/i },
  { theme: 'opencode', name: 'OpenCode', pattern: /opencode/i },
  { theme: 'cursor', name: 'Cursor', pattern: /cursor/i },
  { theme: 'gemini', name: 'Gemini', pattern: /gemini/i },
  { theme: 'copilot', name: 'Copilot', pattern: /copilot|visual studio code|vscode/i },
  { theme: 'gemini', name: 'Antigravity', pattern: /antigravity/i },
  { theme: 'agent', name: 'Qwen', pattern: /qwen/i },
  { theme: 'agent', name: 'Devin', pattern: /devin/i },
  { theme: 'agent', name: 'Windsurf', pattern: /windsurf|codeium/i },
  { theme: 'agent', name: 'Goose', pattern: /goose/i },
  { theme: 'agent', name: 'Kiro', pattern: /kiro/i },
  { theme: 'agent', name: 'Droid', pattern: /droid|factory/i },
  { theme: 'agent', name: 'Junie', pattern: /junie/i },
  { theme: 'agent', name: 'Roo', pattern: /^roo/i },
  { theme: 'agent', name: 'Continue', pattern: /^continue/i },
  { theme: 'agent', name: 'Amp', pattern: /^amp\b/i },
  { theme: 'agent', name: 'Warp', pattern: /^warp\b/i },
  { theme: 'agent', name: 'Cline', pattern: /^cline$/i },
  { theme: 'agent', name: 'Zed', pattern: /^zed$/i },
];
const GENERIC_NAMES = /^(cli|client|mcp|mcp-client|app|agent|unknown)$/i;
const INTERPRETERS = /^(node|bun|deno|python3?)$/;

const match = (text) => (text ? HARNESSES.find((harness) => harness.pattern.test(text)) : undefined);

/** Executable names of our nearest parent processes. Empty where `ps` isn't available. */
function launcherNames(depth = 2) {
  const names = [];
  let pid = process.ppid;
  for (let level = 0; level < depth && pid > 1; level++) {
    try {
      const [first, second] = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/);
      const program = path.basename(first);
      names.push(program);
      // `node /path/to/some-agent/cli.js`: the script's folder names the agent.
      if (second && INTERPRETERS.test(program)) names.push(path.basename(second), path.basename(path.dirname(second)));
      pid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
    } catch {
      break;
    }
  }
  return names;
}

/**
 * @param {{ clientInfo?: { name?: string, title?: string }, label?: string, theme?: string }} options
 * @returns {{ theme: string, label: string }}
 */
export function detectHarness({ clientInfo = {}, label, theme } = {}) {
  // Only fall back to the launcher when the client didn't give a usable name of its own.
  const anonymous = !clientInfo.title && (!clientInfo.name || GENERIC_NAMES.test(clientInfo.name));
  const found =
    match(label) ??
    match(clientInfo.title) ??
    match(clientInfo.name) ??
    (anonymous ? launcherNames().map(match).find(Boolean) : undefined);
  const fallbackName =
    clientInfo.title || (clientInfo.name && !GENERIC_NAMES.test(clientInfo.name) ? clientInfo.name : '') || 'Agent';
  return {
    theme: theme || found?.theme || 'agent',
    label: label || found?.name || fallbackName.replace(/[-_]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()),
  };
}
