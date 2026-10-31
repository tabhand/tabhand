#!/usr/bin/env node
import crypto from 'node:crypto';

const [command, ...args] = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = (...names) => names.some((name) => args.includes(name));

const HELP = `Tabhand: let your AI agents use your own Chrome, in background tabs

  tabhand setup     Install Tabhand, add it to the agents on this machine, and connect Chrome
                      --harness claude,codex   only these agents (default: every one found)
                      --yes                    don't ask before changing agent settings
                      --no-wait                don't wait for Chrome to connect
                      --browser brave          only this browser (default: Chrome, and Brave,
                                               Edge and Dia when they're on this machine)
  tabhand status    Check the install, the Chrome connection and each agent
  tabhand remove    Take Tabhand out of your agents and off this machine
  tabhand cursor    Show or set the name and color every agent's cursor uses on this machine
                      --name Acme --color '#FF5A1F'   e.g. your team's name and brand color
                      --icon initial                  the name tag's icon: initial (the name's first
                                                      letter), sparkle, bolt, star, heart, diamond,
                                                      dot, check, prompt, cube or none
                      --reset                         back to each agent's own look

  Agents it knows: claude, codex, opencode, cursor, gemini, qwen, vscode, copilot, kiro, amp,
  droid, warp, junie, antigravity, devin, windsurf, claude-desktop, cline, zed

  tabhand mcp [--label <name>] [--theme <theme>]   The MCP server your agents start
  tabhand install [--browser chrome]                Install and register the bridge only (development)
  tabhand reload                                     Reload the extension after changing its code
`;

try {
  switch (command) {
    case 'setup': {
      const { setup } = await import('../src/setup.mjs');
      const harnesses = flag('--harness')?.split(',').map((key) => key.trim()).filter(Boolean);
      await setup({ harnesses, yes: has('--yes', '-y'), wait: !has('--no-wait'), browser: flag('--browser') });
      break;
    }
    case 'status':
    case 'doctor': {
      const { report } = await import('../src/setup.mjs');
      await report();
      break;
    }
    case 'remove':
    case 'uninstall': {
      const { remove } = await import('../src/setup.mjs');
      await remove({ yes: has('--yes', '-y') });
      break;
    }
    case 'cursor': {
      const { cursorLook, setCursorLook } = await import('../src/settings.mjs');
      const name = flag('--name');
      const color = flag('--color');
      const icon = flag('--icon');
      const reset = has('--reset');
      const changing = reset || name !== undefined || color !== undefined || icon !== undefined;
      const look = changing ? setCursorLook({ name, color, icon, reset }) : cursorLook();
      const said = look
        ? `Agents' cursors on this machine show ${look.name ? `"${look.name}"` : "each agent's own name"} in ${look.color ? look.color.toUpperCase() : "each agent's own color"}, with ${look.icon ? `the ${look.icon} icon` : "each agent's own icon"}.`
        : "Each agent's cursor shows its own name, color and icon.";
      console.log(said);
      if (changing) console.log('New agent sessions use it. Restart an agent to change one that is running.');
      console.log("To change it in one Chrome profile only, click the Tabhand icon in Chrome's toolbar, then the gear.");
      break;
    }
    case 'mcp': {
      const { runMcpServer } = await import('../src/mcp-server.mjs');
      await runMcpServer({ label: flag('--label') ?? process.env.TABHAND_LABEL, theme: flag('--theme') ?? process.env.TABHAND_THEME });
      break;
    }
    case 'host': {
      const { runHost } = await import('../src/host.mjs');
      await runHost();
      break;
    }
    case 'install': {
      const { install } = await import('../src/install.mjs');
      const result = await install({ browser: flag('--browser'), userDataDir: flag('--user-data-dir') });
      console.log(`Installed. Bridge registered in:\n  ${result.written.join('\n  ')}\nExtension folder: ${result.extensionDir}`);
      break;
    }
    case 'reload': {
      // Reloads the extension from disk after code changes (development).
      const { BridgeClient } = await import('../src/bridge-client.mjs');
      const bridge = new BridgeClient({ sessionId: crypto.randomUUID(), label: 'cli' });
      try {
        await bridge.request('reload_extension');
        console.log('Extension reloading. It reconnects in a few seconds.');
      } finally {
        bridge.close();
      }
      break;
    }
    case '--version':
    case 'version': {
      const { VERSION } = await import('../src/version.mjs');
      console.log(VERSION);
      break;
    }
    default:
      console.log(HELP);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
