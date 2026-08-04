# Postgres.js compatibility matrix

This document compares Postgres.js 3.4.9 at upstream commit
`e7dfa14519f363229ccc3ead7b1b2f2051937efb` with the integrated sqlx-js
PostgreSQL runtime. It is a product boundary, not a promise to reproduce the
Postgres.js API.

Status values are intentionally explicit:

- `Yes` — supported by the public contract.
- `Partial` — the underlying capability exists, but the public contract or
  supported modes are narrower.
- `No` — not implemented today; it may be added when the E2E SQL contract
  justifies it.
- `No, permanent non-goal` — a deliberate permanent non-goal.

## Runtime and connection

| Capability | Postgres.js | sqlx-js | sqlx-js decision |
| --- | --- | --- | --- |
| ESM package | Yes | Yes | The only module format. |
| CommonJS package | Yes | No, permanent non-goal | Consumers must support ESM. |
| Node.js runtime | Yes | Yes | Node.js 24 or newer. |
| Bun runtime | Yes | Yes | Bun 1.3 or newer. |
| Deno runtime | Yes | Yes | Deno 2.9 or newer; covered by a built-package database smoke test. |
| Cloudflare Workers | Yes | No | Requires a separate socket/TLS adapter; the current driver uses Node-compatible sockets. |
| PostgreSQL version floor | Partial | Yes | sqlx-js deliberately requires PostgreSQL 16 or newer. |
| URL and environment connection settings | Yes | Partial | URL configuration is supported; sqlx-js does not reproduce every libpq/Postgres.js option. |
| TCP connections | Yes | Yes | Shared by prepare, migrations, and runtime. |
| Unix-domain sockets | Yes | No | Add only with a concrete deployment need. |
| TLS modes and client certificates | Yes | Yes | `disable`, `prefer`, `require`, `verify-ca`, and `verify-full`; required modes fail closed before PostgreSQL startup on negotiation or certificate failure. |
| Cleartext, MD5, and SCRAM-SHA-256 authentication | Yes | Yes | Covered by the shared wire client. |
| Dynamic password providers | Yes | Yes | A string or async `password` provider is resolved for every new connection. |
| Multiple hosts and `target_session_attrs` | Yes | No | Candidate only for deployments that cannot delegate failover to their endpoint or proxy. |
| Custom socket factory | Yes | No | A future runtime adapter boundary, not a generic public hook. |
| Startup application name and options | Yes | Yes | URL and typed client options are supported. |
| Startup PostgreSQL role | Partial | Yes | Required by generated connection profiles and reapplied to replacement generations. |
| Connect timeout covering password, TCP, TLS, and auth | Yes | Yes | One deadline covers the complete startup path. |
| TCP keepalive and initial probe delay | Yes | Yes | `keepAliveMs` explicitly enables keepalive on every new socket; `0` uses the platform default delay. Managed operation deadlines remain the correctness boundary for active work. |
| Server-side statement timeout | Yes | Yes | Supported through URL or `statementTimeoutMs`. |

## Query and protocol surface

| Capability | Postgres.js | sqlx-js | sqlx-js decision |
| --- | --- | --- | --- |
| Parameterized raw SQL strings | Yes | Yes | The primary runtime primitive. |
| Compile-time query validation and generated types | No | Yes | The core sqlx-js contract. |
| Positional `$N` parameters | Yes | Yes | Prepared and executed through the extended protocol. |
| Named `$name` parameters | No | Yes | Rewritten safely in first-use order before dispatch. |
| Tagged-template query API | Yes | No, permanent non-goal | It cannot select the exact generated query contract without owning the consumer compiler pipeline. |
| Dynamic insert/update/filter query builders | Yes | No, permanent non-goal | Dynamic SQL construction conflicts with the literal compile-time contract; use explicit SQL or application helpers above sqlx-js. |
| Automatic query batching or pipelining | Yes | No, permanent non-goal | Every connection is strictly serial so cancellation, transaction state, and failure ownership remain deterministic. |
| Unnamed extended-protocol execution | Yes | Yes | Uses `Parse`, `Describe`, `Bind`, `Execute`, and `Sync`. |
| Automatic named prepared-statement cache | Yes | No, permanent non-goal | Avoids backend-lifetime state and remains safe for session poolers without cache invalidation machinery. |
| Public query description | Yes | Partial | `prepare` and the internal runtime use `Describe`; no raw public `.describe()` API exists. |
| Lazy pending query and explicit `.execute()` | Yes | Partial | Raw `createClient().unsafe()` queries are lazy and expose `.execute()`; ordinary managed typed calls return native promises and dispatch through the managed lifecycle. |
| Query cancellation | Yes | Yes | Raw pending queries expose `.cancel()`. Managed typed queries bind `AbortSignal` through `sql.with(...)`; a dispatched interruption still reports an unknown outcome and is never replayed. |
| Automatic replay after connection loss | No | No, permanent non-goal | A statement with an unknown outcome is never replayed automatically. |
| Reconnect for later operations | Yes | Yes | A broken raw connection is discarded; managed clients also replace poisoned generations. |
| Object rows | Yes | Yes | Output names must be unique. |
| Rows as value arrays | Yes | Yes | Available through raw pending-query `.values()`. |
| Raw binary-buffer rows | Yes | No | Candidate only if a measured binary or zero-copy use case justifies it. |
| Command and affected-row metadata | Yes | Yes | `command` and `count` are preserved as non-enumerable result metadata. |
| Column, statement, and connection-state result metadata | Yes | No | Not part of the typed application query contract. |
| SQL files | Yes | Yes | Root-relative, compile-time checked, and optionally embedded for bundled deployments. |
| Multiple statements in one call | Yes | No | Requires a sound statement splitter or simple-query surface; tracked on the roadmap. |
| Cursor and chunked result iteration | Yes | No | Planned only with typed backpressure and connection-lifecycle semantics. |
| Row-by-row `forEach` iteration | Yes | No | Belongs to the same future cursor surface. |
| `COPY FROM/TO` streams | Yes | No | Unsupported COPY protocol responses fail fast and discard the connection; a future streaming API requires explicit ownership and runtime-specific adapters. |

## Pooling, transactions, and reliability

| Capability | Postgres.js | sqlx-js | sqlx-js decision |
| --- | --- | --- | --- |
| Lazy connection pool | Yes | Yes | Connections are opened on demand up to `max`. |
| Bounded pool size and FIFO wait queue | Yes | Yes | One lease per operation; queued work continues after query errors. |
| Idle connection eviction | Yes | Yes | Configured in milliseconds through `idleTimeoutMs`; `0` disables it. |
| Maximum connection lifetime | Yes | Yes | Configured in milliseconds through `maxLifetimeMs`; active work finishes before retirement. |
| Public connection reservation | Yes | No, permanent non-goal | Transactions reserve internally; exposing a retained raw lease would bypass managed generation ownership. |
| Pool shutdown | Yes | Yes | Rejects admission and interrupts connections, including an in-progress startup. |
| Idle connections allow natural process exit | No | Yes | Idle sockets and retirement timers are unreferenced; active work remains referenced. |
| Managed bounded shutdown | No | Yes | `createSqlClient().close()` applies grace and force deadlines. |
| `BEGIN` / `COMMIT` / `ROLLBACK` callback | Yes | Yes | A transaction owns one connection until completion. |
| Concurrent calls inside one transaction | Partial | Yes | sqlx-js serializes them on the reserved connection in call order. |
| Isolation, read-only, and deferrable options | Yes | Yes | Applied immediately after `BEGIN`. |
| Nested savepoint callback | Yes | Yes | Typed callbacks recover ordinary PostgreSQL errors with `ROLLBACK TO`; timeout, abort, and connection loss remain terminal for the outer transaction. |
| Two-phase `PREPARE TRANSACTION` helper | Yes | No | Raw SQL remains possible; no dedicated high-level API is planned today. |
| Transaction-local RLS settings contract | No | Yes | Generated profiles require and apply the exact setting allowlist. |
| End-to-end operation and transaction deadlines | No | Yes | Includes pool wait, codec bootstrap, execution, and transaction cleanup. |
| Poisoned-generation single-flight replacement | No | Yes | All collateral operations are rejected; no SQL is replayed. |
| Runtime lifecycle and query observers | Partial | Yes | Dedicated lifecycle events expose stable IDs, profile/role, generation transitions, timeout/failure phase, and outcome without SQL, parameters, URLs, credentials, or certificate objects; the separate source-level `onQuery` hook remains caller-redacted. |
| Structured PostgreSQL notice callback | Yes | Yes | `onNotice` receives message, severity, SQLSTATE, detail, and hint without owning protocol flow. |

## Types and adjacent PostgreSQL features

| Capability | Postgres.js | sqlx-js | sqlx-js decision |
| --- | --- | --- | --- |
| Explicit JSON and PostgreSQL array parameters | Yes | Yes | `sql.json(...)` and `sql.array(...)` keep representations unambiguous. |
| Built-in scalar and array codecs | Yes | Yes | Includes `int8` as `bigint` and the sqlx-js PostgreSQL type table. |
| Native `bigint` for PostgreSQL `int8` | Partial | Yes | sqlx-js never silently narrows `int8` to `number` or exposes it as a decimal string. |
| Temporal infinity values | Partial | Yes | The default `PgTemporal` preserves both infinities; an explicit generator/runtime policy can instead reject them and expose `Date`. |
| Automatic database array-OID discovery | Yes | Yes | Managed generations discover database-local scalar and array OIDs once. |
| Numeric-OID custom codecs | Yes | Yes | Available on raw and managed clients. |
| Name-based custom codec discovery | No | Yes | Managed clients bind generated custom type names to database-local OIDs. |
| Enum, domain, composite, and extension codecs | Partial | Yes | Generated registry and runtime bootstrap share the same type contract. |
| Global key/value transforms | Yes | No, permanent non-goal | Application/domain mapping should remain explicit and outside the wire driver. |
| `undefined` transformation policy | Yes | No, permanent non-goal | `undefined` is not a database value policy; callers must choose SQL `NULL` or omit data before query execution. |
| `LISTEN` / `NOTIFY` | Yes | No | Useful but requires a dedicated long-lived connection lifecycle; tracked on the roadmap. |
| Logical replication subscribe API | Yes | No | Outside the compile-time query contract unless a concrete consumer establishes ownership requirements. |
| CJS/Deno source duplication | Partial | No, permanent non-goal | sqlx-js ships one ESM source and relies on supported runtime compatibility. |

## Replacement gate

Removing Postgres.js from the dependency graph is not by itself the completion
criterion. The integrated driver is ready to replace it only when:

1. Node, Bun, and Deno built-package database smokes pass;
2. cancellation, connection loss, reconnect, pool queueing, transaction
   serialization, startup interruption, and bounded close fault tests pass;
3. idle eviction and maximum connection lifetime pass live backend-retirement
   tests;
4. the complete sqlx-js unit and PostgreSQL integration suites pass;
5. CI TCP blackhole and PostgreSQL restart chaos tests prove bounded
   recovery without replay, leaked backends, or leaked file descriptors;
6. any intentionally unsupported Postgres.js surface is represented above as
   either `No` or `No, permanent non-goal`.

`bun run benchmark:postgres` compares both the managed and raw integrated
clients with the pinned Postgres.js 3.4.9 development reference. The default
comparison does not configure an operation deadline because the reference
client has no equivalent end-to-end deadline. It disables named prepared
statements for both clients, uses `max_pipeline: 1` as the strict serial
control, and keeps the Postgres.js default for the separate pipelined scenario.
It alternates execution order and reports multi-round throughput plus
p50/p95/p99 latency. `SQLX_JS_BENCHMARK_SCENARIO` and
`SQLX_JS_BENCHMARK_DRIVER` select one named case for profiling. Benchmark
results are observational and never act as a correctness gate.
