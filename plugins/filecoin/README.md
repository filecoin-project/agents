# filecoin plugin

The filecoin plugin adds `filecoin` to an agent in one install. It bundles the [agent skill](skills/filecoin/SKILL.md), which teaches the agent to store, share, retrieve, and verify content with the `filecoin` CLI, and connects filecoin-api's read-only [MCP server](../../apps/filecoin-api/README.md). The skill runs the CLI from npm, so the plugin carries no code.

The plugin follows the [Agent Plugins](https://agent-plugins.org/specification) 1.0.0 format and also carries a Claude Code manifest. Every client reads the same `skills/` directory:

| File                                                       | Contents                                                                                                                                                                                                             | Read by                                |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| [`plugin.json`](plugin.json)                               | The portable manifest. `extensions.com.openai` holds the Codex and ChatGPT listing.                                                                                                                                  | Agent Plugins clients, such as Codex   |
| [`mcp.json`](mcp.json)                                     | filecoin-api's MCP server, over Streamable HTTP                                                                                                                                                                      | Agent Plugins clients                  |
| [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) | The same metadata and MCP server in Claude Code's format, which names the transport `http`, with the Codex listing's `displayName` and the documentation, support, and policy links for Anthropic's plugin directory | Claude Code                            |
| [`assets/logo.png`](assets/logo.png)                       | The Filecoin logo, rendered from filecoin-app's favicon                                                                                                                                                              | Codex and Anthropic's plugin directory |
| [`skills/`](skills)                                        | The agent skills. This is their only source: the filecoin-cli build copies them for `filecoin skills install`, and filecoin-app publishes them under `/.well-known/agent-skills/`.                                   | Every client                           |

The repository root is the marketplace for both clients. [`.claude-plugin/marketplace.json`](../../.claude-plugin/marketplace.json) lists the plugin for Claude Code, with the manifest's description and keywords so that `/plugin` shows it before install; `pnpm check:plugin` fails when the two differ. `npx skills add filecoin-project/agents` finds the skills through the entry's `skills` list, so a new skill must be added there too; `pnpm check:plugin` fails until it is. [`.agents/plugins/marketplace.json`](../../.agents/plugins/marketplace.json) lists it for Codex.

## Install

Vercel's [`plugins`](https://github.com/vercel-labs/plugins) installer finds the agents on the machine and installs the plugin in each one:

```sh
npx plugins add filecoin-project/agents
```

`--target claude-code`, `--target codex`, or `--target cursor` picks one agent, and `--yes` skips the prompt, which a run without a terminal needs. The installer sends anonymous install telemetry to Vercel unless `DO_NOT_TRACK=1` is set. It turns on auto-updates when it adds the marketplace to Claude Code.

Each client can also add this repository as a marketplace from GitHub, then install the plugin from it.

In Claude Code:

```sh
claude plugin marketplace add filecoin-project/agents
claude plugin install filecoin@filecoin
```

In Codex:

```sh
codex plugin marketplace add filecoin-project/agents
codex plugin add filecoin@filecoin
```

The MCP server needs no sign-in. Ask the agent to store or share a file on Filecoin, and it loads the skill. In Claude Code, `/filecoin:filecoin` also invokes it. If you added filecoin-api as a standalone MCP server before, remove it, so the agent has one copy of its tools.

Another Agent Plugins client loads the `plugins/filecoin` directory as it is.

Web apps load the plugin from this repository as a marketplace. In Claude, use **Add > Add marketplace** in [**Customize > Plugins**](https://claude.com/docs/plugins/overview). In Cursor, use **Add marketplace > Import from GitHub** in [**Customize > Marketplace**](https://cursor.com/customize/marketplace). In ChatGPT, a workspace admin can [import it](https://learn.chatgpt.com/docs/enterprise/plugin-management). Otherwise, add `https://mcp.filecoin.io` as a custom connector, which gives the MCP tools without the skill.

## Versions

release-please releases the plugin as the `filecoin-plugin` component and writes each version into both manifests. Claude Code keeps an installed plugin at its version until the version changes, so a change to the skill reaches its users with the next release, not with each commit. `pnpm check:plugin` fails when the two manifests disagree.

## Develop

From the repository root, check the manifests with each client's rules:

```sh
pnpm check:plugin
claude plugin validate ./plugins/filecoin
claude plugin validate .
```

Load the plugin in Claude Code without installing it:

```sh
claude --plugin-dir ./plugins/filecoin
```

Install it in Codex from the checkout, and start a new session after each change:

```sh
codex plugin marketplace add .
codex plugin add filecoin@filecoin
```

On 2026-10-08, Claude Code 2.1.289 and the Codex CLI 0.161.0 installed the plugin from a local checkout, listed the `filecoin` skill and the 13 filecoin-api tools, and called `get_status` on calibration. The desktop apps are not verified yet.

On 2026-11-25, `plugins` 1.3.9 installed the plugin from GitHub in Claude Code and Codex, each with its MCP server. The plugin also works in Cursor, with its MCP server. The installer sets Cursor up through `~/.claude/plugins`. The installer reported success for VS Code, but nobody has checked that VS Code loads the plugin. It looks for MCP servers in `.mcp.json`, and this plugin has `mcp.json`.
