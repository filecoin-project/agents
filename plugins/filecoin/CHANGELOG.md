# Changelog

## [0.3.0](https://github.com/filecoin-project/agents/compare/filecoin-plugin-v0.2.0...filecoin-plugin-v0.3.0) (2026-10-20)


### ⚠ BREAKING CHANGES

* **filecoin-cli:** the default `FILECOIN_CONSOLE_URL` is https://pay.filecoin.cloud. New data sets carry `source: 'filecoin-cli'`, so data sets tagged `source: 'filecoin'` are no longer reused and the next `put` creates a new data set.
* **filecoin-plugin:** the plugin's MCP tools are renamed, for example from mcp__plugin_filecoin_filecoin-api__list_providers to mcp__plugin_filecoin_filecoin__list_providers in Claude Code, so permission rules that name the old tools must be updated.

### Features

* **filecoin-cli:** send login, funding, and revoke links to the Filecoin Pay console ([#45](https://github.com/filecoin-project/agents/issues/45)) ([83a330c](https://github.com/filecoin-project/agents/commit/83a330ce34d6fd816976ab79f52afdae26cd3a21))


### Bug Fixes

* **filecoin-plugin:** describe and categorize the plugin in marketplaces, and name the MCP server filecoin ([#46](https://github.com/filecoin-project/agents/issues/46)) ([74e3311](https://github.com/filecoin-project/agents/commit/74e331152eba3ea7bb94540add127a366b28e11b))

## [0.2.0](https://github.com/filecoin-project/agents/compare/filecoin-plugin-v0.1.1...filecoin-plugin-v0.2.0) (2026-10-14)


### ⚠ BREAKING CHANGES

* the npm package is `filecoin` and the command is `filecoin`. Environment variables are `FILECOIN_*` instead of `FIL_*`, the config and state folders are named `filecoin`, so existing users log in again. New data sets carry `source: 'filecoin'` and session keys the `filecoin` origin, so data sets tagged `fil` are no longer reused. The plugin installs as `filecoin@filecoin`, and trace attributes use the `filecoin.` prefix.

### Miscellaneous Chores

* rename fil to filecoin ([#15](https://github.com/filecoin-project/agents/issues/15)) ([29b1720](https://github.com/filecoin-project/agents/commit/29b1720acba53a49ec493398b22884a30511ce30))

## [0.1.1](https://github.com/hugomrdias/fil/compare/fil-plugin-v0.1.0...fil-plugin-v0.1.1) (2026-10-12)


### Bug Fixes

* **fil-cli:** keep a saved session key when fil login runs again ([#70](https://github.com/hugomrdias/fil/issues/70)) ([4a47104](https://github.com/hugomrdias/fil/commit/4a47104f9a94a1f678c1fb1d2b2472f42b62e9b2))

## 0.1.0 (2026-10-08)


### Features

* add the fil agent plugin for Claude Code, Codex, and Agent Plugins clients ([#60](https://github.com/hugomrdias/fil/issues/60)) ([0305871](https://github.com/hugomrdias/fil/commit/0305871530a9639d0bf6d488b19d3c5e69538e89)), closes [#59](https://github.com/hugomrdias/fil/issues/59)


### Bug Fixes

* format plugin manifests the way release-please writes them ([#61](https://github.com/hugomrdias/fil/issues/61)) ([67cc213](https://github.com/hugomrdias/fil/commit/67cc2130106fd481368e0c557666eb5e322dcb6a))
