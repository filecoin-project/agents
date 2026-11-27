# Agents

Pick the way in that matches what your agent can do. In every case, a person owns the wallet and approves what the agent may do. The agent never holds the wallet key.

| Agent                                                   | What it can do                                               | Way in                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Local agent, such as Claude Code, Codex, or Cursor      | Run a shell, keep files, and open pages for you              | [Agent plugin](/agents/plugin), or the CLI and the [agent skill](/agents/skills) |
| Cloud agent, such as a coding agent in a hosted sandbox | Run a shell, but its files are gone when the session ends    | [CLI with a key from secrets](#cloud-agents)                                     |
| Browser agent                                           | Read and use web pages in the browser that holds your wallet | [filecoin-app's WebMCP tools](#browser-agents)                                   |
| Chat app with connectors, such as Claude or ChatGPT     | Call remote tools                                            | [MCP server](/agents/mcp), read-only                                             |

To set up a local agent, paste the prompt from [Set up your agent](/docs/getting-started#set-up-your-agent). [Retrieve and verify](/docs/retrieve) compares what each way can store, retrieve, and check.

<!-- cards -->

- [Agent plugin](/agents/plugin): Install the agent skill and the MCP server together in Claude Code, Codex, or Cursor.
- [Skills](/agents/skills): Install the agent skill alone in any agent with a shell.
- [MCP](/agents/mcp): Add read-only tools to a chat app or an editor.
- [Markdown and agent discovery](/agents/discovery): Read the docs as Markdown, and find the files that describe the site to agents.

<!-- /cards -->

## Cloud agents

A cloud agent has a shell, so it uses the same skill and CLI as a local agent. It has no browser to open for you, and its disk is gone when the session ends. `filecoin login` saves the session key on that disk, so each session would ask you to approve a new key.

Give the agent a key that outlives the session instead:

1. On the Filecoin Pay console's [session keys page](https://pay.filecoin.cloud/console/session-keys), select **New session key** and authorize the key with your wallet. Use the network that the agent will use. The console shows the key once, as `SESSION_KEY` and `WALLET_ADDRESS`.
2. In the agent's environment settings, add the `SESSION_KEY` value as the secret `FILECOIN_SESSION_KEY`, and the `WALLET_ADDRESS` value as `FILECOIN_ROOT_ADDRESS`. Both must be environment variables that the agent's commands can read. A secret that only the setup script sees, or that the agent sees as a placeholder, doesn't work.

The agent then skips `filecoin login`. To confirm that the key works, it runs `filecoin status`. The key expires, and it cannot move funds. Revoke it on the same page to stop the agent. Never paste the key into a chat.

`filecoin ls` lists the wallet's pieces from filecoin-api, so a new session sees what earlier ones stored. Refs and `filecoin operations` are in a local database that a new session does not have. [Find stored content](/docs/retrieve#find-stored-content) shows how to get content back without a ref.

## Browser agents

filecoin-app registers [WebMCP](https://webmachinelearning.github.io/webmcp/) tools. A browser agent can prepare a setup request without building a URL, and read the account, its data sets and pieces, and its session keys. The tools never sign anything. [Web app](/docs/app#webmcp-tools) lists them. WebMCP is an early preview that works in Chrome 149 and later. In other browsers, the agent opens a [setup link](/docs/app#setup-links).

A browser agent cannot run the CLI. To store files while the agent watches, use the dashboard's [upload page](/dashboard/upload). A folder's browser link checks each block in the browser.

## Approve the agent's key

The agent never holds the wallet key. It gets a session key instead, and the wallet owner approves it:

1. The agent runs `filecoin login`. It gets a `login_pending` error with an approval link, and gives you the link.
2. You open the link, connect your wallet, and review the request on the [Filecoin Pay console](https://pay.filecoin.cloud/console)'s setup page. With your wallet, approve each step that the page lists: the session key, the Warm Storage approval, and a deposit.
3. The agent runs `filecoin login --check` to confirm the approval, then `filecoin put`. `--check` never makes a new key, so it can't replace the one you approved.

When the account needs funds or the Warm Storage approval, `filecoin put` returns `insufficient_funds` with a prefilled funding link for you. `filecoin status` returns a funding link in `account.fundingUrl`. To stop the agent, revoke its key on the console's [session keys page](https://pay.filecoin.cloud/console/session-keys). `filecoin logout` returns a link that opens the revocation for its key.
