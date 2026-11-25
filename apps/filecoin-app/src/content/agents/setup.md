# Agent setup guide

Follow these steps to set up `filecoin` for your user. `filecoin` stores files and folders on Filecoin and returns links to share. It needs a shell and Node.js. If you have no shell, add the read-only [MCP server](https://poc.filecoin.cloud/agents/mcp.md) instead.

A person owns the wallet and approves what you may do. Never ask for a private key or a seed phrase. Stay on the calibration test network unless the user asks for mainnet.

1. Run `node --version`. If Node.js is missing, tell the user and stop. If it is older than 24, install the current LTS version and continue.

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

3. If your disk is gone when the session ends, such as in a cloud sandbox, follow [Cloud agents](https://poc.filecoin.cloud/agents.md#cloud-agents), then go to step 4. Otherwise, run `npx -y filecoin login`. If it returns an approval link, give the user the link and stop until they say that they approved it. Then run `npx -y filecoin login --check`.

4. Run `npx -y filecoin status`. If a scope is `expired` or `not granted`, or `account.ready` is `false`, tell the user. If the output has `account.fundingUrl`, give the user that link.

5. When `createDataSet` and `addPieces` have an expiry date and `account.ready` is `true`, tell the user that the setup is done. Offer to store a file or a folder. Store only what the user names. Before you store it, check the size and the cost with `npx -y filecoin put <path> --dry-run`.

Every command writes one JSON object, with `data` or `error`, then optional `next` steps. Give the user each step that is marked `by: "user"`. `npx -y filecoin --help` lists the commands, and the [CLI](https://poc.filecoin.cloud/docs/cli.md) page explains how they work.
