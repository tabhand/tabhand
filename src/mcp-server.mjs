// MCP server an agent launches over stdio. Each server process is one agent session: it gets its
// own background tabs and its own tab group, and cannot see or touch any other tabs.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BridgeClient, OLD_BRIDGE } from './bridge-client.mjs';
import { detectHarness } from './harness.mjs';
import { VERSION } from './version.mjs';

const tabLine = ({ tabId, title, url, profile }) => `Tab ${tabId}: ${title || '(untitled)'} — ${url}${profile ? ` (in ${profile})` : ''}`;
const STATES = {
  on: 'on',
  paused: 'paused by the user',
  'not answering': "on, but Chrome isn't answering",
  outdated: "can't take work until Chrome restarts (it runs an older Tabhand helper)",
};
/** One line per Chrome profile, for browser_list_profiles. */
const profileLine = (p) =>
  `- ${p.name ? `"${p.name}"` : 'Unnamed'} (id ${p.id}): ${STATES[p.state] ?? p.state}` +
  (p.tabs ? `, ${p.tabs === 1 ? 'one of your tabs' : `${p.tabs} of your tabs`}` : '') +
  (p.chosen && p.state !== 'on'
    ? ". You chose it, so your new tabs can't open until it's back, unless you choose another profile."
    : p.newTabs
      ? `. Your new tabs open here${p.chosen ? ' (you chose it)' : ''}.`
      : '.');
const text = (value) => ({ content: [{ type: 'text', text: value }] });
const navigatedNote = (result) =>
  (result.chose ? `\nChose "${result.chose}" in the dropdown.` : '') +
  (result.notes?.length ? `\n${result.notes.join('\n')}` : '') +
  (result.dialog
    ? `\nThe page opened a ${result.dialog.type} dialog: "${result.dialog.message}". Answer it with browser_handle_dialog before doing anything else in this tab.`
    : '') +
  (result.navigated ? '\nThe page changed. Take a new snapshot before using refs.' : '') +
  (result.opened?.length
    ? `\nThis opened ${result.opened.length === 1 ? 'a new tab' : 'new tabs'} in your session:\n${result.opened.map(tabLine).join('\n')}`
    : '');

// Shown to the agent in every session (harnesses add server instructions to their prompts), so it
// knows when to reach for the user's browser and how the tools fit together.
const INSTRUCTIONS = `Tabhand gives you the user's own Chrome, signed in to their accounts, in background tabs that never interrupt them.

Use it whenever a task needs a real browser: pages behind a login (email, dashboards, admin panels, social media), web apps without an API, or checking how a site looks and behaves. Prefer it over fetching URLs directly when a page needs the user's session or runs on JavaScript.

How it works:
- browser_open_tab opens a tab in your own tab group; you can only reach tabs you opened and tabs those pages open.
- browser_snapshot reads the page and labels what you can act on with refs like e12; browser_click and browser_type take those refs. Take a new snapshot after the page changes. If something you can see has no ref, browser_click can take its text instead.
- Prefer snapshots for reading; use browser_screenshot to check visuals.
- Close your tabs with browser_close_tab when you're done.
- The user may have Tabhand in several Chrome profiles (say, work and personal), each signed in to different accounts. When they mention one, or a tool says Tabhand is paused, call browser_list_profiles, then pass the profile to browser_open_tab. If it's unclear which profile they mean, ask them.

You act as the user, with their accounts: ask before sending messages, posting, buying, deleting or changing settings. If a tool says Chrome isn't connected, ask the user to open Chrome and make sure the Tabhand extension is turned on.`;

// Files travel to the extension in pieces, since messages to an extension are capped at 1 MB.
const UPLOAD_PIECE = 512 * 1024;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MIME_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', zip: 'application/zip', json: 'application/json', txt: 'text/plain', csv: 'text/csv',
  md: 'text/markdown', html: 'text/html', mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg',
};
const mimeType = (file) => MIME_TYPES[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';

export async function runMcpServer({ label, theme } = {}) {
  const server = new McpServer({ name: 'tabhand', version: VERSION }, { instructions: INSTRUCTIONS });
  let bridge = null;
  // Connect on first use, once the client has introduced itself.
  const bridgeFor = () => {
    if (!bridge) {
      const harness = detectHarness({ clientInfo: server.server.getClientVersion(), label, theme });
      // Who this agent is, so a restarted MCP server gets its tabs back: the conversation, where the
      // app says (Claude Code does, and keeps it when it resumes one in a new process), or else the
      // app process and folder.
      const conversation = process.env.CLAUDE_CODE_SESSION_ID;
      bridge = new BridgeClient({ sessionId: crypto.randomUUID(), ...harness, conversation, parent: process.ppid, cwd: process.cwd() });
    }
    return bridge;
  };
  const call = (cmd, params) => bridgeFor().request(cmd, params);
  /** Profiles need a bridge from 0.9 on; an older one would open the tab wherever it likes. */
  const needProfiles = async () => {
    await bridgeFor().connect();
    if (!bridge.knowsProfiles) throw new Error(OLD_BRIDGE);
  };

  const tool = (name, description, inputSchema, run, annotations = {}) =>
    server.registerTool(name, { description, inputSchema, annotations: { openWorldHint: true, ...annotations } }, async (args) => {
      try {
        return await run(args);
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: String(error?.message ?? error) }] };
      }
    });

  const tabId = z.number().int().describe('Tab id from browser_open_tab or browser_list_tabs.');

  tool(
    'browser_open_tab',
    "Open a new tab in the user's own Chrome, with their logins, and optionally load a URL. The tab opens in the background inside this session's tab group: Chrome is not brought to the front and the user's tabs are untouched, so they can keep working. Returns the tabId the other browser tools need.",
    {
      url: z.string().optional().describe('Page to load, e.g. https://example.com. Omit for a blank tab.'),
      profile: z
        .string()
        .optional()
        .describe('Chrome profile to open the tab in, by its name or id from browser_list_profiles. Only needed when the user has Tabhand in several profiles. Your later tabs open there too.'),
    },
    async ({ url, profile }) => {
      const wanted = profile?.trim();
      if (!wanted) return text(tabLine(await call('open_tab', { url })));
      await needProfiles();
      // The choice is told to the bridge again whenever this reconnects, so it holds if the bridge
      // moves to another profile: by the profile's id once known, since names can change.
      const before = bridge.profile;
      bridge.profile = wanted;
      try {
        const result = await call('open_tab', { url, profile: wanted });
        if (result.profileId) bridge.profile = result.profileId;
        return text(tabLine(result));
      } catch (error) {
        // Nothing was chosen if no profile matched. (One that's paused is still chosen.)
        if (/^(No Chrome profile|More than one Chrome profile)/.test(error.message)) bridge.profile = before;
        throw error;
      }
    },
  );

  tool(
    'browser_list_profiles',
    "List the Chrome profiles that have Tabhand (for example work and personal, each signed in to different accounts): each one's name, whether Tabhand is on or paused there, and which one your new tabs open in.",
    {},
    async () => {
      await needProfiles();
      const { profiles, chosenMissing } = await call('profiles', {});
      const lines = profiles.map(profileLine);
      if (chosenMissing) lines.push(`You chose ${chosenMissing}, which isn't connected now: its Chrome window may be closed.`);
      if (profiles.length > 1 && profiles.some((p) => !p.name && p.state !== 'outdated')) {
        lines.push('The user can name a profile: right-click the Tabhand icon in that profile\'s Chrome toolbar and choose "Name this profile".');
      }
      if (profiles.length > 1) lines.push('To choose one, pass its name or id as profile to browser_open_tab.');
      const heading = profiles.length === 1 ? 'Tabhand is in one Chrome profile:' : `Tabhand is in ${profiles.length} Chrome profiles:`;
      return text(`${heading}\n${lines.join('\n')}`);
    },
    { readOnlyHint: true },
  );

  tool(
    'browser_navigate',
    'Load a URL in one of this session\'s tabs and wait for it to finish loading.',
    { tabId, url: z.string().describe('Page to load.') },
    async (args) => {
      const result = await call('navigate', args);
      return text(tabLine(result) + navigatedNote(result));
    },
  );

  tool(
    'browser_snapshot',
    'Read the page as an accessibility outline (headings, text, links, buttons, fields). Elements you can act on carry a ref like e123 for browser_click and browser_type; plain elements the page made clickable show as "clickable". Refs stop working after the page changes, so take a new snapshot then.',
    { tabId },
    async (args) => {
      const result = await call('snapshot', args);
      return text(`${tabLine(result)}\n\n${result.snapshot}`);
    },
    { readOnlyHint: true },
  );

  tool(
    'browser_click',
    'Click an element by its ref from browser_snapshot, or else by the text it shows. Waits for any page load the click starts. Links and popups that open a new tab stay in the background, join this session, and are listed in the result. Clicking an option of a dropdown chooses it.',
    {
      tabId,
      ref: z.string().optional().describe('Element ref from browser_snapshot, e.g. e123.'),
      text: z
        .string()
        .optional()
        .describe("Instead of a ref: the visible text of the element to click, for something the snapshot gives no ref but you can see in a screenshot."),
    },
    async (args) => {
      if (!args.ref && !args.text) throw new Error('Give the ref of the element to click, from browser_snapshot, or its text.');
      const result = await call('click', args);
      return text(tabLine(result) + navigatedNote(result));
    },
  );

  tool(
    'browser_type',
    'Type text into a field. Pass the field\'s ref to focus it first; omit ref to type into whatever already has focus. Set clear to replace the existing text and submit to press Enter afterwards. Given a dropdown\'s ref, chooses the option with that text.',
    {
      tabId,
      ref: z.string().optional().describe('Field ref from browser_snapshot, e.g. e123.'),
      text: z.string().describe('Text to type.'),
      clear: z.boolean().optional().describe('Replace the field\'s current text.'),
      submit: z.boolean().optional().describe('Press Enter after typing.'),
    },
    async (args) => {
      const result = await call('type', args);
      return text(tabLine(result) + navigatedNote(result));
    },
  );

  tool(
    'browser_press_key',
    'Press a key in the page: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space, a single character, or a combination such as Shift+Tab.',
    { tabId, key: z.string().describe('Key or combination, e.g. Enter or Shift+Tab.') },
    async (args) => {
      const result = await call('press_key', args);
      return text(tabLine(result) + navigatedNote(result));
    },
  );

  tool(
    'browser_handle_dialog',
    'Answer a confirm or prompt dialog the page opened: accept it (OK) or dismiss it (Cancel). The page waits until it is answered. Alerts are closed for you. Ask the user first if accepting would send, buy, delete or change something.',
    {
      tabId,
      accept: z.boolean().describe('true for OK, false for Cancel.'),
      text: z.string().optional().describe('What to enter, for a prompt dialog.'),
    },
    async (args) => {
      const result = await call('handle_dialog', args);
      return text(`${args.accept ? 'Accepted' : 'Dismissed'} the dialog.\n${tabLine(result)}${navigatedNote(result)}`);
    },
  );

  tool(
    'browser_scroll',
    'Scroll the page up or down, e.g. to load more content or bring something into view for a screenshot.',
    {
      tabId,
      direction: z.enum(['up', 'down']).optional().describe('Defaults to down.'),
      amount: z.number().optional().describe('Pixels to scroll. Defaults to 600.'),
    },
    async (args) => {
      const result = await call('scroll', args);
      return text(`${tabLine(result)}\nScroll position ${result.scroll?.y ?? '?'} of ${result.scroll?.max ?? '?'} px.`);
    },
  );

  tool(
    'browser_screenshot',
    'Take a screenshot of one of this session\'s tabs, even though it is in the background. Prefer browser_snapshot for reading text; use screenshots to check layout and visuals.',
    { tabId, fullPage: z.boolean().optional().describe('Capture the whole page instead of the visible area (capped at 8000 px tall).') },
    async (args) => {
      const result = await call('screenshot', args);
      return { content: [{ type: 'image', data: result.data, mimeType: result.mimeType }, { type: 'text', text: tabLine(result) }] };
    },
    { readOnlyHint: true },
  );

  tool(
    'browser_list_tabs',
    'List the tabs this session has open. Other sessions\' tabs and the user\'s own tabs are never shown.',
    {},
    async () => {
      const { tabs, notes = [] } = await call('list_tabs', {});
      return text([tabs.length ? tabs.map(tabLine).join('\n') : 'No open tabs in this session.', ...notes].join('\n'));
    },
    { readOnlyHint: true },
  );

  tool(
    'browser_upload_file',
    'Attach files from this computer to the page, as if the user picked them. Pass the ref of a file field, or of the button that opens a file picker (no system dialog appears).',
    {
      tabId,
      ref: z.string().describe('Ref of the file field, or of the button that opens the file picker.'),
      paths: z.array(z.string()).min(1).describe('Files to attach: absolute paths, or relative to the directory you run in.'),
    },
    async ({ tabId, ref, paths }) => {
      const uploadId = crypto.randomUUID();
      const files = [];
      let total = 0;
      for (const [index, file] of paths.entries()) {
        const full = path.resolve(file);
        const data = fs.readFileSync(full);
        total += data.length;
        if (total > MAX_UPLOAD_BYTES) throw new Error(`That's more than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB of files.`);
        const base64 = data.toString('base64');
        for (let at = 0; at < base64.length; at += UPLOAD_PIECE) {
          await call('upload_part', { uploadId, file: index, data: base64.slice(at, at + UPLOAD_PIECE), forTab: tabId });
        }
        files.push({ name: path.basename(full), type: mimeType(full) });
      }
      const result = await call('upload_files', { tabId, ref, uploadId, files });
      return text(`Attached ${files.map((file) => file.name).join(', ')}.${navigatedNote(result)}`);
    },
  );

  tool(
    'browser_close_tab',
    'Close one of this session\'s tabs when you are done with it.',
    { tabId },
    async (args) => {
      await call('close_tab', args);
      return text(`Closed tab ${args.tabId}.`);
    },
    { destructiveHint: true },
  );

  const transport = new StdioServerTransport();
  transport.onclose = () => bridge?.close();
  await server.connect(transport);
}
