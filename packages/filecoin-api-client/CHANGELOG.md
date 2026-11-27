# Changelog

## [0.5.0](https://github.com/filecoin-project/agents/compare/filecoin-api-client-v0.4.1...filecoin-api-client-v0.5.0) (2026-11-25)


### ⚠ BREAKING CHANGES

* **filecoin-api-client:** Data route paths start with /v1. Replace paths such as '/{network}/providers' with '/v1/{network}/providers'. '/get/{cid}' does not change.

### Features

* **filecoin-api-client:** call the data routes under /v1 ([a0525b1](https://github.com/filecoin-project/agents/commit/a0525b164fcb41a18d4a11dc85589c2c8d6c6d58))

## [0.4.1](https://github.com/filecoin-project/agents/compare/filecoin-api-client-v0.4.0...filecoin-api-client-v0.4.1) (2026-11-17)


### Bug Fixes

* stop publishing tsconfig.tsbuildinfo in npm packages ([#143](https://github.com/filecoin-project/agents/issues/143)) ([7147ac7](https://github.com/filecoin-project/agents/commit/7147ac7db30db032ce97992520d0919807af3847))

## [0.4.0](https://github.com/filecoin-project/agents/compare/filecoin-api-client-v0.3.0...filecoin-api-client-v0.4.0) (2026-11-17)


### Features

* **filecoin-api-client:** add the ipfs_cid filter to listPieces ([9a8c980](https://github.com/filecoin-project/agents/commit/9a8c980b4bfa87fdc21fc0aae8a6747574662e01))

## [0.3.0](https://github.com/filecoin-project/agents/compare/filecoin-api-client-v0.2.0...filecoin-api-client-v0.3.0) (2026-11-10)


### Features

* **filecoin-api-client:** add the X-Source header and 502 to retrieve ([66749c8](https://github.com/filecoin-project/agents/commit/66749c82a8dff46e5ccfa84fd508cc2bfcf8a922))

## [0.2.0](https://github.com/filecoin-project/agents/compare/filecoin-api-client-v0.1.0...filecoin-api-client-v0.2.0) (2026-10-23)


### Features

* **filecoin-api-client:** regenerate types for the ozone schema ([1f9f48e](https://github.com/filecoin-project/agents/commit/1f9f48e55d00f8a44bde12d70e1ee8ff9f65af38))

## 0.1.0 (2026-10-21)


### Features

* **filecoin-api:** send the rate-limit policy in a RateLimit-Policy header ([#67](https://github.com/filecoin-project/agents/issues/67)) ([b419939](https://github.com/filecoin-project/agents/commit/b419939ff24a8b54e41431243d0463cf4429b84d)), closes [#59](https://github.com/filecoin-project/agents/issues/59)
