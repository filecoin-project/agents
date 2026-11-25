# Filecoin for Agents

`filecoin` stores files and folders on [Filecoin](https://docs.filecoin.cloud/) and returns links you can share. People run it in a terminal, and agents run it in a shell. Every command writes one JSON result that an agent can act on.

This is a prototype. It runs on the calibration test network unless you choose mainnet.

## Ways to use it

- **CLI.** `filecoin put ./site` stores a folder and returns a browser link. `filecoin get` downloads and verifies it. See the [CLI docs](/docs/cli).
- **MCP server.** `https://mcp.filecoin.io` gives agents read-only tools for providers, data sets, pieces, payment rails, and session keys. See [MCP](/agents/mcp).
- **Web app.** [filecoin-app](https://poc.filecoin.cloud) is an explorer for that data and a wallet dashboard for funding storage and approving keys. See [Web app](/docs/app).

## How an agent gets access

The agent never holds the wallet key. It gets a session key, which the wallet owner approves in the Filecoin Pay console and which cannot move funds. [Agents](/agents) shows the way in for local agents, cloud agents, browser agents, and chat apps.

## Start

- [Getting started](/docs/getting-started): set up your agent with one prompt, or install the CLI and store a file.
- [Agents](/agents): add `filecoin` to Claude, ChatGPT, or another agent.
- [API](/docs/api): read Filecoin data over HTTP.
- [Source code](https://github.com/filecoin-project/agents) on GitHub.
