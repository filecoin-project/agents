# Agent plugin

The filecoin plugin adds the [agent skill](/agents/skills) and the read-only [MCP server](/agents/mcp) to your agent in one install. The plugin contains no code, because the skill runs the CLI from npm. The CLI needs Node.js 24 or newer.

## Install

Install the plugin with one command, or use your agent's own commands.

<!-- tabs -->

### One command

```sh
npx plugins add filecoin-project/agents
```

### Claude Code

```sh
claude plugin marketplace add filecoin-project/agents
claude plugin install filecoin@filecoin
```

### Codex

```sh
codex plugin marketplace add filecoin-project/agents
codex plugin add filecoin@filecoin
```

<!-- /tabs -->

Start a new session. When you ask the agent to store or share a file on Filecoin, it loads the skill. The first `filecoin login` asks you to [approve the agent's key](/agents#approve-the-agents-key).

If you already added the MCP server on its own, remove it. Otherwise the agent has two copies of its tools.

## Web apps

Web apps load the plugin from the `filecoin-project/agents` repository on GitHub:

- **Claude.** In [**Customize > Plugins**](https://claude.ai/customize/plugins), select **Add > Add marketplace**. Enter `filecoin-project/agents`, then add the filecoin plugin.
- **Cursor.** In [**Customize > Marketplace**](https://cursor.com/customize/marketplace), select **Add marketplace > Import from GitHub**. Enter `https://github.com/filecoin-project/agents`, then add the filecoin plugin.
- **ChatGPT.** A workspace admin can [import the repository as a marketplace](https://learn.chatgpt.com/docs/enterprise/plugin-management). If your workspace has not imported it, add the [MCP server](/agents/mcp).

## Other agents

The plugin follows the [Agent Plugins](https://agent-plugins.org) format. Other agents that support the format can load the plugin from the repository's [`plugins/filecoin`](https://github.com/filecoin-project/agents/tree/main/plugins/filecoin) directory.

In an agent that doesn't support plugins, install the [agent skill](/agents/skills#install) and the [MCP server](/agents/mcp#install) manually.
