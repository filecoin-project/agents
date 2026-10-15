# Contributing to Filecoin for Agents

This guide covers how to set up the repository, make a change, open a pull request, and release the packages, apps, and plugin. The [root README](../README.md) describes what each one does.

## Set up

Use Node.js 24 or newer and pnpm 11.24.0, which provisions the configured Node.js 24 runtime. Run commands from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
```

Each app's README covers its own development commands and the `.env` file it reads: [filecoin-api](../apps/filecoin-api/README.md), [filecoin-app](../apps/filecoin-app/README.md), and the [filecoin CLI](../packages/filecoin-cli/README.md). The [plugin README](../plugins/filecoin/README.md) covers the agent skills and `claude plugin validate`.

## Make a change

[AGENTS.md](../AGENTS.md) holds the repository rules for coding agents, and they apply to people too:

- Add a short JSDoc description for every new type, class, function, or method, with links to relevant references.
- Keep [docs/filecoin/README.md](../docs/filecoin/README.md) and [docs/filecoin/architecture.md](../docs/filecoin/architecture.md) current in the same change as the code, including the open questions a change answers and the follow-ups it completes.
- Before changing `apps/filecoin-api` or `apps/filecoin-app` server code, `wrangler.jsonc`, or Cloudflare resources, read the Cloudflare [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) and [Wrangler](https://developers.cloudflare.com/workers/wrangler/) docs. Agents load them as the `workers-best-practices` and `wrangler` skills.
- Edit the published agent skills only in `plugins/filecoin/skills/`. The CLI build, filecoin-app's build, and `npx skills add` all read that directory.

Before you push, run the checks CI runs:

```sh
pnpm check
```

`pnpm check` runs TypeScript, tests, and Biome in every workspace through Turborepo, then lints the root configuration and checks the published agent skills and the plugin manifests. `pnpm check:fix` applies Biome fixes. Also run `pnpm build` when you change package exports or compilation settings.

Never edit a `CHANGELOG.md`, a `version` field, a plugin manifest's `version`, or `.github/release-please-manifest.json` by hand. release-please owns them, as [Release](#release) describes.

## Write commit messages and pull request titles

Use [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<optional scope>): <concise imperative description>`, such as `fix(filecoin-cli): keep a saved session key when filecoin login runs again`.

Pull requests merge by squash or rebase, never by merge commit. A squash merge makes the pull request title the commit message, so the title must follow the same format. A rebase merge keeps each commit, so each of their messages must.

release-please reads these messages to pick each release's version and write its changelog. The type decides both:

| Type | Changelog section | Triggers a release |
| --- | --- | --- |
| `feat` | Features | Yes, a minor version below 1.0.0 |
| `fix` | Bug Fixes | Yes, a patch version |
| `perf` | Performance Improvements | Yes, a patch version |
| `revert` | Reverts | Yes, a patch version |
| `deps` | Dependencies | Yes, a patch version |
| `docs`, `style`, `chore`, `refactor`, `test`, `build`, `ci` | Hidden | No |

- **Breaking changes.** Add `!` after the type or scope, such as `feat(filecoin-cli)!: rename the put command`, and describe the change and the migration in a `BREAKING CHANGE:` footer. The footer text goes into the changelog. Below 1.0.0, a breaking change bumps the minor version. A breaking change triggers a release even with a hidden type.
- **Scope.** Name the component the change affects: `filecoin-cli`, `filecoin-api`, `filecoin-app`, or `filecoin-plugin`. Leave it out when a change spans several. The scope only labels the changelog entry. release-please decides which components a commit releases from the files it changes, not from its scope.
- **Root-only changes.** A commit that touches only files outside `packages/`, `apps/`, and `plugins/`, such as `.github/`, `scripts/`, or `docs/`, releases nothing. A change to `pnpm-lock.yaml` alone releases nothing either.

## Open a pull request

1. Branch from `main` and push your branch.
2. Open a pull request against `main` with a Conventional Commits title. Describe what changed and why, and link any issue it closes.
3. The [CI workflow](workflows/ci.yml) runs `pnpm build` and `pnpm check`.
4. A pull request that changes `apps/filecoin-api` or `apps/filecoin-app` gets a Cloudflare preview deployment, and a comment links to it. Fork pull requests have no access to the Cloudflare secret, so they get no preview. Closing the pull request deletes the preview.
5. After approval, squash-merge the pull request. Pushing to `main` deploys filecoin-api or filecoin-app to production when the merged change touches that app or the root workspace files, such as `pnpm-lock.yaml`.

## Release

[release-please](https://github.com/googleapis/release-please) versions each component from the Conventional Commits on `main`. [`release-please-config.json`](release-please-config.json) lists the components, and [`release-please-manifest.json`](release-please-manifest.json) holds their current versions:

| Component | Directory | Tag | Released to |
| --- | --- | --- | --- |
| `filecoin-cli` | `packages/filecoin-cli` | `filecoin-cli-v<version>` | npm as `filecoin`, and a GitHub release |
| `filecoin-api` | `apps/filecoin-api` | `filecoin-api-v<version>` | A GitHub release |
| `filecoin-app` | `apps/filecoin-app` | `filecoin-app-v<version>` | A GitHub release |
| `filecoin-plugin` | `plugins/filecoin` | `filecoin-plugin-v<version>` | A GitHub release, and the marketplaces serve it from `main` |

### How a release happens

1. On each push to `main`, the [Release workflow](workflows/release.yml) opens or updates one release pull request for each component that a releasable commit touched since its last release. Each pull request bumps that component's version and updates its `CHANGELOG.md`. For the plugin, it also writes the version into `plugin.json` and `.claude-plugin/plugin.json`.
2. `always-update` rebuilds every open release pull request from `main` on each push, even when its changelog is unchanged, so its checks and previews always test the current code.
3. Merging a release pull request tags the release as `<component>-v<version>` and creates its GitHub release. A change that spans components, such as a rename, is released once each of their release pull requests merges.
4. The same workflow then publishes each released npm package with `pnpm publish`, which replaces `workspace:` and `catalog:` specifiers, and adds provenance. The apps are private, so they get a version, a changelog, and a GitHub release, but are never published. Their own workflows deploy them on every push to `main`, not on release.

The first release of each component was 0.1.0, because `initial-version` overrides release-please's default of 1.0.0.

### Ship a release

1. Open the release pull request for the component, titled like `chore(main): release filecoin-cli 0.6.0`.
2. Read the changelog in its diff. Fix any wrong entry at its source, as the next section describes, instead of editing the pull request.
3. Wait for its checks to pass, then squash-merge it.
4. Check that the Release workflow tagged the release, created the GitHub release, and, for the CLI, published the version to [npm](https://www.npmjs.com/package/filecoin).

Leave a release pull request open to batch more changes into that release. Each push to `main` updates it.

### Correct a release

- **Fix a merged commit message.** Edit the description of the merged pull request and add the corrected message between override markers. On the next push to `main`, release-please rebuilds the changelog from it:

  ```text
  BEGIN_COMMIT_OVERRIDE
  fix(filecoin-cli): keep a saved session key when filecoin login runs again
  END_COMMIT_OVERRIDE
  ```

  Put several messages between the markers, one per line, to split one squashed pull request into several changelog entries.

- **Choose a version.** Add a `Release-As: <version>` footer to a commit that touches the component, such as `chore(filecoin-cli): release 1.0.0` with the footer `Release-As: 1.0.0`.

- **Rerun a failed publish.** Rerun the Release workflow. `pnpm publish` skips versions already on npm, so a rerun is safe.

### Add a component

1. Add its directory to `packages` in [`release-please-config.json`](release-please-config.json) with a `component` name, and add `extra-files` for any other file that carries the version.
2. Add its directory and current version to [`release-please-manifest.json`](release-please-manifest.json).
3. For a new npm package, publish it once by hand, then add a trusted publisher for it on npmjs.com, as the next section describes. npm configures a trusted publisher only for a package that exists.

### Publishing credentials

The workflow publishes through [npm trusted publishing](https://docs.npmjs.com/trusted-publishers), so the repository holds no npm token. `filecoin` has a trusted publisher on npmjs.com for the `filecoin-project/agents` repository and the `release.yml` workflow.

The publish job runs in the `npm` GitHub environment, which GitHub creates on the first run. Naming `npm` as the trusted publisher's optional environment limits publishing to that job, and the environment's protection rules can later require a reviewer or the `main` branch.

Pull requests that `GITHUB_TOKEN` opens do not trigger CI. To run CI and previews on release pull requests, set a `RELEASE_PLEASE_TOKEN` secret with a token that can open pull requests.
