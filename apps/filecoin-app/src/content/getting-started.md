# Getting started

`filecoin` stores files and folders on Filecoin and returns links to share. Your agent can run it for you, or you can run it in a terminal. This is a prototype. It runs on the calibration test network unless you choose mainnet.

You need Node.js 24 or newer, and a browser wallet that holds calibration FIL and test USDFC. The [Filecoin docs](https://docs.filecoin.cloud/) list the faucets.

## Set up your agent

Paste this prompt into an agent that has a shell, such as Claude Code, Codex, or Cursor. The agent follows the [agent setup guide](/agents/setup), then sends you a link where you approve its key with your wallet. The agent never holds the wallet key.

<!-- prompt -->

```text
Set up Filecoin for me. Fetch https://poc.filecoin.cloud/agents/setup.md and follow it.
```

<!-- /prompt -->

To install one part yourself, pick it here:

<!-- cards -->

- [Agent plugin](/agents/plugin): Install the agent skill and the MCP server together in Claude Code, Codex, or Cursor.
- [Skills](/agents/skills): Install the agent skill alone in any agent with a shell.
- [MCP](/agents/mcp): Add read-only tools to a chat app or an editor.
- [Markdown and agent discovery](/agents/discovery): Read the docs as Markdown, and find the files that describe the site to agents.

<!-- /cards -->

If yours is a cloud agent, a browser agent, or a chat app, start at [Agents](/agents).

## Use the CLI

1. Install `filecoin`, then log in. `filecoin login` opens a page where you approve a session key with your wallet:

   ```sh
   npm install -g filecoin
   filecoin login
   ```

2. Check the account. If it needs funds, `filecoin status` returns a funding link:

   ```sh
   filecoin status
   ```

3. Store a file. The result's `urls.browser` is the link to share:

   ```sh
   filecoin put ./report.pdf
   ```

4. Download the file with the `res_…` ref that `filecoin put` returned. A new upload is available once the provider indexes it, which can take a few minutes:

   ```sh
   filecoin get res_… --output ./copy.pdf
   ```

[CLI](/docs/cli) explains how `filecoin` works. [Retrieve and verify](/docs/retrieve) explains what each link checks.
