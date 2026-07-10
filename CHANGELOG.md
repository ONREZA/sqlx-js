# Changelog

## [0.5.0](https://github.com/ONREZA/sqlx-js/compare/v0.4.0...v0.5.0) (2026-07-10)


### Features

* harden production workflows ([090deeb](https://github.com/ONREZA/sqlx-js/commit/090deeb6a1d7984714f0e9b5932618f5f1a800b7))


### Bug Fixes

* **ci:** support minimum Bun test runner ([e2140c8](https://github.com/ONREZA/sqlx-js/commit/e2140c8c4ecd56b77efa31b9993f283be5c2943e))
* **prepare:** make generated cache portable ([fab2dae](https://github.com/ONREZA/sqlx-js/commit/fab2dae411689638701f61e7e4757c8414a9130d))

## [0.4.0](https://github.com/ONREZA/sqlx-js/compare/v0.3.0...v0.4.0) (2026-07-09)


### Features

* add pgschema workflow and function types ([80a84c2](https://github.com/ONREZA/sqlx-js/commit/80a84c26cb80aa47efd22e461529149678665d85))

## [0.3.0](https://github.com/ONREZA/sqlx-js/compare/v0.2.0...v0.3.0) (2026-07-07)


### Features

* **prepare:** tighten parameter typing ([ee0f372](https://github.com/ONREZA/sqlx-js/commit/ee0f372de456b62a3b56e48d4f9740e87ac8de99))


### Documentation

* align docs with current behavior ([994a3ae](https://github.com/ONREZA/sqlx-js/commit/994a3ae18b06614639d6f134068abde856a59662))

## [0.2.0](https://github.com/ONREZA/sqlx-js/compare/v0.1.0...v0.2.0) (2026-06-03)


### Breaking Changes

* the @onreza/sqlx-js/bun entry point is removed. Import from @onreza/sqlx-js instead; the runtime uses the Postgres.js-backed root entry point.

### Features

* add sqlx-js init command ([b5b4be1](https://github.com/ONREZA/sqlx-js/commit/b5b4be13b02372b085fadc64aa4ee34ce8a293b4))
* composite types, NOT-IS-NULL narrowing and parallel prepare ([0173fe7](https://github.com/ONREZA/sqlx-js/commit/0173fe74561afea98b84dab62866b3896ba28236))
* improve migration lifecycle ([c354e6c](https://github.com/ONREZA/sqlx-js/commit/c354e6ca7cfdfaddf490e9b8f48bd305f33c828f))
* production-readiness (hooks, errors, timeouts, TLS, composite, init) + remove Bun.SQL adapter ([3f5a332](https://github.com/ONREZA/sqlx-js/commit/3f5a332770971fb234aa64bfea9b91375a6d8000))
* remove the Bun.SQL adapter ([83df682](https://github.com/ONREZA/sqlx-js/commit/83df68218dd35ba26b922a593441daa767cbb6e2))
* runtime query hooks, unified PgError, timeouts and TLS CA ([f6c2e82](https://github.com/ONREZA/sqlx-js/commit/f6c2e825820f6d2bbfb56d45e07f2045645c8635))

## 0.1.0 (2026-05-26)


### Breaking Changes

* cache JSON written by prior versions is rejected on read; users must re-run `sqlx-js prepare` to regenerate.

### Features

* add schema snapshots and shadow validation ([0c642c2](https://github.com/ONREZA/sqlx-js/commit/0c642c2379c5f1073cd4c300f0a0aa5bf0b9af30))
* add sql.file, sql.transaction, source-mapped errors, and cache pruning ([a994494](https://github.com/ONREZA/sqlx-js/commit/a994494f4c085b3fce6fd85ce63e11b70ecc7cf0))
* cache override discriminator and degraded analysis surfacing ([5180fd9](https://github.com/ONREZA/sqlx-js/commit/5180fd952cae8b10adf18231dd064ef5d87cbb7e))
* harden wire protocol, runtime, and migrate; expose ConnectionLostError ([0c13f05](https://github.com/ONREZA/sqlx-js/commit/0c13f05746b8fd19452c63407b9b2a183b6adcdb))
* improve DML returning and nullability inference ([272755d](https://github.com/ONREZA/sqlx-js/commit/272755d8eb6f68b63abed8e8ebd8d42755b64e18))
* initial public release ([b629ed6](https://github.com/ONREZA/sqlx-js/commit/b629ed69cdb37e706993712a69fbc93950a6928f))
* migrate package to sqlx-js ([9a822f3](https://github.com/ONREZA/sqlx-js/commit/9a822f34ec1a671fa6d469d87b54b3559cded83b))
* parameter nullability, one/optional helpers, built declarations ([793e07c](https://github.com/ONREZA/sqlx-js/commit/793e07c1e9e06683c22c24539bbca4672ff49af4))
* typed Postgres extension types, domains, and wider OID coverage ([f4b4355](https://github.com/ONREZA/sqlx-js/commit/f4b43551f07ed1f483b82a8aac29517eea487038))


### Bug Fixes

* add repository url and reset release state ([eacb86f](https://github.com/ONREZA/sqlx-js/commit/eacb86f261081cf1236b3368e086b6ff22277e8b))
* drain PG wire protocol after ErrorResponse to keep connection healthy ([1e9cd88](https://github.com/ONREZA/sqlx-js/commit/1e9cd8882726cdbd5909466bcaecbe67d4d57e05))
* scan sql.one/optional chains and encode primitive arrays as PG literals ([eb5e213](https://github.com/ONREZA/sqlx-js/commit/eb5e21364093102e951b9b37b10c4e977c14f2ed))
* **scanner,watch:** track sql shadowing and normalize watcher paths ([acd8c5a](https://github.com/ONREZA/sqlx-js/commit/acd8c5acc468575b4c1c2902fd12320d197f6a6b))


### Documentation

* document extension type registry, customTypes config, and domains ([c6225f6](https://github.com/ONREZA/sqlx-js/commit/c6225f6a52f6a1269b2af9d9b0c5a034a9eaff58))
* document sql.file, sql.transaction, error reporting and prune flag ([640b440](https://github.com/ONREZA/sqlx-js/commit/640b44043d5dec592a496fa3b68c7c3daafc1132))
* parameter nullability, sql.one/optional, dts rename ([3fd9a71](https://github.com/ONREZA/sqlx-js/commit/3fd9a71b6af198fee9ff941aeb9cb50ef6325f75))
* scanner coverage for one/optional chains, array param encoding ([ea51003](https://github.com/ONREZA/sqlx-js/commit/ea51003a9cfdd4f91a59d04c8def30f633b7d5c8))


### Tests

* add integration suite covering prepare errors, file queries, and tx scope ([1682711](https://github.com/ONREZA/sqlx-js/commit/1682711b606b50225a8c4992a395a10c6a4dcf05))
* run integration suite in an isolated Postgres container ([f1aa36b](https://github.com/ONREZA/sqlx-js/commit/f1aa36bb0b7792dd8e2714f0bf013b6c49f38999))


### CI

* chain publish into release workflow ([42c2e36](https://github.com/ONREZA/sqlx-js/commit/42c2e3618ffb7688dedf4c33bd7d659582ce898d))
* consolidate manual publish into release workflow ([924224a](https://github.com/ONREZA/sqlx-js/commit/924224a9cc0fa65f1b99d877162d6d8c196f6e0b))
* pin Action SHAs, add Dependabot, prevent release shell-injection ([05a743c](https://github.com/ONREZA/sqlx-js/commit/05a743cfe73ddc206504c40bc73e9647756a0585))


### Chores

* pin initial release to 0.1.0 ([41378a0](https://github.com/ONREZA/sqlx-js/commit/41378a0ce38f4df09e5a12a800a8e443ce923009))
