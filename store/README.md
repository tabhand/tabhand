# Chrome Web Store listing

What goes into each field of the Chrome Web Store developer dashboard, kept here so updates stay consistent. The images in this folder are the listing's: `icon-128.png` (store icon), `screenshot-1..3.png` (1280×800), `promo-small.png` (small promo tile, 440×280).

The package is `extension/`, zipped with the manifest's `key` removed (the store assigns its own ID).

## Store listing

**Category:** Developer Tools. **Language:** English.

**Description:**

```
Tabhand lets the AI agents you already use (Claude Code, Codex, Cursor, OpenCode, Gemini CLI, Copilot and more) work in your own Chrome, where you're already signed in.

• Background tabs. Each agent works in tabs of its own, grouped and muted. Chrome never jumps to the front, so you keep working.
• Your logins. Agents use the sites you're signed in to; you never hand over a password.
• Your tabs stay yours. An agent can only reach the tabs it opened: never yours, never another agent's.
• Watch it work. Each agent gets its own cursor that glides, clicks and types, and its tabs wear its icon.
• Stop anytime. Click the toolbar icon to pause every agent at once.

Set up with one command:
  npx tabhand setup
It adds Tabhand to the agents on your computer and connects them to this extension. Everything runs on your computer: no servers, no analytics.

Open source (MIT): https://github.com/tabhand/tabhand
```

## Privacy practices

**Single purpose:**

```
Lets AI agents running on the user's computer browse in Chrome tabs of their own, in the background.
```

**Permission justifications:**

| Permission | Justification |
|---|---|
| debugger | Tabhand drives only the tabs an AI agent opened: it reads the page (accessibility tree, screenshots) and makes the agent's clicks and typing through the Chrome DevTools Protocol, which works while the tab stays in the background. It never attaches to the user's own tabs. |
| nativeMessaging | Connects to the Tabhand helper on the user's computer (installed with `npx tabhand setup`), which relays requests from the user's own AI agents. No remote servers are involved. |
| tabGroups | Keeps each agent's tabs in a tab group named after the agent, so the user sees what each agent opened. |
| storage | Remembers which tabs belong to which agent and whether the user paused Tabhand, in session storage that's cleared when Chrome restarts. |
| alarms | Periodically reconnects to the local helper and releases tabs an agent stopped using. |
| scripting | Shows the agent's cursor and tab icon in the agent's tabs, and removes other extensions' pop-up frames from those tabs, which would otherwise block the debugger. |
| Host permission (all sites) | The user's agents can be asked to work on any website, so Tabhand needs access to the pages they open. It acts only in tabs an agent opened. |

**Remote code:** No, I am not using remote code.

**Data usage:** check *Website content* (pages in the agent's tabs go to the user's own agent, on their computer). Check all three certifications.

**Privacy policy URL:** https://github.com/tabhand/tabhand/blob/main/PRIVACY.md

## Distribution

Public, all regions, free.

## Test instructions (for reviewers)

```
Tabhand needs its companion helper. On macOS with Node.js 20+, run: npx tabhand setup
Then ask an MCP-capable agent such as Claude Code: "Open example.com with the browser tools and tell me the page title."
```
