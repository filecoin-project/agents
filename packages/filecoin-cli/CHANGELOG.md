# Changelog

## [0.5.2](https://github.com/filecoin-project/agents/compare/filecoin-cli-v0.5.1...filecoin-cli-v0.5.2) (2026-10-16)


### Performance Improvements

* update filecoin-cli and filecoin-api to synapse-core 0.10.2 ([#43](https://github.com/filecoin-project/agents/issues/43)) ([041a490](https://github.com/filecoin-project/agents/commit/041a4909a66e3487c6aefbd41f1e0bd802516873))

## [0.5.1](https://github.com/filecoin-project/agents/compare/filecoin-cli-v0.5.0...filecoin-cli-v0.5.1) (2026-10-15)


### Bug Fixes

* **filecoin-cli:** patch protons-runtime uint64 encoding for 2–4 GiB files ([842fcd1](https://github.com/filecoin-project/agents/commit/842fcd1abf0223961a888ed991addd3ab9bcfd6a))

## [0.5.0](https://github.com/filecoin-project/agents/compare/filecoin-cli-v0.4.0...filecoin-cli-v0.5.0) (2026-10-14)


### ⚠ BREAKING CHANGES

* the npm package is `filecoin` and the command is `filecoin`. Environment variables are `FILECOIN_*` instead of `FIL_*`, the config and state folders are named `filecoin`, so existing users log in again. New data sets carry `source: 'filecoin'` and session keys the `filecoin` origin, so data sets tagged `fil` are no longer reused. The plugin installs as `filecoin@filecoin`, and trace attributes use the `filecoin.` prefix.

### Miscellaneous Chores

* rename fil to filecoin ([#15](https://github.com/filecoin-project/agents/issues/15)) ([29b1720](https://github.com/filecoin-project/agents/commit/29b1720acba53a49ec493398b22884a30511ce30))

## [0.4.0](https://github.com/hugomrdias/fil/compare/fil-cli-v0.3.0...fil-cli-v0.4.0) (2026-10-12)


### Features

* progress heartbeat in clipact, and transaction hashes while fil waits ([#71](https://github.com/hugomrdias/fil/issues/71)) ([f9d538a](https://github.com/hugomrdias/fil/commit/f9d538a910c62e53e451dce0cd7de2a9a2e48037))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * clipact bumped to 0.4.0

## [0.3.0](https://github.com/hugomrdias/fil/compare/fil-cli-v0.2.1...fil-cli-v0.3.0) (2026-10-12)


### Features

* early retrieval links during put, with a provider hint in fil-api ([#65](https://github.com/hugomrdias/fil/issues/65)) ([023073b](https://github.com/hugomrdias/fil/commit/023073b23dd9b8f5b4ba94f55768f89e91b28520))


### Bug Fixes

* **fil-cli:** cancel provider requests on interrupt with synapse-core 0.10.1 ([#68](https://github.com/hugomrdias/fil/issues/68)) ([c5f7e4b](https://github.com/hugomrdias/fil/commit/c5f7e4b059532b60ffaf68c5483ae841ed462f3d))
* **fil-cli:** keep a saved session key when fil login runs again ([#70](https://github.com/hugomrdias/fil/issues/70)) ([4a47104](https://github.com/hugomrdias/fil/commit/4a47104f9a94a1f678c1fb1d2b2472f42b62e9b2))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * clipact bumped to 0.3.0

## [0.2.1](https://github.com/hugomrdias/fil/compare/fil-cli-v0.2.0...fil-cli-v0.2.1) (2026-10-12)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * clipact bumped to 0.2.0

## [0.2.0](https://github.com/hugomrdias/fil/compare/fil-cli-v0.1.0...fil-cli-v0.2.0) (2026-10-08)


### Features

* add the fil agent plugin for Claude Code, Codex, and Agent Plugins clients ([#60](https://github.com/hugomrdias/fil/issues/60)) ([0305871](https://github.com/hugomrdias/fil/commit/0305871530a9639d0bf6d488b19d3c5e69538e89)), closes [#59](https://github.com/hugomrdias/fil/issues/59)

## 0.1.0 (2026-10-08)


### Features

* approve fil login keys and funding on a fil-app setup page ([#35](https://github.com/hugomrdias/fil/issues/35)) ([4422657](https://github.com/hugomrdias/fil/commit/442265799a2f36b2861824c286ce722e09a3348d))
* **clipact:** data or error result envelope with an error registry ([#26](https://github.com/hugomrdias/fil/issues/26)) ([0f152ff](https://github.com/hugomrdias/fil/commit/0f152ff960d942b0492d307c44033d9e62115fba))
* **fil-app:** improve the is-agentic.com score and say "Filecoin" in prose ([#45](https://github.com/hugomrdias/fil/issues/45)) ([17a7330](https://github.com/hugomrdias/fil/commit/17a7330f23e282c8b353c8138b9a409acc754ae0))
* **fil-cli:** prototype the Filecoin CLI (fil) on clipact with console login, single-copy storage, and resumable jobs ([#5](https://github.com/hugomrdias/fil/issues/5)) ([93de7a1](https://github.com/hugomrdias/fil/commit/93de7a106f262a50a873629f34afe28d0c29f2cf)), closes [#1](https://github.com/hugomrdias/fil/issues/1) [#2](https://github.com/hugomrdias/fil/issues/2) [#3](https://github.com/hugomrdias/fil/issues/3) [#4](https://github.com/hugomrdias/fil/issues/4)
* **fil-cli:** return fil-api /get links instead of Curio URLs ([#41](https://github.com/hugomrdias/fil/issues/41)) ([e2aaa07](https://github.com/hugomrdias/fil/commit/e2aaa0733fe8176f4e373f45d6e979542d49feec))
* give each kind of agent one way in to fil, with progressive discovery ([#53](https://github.com/hugomrdias/fil/issues/53)) ([0f1fb2b](https://github.com/hugomrdias/fil/commit/0f1fb2b75dac91751e05b67a0d2ec8effb553438))
* publish agent skills from one root skills directory ([#52](https://github.com/hugomrdias/fil/issues/52)) ([8bbe993](https://github.com/hugomrdias/fil/commit/8bbe99326d68afb56a25f1ce93b559d261c2054d))
* version packages and release them to npm with release-please ([#54](https://github.com/hugomrdias/fil/issues/54)) ([4bb7dce](https://github.com/hugomrdias/fil/commit/4bb7dce5c592efd11d6cc4036547215267afc7a3))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * clipact bumped to 0.1.0
