# Changelog

## [0.6.0](https://github.com/ONREZA/bun-sqlx/compare/v0.5.0...v0.6.0) (2026-05-22)


### Features

* add schema snapshots and shadow validation ([0c642c2](https://github.com/ONREZA/bun-sqlx/commit/0c642c2379c5f1073cd4c300f0a0aa5bf0b9af30))

## [0.5.0](https://github.com/ONREZA/bun-sqlx/compare/v0.4.1...v0.5.0) (2026-05-21)


### ⚠ BREAKING CHANGES

* cache JSON written by prior versions is rejected on read; users must re-run \`bun-sqlx prepare\` to regenerate.

### Features

* cache override discriminator and degraded analysis surfacing ([5180fd9](https://github.com/ONREZA/bun-sqlx/commit/5180fd952cae8b10adf18231dd064ef5d87cbb7e))
* harden wire protocol, runtime, and migrate; expose ConnectionLostError ([0c13f05](https://github.com/ONREZA/bun-sqlx/commit/0c13f05746b8fd19452c63407b9b2a183b6adcdb))


### Bug Fixes

* **scanner,watch:** track sql shadowing and normalize watcher paths ([acd8c5a](https://github.com/ONREZA/bun-sqlx/commit/acd8c5acc468575b4c1c2902fd12320d197f6a6b))


### CI

* pin Action SHAs, add Dependabot, prevent release shell-injection ([05a743c](https://github.com/ONREZA/bun-sqlx/commit/05a743cfe73ddc206504c40bc73e9647756a0585))

## [0.4.1](https://github.com/ONREZA/bun-sqlx/compare/v0.4.0...v0.4.1) (2026-05-19)


### Bug Fixes

* scan sql.one/optional chains and encode primitive arrays as PG literals ([eb5e213](https://github.com/ONREZA/bun-sqlx/commit/eb5e21364093102e951b9b37b10c4e977c14f2ed))


### Documentation

* scanner coverage for one/optional chains, array param encoding ([ea51003](https://github.com/ONREZA/bun-sqlx/commit/ea51003a9cfdd4f91a59d04c8def30f633b7d5c8))

## [0.4.0](https://github.com/ONREZA/bun-sqlx/compare/v0.3.0...v0.4.0) (2026-05-19)


### Features

* parameter nullability, one/optional helpers, built declarations ([793e07c](https://github.com/ONREZA/bun-sqlx/commit/793e07c1e9e06683c22c24539bbca4672ff49af4))


### Documentation

* parameter nullability, sql.one/optional, dts rename ([3fd9a71](https://github.com/ONREZA/bun-sqlx/commit/3fd9a71b6af198fee9ff941aeb9cb50ef6325f75))

## [0.3.0](https://github.com/ONREZA/bun-sqlx/compare/v0.2.0...v0.3.0) (2026-05-19)


### Features

* typed Postgres extension types, domains, and wider OID coverage ([f4b4355](https://github.com/ONREZA/bun-sqlx/commit/f4b43551f07ed1f483b82a8aac29517eea487038))


### Documentation

* document extension type registry, customTypes config, and domains ([c6225f6](https://github.com/ONREZA/bun-sqlx/commit/c6225f6a52f6a1269b2af9d9b0c5a034a9eaff58))


### Tests

* run integration suite in an isolated Postgres container ([f1aa36b](https://github.com/ONREZA/bun-sqlx/commit/f1aa36bb0b7792dd8e2714f0bf013b6c49f38999))

## [0.2.0](https://github.com/ONREZA/bun-sqlx/compare/v0.1.0...v0.2.0) (2026-05-19)


### Features

* add sql.file, sql.transaction, source-mapped errors, and cache pruning ([a994494](https://github.com/ONREZA/bun-sqlx/commit/a994494f4c085b3fce6fd85ce63e11b70ecc7cf0))


### Bug Fixes

* drain PG wire protocol after ErrorResponse to keep connection healthy ([1e9cd88](https://github.com/ONREZA/bun-sqlx/commit/1e9cd8882726cdbd5909466bcaecbe67d4d57e05))


### Documentation

* document sql.file, sql.transaction, error reporting and prune flag ([640b440](https://github.com/ONREZA/bun-sqlx/commit/640b44043d5dec592a496fa3b68c7c3daafc1132))


### Tests

* add integration suite covering prepare errors, file queries, and tx scope ([1682711](https://github.com/ONREZA/bun-sqlx/commit/1682711b606b50225a8c4992a395a10c6a4dcf05))

## 0.1.0 (2026-05-19)


### Features

* initial public release ([b629ed6](https://github.com/ONREZA/bun-sqlx/commit/b629ed69cdb37e706993712a69fbc93950a6928f))


### Bug Fixes

* add repository url and reset release state ([eacb86f](https://github.com/ONREZA/bun-sqlx/commit/eacb86f261081cf1236b3368e086b6ff22277e8b))


### CI

* chain publish into release workflow ([42c2e36](https://github.com/ONREZA/bun-sqlx/commit/42c2e3618ffb7688dedf4c33bd7d659582ce898d))
* consolidate manual publish into release workflow ([924224a](https://github.com/ONREZA/bun-sqlx/commit/924224a9cc0fa65f1b99d877162d6d8c196f6e0b))


### Chores

* pin initial release to 0.1.0 ([41378a0](https://github.com/ONREZA/bun-sqlx/commit/41378a0ce38f4df09e5a12a800a8e443ce923009))
