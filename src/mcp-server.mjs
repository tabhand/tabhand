// MCP server an agent launches over stdio. Each server process is one agent session: it gets its
// own background tabs and its own tab group, and cannot see or touch any other tabs.

import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BridgeClient } from './bridge-client.mjs';
import { detectHarness } from './harness.mjs';
import { VERSION } from './version.mjs';

const tabLine = ({ tabId, title, url }) => `Tab ${tabId}: ${title || '(untitled)'} — ${url}`;
const text = (value) => ({ content: [{ type: 'text', text: value }] });
const navigatedNote = (result) =>
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
- browser_snapshot reads the page and labels what you can act on with refs like e12; browser_click and browser_type take those refs. Take a new snapshot after the page changes.
- Prefer snapshots for reading; use browser_screenshot to check visuals.
- Close your tabs with browser_close_tab when you're done.

You act as the user, with their accounts: ask before sending messages, posting, buying, deleting or changing settings. If a tool says Chrome isn't connected, ask the user to open Chrome and make sure the Tabhand extension is turned on.`;

export async function runMcpServer({ label, theme } = {}) {
  const server = new McpServer({ name: 'tabhand', version: VERSION }, { instructions: INSTRUCTIONS });
  let bridge = null;
  const call = async (cmd, params) => {
    // Connect on first use, once the client has introduced itself.
    if (!bridge) {
      const harness = detectHarness({ clientInfo: server.server.getClientVersion(), label, theme });
      bridge = new BridgeClient({ sessionId: crypto.randomUUID(), ...harness });
    }
    return bridge.request(cmd, params);
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
    { url: z.string().optional().describe('Page to load, e.g. https://example.com. Omit for a blank tab.') },
    async ({ url }) => text(tabLine(await call('open_tab', { url }))),
  );

  tool(
    'browser_navigate',
    'Load a URL in one of this session\'s tabs and wait for it to finish loading.',
    { tabId, url: z.string().describe('Page to load.') },
    async (args) => text(tabLine(await call('navigate', args))),
  );

  tool(
    'browser_snapshot',
    'Read the page as an accessibility outline (headings, text, links, buttons, fields). Elements you can act on carry a ref like e123 for browser_click and browser_type. Refs stop working after the page changes, so take a new snapshot then.',
    { tabId },
    async (args) => {
      const result = await call('snapshot', args);
      return text(`${tabLine(result)}\n\n${result.snapshot}`);
    },
    { readOnlyHint: true },
  );

  tool(
    'browser_click',
    'Click an element by its ref from browser_snapshot. Waits for any page load the click starts. Links and popups that open a new tab stay in the background, join this session, and are listed in the result.',
    { tabId, ref: z.string().describe('Element ref from browser_snapshot, e.g. e123.') },
    async (args) => {
      const result = await call('click', args);
      return text(tabLine(result) + navigatedNote(result));
    },
  );

  tool(
    'browser_type',
    'Type text into a field. Pass the field\'s ref to focus it first; omit ref to type into whatever already has focus. Set clear to replace the existing text and submit to press Enter afterwards.',
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
      const { tabs } = await call('list_tabs', {});
      return text(tabs.length ? tabs.map(tabLine).join('\n') : 'No open tabs in this session.');
    },
    { readOnlyHint: true },
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
