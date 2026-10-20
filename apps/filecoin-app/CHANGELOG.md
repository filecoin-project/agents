# Changelog

## [0.7.0](https://github.com/filecoin-project/agents/compare/filecoin-app-v0.6.0...filecoin-app-v0.7.0) (2026-10-20)


### ⚠ BREAKING CHANGES

* **filecoin-cli:** `filecoin publish` and `filecoin rm` are removed. Use `filecoin put` and `filecoin delete` instead.
* **filecoin-cli:** the default `FILECOIN_CONSOLE_URL` is https://pay.filecoin.cloud. New data sets carry `source: 'filecoin-cli'`, so data sets tagged `source: 'filecoin'` are no longer reused and the next `put` creates a new data set.
* **filecoin-plugin:** the plugin's MCP tools are renamed, for example from mcp__plugin_filecoin_filecoin-api__list_providers to mcp__plugin_filecoin_filecoin__list_providers in Claude Code, so permission rules that name the old tools must be updated.

### Features

* **filecoin-app:** port the console's setup page steps to /dashboard/setup ([#51](https://github.com/filecoin-project/agents/issues/51)) ([0c26dfc](https://github.com/filecoin-project/agents/commit/0c26dfc174ce2c5cb0a6a6b96d399016beea7f2c))
* **filecoin-cli:** send login, funding, and revoke links to the Filecoin Pay console ([#45](https://github.com/filecoin-project/agents/issues/45)) ([83a330c](https://github.com/filecoin-project/agents/commit/83a330ce34d6fd816976ab79f52afdae26cd3a21))
* **filecoin-cli:** tag console links for the console's analytics ([#53](https://github.com/filecoin-project/agents/issues/53)) ([2442eae](https://github.com/filecoin-project/agents/commit/2442eae2d8c4fd3546266998f90cf88f2a9afd3a))
* **filecoin-cli:** upgrade to clipact 0.7, with globals, its folder, and its store ([#54](https://github.com/filecoin-project/agents/issues/54)) ([f53f53d](https://github.com/filecoin-project/agents/commit/f53f53d01fc90a5dc3a6464363eee64f8edcbff6))


### Bug Fixes

* **filecoin-app:** fetch filecoin-api from its Custom Domain so detail pages render ([#55](https://github.com/filecoin-project/agents/issues/55)) ([86138d3](https://github.com/filecoin-project/agents/commit/86138d33e2cbfcea720922a84f5e2541b0b93c39))
* **filecoin-plugin:** describe and categorize the plugin in marketplaces, and name the MCP server filecoin ([#46](https://github.com/filecoin-project/agents/issues/46)) ([74e3311](https://github.com/filecoin-project/agents/commit/74e331152eba3ea7bb94540add127a366b28e11b))

## [0.6.0](https://github.com/filecoin-project/agents/compare/filecoin-app-v0.5.1...filecoin-app-v0.6.0) (2026-10-16)


### Features

* **filecoin-api:** add search_docs MCP tool backed by GitBook docs search ([#38](https://github.com/filecoin-project/agents/issues/38)) ([8796467](https://github.com/filecoin-project/agents/commit/87964676a3e9d4543178159300c886934fb45403))
* **filecoin-app:** use synapse-react 0.5.1 for data sets and uploads ([#42](https://github.com/filecoin-project/agents/issues/42)) ([baafad0](https://github.com/filecoin-project/agents/commit/baafad0cdb1ef55ceb2d209a19d57895eaafcc98))


### Bug Fixes

* **filecoin-app:** bill session key data sets to the root wallet ([#36](https://github.com/filecoin-project/agents/issues/36)) ([19a314f](https://github.com/filecoin-project/agents/commit/19a314f0d1cbfabb01a33a198f7a5aacf19534a3))


### Performance Improvements

* update filecoin-cli and filecoin-api to synapse-core 0.10.2 ([#43](https://github.com/filecoin-project/agents/issues/43)) ([041a490](https://github.com/filecoin-project/agents/commit/041a4909a66e3487c6aefbd41f1e0bd802516873))

## [0.5.1](https://github.com/filecoin-project/agents/compare/filecoin-app-v0.5.0...filecoin-app-v0.5.1) (2026-10-15)


### Bug Fixes

* **filecoin-app:** cache the Wrangler deploy redirect with the build ([c95ec9b](https://github.com/filecoin-project/agents/commit/c95ec9b5b646320f438aaf8f0b7058b82a489764))

## [0.5.0](https://github.com/filecoin-project/agents/compare/filecoin-app-v0.4.0...filecoin-app-v0.5.0) (2026-10-14)


### ⚠ BREAKING CHANGES

* the npm package is `filecoin` and the command is `filecoin`. Environment variables are `FILECOIN_*` instead of `FIL_*`, the config and state folders are named `filecoin`, so existing users log in again. New data sets carry `source: 'filecoin'` and session keys the `filecoin` origin, so data sets tagged `fil` are no longer reused. The plugin installs as `filecoin@filecoin`, and trace attributes use the `filecoin.` prefix.

### Bug Fixes

* **filecoin-app:** rebuild when .env changes ([#17](https://github.com/filecoin-project/agents/issues/17)) ([35999f2](https://github.com/filecoin-project/agents/commit/35999f2d078bf3cf2e28fa9af252f2c479cf8feb))


### Miscellaneous Chores

* rename fil to filecoin ([#15](https://github.com/filecoin-project/agents/issues/15)) ([29b1720](https://github.com/filecoin-project/agents/commit/29b1720acba53a49ec493398b22884a30511ce30))

## [0.4.0](https://github.com/hugomrdias/fil/compare/fil-app-v0.3.0...fil-app-v0.4.0) (2026-10-12)


### Features

* **fil-app:** add an agent quickstart with tabbed install commands ([#73](https://github.com/hugomrdias/fil/issues/73)) ([c7c033c](https://github.com/hugomrdias/fil/commit/c7c033cee4edc8af4706be5e40ee4ad07584250d))

## [0.3.0](https://github.com/hugomrdias/fil/compare/fil-app-v0.2.0...fil-app-v0.3.0) (2026-10-12)


### Features

* early retrieval links during put, with a provider hint in fil-api ([#65](https://github.com/hugomrdias/fil/issues/65)) ([023073b](https://github.com/hugomrdias/fil/commit/023073b23dd9b8f5b4ba94f55768f89e91b28520))


### Bug Fixes

* **fil-cli:** cancel provider requests on interrupt with synapse-core 0.10.1 ([#68](https://github.com/hugomrdias/fil/issues/68)) ([c5f7e4b](https://github.com/hugomrdias/fil/commit/c5f7e4b059532b60ffaf68c5483ae841ed462f3d))
* **fil-cli:** keep a saved session key when fil login runs again ([#70](https://github.com/hugomrdias/fil/issues/70)) ([4a47104](https://github.com/hugomrdias/fil/commit/4a47104f9a94a1f678c1fb1d2b2472f42b62e9b2))

## [0.2.0](https://github.com/hugomrdias/fil/compare/fil-app-v0.1.0...fil-app-v0.2.0) (2026-10-08)


### Features

* add the fil agent plugin for Claude Code, Codex, and Agent Plugins clients ([#60](https://github.com/hugomrdias/fil/issues/60)) ([0305871](https://github.com/hugomrdias/fil/commit/0305871530a9639d0bf6d488b19d3c5e69538e89)), closes [#59](https://github.com/hugomrdias/fil/issues/59)
* **fil-app:** rename the Agent setup page to Agents ([#57](https://github.com/hugomrdias/fil/issues/57)) ([b7b3edf](https://github.com/hugomrdias/fil/commit/b7b3edfbeee2f48ada5da92863a71f339eae3c14))
* **fil-app:** rename the API docs page to API and MCP ([#62](https://github.com/hugomrdias/fil/issues/62)) ([896b758](https://github.com/hugomrdias/fil/commit/896b75863010cf411521b143c8b274dd4c6632e9))

## 0.1.0 (2026-10-08)


### Features

* approve fil login keys and funding on a fil-app setup page ([#35](https://github.com/hugomrdias/fil/issues/35)) ([4422657](https://github.com/hugomrdias/fil/commit/442265799a2f36b2861824c286ce722e09a3348d))
* **fil-app:** add explorer and wallet dashboard SPA ([#15](https://github.com/hugomrdias/fil/issues/15)) ([58af6e4](https://github.com/hugomrdias/fil/commit/58af6e4f5669eed3cd0a998de7635b45d715714e))
* **fil-app:** add read-only WebMCP tools for the account and storage ([#38](https://github.com/hugomrdias/fil/issues/38)) ([46c55bd](https://github.com/hugomrdias/fil/commit/46c55bdb5175a92d4e4e12617ecd91c318f0da50)), closes [#34](https://github.com/hugomrdias/fil/issues/34)
* **fil-app:** add the website, docs, and agent setup pages ([#43](https://github.com/hugomrdias/fil/issues/43)) ([7bd4f4f](https://github.com/hugomrdias/fil/commit/7bd4f4f6caf43bf0072385a131e5346d432a34d7))
* **fil-app:** improve the is-agentic.com score and say "Filecoin" in prose ([#45](https://github.com/hugomrdias/fil/issues/45)) ([17a7330](https://github.com/hugomrdias/fil/commit/17a7330f23e282c8b353c8138b9a409acc754ae0))
* **fil-app:** open pieces through fil-api's /get/{cid} retrieval route ([#23](https://github.com/hugomrdias/fil/issues/23)) ([26c83ca](https://github.com/hugomrdias/fil/commit/26c83caf4715d5a1755980622114f2b84070d30b))
* **fil-app:** render the app with TanStack Start on Workers ([#42](https://github.com/hugomrdias/fil/issues/42)) ([3600a45](https://github.com/hugomrdias/fil/commit/3600a459ac7b2c6f2be8bfe33e430037bb23d27f))
* **fil-app:** summarize the project in llms.txt and list the overview ([#44](https://github.com/hugomrdias/fil/issues/44)) ([af4c54c](https://github.com/hugomrdias/fil/commit/af4c54c977de650aae74f5011e3c1e93bd232880))
* give each kind of agent one way in to fil, with progressive discovery ([#53](https://github.com/hugomrdias/fil/issues/53)) ([0f1fb2b](https://github.com/hugomrdias/fil/commit/0f1fb2b75dac91751e05b67a0d2ec8effb553438))
* publish agent skills from one root skills directory ([#52](https://github.com/hugomrdias/fil/issues/52)) ([8bbe993](https://github.com/hugomrdias/fil/commit/8bbe99326d68afb56a25f1ce93b559d261c2054d))
* version packages and release them to npm with release-please ([#54](https://github.com/hugomrdias/fil/issues/54)) ([4bb7dce](https://github.com/hugomrdias/fil/commit/4bb7dce5c592efd11d6cc4036547215267afc7a3))


### Bug Fixes

* **fil-app:** offer get_setup_status before the wallet connects ([#36](https://github.com/hugomrdias/fil/issues/36)) ([5b8b254](https://github.com/hugomrdias/fil/commit/5b8b254001727ec3b7f43aa0218e71872bdc08e6)), closes [#34](https://github.com/hugomrdias/fil/issues/34)
* **fil-app:** polish responsive layouts and guard oversized expiries ([#16](https://github.com/hugomrdias/fil/issues/16)) ([09d6dd7](https://github.com/hugomrdias/fil/commit/09d6dd77375f0a6412c03da5839c96a8bdba2f05))
* **fil-app:** spell the ID pattern with [0-9] so agents read it correctly ([#39](https://github.com/hugomrdias/fil/issues/39)) ([b2e8664](https://github.com/hugomrdias/fil/commit/b2e866459698f32be9d2327caf1967d7a486012a)), closes [#34](https://github.com/hugomrdias/fil/issues/34)
* **fil-app:** vertically center select item content ([#17](https://github.com/hugomrdias/fil/issues/17)) ([be1e3fe](https://github.com/hugomrdias/fil/commit/be1e3fe3148d09810035e92bb6dc3c4db2a1f10a))
* report indexer lag against the chain head and serve fresh fil-api reads ([#48](https://github.com/hugomrdias/fil/issues/48)) ([4636540](https://github.com/hugomrdias/fil/commit/4636540f7db1af09fc090884acd27e0ff762a69d))
* validate PieceCID v2 in fil-api's piece filter and the explorer search ([#40](https://github.com/hugomrdias/fil/issues/40)) ([7df40c6](https://github.com/hugomrdias/fil/commit/7df40c6621085cf8a89aa36629c83c509d9ab495)), closes [#37](https://github.com/hugomrdias/fil/issues/37)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @hugomrdias/vite-plugin-agent-skills bumped to 0.1.0
