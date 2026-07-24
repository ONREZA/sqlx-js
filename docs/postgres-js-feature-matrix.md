# Postgres.js compatibility matrix

This document compares Postgres.js 3.4.9 at upstream commit
`e7dfa14519f363229ccc3ead7b1b2f2051937efb` with the integrated sqlx-js
PostgreSQL runtime. It is a product boundary, not a promise to reproduce the
Postgres.js API.

Status values are intentionally explicit:

- `Да` — supported by the public contract.
- `Частично` — the underlying capability exists, but the public contract or
  supported modes are narrower.
- `Нет` — not implemented today; it may be added when the E2E SQL contract
  justifies it.
- `Нет и не будет` — a deliberate permanent non-goal.

## Runtime and connection

| Capability | Postgres.js | sqlx-js | sqlx-js decision |
| --- | --- | --- | --- |
| ESM package | Да | Да | The only module format. |
| CommonJS package | Да | Нет и не будет | Consumers must support ESM. |
| Node.js runtime | Да | Да | Node.js 24 or newer. |
| Bun runtime | Да | Да | Bun 1.3 or newer. |
| Deno runtime | Да | Да | Deno 2.9 or newer; covered by a built-package database smoke test. |
| Cloudflare Workers | Да | Нет | Requires a separate socket/TLS adapter; the current driver uses Node-compatible sockets. |
| PostgreSQL version floor | Частично | Да | sqlx-js deliberately requires PostgreSQL 16 or newer. |
| URL and environment connection settings | Да | Частично | URL configuration is supported; sqlx-js does not reproduce every libpq/Postgres.js option. |
| TCP connections | Да | Да | Shared by prepare, migrations, and runtime. |
| Unix-domain sockets | Да | Нет | Add only with a concrete deployment need. |
| TLS modes and client certificates | Да | Да | `disable`, `prefer`, `require`, `verify-ca`, and `verify-full`. |
| Cleartext, MD5, and SCRAM-SHA-256 authentication | Да | Да | Covered by the shared wire client. |
| Dynamic password providers | Да | Да | A string or async `password` provider is resolved for every new connection. |
| Multiple hosts and `target_session_attrs` | Да | Нет | Candidate only for deployments that cannot delegate failover to their endpoint or proxy. |
| Custom socket factory | Да | Нет | A future runtime adapter boundary, not a generic public hook. |
| Startup application name and options | Да | Да | URL and typed client options are supported. |
| Startup PostgreSQL role | Частично | Да | Required by generated connection profiles and reapplied to replacement generations. |
| Connect timeout covering TCP, TLS, and auth | Да | Да | One deadline covers the complete startup path. |
| Server-side statement timeout | Да | Да | Supported through URL or `statementTimeoutMs`. |

## Query and protocol surface

| Capability | Postgres.js | sqlx-js | sqlx-js decision |
| --- | --- | --- | --- |
| Parameterized raw SQL strings | Да | Да | The primary runtime primitive. |
| Compile-time query validation and generated types | Нет | Да | The core sqlx-js contract. |
| Positional `$N` parameters | Да | Да | Prepared and executed through the extended protocol. |
| Named `$name` parameters | Нет | Да | Rewritten safely in first-use order before dispatch. |
| Tagged-template query API | Да | Нет и не будет | It cannot select the exact generated query contract without owning the consumer compiler pipeline. |
| Dynamic insert/update/filter query builders | Да | Нет и не будет | Dynamic SQL construction conflicts with the literal compile-time contract; use explicit SQL or application helpers above sqlx-js. |
| Automatic query batching or pipelining | Да | Нет и не будет | Every connection is strictly serial so cancellation, transaction state, and failure ownership remain deterministic. |
| Unnamed extended-protocol execution | Да | Да | Uses `Parse`, `Describe`, `Bind`, `Execute`, and `Sync`. |
| Automatic named prepared-statement cache | Да | Нет и не будет | Avoids backend-lifetime state and remains safe for session poolers without cache invalidation machinery. |
| Public query description | Да | Частично | `prepare` and the internal runtime use `Describe`; no raw public `.describe()` API exists. |
| Lazy pending query and explicit `.execute()` | Да | Да | Awaiting or calling `.execute()` dispatches the query. |
| Query cancellation | Да | Да | Uses PostgreSQL `CancelRequest`; managed deadlines still report an unknown outcome after dispatch. |
| Automatic replay after connection loss | Нет | Нет и не будет | A statement with an unknown outcome is never replayed automatically. |
| Reconnect for later operations | Да | Да | A broken raw connection is discarded; managed clients also replace poisoned generations. |
| Object rows | Да | Да | Output names must be unique. |
| Rows as value arrays | Да | Да | Available through raw pending-query `.values()`. |
| Raw binary-buffer rows | Да | Нет | Candidate only if a measured binary or zero-copy use case justifies it. |
| Command and affected-row metadata | Да | Да | `command` and `count` are preserved as non-enumerable result metadata. |
| Column, statement, and connection-state result metadata | Да | Нет | Not part of the typed application query contract. |
| SQL files | Да | Да | Root-relative, compile-time checked, and optionally embedded for bundled deployments. |
| Multiple statements in one call | Да | Нет | Requires a sound statement splitter or simple-query surface; tracked on the roadmap. |
| Cursor and chunked result iteration | Да | Нет | Planned only with typed backpressure and connection-lifecycle semantics. |
| Row-by-row `forEach` iteration | Да | Нет | Belongs to the same future cursor surface. |
| `COPY FROM/TO` streams | Да | Нет | Unsupported COPY protocol responses fail fast and discard the connection; a future streaming API requires explicit ownership and runtime-specific adapters. |

## Pooling, transactions, and reliability

| Capability | Postgres.js | sqlx-js | sqlx-js decision |
| --- | --- | --- | --- |
| Lazy connection pool | Да | Да | Connections are opened on demand up to `max`. |
| Bounded pool size and FIFO wait queue | Да | Да | One lease per operation; queued work continues after query errors. |
| Idle connection eviction | Да | Да | Configured in milliseconds through `idleTimeoutMs`; `0` disables it. |
| Maximum connection lifetime | Да | Да | Configured in milliseconds through `maxLifetimeMs`; active work finishes before retirement. |
| Public connection reservation | Да | Нет и не будет | Transactions reserve internally; exposing a retained raw lease would bypass managed generation ownership. |
| Pool shutdown | Да | Да | Rejects admission and interrupts connections, including an in-progress startup. |
| Idle connections allow natural process exit | Нет | Да | Idle sockets and retirement timers are unreferenced; active work remains referenced. |
| Managed bounded shutdown | Нет | Да | `createSqlClient().close()` applies grace and force deadlines. |
| `BEGIN` / `COMMIT` / `ROLLBACK` callback | Да | Да | A transaction owns one connection until completion. |
| Concurrent calls inside one transaction | Частично | Да | sqlx-js serializes them on the reserved connection in call order. |
| Isolation, read-only, and deferrable options | Да | Да | Applied immediately after `BEGIN`. |
| Nested savepoint callback | Да | Нет | Add when the typed transaction API defines failure and cancellation semantics. |
| Two-phase `PREPARE TRANSACTION` helper | Да | Нет | Raw SQL remains possible; no dedicated high-level API is planned today. |
| Transaction-local RLS settings contract | Нет | Да | Generated profiles require and apply the exact setting allowlist. |
| End-to-end operation and transaction deadlines | Нет | Да | Includes pool wait, codec bootstrap, execution, and transaction cleanup. |
| Poisoned-generation single-flight replacement | Нет | Да | All collateral operations are rejected; no SQL is replayed. |
| Runtime lifecycle and query observers | Частично | Да | Stable query IDs, profile/role, generation transitions, timeout phase, and outcome are exposed. |
| Structured PostgreSQL notice callback | Да | Да | `onNotice` receives message, severity, SQLSTATE, detail, and hint without owning protocol flow. |

## Types and adjacent PostgreSQL features

| Capability | Postgres.js | sqlx-js | sqlx-js decision |
| --- | --- | --- | --- |
| Explicit JSON and PostgreSQL array parameters | Да | Да | `sql.json(...)` and `sql.array(...)` keep representations unambiguous. |
| Built-in scalar and array codecs | Да | Да | Includes `int8` as `bigint` and the sqlx-js PostgreSQL type table. |
| Native `bigint` for PostgreSQL `int8` | Частично | Да | sqlx-js never silently narrows `int8` to `number` or exposes it as a decimal string. |
| Temporal infinity values | Частично | Да | `PgTemporal` preserves `infinity` and `-infinity` instead of constructing an invalid `Date`. |
| Automatic database array-OID discovery | Да | Да | Managed generations discover database-local scalar and array OIDs once. |
| Numeric-OID custom codecs | Да | Да | Available on raw and managed clients. |
| Name-based custom codec discovery | Нет | Да | Managed clients bind generated custom type names to database-local OIDs. |
| Enum, domain, composite, and extension codecs | Частично | Да | Generated registry and runtime bootstrap share the same type contract. |
| Global key/value transforms | Да | Нет и не будет | Application/domain mapping should remain explicit and outside the wire driver. |
| `undefined` transformation policy | Да | Нет и не будет | `undefined` is not a database value policy; callers must choose SQL `NULL` or omit data before query execution. |
| `LISTEN` / `NOTIFY` | Да | Нет | Useful but requires a dedicated long-lived connection lifecycle; tracked on the roadmap. |
| Logical replication subscribe API | Да | Нет | Outside the compile-time query contract unless a concrete consumer establishes ownership requirements. |
| CJS/Deno source duplication | Частично | Нет и не будет | sqlx-js ships one ESM source and relies on supported runtime compatibility. |

## Replacement gate

Removing Postgres.js from the dependency graph is not by itself the completion
criterion. The integrated driver is ready to replace it only when:

1. Node, Bun, and Deno built-package database smokes pass;
2. cancellation, connection loss, reconnect, pool queueing, transaction
   serialization, startup interruption, and bounded close fault tests pass;
3. idle eviction and maximum connection lifetime pass live backend-retirement
   tests;
4. the complete sqlx-js unit and PostgreSQL integration suites pass;
5. any intentionally unsupported Postgres.js surface is represented above as
   either `Нет` or `Нет и не будет`.
