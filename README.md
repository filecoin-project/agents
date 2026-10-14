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

## Release

[release-please](https://github.com/googleapis/release-please) versions the CLI, the two apps, and the plugin from [Conventional Commits](https://www.conventionalcommits.org/). [`.github/release-please-config.json`](.github/release-please-config.json) lists them, and [`.github/.release-please-manifest.json`](.github/.release-please-manifest.json) holds their current versions.

1. On each push to `main`, the [Release workflow](.github/workflows/release.yml) opens or updates one release pull request. It bumps the version and updates `CHANGELOG.md` of every package, app, or plugin that a commit touched since its last release. The first release of each was 0.1.0, because `initial-version` overrides release-please's default of 1.0.0. Below 1.0.0, `feat` bumps the minor version and `fix` the patch version.
2. Merging the release pull request tags each release as `<component>-v<version>`, such as `filecoin-cli-v0.1.0`, and creates its GitHub release.
3. The same workflow then publishes each released package with `pnpm publish`, which replaces `workspace:` and `catalog:` specifiers, and adds provenance. The apps get a version, a changelog, and a GitHub release, but are never published. Their own workflows deploy them. The plugin's version goes into both of its manifests, and the marketplaces serve it from `main`.

The workflow publishes through [npm trusted publishing](https://docs.npmjs.com/trusted-publishers), so the repository holds no npm token. `filecoin` has a trusted publisher on npmjs.com for the `filecoin-project/agents` repository and the `release.yml` workflow. The publish job runs in the `npm` GitHub environment, which GitHub creates on the first run. Naming `npm` as the trusted publisher's optional environment limits publishing to that job, and the environment's protection rules can later require a reviewer or the `main` branch. npm configures it only for a package that exists, so publish each package once by hand before its first release. Pull requests that `GITHUB_TOKEN` opens do not trigger CI, so set a `RELEASE_PLEASE_TOKEN` secret with a token that can open pull requests to run CI on the release pull request.
