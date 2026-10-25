# Tabhand privacy policy

Effective October 17, 2026. Updated October 20, 2026.

Tabhand is an open-source Chrome extension and command-line tool. It lets AI agents that you run on your own computer, such as Claude Code or Codex, use your Chrome.

## What Tabhand handles

- **Only the agent's own tabs.** When one of your agents uses Tabhand, the extension opens tabs for that agent. It reads those tabs' pages (text, page structure, screenshots) and makes the clicks and typing the agent asks for. It doesn't read or act on any other tab: not yours, and not another agent's. The one thing it checks is a new tab's first web address, as the tab opens right after an agent's page asked for one, to tell whether that page opened it. It doesn't keep that address or send it anywhere.
- **It stays on your computer.** Page content goes from the extension to the Tabhand helper on your computer, through Chrome's native messaging. The helper hands it to the agent that asked for it.
- **Your agent's own policy applies after that.** What the agent does with the content, such as sending it to its AI provider, is covered by that agent's privacy policy.
- **Files are uploaded only on request.** When an agent asks Tabhand to upload files, Tabhand reads them from your computer and attaches them to the page the agent is working in.

## What Tabhand doesn't do

- Tabhand has no servers. The developer receives none of your data.
- No analytics, tracking or ads. Nothing is sold or shared.
- The helper's log on your computer records only when Chrome and agents connect or disconnect. It never records URLs, page content or anything typed.
- What the extension stores in Chrome is limited to which tabs belong to which agent, and whether you've paused Tabhand, which is cleared when Chrome restarts; and the name you give a Chrome profile, with a random id for it, which stays until you remove the extension.
- The profile's name and id go to the helper on your computer, so your agents can tell your Chrome profiles apart.

## Permissions

| Permission | Why Tabhand needs it |
|---|---|
| `debugger` | To read, click and type in the agent's own tabs while they stay in the background |
| `nativeMessaging` | To talk to the Tabhand helper on your computer, which connects your agents |
| Access to all sites | Your agents can be asked to work on any site |
| `scripting` | To show the agent's cursor and tab icon, and to clear other extensions' pop-ups out of the agent's tabs |
| `tabGroups` | To keep each agent's tabs in a group of their own |
| `storage` | To remember which tabs belong to which agent |
| `alarms` | To check the connection to the helper now and then |
| `identity` and `identity.email` (optional) | Only if you click "Use this profile's Google email" while naming a profile: Chrome asks you first. Tabhand reads the email once to fill in the name, then gives the permission back |

## Contact

Questions or concerns: [open an issue](https://github.com/tabhand/tabhand/issues).
