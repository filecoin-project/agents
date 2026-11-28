# Changelog

## [0.9.0](https://github.com/filecoin-project/agents/compare/filecoin-cli-v0.8.0...filecoin-cli-v0.9.0) (2026-11-28)


### Features

* **filecoin-cli:** add --include-hidden to put ([#176](https://github.com/filecoin-project/agents/issues/176)) ([429bfd9](https://github.com/filecoin-project/agents/commit/429bfd940585d9b3c622295e802e8aa2db68a95c))


### Bug Fixes

* **filecoin-cli:** bound CAR header and section reads in get ([d919b0a](https://github.com/filecoin-project/agents/commit/d919b0a5a9491cff6f83729e0e4ea853796da135)), closes [#178](https://github.com/filecoin-project/agents/issues/178)
* **filecoin-cli:** reject a symlink as the input of put ([#171](https://github.com/filecoin-project/agents/issues/171)) ([5500a07](https://github.com/filecoin-project/agents/commit/5500a077280e67cd4d64611239f2865517d840a8))
* **filecoin-cli:** reject special files and backslash names in put ([#173](https://github.com/filecoin-project/agents/issues/173)) ([d2667f4](https://github.com/filecoin-project/agents/commit/d2667f46756db6b3d2f63e16cb9dde2a12cfb6c3))
* **filecoin-cli:** report every symlink when put rejects a folder ([#170](https://github.com/filecoin-project/agents/issues/170)) ([c9ef3f2](https://github.com/filecoin-project/agents/commit/c9ef3f2f0673a7da062042cecd9084be124e6d78))

## [0.8.0](https://github.com/filecoin-project/agents/compare/filecoin-cli-v0.7.0...filecoin-cli-v0.8.0) (2026-11-17)


### ⚠ BREAKING CHANGES

* **filecoin-cli:** the `delete` input field `ref` is now `target`, and its output is `{ dryRun, operationId, state, target, removals, resources }` instead of a resource with URLs. `operations resume` of a delete returns the same shape.
* **filecoin-cli:** the positional is `target` instead of `ref`, so `--ref` no longer works. The output adds `network` and `pieces`, `resource` is present only when local state has one, and `urls` is absent when filecoin-api has no PieceCID for the piece.
* **filecoin-cli:** ls returns pieces instead of resources. --all now includes removed pieces, and --provider filters by storage provider.
* **filecoin-cli:** `get <pieceCid>` of a managed file or folder stored as a CAR writes the CAR instead of extracting it. The result's `pieceCid` is optional, and a new `rootCid` names the root an extraction checked.
* **filecoin-cli:** a file stored without `--raw` is now a CAR, so its `/piece` URL serves the CAR and its browser link goes through inbrowser.link. Pass `--raw` to store the exact bytes.

### Features

* **filecoin-cli:** add datasets ls and datasets inspect ([fd2d711](https://github.com/filecoin-project/agents/commit/fd2d711e339ddd3131c61b232b0a2885e86ff330))
* **filecoin-cli:** commit with synapse-core 0.11.0's JSON-safe commits ([010609b](https://github.com/filecoin-project/agents/commit/010609b3740a28ebd89e848efd52d46dde371166)), closes [#105](https://github.com/filecoin-project/agents/issues/105)
* **filecoin-cli:** delete pieces by ref, PieceCID, root CID, or ID pair ([5726eae](https://github.com/filecoin-project/agents/commit/5726eaeab676c586395bb317ae043531972ccd9f))
* **filecoin-cli:** extract depth-first CARs that send each block once ([aacd4cf](https://github.com/filecoin-project/agents/commit/aacd4cfd78628bddda747458aab81804b8f644ce))
* **filecoin-cli:** inspect pieces by ref, PieceCID, root CID, or ID pair ([a65dbe3](https://github.com/filecoin-project/agents/commit/a65dbe35b3c8b018e661a798cdf374fa4b11a33d))
* **filecoin-cli:** list the wallet's pieces from filecoin-api in ls ([cb431dd](https://github.com/filecoin-project/agents/commit/cb431dd49bb67888ab5c21356d9fa70d8a2d7daa))
* **filecoin-cli:** select providers with selectReachableProviders ([3545ea7](https://github.com/filecoin-project/agents/commit/3545ea7e099819376d76e5c22b0f6f02bd4480fa)), closes [#105](https://github.com/filecoin-project/agents/issues/105)
* **filecoin-cli:** store a second copy on another provider ([bfb8ec9](https://github.com/filecoin-project/agents/commit/bfb8ec93495faa414bdc632952a99299e3650ea3))
* **filecoin-cli:** store files as IPFS-indexed CARs by default ([4ae5b1d](https://github.com/filecoin-project/agents/commit/4ae5b1df6be49060c7a70ad50264542c9e796ae2))
* **filecoin-cli:** stream put CARs in DFS order without staging ([1ddeb4e](https://github.com/filecoin-project/agents/commit/1ddeb4e509d6f7579c2be35432d564ebcfe5bb47))
* **filecoin-cli:** stream roots from /ipfs and resolve other CIDs through filecoin-api ([6b5b5a8](https://github.com/filecoin-project/agents/commit/6b5b5a8d3c4ef6f3355c88747bbb29f1afe50ee1))
* **filecoin-cli:** wait for removals with SP.waitForDeletePieces ([bee2dd1](https://github.com/filecoin-project/agents/commit/bee2dd1a274247b638cd0654c95db0f2444397f1)), closes [#105](https://github.com/filecoin-project/agents/issues/105)


### Bug Fixes

* **filecoin-cli:** accept a CIDv1 answer to a CIDv0 root in get ([9a231b2](https://github.com/filecoin-project/agents/commit/9a231b22db9dc07aaadbfd398381b529bd33cf30))
* **filecoin-cli:** keep the second copy off the first copy's provider ([28bcf2d](https://github.com/filecoin-project/agents/commit/28bcf2dbbbd048c754aaf52756a65ed9370fb49b))
* **filecoin-cli:** read every page and filter providers first in delete ([6c986b4](https://github.com/filecoin-project/agents/commit/6c986b4e9bd2368f3c618561966ea1c0095dfdd1))
* **filecoin-cli:** reject oversized content before staging its CAR ([eea14b0](https://github.com/filecoin-project/agents/commit/eea14b02b9ca0a57593ac78fae987fae94b9ecd7))
* **filecoin-cli:** report the bytes get writes as its size ([f62c5ed](https://github.com/filecoin-project/agents/commit/f62c5ed033a2ba81e6b9f25081984f5c26b04aa6))
* stop publishing tsconfig.tsbuildinfo in npm packages ([#143](https://github.com/filecoin-project/agents/issues/143)) ([7147ac7](https://github.com/filecoin-project/agents/commit/7147ac7db30db032ce97992520d0919807af3847))


### Dependencies

* **filecoin-cli:** take zod from the catalog ([9647687](https://github.com/filecoin-project/agents/commit/9647687901e5816013f7749a959b65c8f08171ba))
* **filecoin-cli:** update viem to 2.57.19 and zod to 4.6.7 ([a826f08](https://github.com/filecoin-project/agents/commit/a826f08df6cb32fdd94d6dd403b388f3e47d84ea))

## [0.7.0](https://github.com/filecoin-project/agents/compare/filecoin-cli-v0.6.0...filecoin-cli-v0.7.0) (2026-10-23)


### Features

* **cli:** link the Filecoin Pay console home in status ([#73](https://github.com/filecoin-project/agents/issues/73)) ([44bc192](https://github.com/filecoin-project/agents/commit/44bc1920885d5f3673a111f65b7e5a73a47d80c8))
* **cli:** report balances, runway, and storage in status ([#68](https://github.com/filecoin-project/agents/issues/68)) ([5092654](https://github.com/filecoin-project/agents/commit/5092654be8c25a3b397d980194ffaf6a0d0bdf92))

## [0.6.0](https://github.com/filecoin-project/agents/compare/filecoin-cli-v0.5.2...filecoin-cli-v0.6.0) (2026-10-20)


### ⚠ BREAKING CHANGES

* **filecoin-cli:** `filecoin publish` and `filecoin rm` are removed. Use `filecoin put` and `filecoin delete` instead.
* **filecoin-cli:** the default `FILECOIN_CONSOLE_URL` is https://pay.filecoin.cloud. New data sets carry `source: 'filecoin-cli'`, so data sets tagged `source: 'filecoin'` are no longer reused and the next `put` creates a new data set.

### Features

* **filecoin-cli:** send login, funding, and revoke links to the Filecoin Pay console ([#45](https://github.com/filecoin-project/agents/issues/45)) ([83a330c](https://github.com/filecoin-project/agents/commit/83a330ce34d6fd816976ab79f52afdae26cd3a21))
* **filecoin-cli:** tag console links for the console's analytics ([#53](https://github.com/filecoin-project/agents/issues/53)) ([2442eae](https://github.com/filecoin-project/agents/commit/2442eae2d8c4fd3546266998f90cf88f2a9afd3a))
* **filecoin-cli:** upgrade to clipact 0.7, with globals, its folder, and its store ([#54](https://github.com/filecoin-project/agents/issues/54)) ([f53f53d](https://github.com/filecoin-project/agents/commit/f53f53d01fc90a5dc3a6464363eee64f8edcbff6))

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
