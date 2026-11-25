# Agent setup guide

Follow these steps to set up `filecoin` for your user. `filecoin` stores files and folders on Filecoin and returns links to share. It needs a shell and Node.js 24 or newer. If you have no shell, add the read-only [MCP server](https://poc.filecoin.cloud/agents/mcp.md) instead.

A person owns the wallet and approves what you may do. Never ask for a private key or a seed phrase. Stay on the calibration test network unless the user asks for mainnet. The commands pass `--network calibration`, because the CLI's saved or environment setting can name another network. If the user asks for mainnet, pass `--network mainnet` instead. Add the same flag to every `filecoin` command that you run, including commands from `next` steps.

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

4. Run `npx -y filecoin status --network calibration` and read `data.session.state`:
   - `none`: run `npx -y filecoin login --network calibration`. It returns a `login_pending` error with an approval link. Give the user that link, then stop until they say that they approved it.
   - `pending`: give the user the link in `data.session.url`, then stop until they say that they approved it.
   - `active`: go to step 6. An active key can still lack permissions, which step 6 checks.

5. Run `npx -y filecoin login --check --network calibration` once to confirm the approval. If it returns `permission_denied`, the user approved only some of the permissions. Go to step 6, which checks the ones that storing needs. If it returns any other error, give the user its `next` steps and stop.

6. Run `npx -y filecoin status --network calibration`. You can store files only when both of these checks pass:
   - `data.session.scopes.createDataSet` and `data.session.scopes.addPieces` each hold an expiry date. If either is `expired` or `not granted`, the key cannot store files. Replace the key as the rest of this step describes, and wait for the user.
   - `data.account.ready` is `true`. If it is `false`, give the user the link in `data.account.fundingUrl` and stop. When the user is done, repeat this step.

   To replace a key when `data.session.source` is `env`, ask the user to follow [Cloud agents](https://poc.filecoin.cloud/agents.md#cloud-agents), replace the two environment values, and tell you when they are set. Never ask for the key itself, and tell the user not to paste it into the chat. Then repeat this step.

   To replace a key when `data.session.source` is `config`, request one with the two scopes that storing needs. Request `schedulePieceRemovals` too only if the user wants you to delete pieces:

   ```sh
   npx -y filecoin login --scopes createDataSet --scopes addPieces --network calibration
   ```

   If it returns `login_pending`, give the user the approval link. If it returns `session_conflict`, the saved key still has other permissions. Ask the user whether to replace the key. If they agree, run the command again with `--fresh`, and give the user the approval link. When the user has approved the key, go to step 5.

7. When both checks pass, tell the user that the setup is done, and offer to store a file or a folder. Store only what the user names. Before you store it, check the size and the cost with `npx -y filecoin put <path> --dry-run --network calibration`.

Every command writes one JSON object, with `data` or `error`, then optional `next` steps. Give the user each step that is marked `by: "user"`. `npx -y filecoin --help` lists the commands, and the [CLI](https://poc.filecoin.cloud/docs/cli.md) page explains how they work.
