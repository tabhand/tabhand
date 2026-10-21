// Connection from an agent session (the MCP server) to the native host's Unix socket.

import fs from 'node:fs';
import net from 'node:net';
import { socketPath, tokenPath } from './paths.mjs';

export const NOT_CONNECTED =
  'Tabhand cannot reach Chrome. Ask the user to open Chrome and check that the Tabhand extension is installed and enabled (`tabhand status` shows the setup).';

export const OLD_BRIDGE =
  "Tabhand's helper in Chrome is from before it knew about Chrome profiles. Ask the user to quit Chrome and open it again, which restarts it.";

export class BridgeClient {
  /**
   * conversation, or else parent and cwd: who the agent is (its conversation, or the process that
   * runs it and its folder). If the app restarts this MCP server, the new one gets the old session's
   * tabs back by them.
   * @param {{sessionId: string, label: string, theme?: string, conversation?: string, parent?: number, cwd?: string}} options
   */
  constructor({ sessionId, label, theme = 'agent', conversation, parent, cwd }) {
    this.sessionId = sessionId;
    this.label = label;
    this.theme = theme;
    this.conversation = conversation;
    this.parent = parent;
    this.cwd = cwd;
    /** @type {net.Socket | null} */
    this.socket = null;
    /** @type {Promise<void> | null} */
    this.connecting = null;
    this.pending = new Map();
    this.nextId = 1;
    /** The Chrome profile the agent chose, if it did: told to the bridge each time this connects. */
    this.profile = null;
    this.knowsProfiles = false;
  }

  connect() {
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      let token;
      try {
        token = fs.readFileSync(tokenPath(), 'utf8').trim();
      } catch {
        reject(new Error(NOT_CONNECTED));
        return;
      }
      const socket = net.connect(socketPath());
      let buffer = '';
      let welcomed = false;
      socket.setEncoding('utf8');
      socket.once('connect', () => {
        const hello = { type: 'hello', token, sessionId: this.sessionId, label: this.label, theme: this.theme, profile: this.profile ?? undefined, conversation: this.conversation, parent: this.parent, cwd: this.cwd };
        socket.write(JSON.stringify(hello) + '\n');
      });
      socket.on('data', (data) => {
        buffer += data;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message.type === 'welcome') {
            welcomed = true;
            // Bridges from 0.9 on can tell Chrome profiles apart.
            this.knowsProfiles = message.profiles === true;
            // A restarted MCP server may have taken over its earlier session's tabs.
            if (typeof message.sessionId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(message.sessionId)) this.sessionId = message.sessionId;
            this.socket = socket;
            resolve();
          } else if (message.type === 'error') {
            reject(new Error(`Tabhand refused the connection: ${message.error}`));
          } else if (message.type === 'response') {
            const entry = this.pending.get(message.id);
            if (!entry) continue;
            this.pending.delete(message.id);
            if (message.ok) entry.resolve(message.result);
            else entry.reject(new Error(message.error || 'Unknown error'));
          }
        }
      });
      socket.on('error', () => {});
      socket.on('close', () => {
        if (!welcomed) reject(new Error(NOT_CONNECTED));
        if (this.socket === socket) this.socket = null;
        for (const entry of this.pending.values()) entry.reject(new Error('Lost the connection to Chrome. Try again.'));
        this.pending.clear();
      });
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /** Sends one command to the extension and resolves with its result. */
  async request(cmd, params = {}) {
    await this.connect();
    // The agent chose a profile, but this bridge can't tell profiles apart (an older helper took over):
    // new work would land in whichever profile it runs in, possibly signed in as someone else.
    if (this.profile && !this.knowsProfiles && !Number.isInteger(params.tabId) && !Number.isInteger(params.forTab)) throw new Error(OLD_BRIDGE);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(JSON.stringify({ type: 'request', id, cmd, params }) + '\n');
    });
  }

  close() {
    this.socket?.destroy();
  }
}
