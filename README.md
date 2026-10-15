# ⨎ Filecoin for Agents

Tools that let AI agents, and the people who run them, store and retrieve data on [Filecoin](https://docs.filecoin.cloud/). The `filecoin` CLI uploads files and folders to a storage provider and returns retrieval URLs. An agent plugin brings its skills to Claude Code, Codex, and other clients. A read-only REST API and MCP server expose providers, data sets, pieces, and payment rails. A web app pairs an explorer for that data with a wallet dashboard for Filecoin Pay.

This is a pnpm and Turborepo monorepo. The CLI publishes to npm, and the apps stay private.

## Packages and apps

| Directory | npm | Contents |
| --- | --- | --- |
| [`packages/filecoin-cli`](packages/filecoin-cli/README.md) | `filecoin` | `filecoin`, a prototype CLI that stores files and folders on one Curio provider and returns retrieval URLs. People and agents both run it. |
| [`apps/filecoin-api`](apps/filecoin-api/README.md) | Private | A Cloudflare Worker that serves a REST API and an MCP server for providers, data sets, pieces, Filecoin Pay rails, and session keys. |
| [`apps/filecoin-app`](apps/filecoin-app/README.md) | Private | A React explorer for filecoin-api data, and a wallet dashboard for Filecoin Pay, Warm Storage approval, data sets, and session keys. |
| [`plugins/filecoin`](plugins/filecoin/README.md) | | The filecoin agent plugin for Claude Code, Codex, and other [Agent Plugins](https://agent-plugins.org) clients. It bundles the agent skills and the MCP server. Its `skills/` directory is the only source of the skills, which `filecoin skills install`, filecoin-app's `/.well-known/agent-skills/`, and `npx skills add filecoin-project/agents` also read. |

## Documentation

| Document | Contents |
| --- | --- |
| [Filecoin for Agents overview](docs/filecoin/README.md) | The CLI, REST API, MCP server, and app, with the assumptions, compromises, open questions, and follow-up work of the proof of concept |
| [CLI architecture](docs/filecoin/architecture.md) | Modules, login, put, get, and delete flows, state, recovery, and verification |
| [CLI interface research](docs/filecoin/interface-research.md) | The historical design research behind the CLI: commands, resources, operations, and local state |

## Build and check

Use Node.js 24 or newer and pnpm 11.24.0, which provisions the configured Node.js 24 runtime. Run commands from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
```

`pnpm check` runs TypeScript, tests, and Biome in every workspace through Turborepo, then lints the root configuration and checks the published agent skills and the plugin manifests. `pnpm check:fix` applies Biome fixes. Each app's README covers its own development commands.

## Contributing and releases

[CONTRIBUTING.md](.github/CONTRIBUTING.md) covers making a change, commit messages, pull requests, and how [release-please](https://github.com/googleapis/release-please) versions and releases the CLI, the two apps, and the plugin.
