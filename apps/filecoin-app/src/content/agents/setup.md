# Agent setup guide

Follow these steps to set up `filecoin` for your user. `filecoin` stores files and folders on Filecoin and returns links to share. It needs a shell and Node.js 24 or newer. If you have no shell, add the read-only [MCP server](https://poc.filecoin.cloud/agents/mcp.md) instead.

A person owns the wallet and approves what you may do. Never ask for a private key or a seed phrase. Stay on the calibration test network unless the user asks for mainnet.

1. Run `node --version`. If Node.js is missing or older than 24, tell the user and stop.

2. Tell the user what you are about to install, then install it for your agent.

   If your agent is in this table, install the [agent plugin](https://poc.filecoin.cloud/agents/plugin.md):

   | Agent              | Target           |
   | ------------------ | ---------------- |
   | Claude Code        | `claude-code`    |
   | Codex              | `codex`          |
   | Cursor             | `cursor`         |
   | GitHub Copilot CLI | `github-copilot` |
   | Grok Build         | `grok`           |
   | Kimi Code          | `kimi`           |
   | Visual Studio Code | `vscode`         |

   Replace `<target>` with your agent's target:

   ```sh
   DO_NOT_TRACK=1 npx -y plugins add filecoin-project/agents --target <target> --yes
   ```

   In any other agent, or if the command fails, install the agent skill into the project:

   ```sh
   npx -y skills add filecoin-project/agents -y
   ```

   Then add the read-only MCP server. Replace `<agent>` with your agent's name from `npx -y add-mcp list-agents`:

   ```sh
   npx -y add-mcp https://mcp.filecoin.io -g -y -a <agent>
   ```

   If your agent is not listed, or the command fails, add `https://mcp.filecoin.io` to the agent's MCP settings as a Streamable HTTP server. If you can't, give the user the URL.

   The agent loads what you installed in its next session. To finish the setup in this session, follow the rest of this guide.

3. If your disk is gone when the session ends, such as in a cloud sandbox, do not log in. Follow [Cloud agents](https://poc.filecoin.cloud/agents.md#cloud-agents) instead of steps 4 and 5.

4. Run `npx -y filecoin status` and read `data.session.state`:
   - `none`: run `npx -y filecoin login`. It returns a `login_pending` error with an approval link. Give the user that link, then stop until they say that they approved it.
   - `pending`: give the user the link in `data.session.url`, then stop until they say that they approved it.
   - `active`: go to step 6.

5. Run `npx -y filecoin login --check` once to confirm the approval.

6. Run `npx -y filecoin status`. If it returns `data.account.fundingUrl`, give the user that link.

7. Tell the user that the setup is done, and offer to store a file or a folder. Store only what the user names. Before you store it, check the size and the cost with `npx -y filecoin put <path> --dry-run`.

Every command writes one JSON object, with `data` or `error`, then optional `next` steps. Give the user each step that is marked `by: "user"`. `npx -y filecoin --help` lists the commands, and the [CLI](https://poc.filecoin.cloud/docs/cli.md) page explains how they work.
