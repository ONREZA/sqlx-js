# Changelog

## [0.30.0](https://github.com/ONREZA/sqlx-js/compare/v0.29.0...v0.30.0) (2026-08-09)


### ⚠ BREAKING CHANGES

* **api:** remove global managed client exports and ambient generated registries. Remove jsonbTypes, queries --embed, and legacy lifecycle hooks.
* **json:** PostgreSQL JSON inputs and results now use SqlxJson documents and require regenerated cache and runtime descriptors.
* **runtime:** require Temporal SQL values and reject timestamp without time zone unless explicitly allowed.

### Features

* **api:** consolidate generated workflows ([2ed92de](https://github.com/ONREZA/sqlx-js/commit/2ed92de56e6895d1b80c3a05ca8f3f06216e667f))
* close prepare and runtime dx gaps ([7cb8b76](https://github.com/ONREZA/sqlx-js/commit/7cb8b769f782cf1c061017fe51e4866aff57de40))
* **json:** add extended json protocol ([e2d0040](https://github.com/ONREZA/sqlx-js/commit/e2d0040b71b3d200274dd8a5c2abb1ab68ebddb9))
* **queries:** audit query reuse ([b732b74](https://github.com/ONREZA/sqlx-js/commit/b732b7461f90485b42306fa8ac56cb7fd46de062))
* **runtime:** add decode error context ([84a86df](https://github.com/ONREZA/sqlx-js/commit/84a86df4c859e3a2d93b6745424ddab0ff465429))
* **runtime:** require temporal sql values ([4484391](https://github.com/ONREZA/sqlx-js/commit/4484391ece035a50429438678c97b0f3282ba086))


### Bug Fixes

* **api:** close compatibility review gaps ([70ece28](https://github.com/ONREZA/sqlx-js/commit/70ece28d637e167abd0685bf4c702bf6071282d1))
* **api:** close mapped query review gaps ([be15bd7](https://github.com/ONREZA/sqlx-js/commit/be15bd7a18b3d20b52c78ecd631f3e160d841de2))
* **api:** enforce exact generated contracts ([a8c8a76](https://github.com/ONREZA/sqlx-js/commit/a8c8a763e4efb157baf1695280a2906a8ab83e34))
* **ci:** provide temporal api to clients ([bd7290d](https://github.com/ONREZA/sqlx-js/commit/bd7290da0182fb4dd9d9ad78520e2303de289c31))
* **ci:** refresh pgschema fixture artifacts ([070b098](https://github.com/ONREZA/sqlx-js/commit/070b098899efc594519cbe923fd514d1231462dd))
* **cli:** keep json failure summary complete ([aeac2f1](https://github.com/ONREZA/sqlx-js/commit/aeac2f1884d9803a17b62433254308ed61639751))
* **doctor:** probe schema materializer ([6f9f4fd](https://github.com/ONREZA/sqlx-js/commit/6f9f4fd830d481671f39f0128b250cd9b0c0bb43))
* **json:** bound audit number regex input ([c76072f](https://github.com/ONREZA/sqlx-js/commit/c76072fb26d128ddf531b43979fe1bab7b3b94f8))
* **json:** bound canonical number expansion ([2f6c81f](https://github.com/ONREZA/sqlx-js/commit/2f6c81f806ce8a376ec48c7b19d217fdf82b6dec))
* **json:** enforce reader audit invariants ([dc460da](https://github.com/ONREZA/sqlx-js/commit/dc460dadec4e4d78e038e5bc08fa063101e0a38a))
* **json:** enforce review invariants ([7f12847](https://github.com/ONREZA/sqlx-js/commit/7f128479e6e3923dbe4e2d15565967057862377d))
* **json:** make document brands unforgeable ([7bb6598](https://github.com/ONREZA/sqlx-js/commit/7bb65987e60c856c65e2550abe650de4651ce85b))
* **json:** preserve exact-number equality ([2878711](https://github.com/ONREZA/sqlx-js/commit/287871109afe55a2ab7bf3ee19dba7f295927765))
* **json:** size jsonb numbers without rendering ([ca1dd30](https://github.com/ONREZA/sqlx-js/commit/ca1dd3016deaa86422e05da3a9b32147ebe66550))
* **prepare:** canonicalize cache publication ([f5d3d11](https://github.com/ONREZA/sqlx-js/commit/f5d3d11f74e697d74995bec758dacc15a8510a5a))
* **prepare:** publish artifacts atomically ([044c74c](https://github.com/ONREZA/sqlx-js/commit/044c74cb631800bf4f4b96f8454db3bb1ef74b8a))
* **queries:** preserve audit semantics ([0946041](https://github.com/ONREZA/sqlx-js/commit/09460413eba00fc895106d29087a3bf0eadf9047))
* **runtime:** close temporal review gaps ([6d5d8e2](https://github.com/ONREZA/sqlx-js/commit/6d5d8e2dddc481150a722639d26b538ae43b1a9b))
* **schema:** canonicalize generated contracts ([0873196](https://github.com/ONREZA/sqlx-js/commit/0873196346b00d34192ebde4b1d717bbc81250ac))


### Documentation

* **json:** propose extended protocol ([9cfd1c6](https://github.com/ONREZA/sqlx-js/commit/9cfd1c614c2d29f868453102fd219e893f3a3da4))
* **upgrade:** merge 0.30 migration guide ([368a768](https://github.com/ONREZA/sqlx-js/commit/368a768172992af3ede966191207ab451e5e97be))
* **upgrades:** merge 0.31 into 0.30 ([5425de6](https://github.com/ONREZA/sqlx-js/commit/5425de624af42612f6fc119bbd5fc8bd1a8ffb18))

## [0.29.0](https://github.com/ONREZA/sqlx-js/compare/v0.28.0...v0.29.0) (2026-08-04)


### Features

* **query:** add result element assertions ([59b652e](https://github.com/ONREZA/sqlx-js/commit/59b652e0978995e99f3941c9463459ae4dabe2a8))


### Documentation

* **roadmap:** define planning data ownership ([#65](https://github.com/ONREZA/sqlx-js/issues/65)) ([ad0918c](https://github.com/ONREZA/sqlx-js/commit/ad0918c3141eed41b96703cba89098fddec3561d))

## [0.28.0](https://github.com/ONREZA/sqlx-js/compare/v0.27.0...v0.28.0) (2026-08-04)


### Features

* **runtime:** add query options and keepalive ([#63](https://github.com/ONREZA/sqlx-js/issues/63)) ([ff11c79](https://github.com/ONREZA/sqlx-js/commit/ff11c79de68be75857f5d8fae93623579ab946d0))

## [0.27.0](https://github.com/ONREZA/sqlx-js/compare/v0.26.0...v0.27.0) (2026-08-04)


### Features

* harden sql contract boundaries ([#61](https://github.com/ONREZA/sqlx-js/issues/61)) ([78c2c85](https://github.com/ONREZA/sqlx-js/commit/78c2c85a4cf44ea958f0a355e08400827dfd6454))

## [0.26.0](https://github.com/ONREZA/sqlx-js/compare/v0.25.0...v0.26.0) (2026-08-02)


### Features

* **cli:** mark generated artifacts ([3826c5e](https://github.com/ONREZA/sqlx-js/commit/3826c5ebf48cbf1543cb9a161a6efc8d0e5f702a))


### Bug Fixes

* **runtime:** redact database messages from lifecycle events ([5cab1fb](https://github.com/ONREZA/sqlx-js/commit/5cab1fb5dbb033d17fbb956a6cfacc1672ce2da8))

## [0.25.0](https://github.com/ONREZA/sqlx-js/compare/v0.24.1...v0.25.0) (2026-07-30)


### Features

* **cli:** clarify diagnostic output ([#57](https://github.com/ONREZA/sqlx-js/issues/57)) ([e43c911](https://github.com/ONREZA/sqlx-js/commit/e43c911145826e873d3b814845bf0e9effa3831b))

## [0.24.1](https://github.com/ONREZA/sqlx-js/compare/v0.24.0...v0.24.1) (2026-07-29)


### Bug Fixes

* **ci:** accept restart ssl rejection ([#55](https://github.com/ONREZA/sqlx-js/issues/55)) ([6282b23](https://github.com/ONREZA/sqlx-js/commit/6282b23d0c47c982c3d57adc21d8c21c618a2f3a)), closes [#52](https://github.com/ONREZA/sqlx-js/issues/52)

## [0.24.0](https://github.com/ONREZA/sqlx-js/compare/v0.23.1...v0.24.0) (2026-07-29)


### Features

* **runtime:** harden temporal and tls dx ([#53](https://github.com/ONREZA/sqlx-js/issues/53)) ([51f2f22](https://github.com/ONREZA/sqlx-js/commit/51f2f22cac9fd37d4e0b5ecf708c8480f88ba624)), closes [#52](https://github.com/ONREZA/sqlx-js/issues/52)

## [0.23.1](https://github.com/ONREZA/sqlx-js/compare/v0.23.0...v0.23.1) (2026-07-26)


### Bug Fixes

* **ci:** restrict trusted publishing ([c6cb5ca](https://github.com/ONREZA/sqlx-js/commit/c6cb5ca1bca87a1e46053e567fd81d7995d8a9e8)), closes [#43](https://github.com/ONREZA/sqlx-js/issues/43)
* **ci:** verify committed schema snapshots ([#47](https://github.com/ONREZA/sqlx-js/issues/47)) ([9779e29](https://github.com/ONREZA/sqlx-js/commit/9779e297547a9a1f44a6e3599b80a2c5931a5991))
* close security audit follow-ups ([#51](https://github.com/ONREZA/sqlx-js/issues/51)) ([f1062fd](https://github.com/ONREZA/sqlx-js/commit/f1062fdb7af50b370ca222273afd16f82b7b239c))
* **migrate:** reject foreign history stores ([2bfd810](https://github.com/ONREZA/sqlx-js/commit/2bfd81061b21e3c62e884b65f2ea04b6a7fa4eaa)), closes [#42](https://github.com/ONREZA/sqlx-js/issues/42)
* **prepare:** infer quantified array nulls ([#49](https://github.com/ONREZA/sqlx-js/issues/49)) ([a54829c](https://github.com/ONREZA/sqlx-js/commit/a54829c8cbb3f64d87ca5b4ffffb5bbc13ff7188))
* **runtime:** skip dropped composite fields ([#46](https://github.com/ONREZA/sqlx-js/issues/46)) ([efbcaaf](https://github.com/ONREZA/sqlx-js/commit/efbcaaf62b8577231d236a0532a09fe2fffe5971))
* **runtime:** validate abort signals ([#45](https://github.com/ONREZA/sqlx-js/issues/45)) ([16ad4a8](https://github.com/ONREZA/sqlx-js/commit/16ad4a8a5507464bbb626844158f4908a444b16e))
* **types:** validate profiled query mappers ([#48](https://github.com/ONREZA/sqlx-js/issues/48)) ([b5b5773](https://github.com/ONREZA/sqlx-js/commit/b5b577319a1b1c417786d8da4fb2295a978d8159))
* **watch:** ignore custom declaration output ([#50](https://github.com/ONREZA/sqlx-js/issues/50)) ([eb0a0f7](https://github.com/ONREZA/sqlx-js/commit/eb0a0f7e55a549c79e645539a86111ec6692aa82))

## [0.23.0](https://github.com/ONREZA/sqlx-js/compare/v0.22.0...v0.23.0) (2026-07-26)


### Features

* make strict prepare the default workflow ([#40](https://github.com/ONREZA/sqlx-js/issues/40)) ([c4174cf](https://github.com/ONREZA/sqlx-js/commit/c4174cf2cc8e34b820660354bedf88d98ef7b7ab))

## [0.22.0](https://github.com/ONREZA/sqlx-js/compare/v0.21.0...v0.22.0) (2026-07-25)


### Features

* **runtime:** add prepared descriptors ([e1cec73](https://github.com/ONREZA/sqlx-js/commit/e1cec738062f2bf5033c45180af7c62b6a3effa2))


### Bug Fixes

* **prepare:** stabilize descriptor ordering ([5cb8ea1](https://github.com/ONREZA/sqlx-js/commit/5cb8ea1d56e6c871ead0bebfc966fdde3cfbd722))
* **runtime:** harden prepared descriptors ([396eb16](https://github.com/ONREZA/sqlx-js/commit/396eb167749f3a0404dbdacfc30330e3f1fa15b7))


### Performance

* **postgres:** optimize runtime hot paths ([d2ac320](https://github.com/ONREZA/sqlx-js/commit/d2ac3200afcde1acc00a112bded7f7c622dd7509))
* **postgres:** prove descriptor fast path ([1a1b226](https://github.com/ONREZA/sqlx-js/commit/1a1b226f669d94d77051a204c65650b16fe02ac0))

## [0.21.0](https://github.com/ONREZA/sqlx-js/compare/v0.20.1...v0.21.0) (2026-07-25)


### Features

* **skills:** add agent workflows ([5917e1a](https://github.com/ONREZA/sqlx-js/commit/5917e1a17429099fc39536dc55445cec99d66a82))


### Documentation

* **oss:** reorganize project documentation ([d330125](https://github.com/ONREZA/sqlx-js/commit/d330125eeb89c9f487cec251adf7bf797b0be5bd))

## [0.20.1](https://github.com/ONREZA/sqlx-js/compare/v0.20.0...v0.20.1) (2026-07-25)


### Bug Fixes

* **postgres:** preserve startup SQLSTATE ([859a732](https://github.com/ONREZA/sqlx-js/commit/859a732d5f9656b5ec6c6a5abb41a4e971abc6c0))


### Performance

* **postgres:** harden runtime reliability ([1aa61e1](https://github.com/ONREZA/sqlx-js/commit/1aa61e1e0cec4d3874f04dd066e2f65c09e993eb)), closes [#32](https://github.com/ONREZA/sqlx-js/issues/32)

## [0.20.0](https://github.com/ONREZA/sqlx-js/compare/v0.19.0...v0.20.0) (2026-07-24)


### Features

* **runtime:** integrate PostgreSQL driver ([df86fa2](https://github.com/ONREZA/sqlx-js/commit/df86fa2d5f9e41a397e56ab27d8cad7b0f0ec90c))

## [0.19.0](https://github.com/ONREZA/sqlx-js/compare/v0.18.0...v0.19.0) (2026-07-24)


### Features

* **rls:** add transaction context support ([24285e2](https://github.com/ONREZA/sqlx-js/commit/24285e28d4c3d57d84585c36b19d4bba2a16fd4b))

## [0.18.0](https://github.com/ONREZA/sqlx-js/compare/v0.17.0...v0.18.0) (2026-07-24)


### Features

* **prepare:** validate function contracts ([fa8c58a](https://github.com/ONREZA/sqlx-js/commit/fa8c58ae56a76006d6fee0d97dfb839243f68506))


### Documentation

* **roadmap:** refine planned investments ([8a5f142](https://github.com/ONREZA/sqlx-js/commit/8a5f142391e51d3970c0fae59c28e6fce86eb098))

## [0.17.0](https://github.com/ONREZA/sqlx-js/compare/v0.16.0...v0.17.0) (2026-07-24)


### ⚠ BREAKING CHANGES

* **deps:** source-scanning commands require TypeScript 5.4-6.x.
* **cli:** prepare no longer accepts --shadow-url or --migrations, and snapshot commands no longer apply migrations or read SHADOW_DATABASE_URL implicitly.
* **cli:** remove db, schema, migrate dev, and migrate verify in favor of pgschema, snapshot, dev, and verify.

### Features

* **cli:** simplify schema workflows ([89b0f66](https://github.com/ONREZA/sqlx-js/commit/89b0f66527c92aa7dc00d1cc733a67e9ed556d0c))
* **pgschema:** verify desired state in shadow ([062e22f](https://github.com/ONREZA/sqlx-js/commit/062e22f60b41910ab70e32845041edadd48314d0))


### Bug Fixes

* **cli:** align workflow boundaries ([fbd57d1](https://github.com/ONREZA/sqlx-js/commit/fbd57d1f7beeb972de880aada730eccdfc1cd3cb))


### Chores

* **deps:** update dependencies ([de8413a](https://github.com/ONREZA/sqlx-js/commit/de8413a8b16e2311ca712cc5c1f6521e5c0e90c4))

## [0.16.0](https://github.com/ONREZA/sqlx-js/compare/v0.15.0...v0.16.0) (2026-07-23)


### Features

* **profiles:** bind queries to database roles ([818df3c](https://github.com/ONREZA/sqlx-js/commit/818df3c1b46f7b73fb71af668a8a1a66f08d9bcc))

## [0.15.0](https://github.com/ONREZA/sqlx-js/compare/v0.14.0...v0.15.0) (2026-07-22)


### ⚠ BREAKING CHANGES

* **runtime:** remove getClient, setClient, and SqlClient.client. Use createSqlClient for managed execution or createClient for raw access.

### Features

* **runtime:** harden managed query lifecycle ([e0eca46](https://github.com/ONREZA/sqlx-js/commit/e0eca463091879d0efb8d59cea4e9cf72c44588e))

## [0.14.0](https://github.com/ONREZA/sqlx-js/compare/v0.13.1...v0.14.0) (2026-07-16)


### Features

* **prepare:** generate postgres enum catalog ([7c2cc12](https://github.com/ONREZA/sqlx-js/commit/7c2cc1265b16b6e59deb06779849d8309b8baaed))

## [0.13.1](https://github.com/ONREZA/sqlx-js/compare/v0.13.0...v0.13.1) (2026-07-13)


### Bug Fixes

* **prepare:** infer update returning nullability ([ee422ac](https://github.com/ONREZA/sqlx-js/commit/ee422ace0b14c5b95a6b2c500b384caca2a0a170))

## [0.13.0](https://github.com/ONREZA/sqlx-js/compare/v0.12.0...v0.13.0) (2026-07-13)


### Features

* **prepare:** infer data-modifying cte params ([83c5c86](https://github.com/ONREZA/sqlx-js/commit/83c5c869eeb3a497c8367e3d73ceb534b77fbb35))

## [0.12.0](https://github.com/ONREZA/sqlx-js/compare/v0.11.0...v0.12.0) (2026-07-12)


### Features

* **dx:** add mapped query contracts ([#20](https://github.com/ONREZA/sqlx-js/issues/20)) ([84a0124](https://github.com/ONREZA/sqlx-js/commit/84a01242ed83423bed5c3dc4649150a944a9b64b))

## [0.11.0](https://github.com/ONREZA/sqlx-js/compare/v0.10.1...v0.11.0) (2026-07-12)


### Features

* **prepare:** strengthen database validation ([157e53e](https://github.com/ONREZA/sqlx-js/commit/157e53e9609e24168f94409482205e8005685812))
* **runtime:** add end-to-end type codecs ([41db4af](https://github.com/ONREZA/sqlx-js/commit/41db4afc631bdc925e49acb7bdcb13b0a5e8b0d3))

## [0.10.1](https://github.com/ONREZA/sqlx-js/compare/v0.10.0...v0.10.1) (2026-07-12)


### Bug Fixes

* **prepare:** infer non-null expressions ([f41fb36](https://github.com/ONREZA/sqlx-js/commit/f41fb36726dc300a57089b1f6b24ce13a41e335d))

## [0.10.0](https://github.com/ONREZA/sqlx-js/compare/v0.9.2...v0.10.0) (2026-07-12)


### Features

* **dx:** improve sql integration ergonomics ([a2202a5](https://github.com/ONREZA/sqlx-js/commit/a2202a5e3f9b062118f1e040ff11419bd934c446))

## [0.9.2](https://github.com/ONREZA/sqlx-js/compare/v0.9.1...v0.9.2) (2026-07-11)


### Bug Fixes

* **prepare:** accept existential json params ([271500c](https://github.com/ONREZA/sqlx-js/commit/271500c9ef90d562960589b1554cbb167c0238b1))

## [0.9.1](https://github.com/ONREZA/sqlx-js/compare/v0.9.0...v0.9.1) (2026-07-11)


### Bug Fixes

* **types:** preserve query result inference ([b361854](https://github.com/ONREZA/sqlx-js/commit/b361854eb06cc012a440fdde88ff439f622af253))

## [0.9.0](https://github.com/ONREZA/sqlx-js/compare/v0.8.0...v0.9.0) (2026-07-11)


### Features

* **dx:** add reusable query workflows ([6a9c3be](https://github.com/ONREZA/sqlx-js/commit/6a9c3be79104c33b1d068119d6979c9006ee3a6e))

## [0.8.0](https://github.com/ONREZA/sqlx-js/compare/v0.7.0...v0.8.0) (2026-07-11)


### Features

* add named params and production CI ([#12](https://github.com/ONREZA/sqlx-js/issues/12)) ([312ef5a](https://github.com/ONREZA/sqlx-js/commit/312ef5a466f126063252d83137f68231005a00ce))

## [0.7.0](https://github.com/ONREZA/sqlx-js/compare/v0.6.0...v0.7.0) (2026-07-11)


### Features

* **dx:** improve production readiness ([#10](https://github.com/ONREZA/sqlx-js/issues/10)) ([99de05e](https://github.com/ONREZA/sqlx-js/commit/99de05e9334e839d4becbd5bf9a8a47a14da9f3d))

## [0.6.0](https://github.com/ONREZA/sqlx-js/compare/v0.5.0...v0.6.0) (2026-07-10)


### Features

* **dx:** harden production workflows ([f252cb6](https://github.com/ONREZA/sqlx-js/commit/f252cb64d4d534dd8b3c3f8706183947e48deccc))

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
