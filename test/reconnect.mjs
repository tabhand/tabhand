// An agent's app can restart Tabhand's MCP server mid-task: Claude Code does when it reconnects its
// MCP servers, and resumes a conversation in a new process after an interrupt. The new server gets
// the old one's tabs back, as long as it's the same agent: the same conversation, or else the same
// app process, folder and name. Another agent never gets them, and once an agent can't come back,
// its session ends as before.
//
// Runs a real native host against a fake extension (no Chrome needed), with real MCP servers.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readMessages, writeMessage } from '../src/native-messaging.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin/tabhand.mjs');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabhand-reconnect-'));
// The agents here are this test's own, not part of a conversation that may be running the test.
delete process.env.CLAUDE_CODE_SESSION_ID;
const env = { ...process.env, TABHAND_DATA_DIR: dataDir, TABHAND_HOME: dataDir, TABHAND_SESSION_GRACE_MS: '400' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

// The extension's side: tabs per session, and which sessions ended. It keeps them when its helper
// restarts, as Tabhand's extension does.
const extension = { tabs: new Map(), ended: [], nextTab: 100, active: false };
let host;
function startHost() {
  const helper = spawn(process.execPath, [bin, 'host', `chrome-extension://${'a'.repeat(32)}/`], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  readMessages(helper.stdout, (message) => {
    if (message.type === 'active') extension.active = true;
    if (message.type === 'session-ended') extension.ended.push(message.sessionId);
    if (message.type !== 'request') return;
    const tabs = extension.tabs.get(message.sessionId) ?? [];
    let reply;
    if (message.cmd === 'open_tab') {
      const tabId = extension.nextTab++;
      extension.tabs.set(message.sessionId, [...tabs, tabId]);
      reply = { ok: true, result: { tabId, title: 'Page', url: message.params.url } };
    } else if (message.cmd === 'list_tabs') {
      reply = { ok: true, result: { tabs: tabs.map((tabId) => ({ tabId, title: 'Page', url: 'https://example.com/' })) } };
    } else {
      reply = { ok: false, error: `Unknown command: ${message.cmd}` };
    }
    writeMessage(helper.stdin, { type: 'response', id: message.id, ...reply });
  });
  writeMessage(helper.stdin, { type: 'hello', version: '0.9.0', profile: { id: 'aaaa1111', name: 'Work' } });
  return helper;
}
host = startHost();

// Another app: a process of its own that runs the MCP server, and takes it down when it goes.
const otherApp = `
  const server = require('node:child_process').spawn(process.execPath, process.argv.slice(1), { stdio: 'inherit' });
  process.on('SIGTERM', () => { server.kill(); process.exit(0); });
  server.on('exit', (code) => process.exit(code ?? 0));`;

/** An MCP server, run by this test (its "app") or by another app, in a conversation if given. */
async function agent({ fromOtherApp = false, conversation } = {}) {
  const command = process.execPath;
  const args = fromOtherApp ? ['-e', otherApp, bin, 'mcp', '--label', 'Claude'] : [bin, 'mcp', '--label', 'Claude'];
  const client = new Client({ name: 'tabhand-reconnect', version: '0' });
  await client.connect(new StdioClientTransport({ command, args, env: conversation ? { ...env, CLAUDE_CODE_SESSION_ID: conversation } : env }));
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { error: Boolean(result.isError), text: result.content.map((c) => c.text ?? '').join('\n') };
  };
  return { client, call };
}

async function until(test, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return true;
    await sleep(50);
  }
  return false;
}

try {
  check('the host runs the bridge', await until(() => extension.active));

  const first = await agent();
  const opened = await first.call('browser_open_tab', { url: 'https://example.com/' });
  const tabId = Number(/^Tab (\d+):/m.exec(opened.text)?.[1]);
  await first.client.close();
  await sleep(1500);
  check('while its app is still open, the session waits past the usual grace', extension.ended.length === 0, `ended: ${extension.ended.length}`);

  const restarted = await agent();
  let listed = await restarted.call('browser_list_tabs');
  check('the restarted MCP server gets the tab back', listed.text.includes(`Tab ${tabId}:`), listed.text);
  await restarted.client.close();
  await sleep(200);

  const other = await agent({ fromOtherApp: true });
  listed = await other.call('browser_list_tabs');
  check('another agent in the same folder does not get it', !listed.text.includes(`Tab ${tabId}:`), listed.text);
  await other.call('browser_open_tab', { url: 'https://example.com/' });
  const otherSession = [...extension.tabs.keys()].at(-1);
  await other.client.close();
  check('a session whose app is gone ends after the usual grace', await until(() => extension.ended.includes(otherSession), 3000), `ended: ${extension.ended.length}`);

  const again = await agent();
  listed = await again.call('browser_list_tabs');
  check('and the first agent can still come back for its tab', listed.text.includes(`Tab ${tabId}:`), listed.text);
  await again.client.close();

  // Claude Code resumes a conversation in a new process (after an interrupt, say) and tells its MCP
  // servers which conversation they're in. Then that's what matches.
  const talk = await agent({ fromOtherApp: true, conversation: 'conversation-aaaa1111' });
  const talkTab = Number(/^Tab (\d+):/m.exec((await talk.call('browser_open_tab', { url: 'https://example.com/' })).text)?.[1]);
  const talkSession = [...extension.tabs.keys()].at(-1);
  await talk.client.close();
  await sleep(1500);
  check('a conversation that may be resumed waits, even with its app gone', !extension.ended.includes(talkSession), `ended: ${extension.ended.length}`);
  const stranger = await agent({ conversation: 'conversation-bbbb2222' });
  listed = await stranger.call('browser_list_tabs');
  check('another conversation, even in the same app and folder, does not get its tab', !listed.text.includes(`Tab ${talkTab}:`), listed.text);
  await stranger.client.close();
  const resumed = await agent({ fromOtherApp: true, conversation: 'conversation-aaaa1111' });
  listed = await resumed.call('browser_list_tabs');
  check('the resumed conversation, in a new app process, gets its tab back', listed.text.includes(`Tab ${talkTab}:`), listed.text);

  // The helper restarts (Chrome restarts it with the extension) and forgets who took over what. The
  // resumed agent still comes back as the session it took over.
  extension.active = false;
  host.kill();
  await new Promise((resolve) => host.once('exit', resolve));
  host = startHost();
  await until(() => extension.active);
  let after = { error: true, text: '' };
  for (let i = 0; i < 20 && after.error; i++) {
    after = await resumed.call('browser_list_tabs');
    if (after.error) await sleep(100);
  }
  check('after its helper restarts, the resumed agent still has its tab', after.text.includes(`Tab ${talkTab}:`), after.text);
  await resumed.client.close();
} catch (error) {
  check('test run', false, error.message);
} finally {
  host.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(results.every(Boolean) ? 0 : 1);
}
