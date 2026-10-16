// Two Chrome profiles, one paused: new work goes to the profile where Tabhand is on.
//
// Runs two real native hosts against fake extensions (no Chrome needed). Profile A starts first,
// so its host runs the bridge; profile B's host stands by. With A paused, an agent's new work
// should land in B and stay there; work on a tab that lives in A should wait for A; and nothing
// should hang when there's nowhere to go.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readMessages, writeMessage } from '../src/native-messaging.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabhand-profiles-'));
const env = { ...process.env, TABHAND_DATA_DIR: dataDir, TABHAND_HOME: dataDir, TABHAND_SESSION_GRACE_MS: '400' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const PAUSED = 'The user paused Tabhand in Chrome. Ask them to click the Tabhand toolbar icon to resume.';

/** A Chrome profile: a real host process with a fake extension on the other end of its pipe. */
function profile(name, firstTab) {
  const host = spawn(process.execPath, [path.join(root, 'bin/tabhand.mjs'), 'host', `chrome-extension://${'a'.repeat(32)}/`], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const p = { name, host, paused: false, big: false, seen: [], ended: [], state: null, nextTab: firstTab };
  readMessages(host.stdout, (message) => {
    if (message.type === 'standby' || message.type === 'active') p.state = message.type;
    if (message.type === 'session-ended') p.ended.push(message.sessionId);
    if (message.type !== 'request') return;
    p.seen.push(message.cmd);
    let reply;
    if (p.paused) reply = { ok: false, error: PAUSED };
    else if (message.cmd === 'open_tab') reply = { ok: true, result: { tabId: p.nextTab++, title: `Opened in ${name}`, url: message.params.url } };
    else if (message.cmd === 'snapshot') reply = { ok: true, result: { tabId: message.params.tabId, title: `Page in ${name}`, url: 'https://example.com/', snapshot: p.big ? 'x'.repeat(5_500_000) : `- heading "${name}"` } };
    else if (message.cmd === 'list_tabs') reply = { ok: true, result: { tabs: [] } };
    else reply = { ok: false, error: `Unknown command: ${message.cmd}` };
    writeMessage(host.stdin, { type: 'response', id: message.id, ...reply });
  });
  writeMessage(host.stdin, { type: 'hello', version: '0.8.0' });
  return p;
}

async function until(test, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return true;
    await sleep(50);
  }
  return false;
}

async function agent(label) {
  const client = new Client({ name: 'tabhand-profiles', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'bin/tabhand.mjs'), 'mcp', '--label', label], env }));
  const call = async (name, args = {}) => {
    const started = Date.now();
    const result = await client.callTool({ name, arguments: args });
    return { error: Boolean(result.isError), text: result.content.map((c) => c.text ?? '').join('\n'), ms: Date.now() - started };
  };
  return { client, call };
}

const procs = [];
try {
  const a = profile('A', 100);
  procs.push(a.host);
  check('profile A runs the bridge', await until(() => a.state === 'active'));
  const b = profile('B', 200);
  procs.push(b.host);
  check('profile B stands by', await until(() => b.state === 'standby'));
  await sleep(300); // B's standby hello reaches A

  // A is on: work goes to A, as before.
  const one = await agent('One');
  let r = await one.call('browser_open_tab', { url: 'https://example.com/' });
  check('with both on, work goes to the profile running the bridge', !r.error && /Opened in A/.test(r.text), r.text);

  // Pause A. New work from a new session goes to B.
  a.paused = true;
  const two = await agent('Two');
  r = await two.call('browser_open_tab', { url: 'https://example.com/' });
  check('with A paused, a new tab opens in B', !r.error && /Opened in B/.test(r.text), r.text);
  const tabInB = Number(/^Tab (\d+):/m.exec(r.text)?.[1]);
  r = await two.call('browser_snapshot', { tabId: tabInB });
  check('that session keeps working in B', !r.error && /Page in B/.test(r.text), r.text.split('\n')[0]);
  const aSnapshots = a.seen.filter((c) => c === 'snapshot').length;
  check('and A is not asked again once the session moved', aSnapshots === 0, `A saw ${aSnapshots} snapshot(s)`);

  // Session One has a tab in A. While A is paused, work on that tab waits for A (it isn't in B)...
  r = await one.call('browser_snapshot', { tabId: 100 });
  check('work on a tab in paused A says paused', r.error && /paused/i.test(r.text), r.text);
  check('and is not sent to B', b.seen.filter((c) => c === 'snapshot').length === 1);
  // ...while One's new work goes to B.
  r = await one.call('browser_open_tab', { url: 'https://example.com/' });
  check('a session with a tab in A opens its next tab in B', !r.error && /Opened in B/.test(r.text), r.text);
  const oneInB = Number(/^Tab (\d+):/m.exec(r.text)?.[1]);

  // Resume A: each tab is worked on where it lives, and a new session goes to A again.
  a.paused = false;
  r = await one.call('browser_snapshot', { tabId: 100 });
  check('after resuming A, its tab in A is reachable again', !r.error && /Page in A/.test(r.text), r.text.split('\n')[0]);
  r = await one.call('browser_snapshot', { tabId: oneInB });
  check('and its tab in B is still worked on in B', !r.error && /Page in B/.test(r.text), r.text.split('\n')[0]);
  const three = await agent('Three');
  r = await three.call('browser_open_tab', { url: 'https://example.com/' });
  check('a new session goes to A again', !r.error && /Opened in A/.test(r.text), r.text);

  // A large answer from B (a full-page screenshot can be several MB) comes through.
  b.big = true;
  r = await two.call('browser_snapshot', { tabId: tabInB });
  check('a 5.5 MB answer from B comes through', !r.error && r.text.length > 5_000_000, `${r.text.length} chars`);
  b.big = false;
  r = await two.call('browser_snapshot', { tabId: tabInB });
  check('and B is still standing by after it', !r.error && /Page in B/.test(r.text) && b.state === 'standby', r.text.split('\n')[0]);

  // B gets paused while A is on: Two's new work comes back to A; its tab in B waits for B.
  b.paused = true;
  r = await two.call('browser_open_tab', { url: 'https://example.com/' });
  check('when B is paused, a moved session\'s new work comes back to A', !r.error && /Opened in A/.test(r.text), r.text);
  r = await two.call('browser_snapshot', { tabId: tabInB });
  check('while its tab in B says paused', r.error && /paused/i.test(r.text), r.text);
  b.paused = false;

  // When a session that worked in B ends, B hears so (to tidy its tab group).
  await two.client.close();
  check('the profile a session worked in hears it ended', await until(() => b.ended.length > 0, 3000), `B heard ${b.ended.length}`);

  // Both paused: a clear answer, quickly, rather than a hang.
  a.paused = true;
  b.paused = true;
  const four = await agent('Four');
  r = await four.call('browser_open_tab', { url: 'https://example.com/' });
  check('with every profile paused, the agent hears paused', r.error && /paused/i.test(r.text), r.text);
  check('quickly', r.ms < 2000, `${r.ms} ms`);

  // An older host standing by can't take relayed work: it must not be waited on.
  b.paused = false;
  const old = net.connect(path.join(dataDir, 'bridge.sock'));
  await new Promise((done) => old.once('connect', done));
  old.write(JSON.stringify({ type: 'standby', token: fs.readFileSync(path.join(dataDir, 'token'), 'utf8'), version: '0.8.0' }) + '\n');
  await sleep(200);
  b.host.kill();
  await until(() => b.host.exitCode !== null || b.host.signalCode !== null);
  await sleep(200);
  const five = await agent('Five');
  r = await five.call('browser_open_tab', { url: 'https://example.com/' });
  check('an older standby is skipped, not waited on', r.error && /paused/i.test(r.text) && r.ms < 2000, `${r.ms} ms: ${r.text}`);
  old.destroy();

  for (const c of [one, three, four, five]) await c.client.close().catch(() => {});
} catch (error) {
  check('runs without throwing', false, error.stack);
} finally {
  for (const p of procs) p.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
