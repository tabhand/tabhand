// Two Chrome profiles, "Work" and "Personal": agents see them by name and can choose one, and when
// one is paused, new work goes to the profile where Tabhand is on.
//
// Runs two real native hosts against fake extensions (no Chrome needed). Profile A starts first,
// so its host runs the bridge; profile B's host stands by. With A paused, an agent's new work
// should land in B and stay there; work on a tab that lives in A should wait for A; an agent that
// chose a profile should stay in it; and nothing should hang when there's nowhere to go.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BridgeClient, OLD_BRIDGE } from '../src/bridge-client.mjs';
import { readMessages, writeMessage } from '../src/native-messaging.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabhand-profiles-'));
// The agents here run under this test, which stays open, so their sessions would wait minutes for
// a restarted agent (see test/reconnect.mjs). Keep both waits short.
// The agents here are this test's own, not part of a conversation that may be running the test.
delete process.env.CLAUDE_CODE_SESSION_ID;
const env = { ...process.env, TABHAND_DATA_DIR: dataDir, TABHAND_HOME: dataDir, TABHAND_SESSION_GRACE_MS: '400', TABHAND_RECONNECT_GRACE_MS: '400' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const PAUSED = 'The user paused Tabhand in Chrome. Ask them to click the Tabhand icon in Chrome’s toolbar and press Resume.';

/** A Chrome profile: a real host process with a fake extension on the other end of its pipe. */
function profile(name, firstTab, identity) {
  const host = spawn(process.execPath, [path.join(root, 'bin/tabhand.mjs'), 'host', `chrome-extension://${'a'.repeat(32)}/`], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const p = { name, host, paused: false, big: false, seen: [], ended: [], state: null, nextTab: firstTab, tabs: new Map() };
  readMessages(host.stdout, (message) => {
    if (message.type === 'standby' || message.type === 'active') p.state = message.type;
    if (message.type === 'session-ended') p.ended.push(message.sessionId);
    if (message.type !== 'request') return;
    p.seen.push(message.cmd);
    let reply;
    if (p.paused) reply = { ok: false, error: PAUSED };
    else if (message.cmd === 'open_tab') {
      const tabId = p.nextTab++;
      p.tabs.set(message.sessionId, [...(p.tabs.get(message.sessionId) ?? []), tabId]);
      reply = { ok: true, result: { tabId, title: `Opened in ${name}`, url: message.params.url } };
    }
    else if (message.cmd === 'snapshot') reply = { ok: true, result: { tabId: message.params.tabId, title: `Page in ${name}`, url: 'https://example.com/', snapshot: p.big ? 'x'.repeat(5_500_000) : `- heading "${name}"` } };
    else if (message.cmd === 'list_tabs') reply = { ok: true, result: { tabs: (p.tabs.get(message.sessionId) ?? []).map((tabId) => ({ tabId, title: `Page in ${name}`, url: 'https://example.com/' })) } };
    else reply = { ok: false, error: `Unknown command: ${message.cmd}` };
    writeMessage(host.stdin, { type: 'response', id: message.id, ...reply });
  });
  writeMessage(host.stdin, { type: 'hello', version: '0.9.0', profile: identity });
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
  const a = profile('A', 100, { id: 'aaaa1111', name: 'Work' });
  procs.push(a.host);
  check('profile A runs the bridge', await until(() => a.state === 'active'));
  const b = profile('B', 200, { id: 'bbbb2222', name: 'Personal' });
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

  // Agents see the profiles by name, and can choose one.
  const six = await agent('Six');
  r = await six.call('browser_list_profiles');
  check('the agent sees both profiles by name', !r.error && /"Work"[^\n]*: on/.test(r.text) && /"Personal"[^\n]*: on/.test(r.text), r.text);
  check('and which one its new tabs open in', /"Work"[^\n]*Your new tabs open here/.test(r.text), r.text);
  r = await six.call('browser_open_tab', { url: 'https://example.com/', profile: 'personal' });
  check('asking for a profile by name opens the tab there', !r.error && /Opened in B/.test(r.text) && /\(in "Personal"\)/.test(r.text), r.text);
  r = await six.call('browser_open_tab', { url: 'https://example.com/' });
  check('and its later tabs open there too', !r.error && /Opened in B/.test(r.text), r.text);

  // The chosen profile gets paused: the agent hears so, rather than ending up in another account.
  b.paused = true;
  const aOpens = a.seen.filter((c) => c === 'open_tab').length;
  r = await six.call('browser_open_tab', { url: 'https://example.com/' });
  check('when the profile it chose is paused, the agent hears so', r.error && /paused in "Personal", the Chrome profile you chose/.test(r.text), r.text);
  check('and the tab does not open in the other profile', a.seen.filter((c) => c === 'open_tab').length === aOpens);
  r = await six.call('browser_list_profiles');
  check('the list shows it paused and chosen', /"Personal"[^\n]*paused[^\n]*You chose it, so your new tabs can't open/.test(r.text) && /"Work"[^\n]*: on/.test(r.text), r.text);
  b.paused = false;

  r = await six.call('browser_open_tab', { url: 'https://example.com/', profile: 'Client' });
  check("asking for a profile that isn't there names the ones that are", r.error && /No Chrome profile/.test(r.text) && /"Work"/.test(r.text) && /"Personal"/.test(r.text), r.text);

  // The user renames a profile.
  writeMessage(b.host.stdin, { type: 'profile', profile: { id: 'bbbb2222', name: 'Home' } });
  await sleep(200);
  r = await six.call('browser_list_profiles');
  check('a renamed profile shows its new name', /"Home"/.test(r.text) && !/"Personal"/.test(r.text), r.text);
  r = await six.call('browser_open_tab', { url: 'https://example.com/', profile: 'work' });
  check('the agent can switch profiles', !r.error && /Opened in A/.test(r.text), r.text);
  const tabInWork = Number(/^Tab (\d+):/m.exec(r.text)?.[1]);
  r = await six.call('browser_list_tabs');
  check('its tab list covers both profiles', /in "Work"/.test(r.text) && /in "Home"/.test(r.text) && (r.text.match(/^Tab /gm) ?? []).length === 3, r.text);
  a.paused = true;
  r = await six.call('browser_list_tabs');
  check('with one paused, the list says how many tabs are there', !r.error && /One more tab is in "Work", where Tabhand is paused/.test(r.text), r.text);
  r = await six.call('browser_snapshot', { tabId: tabInWork });
  check('work on a tab in a paused profile says which profile it is in', r.error && /This tab is in "Work"/.test(r.text), r.text);
  a.paused = false;

  // An agent that chose the other profile, before it goes away (below).
  const seven = await agent('Seven');
  r = await seven.call('browser_open_tab', { url: 'https://example.com/', profile: 'bbbb2222' });
  check('a profile can be chosen by its id', !r.error && /Opened in B/.test(r.text), r.text);

  // A session whose agent chose a profile before the bridge moved here says so as it connects.
  process.env.TABHAND_DATA_DIR = dataDir;
  const moved = new BridgeClient({ sessionId: crypto.randomUUID(), label: 'Eight' });
  moved.profile = 'bbbb2222';
  const listed = await moved.request('profiles');
  const home = listed.profiles.find((p) => p.id === 'bbbb2222');
  check('a choice carried over from before the bridge moved is listed as chosen', home?.chosen && home.newTabs && !listed.chosenMissing, JSON.stringify(listed));
  const opened = await moved.request('open_tab', { url: 'https://example.com/' });
  check('and its new tabs open there, and say which profile by id', /Opened in B/.test(opened.title) && opened.profileId === 'bbbb2222', JSON.stringify(opened));
  moved.close();

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
  r = await five.call('browser_list_profiles');
  check('and listed as needing Chrome to restart', /Unnamed[^\n]*older Tabhand helper/.test(r.text), r.text);
  r = await seven.call('browser_open_tab', { url: 'https://example.com/' });
  check('an agent whose chosen profile went away hears so', r.error && /can't reach "Home", the Chrome profile you chose/.test(r.text), r.text);
  old.destroy();

  for (const c of [one, three, four, five, six, seven]) await c.client.close().catch(() => {});

  // An older bridge, which can't tell profiles apart, took over: an agent that chose a profile isn't
  // sent to whichever profile that bridge runs in.
  const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabhand-old-bridge-'));
  process.env.TABHAND_DATA_DIR = oldDir;
  fs.writeFileSync(path.join(oldDir, 'token'), 'old-token');
  const asked = [];
  const oldBridge = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (data) => {
      buffer += data;
      for (let i; (i = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(i + 1)) {
        const message = JSON.parse(buffer.slice(0, i));
        if (message.type === 'hello') socket.write(JSON.stringify({ type: 'welcome' }) + '\n');
        if (message.type === 'request') {
          asked.push(message.cmd);
          socket.write(JSON.stringify({ type: 'response', id: message.id, ok: true, result: { tabId: 9, title: 'Old', url: '' } }) + '\n');
        }
      }
    });
  });
  await new Promise((done) => oldBridge.listen(path.join(oldDir, 'bridge.sock'), done));
  const chose = new BridgeClient({ sessionId: crypto.randomUUID(), label: 'Nine' });
  chose.profile = 'aaaa1111';
  const answer = await chose.request('open_tab', { url: 'https://example.com/' }).then(() => 'opened', (e) => e.message);
  check('with an older bridge, an agent that chose a profile opens nothing', answer === OLD_BRIDGE && !asked.includes('open_tab'), answer);
  const onTab = await chose.request('snapshot', { tabId: 9 }).then(() => 'answered', (e) => e.message);
  check('but its work on a tab it has still goes through', onTab === 'answered', onTab);
  chose.close();
  oldBridge.close();
  fs.rmSync(oldDir, { recursive: true, force: true });
} catch (error) {
  check('runs without throwing', false, error.stack);
} finally {
  for (const p of procs) p.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
