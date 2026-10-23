# Changelog

## [0.5.0](https://github.com/filecoin-project/agents/compare/filecoin-api-v0.4.1...filecoin-api-v0.5.0) (2026-10-23)


### ⚠ BREAKING CHANGES

* **filecoin-api:** `Rail.txHash` and the `txHash` of each session key permission are removed, because the indexer's summary tables store no transaction hash. `Rail.settledUpTo` is never null. `/status` and `/health` report one indexer, `ozone`.

### Features

* **filecoin-api:** move the MCP server to MCP SDK v2 ([8def2ed](https://github.com/filecoin-project/agents/commit/8def2ed63849d65bd718ed4265affec7557c02d3)), closes [#88](https://github.com/filecoin-project/agents/issues/88)
* **filecoin-api:** read the indexer's ozone schema and drop foc-observer ([7a58f0b](https://github.com/filecoin-project/agents/commit/7a58f0beaf445df39fa7a7aded1fee70ffb537fa))
* **filecoin-api:** send the rate-limit policy in a RateLimit-Policy header ([#67](https://github.com/filecoin-project/agents/issues/67)) ([b419939](https://github.com/filecoin-project/agents/commit/b419939ff24a8b54e41431243d0463cf4429b84d)), closes [#59](https://github.com/filecoin-project/agents/issues/59)
* **filecoin-api:** serve the MCP server card ([#76](https://github.com/filecoin-project/agents/issues/76)) ([674eb77](https://github.com/filecoin-project/agents/commit/674eb779f0e765360ad39c6c7d67ff6fbd7dbc40))

## [0.4.1](https://github.com/filecoin-project/agents/compare/filecoin-api-v0.4.0...filecoin-api-v0.4.1) (2026-10-20)


### Bug Fixes

* **filecoin-api:** report the release version and tool titles over MCP ([#47](https://github.com/filecoin-project/agents/issues/47)) ([54a7435](https://github.com/filecoin-project/agents/commit/54a7435ebc68c6cea208871c72f5e32884ab843f))

## [0.4.0](https://github.com/filecoin-project/agents/compare/filecoin-api-v0.3.0...filecoin-api-v0.4.0) (2026-10-16)


### Features

* **filecoin-api:** add search_docs MCP tool backed by GitBook docs search ([#38](https://github.com/filecoin-project/agents/issues/38)) ([8796467](https://github.com/filecoin-project/agents/commit/87964676a3e9d4543178159300c886934fb45403))


### Performance Improvements

* update filecoin-cli and filecoin-api to synapse-core 0.10.2 ([#43](https://github.com/filecoin-project/agents/issues/43)) ([041a490](https://github.com/filecoin-project/agents/commit/041a4909a66e3487c6aefbd41f1e0bd802516873))

## [0.3.0](https://github.com/filecoin-project/agents/compare/filecoin-api-v0.2.0...filecoin-api-v0.3.0) (2026-10-14)


### ⚠ BREAKING CHANGES

* the npm package is `filecoin` and the command is `filecoin`. Environment variables are `FILECOIN_*` instead of `FIL_*`, the config and state folders are named `filecoin`, so existing users log in again. New data sets carry `source: 'filecoin'` and session keys the `filecoin` origin, so data sets tagged `fil` are no longer reused. The plugin installs as `filecoin@filecoin`, and trace attributes use the `filecoin.` prefix.

### Miscellaneous Chores

* rename fil to filecoin ([#15](https://github.com/filecoin-project/agents/issues/15)) ([29b1720](https://github.com/filecoin-project/agents/commit/29b1720acba53a49ec493398b22884a30511ce30))

## [0.2.0](https://github.com/hugomrdias/fil/compare/fil-api-v0.1.0...fil-api-v0.2.0) (2026-10-12)


### Features

* early retrieval links during put, with a provider hint in fil-api ([#65](https://github.com/hugomrdias/fil/issues/65)) ([023073b](https://github.com/hugomrdias/fil/commit/023073b23dd9b8f5b4ba94f55768f89e91b28520))


### Bug Fixes

* **fil-cli:** cancel provider requests on interrupt with synapse-core 0.10.1 ([#68](https://github.com/hugomrdias/fil/issues/68)) ([c5f7e4b](https://github.com/hugomrdias/fil/commit/c5f7e4b059532b60ffaf68c5483ae841ed462f3d))

## 0.1.0 (2026-10-08)


### Features

* **fil-api:** add Cloudflare Worker API and MCP server for Filecoin onchain data ([2fb6b04](https://github.com/hugomrdias/fil/commit/2fb6b04976255409b3b30003c35977cfa73178ca))
* **fil-api:** redirect PieceCIDs and IPFS CIDs to providers via /get/{cid} ([#22](https://github.com/hugomrdias/fil/issues/22)) ([d8f6ab2](https://github.com/hugomrdias/fil/commit/d8f6ab278ae887c622e3f19852f66d26c3bf5561))
* **fil-api:** run the Worker in Frankfurt next to the Hyperdrive pool ([#50](https://github.com/hugomrdias/fil/issues/50)) ([cf568dc](https://github.com/hugomrdias/fil/commit/cf568dc8f9fc74a61c2d7165d07aef5b3b3cfa6b))
* **fil-api:** trace requests with Ray IDs and custom spans, and tighten network routes ([#19](https://github.com/hugomrdias/fil/issues/19)) ([10d9637](https://github.com/hugomrdias/fil/commit/10d96376a9de8731646b6d91ea171a252178e751))
* **fil-app:** improve the is-agentic.com score and say "Filecoin" in prose ([#45](https://github.com/hugomrdias/fil/issues/45)) ([17a7330](https://github.com/hugomrdias/fil/commit/17a7330f23e282c8b353c8138b9a409acc754ae0))


### Bug Fixes

* **fil-api:** address review findings ([3594d1a](https://github.com/hugomrdias/fil/commit/3594d1a4251a8dc12fb6eaf892befebfb1f81d62))
* report indexer lag against the chain head and serve fresh fil-api reads ([#48](https://github.com/hugomrdias/fil/issues/48)) ([4636540](https://github.com/hugomrdias/fil/commit/4636540f7db1af09fc090884acd27e0ff762a69d))
* validate PieceCID v2 in fil-api's piece filter and the explorer search ([#40](https://github.com/hugomrdias/fil/issues/40)) ([7df40c6](https://github.com/hugomrdias/fil/commit/7df40c6621085cf8a89aa36629c83c509d9ab495)), closes [#37](https://github.com/hugomrdias/fil/issues/37)


### Performance Improvements

* **fil-api:** avoid planner traps in rail and owner piece queries, and compose SQL with a typed tag ([#20](https://github.com/hugomrdias/fil/issues/20)) ([7bee9a2](https://github.com/hugomrdias/fil/commit/7bee9a2ad0b141ee1ea6643325864a94574152cf))
