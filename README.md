# ⨎ Filecoin for Agents

Tools that let AI agents, and the people who run them, store and retrieve data on [Filecoin](https://docs.filecoin.cloud/). The `filecoin` CLI uploads files and folders to a storage provider and returns retrieval URLs. An agent plugin brings its skills to Claude Code, Codex, and other clients. A read-only REST API and MCP server expose providers, data sets, pieces, and payment rails. A web app pairs an explorer for that data with a wallet dashboard for Filecoin Pay.

This is a pnpm and Turborepo monorepo. The CLI and the API client publish to npm, the plugin installs from this repository, and the apps stay private.

## Packages

Packages under `packages/` publish to npm.

| Directory | npm | Contents |
| --- | --- | --- |
| [`packages/filecoin-cli`](packages/filecoin-cli/README.md) | [`filecoin`](https://www.npmjs.com/package/filecoin) | `filecoin`, a CLI that stores files and folders on Filecoin and returns retrieval URLs. People and agents both run it. |
| [`packages/filecoin-api-client`](packages/filecoin-api-client/README.md) | [`@filecoin-project/api-client`](https://www.npmjs.com/package/@filecoin-project/api-client) | A typed filecoin-api client generated from the API's OpenAPI document. |

## Apps

Apps under `apps/` are private Cloudflare Workers.

| Directory | Hosts | Contents |
| --- | --- | --- |
| [`apps/filecoin-api`](apps/filecoin-api/README.md) | `api.filecoin.io`, `mcp.filecoin.io` | A REST API and an MCP server for providers, data sets, pieces, Filecoin Pay rails, and session keys. |
| [`apps/filecoin-app`](apps/filecoin-app/README.md) | `poc.filecoin.cloud` | A proof-of-concept web app built on the other components here. It reads filecoin-api through the API client, serves the plugin's agent skills, and documents the CLI. |

[Deployments and domains](docs/filecoin/deployments.md) shows how the apps and their domains relate, and lists every hostname, including the `filecoin.cloud` ones kept for older links.

## Plugins

Each plugin under `plugins/` carries two manifests: `plugin.json` in the [Agent Plugins](https://agent-plugins.org) format, which Codex and other clients read, and `.claude-plugin/plugin.json` in the [Claude Code plugin](https://code.claude.com/docs/en/plugins) format. The repository root is their marketplace for both, through [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) for Claude Code and [`.agents/plugins/marketplace.json`](.agents/plugins/marketplace.json) for Codex.

| Directory | Contents |
| --- | --- |
| [`plugins/filecoin`](plugins/filecoin/README.md) | The filecoin agent plugin. It bundles the agent skills and connects filecoin-api's MCP server. |

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

## Skills

The agent skills live in [`plugins/filecoin/skills`](plugins/filecoin/skills). That directory is their only source, and every install path reads it.

| Skill | Contents |
| --- | --- |
| [`filecoin`](plugins/filecoin/skills/filecoin/SKILL.md) | Store files and folders on Filecoin with the `filecoin` CLI, share links to them, and retrieve and verify them later. |

Install the skills without the plugin in any of these ways:

| Command or URL | Source |
| --- | --- |
| `npx skills add filecoin-project/agents` | This repository, through the plugin's entry in [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) |
| `filecoin skills install` | The copy bundled with the CLI at build time |
| `/.well-known/agent-skills/` on filecoin-app | The [agent skills discovery](https://github.com/cloudflare/agent-skills-discovery-rfc) index that filecoin-app publishes |

A new skill must also be listed in the marketplace entry's `skills`; `pnpm check:plugin` fails until it is.

## Documentation

| Document | Contents |
| --- | --- |
| [Filecoin for Agents overview](docs/filecoin/README.md) | The CLI, REST API, MCP server, and app, with the assumptions, compromises, open questions, and follow-up work of the proof of concept |
| [CLI architecture](docs/filecoin/architecture.md) | Modules, login, put, get, and delete flows, state, recovery, and verification |
| [Deployments and domains](docs/filecoin/deployments.md) | Where filecoin-api and filecoin-app run, and the hostnames that serve them |
| [Agent support on docs.filecoin.io](docs/filecoin/filecoin-docs-agent-support.md) | Research for the Filecoin docs team on what docs.filecoin.io gives agents |

## Build and check

Use Node.js 24 or newer and pnpm 12.14.0, which provisions the configured Node.js 24 runtime. Run commands from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
```

`pnpm check` runs TypeScript, tests, and Biome in every workspace through Turborepo, then lints the root configuration and checks the published agent skills and the plugin manifests. `pnpm check:fix` applies Biome fixes. Each package's and app's README covers its own development commands.

## Contributing and releases

[CONTRIBUTING.md](.github/CONTRIBUTING.md) covers making a change, commit messages, pull requests, and how [release-please](https://github.com/googleapis/release-please) versions and releases the CLI, the two apps, and the plugin.
