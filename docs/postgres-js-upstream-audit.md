# Postgres.js open issue and pull request audit

Audit date: 2026-07-24.

The upstream snapshot contained 269 open items: 226 issues and 43 pull
requests. Every item was first classified by surface area. Protocol,
connection, pool, transaction, type, runtime, and observability items received
individual review; tagged builders, transforms, cursor/COPY, subscription, and
runtime-port items were then evaluated against the explicit
[feature matrix](./postgres-js-feature-matrix.md).

This is not a plan to reproduce Postgres.js. An upstream fix is adopted only
when it improves the sqlx-js E2E PostgreSQL contract without importing an
intentionally rejected surface.

## Adopted reliability and DX behavior

| Upstream items | Risk or request | sqlx-js resolution |
| --- | --- | --- |
| [#1182](https://github.com/porsager/postgres/issues/1182) | `int8` is exposed as a decimal string. | All PostgreSQL `int8` values, including `row_number()`, decode to native `bigint`. |
| [#1179](https://github.com/porsager/postgres/issues/1179), [#1180](https://github.com/porsager/postgres/pull/1180) | A clean close during startup can create an infinite reconnect stampede. | Connection establishment never retries internally. The accepted operation rejects once; a later operation may open a new connection. A fault test verifies one clean rejection produces exactly one attempt. |
| [#1181](https://github.com/porsager/postgres/issues/1181), [#1119](https://github.com/porsager/postgres/issues/1119), [#1120](https://github.com/porsager/postgres/pull/1120), [#795](https://github.com/porsager/postgres/issues/795) | A failed pipelined query can leak its row counter into the next result and create sparse arrays. | There is no per-connection pipelining. Rows and metadata are local to one serial protocol cycle, and queued work is regression-tested after a query error. |
| [#1154](https://github.com/porsager/postgres/issues/1154), [#1168](https://github.com/porsager/postgres/pull/1168), [#1066](https://github.com/porsager/postgres/issues/1066) | A deferred write can run after the socket was cleared and crash the process. | The integrated driver has no deferred write queue. Close marks the client terminal, rejects protocol waiters, and destroys the socket before another operation can use it. |
| [#1133](https://github.com/porsager/postgres/issues/1133), [#1155](https://github.com/porsager/postgres/pull/1155) | A transaction-scoped client can reconnect and execute later statements outside its transaction. | Only root pool operations may reconnect. Once `BEGIN` succeeds, every transaction statement, `COMMIT`, and `ROLLBACK` is bound to that exact connection; loss makes the scoped client terminal. A live test proves a post-loss write never executes. |
| [#1130](https://github.com/porsager/postgres/issues/1130), [#1097](https://github.com/porsager/postgres/issues/1097), [#1142](https://github.com/porsager/postgres/pull/1142) | `end()` can wait forever after ECONNRESET or backend termination. | Pool shutdown destroys every slot and settles all queues, authentication failures, TLS negotiation, and stalled dynamic-password waits. Live and fault tests bound shutdown after backend termination and during startup. |
| [#1090](https://github.com/porsager/postgres/issues/1090) | Resolving at `CommandComplete` can miss a deferred error delivered before `ReadyForQuery`. | Extended-protocol queries collect the entire cycle through `ReadyForQuery` and reject any `ErrorResponse`, including one after `CommandComplete`. |
| [#1082](https://github.com/porsager/postgres/issues/1082), [#729](https://github.com/porsager/postgres/issues/729) | Parameter/build failures can settle the wrong pipelined promise or leave a transaction promise pending. | Each query owns its lazy promise and connections are serial. `undefined` fails locally with an actionable error, the transaction rolls back, and the pool remains usable. |
| [#455](https://github.com/porsager/postgres/issues/455), [#513](https://github.com/porsager/postgres/issues/513) | Catching a database error inside a callback can obscure transaction failure. | The driver verifies that PostgreSQL returned `COMMIT`, not its automatic `ROLLBACK` tag, before returning callback success. |
| [#1089](https://github.com/porsager/postgres/issues/1089), [#824](https://github.com/porsager/postgres/issues/824), [#827](https://github.com/porsager/postgres/issues/827) | Half-open sockets and pool admission can leave application operations pending forever. | Managed operation and transaction deadlines include codec bootstrap, pool wait, connection startup, execution, and cleanup. Timeout poisons and replaces the generation without replay. |
| [#789](https://github.com/porsager/postgres/issues/789), [#1081](https://github.com/porsager/postgres/pull/1081) | First-query type discovery races application query encoding. | Runtime codec bootstrap is single-flight per generation and completes before any application query dispatch. |
| [#903](https://github.com/porsager/postgres/issues/903), [#952](https://github.com/porsager/postgres/issues/952) | Transactions repeatedly fetch array type metadata. | Database-local type discovery runs once per managed pool generation, not once per transaction or connection. |
| [#1049](https://github.com/porsager/postgres/issues/1049), [#1124](https://github.com/porsager/postgres/issues/1124) | SQL `NULL` array elements become `NaN` or the string `"NULL"`. | The shared array parser preserves unquoted SQL `NULL` as JavaScript `null`, including nested arrays and `array_agg`. |
| [#728](https://github.com/porsager/postgres/issues/728) | PostgreSQL temporal infinity becomes an invalid `Date`. | Generated and runtime contracts use `PgTemporal = Date \| "infinity" \| "-infinity"` and preserve both literals. |
| [#869](https://github.com/porsager/postgres/issues/869) | Idle pool sockets prevent natural process exit. | Idle sockets and retirement timers are unreferenced and are referenced again when leased. Packed Node and Bun smokes verify natural exit without `end()`. |
| [#881](https://github.com/porsager/postgres/issues/881) | Rotating credentials need a fresh secret at reconnect. | `password` accepts a string or async provider and is resolved for every new connection. Dynamic usernames remain a separate candidate. |
| [#1057](https://github.com/porsager/postgres/issues/1057), [#1127](https://github.com/porsager/postgres/pull/1127) | Hand-written URL parsing mishandles encoded hosts and IPv6. | Connection URLs use the platform `URL` parser, decode host names, and normalize bracketed IPv6 before opening the socket. |
| [#1063](https://github.com/porsager/postgres/issues/1063) | Notice suppression and typing are inconsistent. | sqlx-js is silent by default and exposes one typed `onNotice` callback with message, severity, SQLSTATE, detail, and hint. Observer failures cannot alter protocol state. |
| [#1171](https://github.com/porsager/postgres/issues/1171), [#461](https://github.com/porsager/postgres/issues/461), [#1051](https://github.com/porsager/postgres/pull/1051) | APM integration otherwise requires monkey-patching driver internals. | Managed clients already expose stable query IDs, query/transaction completion, timeout phase/outcome, role/profile, generation changes, and isolated hook errors on Node, Bun, and Deno. |
| [#960](https://github.com/porsager/postgres/issues/960), [#943](https://github.com/porsager/postgres/issues/943) | Named prepared statements conflict with transaction poolers or leak into simple-query behavior. | Runtime queries use unnamed extended-protocol statements only. There is no server-side prepared-statement cache or `prepare` mode switch. |

## Deliberately avoided bug classes

The following clusters are not ported because their owning API is a permanent
non-goal:

| Cluster | Representative upstream items | Decision |
| --- | --- | --- |
| Tagged templates and dynamic builders | [#813](https://github.com/porsager/postgres/issues/813), [#1019](https://github.com/porsager/postgres/issues/1019), [#1071](https://github.com/porsager/postgres/issues/1071), [#1126](https://github.com/porsager/postgres/issues/1126), [#1165](https://github.com/porsager/postgres/pull/1165) | Keep literal function-call SQL and compile-time query identity. |
| Automatic pipelining and partial transaction pipelines | [#951](https://github.com/porsager/postgres/issues/951), [#966](https://github.com/porsager/postgres/issues/966), [#1082](https://github.com/porsager/postgres/issues/1082), [#1181](https://github.com/porsager/postgres/issues/1181) | Keep one serial protocol cycle per connection. |
| Implicit value/column/JSON transforms | [#983](https://github.com/porsager/postgres/issues/983), [#1038](https://github.com/porsager/postgres/issues/1038), [#1157](https://github.com/porsager/postgres/issues/1157), [#1169](https://github.com/porsager/postgres/pull/1169) | Keep application/domain mapping explicit; do not mutate JSON keys in the driver. |
| Public connection reservation | [#713](https://github.com/porsager/postgres/issues/713), [#751](https://github.com/porsager/postgres/issues/751), [#925](https://github.com/porsager/postgres/issues/925), [#1116](https://github.com/porsager/postgres/pull/1116) | Reserve only inside transactions so callers cannot bypass generation ownership. |
| Automatic named statement caching | [#960](https://github.com/porsager/postgres/issues/960), [#943](https://github.com/porsager/postgres/issues/943) | Use unnamed statements permanently. |
| CJS and generated runtime copies | Deno/CJS duplication visible across many open PRs, including [#771](https://github.com/porsager/postgres/pull/771), [#1034](https://github.com/porsager/postgres/pull/1034), and [#1138](https://github.com/porsager/postgres/pull/1138) | Ship one ESM source for supported runtimes. |

Cursor, COPY, `LISTEN`/`NOTIFY`, and logical replication bugs were reviewed but
do not affect the current driver because those public surfaces do not exist.
They remain explicit `Нет` items in the feature matrix rather than accidental
omissions. Their representative reliability fixes include
[#1016](https://github.com/porsager/postgres/pull/1016),
[#1167](https://github.com/porsager/postgres/pull/1167), and
[#1183](https://github.com/porsager/postgres/pull/1183).

## Follow-up candidates

These items improve a supported or plausible future boundary but require a
separate design and verification pass:

| Upstream item | Candidate | Boundary before adoption |
| --- | --- | --- |
| [#1008](https://github.com/porsager/postgres/pull/1008) | SCRAM-SHA-256-PLUS channel binding | Implement without a heavy X.509 dependency and verify against TLS endpoints that both offer and omit PLUS. |
| [#993](https://github.com/porsager/postgres/issues/993), [#1177](https://github.com/porsager/postgres/pull/1177) | PostgreSQL 17 direct TLS negotiation | Preserve every `sslmode` verification guarantee and fallback rule. |
| [#881](https://github.com/porsager/postgres/issues/881), [#882](https://github.com/porsager/postgres/pull/882) | Dynamic username/database providers | Define atomic credential snapshots so username and password cannot rotate out of sync. |
| [#1095](https://github.com/porsager/postgres/issues/1095) | GSSAPI | Requires an explicit enterprise deployment and cross-runtime ownership decision. |
| [#737](https://github.com/porsager/postgres/issues/737), [#950](https://github.com/porsager/postgres/issues/950) | Unix-domain sockets | Add when a real deployment needs them; keep URL parsing and TLS behavior unambiguous. |
| [#955](https://github.com/porsager/postgres/pull/955), [#1109](https://github.com/porsager/postgres/pull/1109) | Cloudflare/edge socket adapter | Reuse the same protocol state machine; do not fork a second generated driver copy. |

## Audit closure rule

The audit is complete for this upstream snapshot when every open item is
covered by one of:

1. an adopted behavior with a sqlx-js regression test;
2. an explicit matrix row marked `Нет` or `Нет и не будет`;
3. a follow-up candidate with a named design boundary;
4. a Postgres.js-only implementation detail that cannot occur because its
   owning surface is absent.

Future audits should compare issue/PR numbers newer than 1183 and revisit older
items only when sqlx-js expands a currently absent surface.
