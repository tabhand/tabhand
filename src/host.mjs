// Native messaging host. Chrome starts this process when the Tabhand extension connects,
// and stops it when the extension disconnects. It relays requests from local agent sessions
// (MCP servers, over a Unix socket) to the extension, and responses back.
//
// There is no TCP listener: web pages and other machines cannot reach it. The socket lives in a
// directory only the current user can read, and every client must present a token from that
// directory. The log records lifecycle events only, never page content, URLs or typed text.

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import { readMessages, writeMessage } from './native-messaging.mjs';
import { dataDir, logPath, socketPath, tokenPath } from './paths.mjs';

const SESSION_GRACE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_LINE_BYTES = 4 * 1024 * 1024;

function log(message) {
  try {
    fs.appendFileSync(logPath(), `${new Date().toISOString()} [host ${process.pid}] ${message}\n`, { mode: 0o600 });
  } catch {}
}

function isSocketLive(path) {
  return new Promise((resolve) => {
    const probe = net.connect(path);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
}

export async function runHost() {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir(), 0o700);
  try {
    if (fs.statSync(logPath()).size > 1_000_000) fs.truncateSync(logPath(), 0);
  } catch {}

  if (await isSocketLive(socketPath())) {
    // Another browser profile already runs a host. One bridge per user for now.
    log('another host owns the socket; exiting');
    process.exit(0);
  }
  try {
    fs.unlinkSync(socketPath());
  } catch {}

  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenPath(), token, { mode: 0o600 });
  const tokenBuffer = Buffer.from(token);

  /** @type {Map<string, {socket: net.Socket, sessionId: string}>} sessionId -> live client */
  const sessions = new Map();
  /** @type {Map<string, NodeJS.Timeout>} sessionId -> pending end-of-session timer */
  const endTimers = new Map();
  /** @type {Map<number, {socket: net.Socket, id: unknown, timer: NodeJS.Timeout}>} */
  const pending = new Map();
  let nextId = 1;

  const toExtension = (message) => writeMessage(process.stdout, message);

  const send = (socket, message) => {
    if (!socket.destroyed) socket.write(JSON.stringify(message) + '\n');
  };

  function onClientLine(client, line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.type === 'hello') {
      const given = Buffer.from(String(message.token ?? ''));
      const ok = given.length === tokenBuffer.length && crypto.timingSafeEqual(given, tokenBuffer);
      const sessionId = String(message.sessionId ?? '');
      if (!ok || !/^[A-Za-z0-9-]{8,64}$/.test(sessionId)) {
        send(client.socket, { type: 'error', error: 'Unauthorized' });
        client.socket.destroy();
        return;
      }
      client.sessionId = sessionId;
      client.label = String(message.label ?? 'Agent').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 40) || 'Agent';
      client.theme = /^[a-z]{1,16}$/.test(message.theme) ? message.theme : 'agent';
      clearTimeout(endTimers.get(sessionId));
      endTimers.delete(sessionId);
      const previous = sessions.get(sessionId);
      if (previous && previous.socket !== client.socket) previous.socket.destroy();
      sessions.set(sessionId, client);
      send(client.socket, { type: 'welcome' });
      log('session connected');
      return;
    }

    if (message.type === 'request') {
      if (!client.sessionId) {
        send(client.socket, { type: 'response', id: message.id, ok: false, error: 'Unauthorized' });
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        send(client.socket, { type: 'response', id: message.id, ok: false, error: 'Chrome did not answer in time.' });
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { socket: client.socket, id: message.id, timer });
      toExtension({
        type: 'request',
        id,
        sessionId: client.sessionId,
        label: client.label,
        theme: client.theme,
        cmd: String(message.cmd ?? ''),
        params: message.params ?? {},
      });
    }
  }

  function onClientClosed(client) {
    const { sessionId } = client;
    if (!sessionId || sessions.get(sessionId) !== client) return;
    sessions.delete(sessionId);
    // Agents reconnect after hiccups; only end the session if it stays away.
    endTimers.set(
      sessionId,
      setTimeout(() => {
        endTimers.delete(sessionId);
        toExtension({ type: 'session-ended', sessionId });
        log('session ended');
      }, SESSION_GRACE_MS),
    );
  }

  const server = net.createServer((socket) => {
    const client = { socket, sessionId: '', label: '', theme: 'agent' };
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (data) => {
      buffer += data;
      if (buffer.length > MAX_LINE_BYTES) {
        socket.destroy();
        return;
      }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) onClientLine(client, line);
      }
    });
    socket.on('close', () => onClientClosed(client));
    socket.on('error', () => {});
  });

  readMessages(process.stdin, (message) => {
    if (message.type === 'response') {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      send(entry.socket, { type: 'response', id: entry.id, ok: message.ok, result: message.result, error: message.error });
    } else if (message.type === 'hello') {
      log(`extension ${message.version ?? '?'} connected`);
    }
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log('stopping');
    server.close();
    try {
      if (fs.readFileSync(tokenPath(), 'utf8') === token) {
        fs.unlinkSync(tokenPath());
        fs.unlinkSync(socketPath());
      }
    } catch {}
    process.exit(0);
  };
  process.stdin.on('end', stop);
  process.stdin.on('close', stop);
  process.stdout.on('error', stop);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  server.listen(socketPath(), () => {
    fs.chmodSync(socketPath(), 0o600);
    log('listening');
  });
}
