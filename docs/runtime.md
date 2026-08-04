# Runtime and clients

Transactions, managed and raw clients, dynamic escape hatches, migrations, lifecycle APIs, errors, and runtime options.

The preferred application boundary is the user-owned `db.ts` created by
`sqlx-js init`. It imports the generated registry and runtime descriptors, so
parameterized prepared queries use the one-write path without runtime
filesystem discovery.

## Per-query options

`sql.with({ timeoutMs, signal })` keeps request-scoped execution controls out
of SQL parameters while preserving the generated query type:

```ts
const requestSql = db.sql.with({
  timeoutMs: 2_000,
  signal: request.signal,
});
const rows = await requestSql(
  `SELECT id FROM jobs WHERE owner_id = $1`,
  ownerId,
);
```

The bound executor also exposes `.one`, `.optional`, `.execute`, and `.file`.
It may be retained in a local `const` for one request. Chained `.with(...)`
calls merge options and later values override earlier ones, so a query-specific
timeout does not discard an already-bound request signal. Options are captured
when the executor is created. Explicit execution options from `defineQuery`
use the same merge rule. A bound `timeoutMs` overrides the client's
`operationTimeoutMs` for that query; omitting it preserves the client default.

The bound executor can be used inside a transaction as `tx.with(...)`;
interruption then expires the whole transaction rather than allowing later
statements to run on an uncertain connection state. The managed runtime is
required because a structural third-party executor cannot honor these
lifecycle guarantees.

## `sql.transaction(fn)`

Wrap a function body in a database transaction. The callback receives a scoped `tx` that has the same typed `()` and `.file()` surface, but routes through the transaction's dedicated connection. The scanner recognises the callback parameter name and validates inner queries against `KnownQueries`.

```ts
import { db } from "./db.js";

const { userId, postId } = await db.sql.transaction(async (tx) => {
  const u = await tx(
    `INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id AS "id!"`,
    "Alice", "alice@example.com",
  );
  const p = await tx(
    `INSERT INTO posts (user_id, title) VALUES ($1, $2) RETURNING id AS "id!"`,
    u[0].id, "Hello",
  );
  return { userId: u[0].id, postId: p[0].id };
});
```

If the callback throws, the transaction is rolled back. The return value of the callback becomes the return value of `transaction`.

### Typed savepoints

Transaction executors expose recursively typed savepoints:

```ts
await db.sql.transaction(async (tx) => {
  await tx.savepoint(async (sp) => {
    await sp.execute(
      `INSERT INTO audit_log (message) VALUES ($1)`,
      "created",
    );
  });
});
```

A successful callback releases the savepoint. If the callback throws, or a
PostgreSQL statement fails even when the callback catches that error, the
runtime issues `ROLLBACK TO SAVEPOINT` and then releases it. This restores the
transaction to a usable state without hiding the callback error.

Await every `savepoint(...)` call, and issue work through the executor passed to
the currently active callback (`sp`, or its nested child). Parent and completed
scoped executors reject new work so queries cannot escape their savepoint or
transaction ownership boundary.

Timeouts, aborts, and connection loss remain terminal for the outer
transaction. They skip savepoint recovery because a dispatched statement may
have an unknown outcome. Nested savepoints use the same rule and stay on the
transaction's single owned connection. These semantics follow PostgreSQL's
[`SAVEPOINT`](https://www.postgresql.org/docs/current/sql-savepoint.html) and
[`ROLLBACK TO SAVEPOINT`](https://www.postgresql.org/docs/current/sql-rollback-to.html)
behavior.

## `unsafe(query, ...params)`

Same runtime as `sql` but without type-checking. For dynamic SQL where compile-time validation isn't possible.

## `sql.id(...parts)` / `id(...parts)`

Quote a dynamic identifier only if it exists in the generated schema snapshot. This is for the narrow cases where a table, column, function, type, index, or constraint name must be chosen dynamically.

```ts
import { db } from "./db.js";

const orderBy = db.sql.id("users", "created_at");
await db.unsafe(`SELECT id, email FROM ${db.sql.id("users")} ORDER BY ${orderBy} DESC`);
```

The default snapshot path is `.sqlx-js/schema/schema.json`. Override it at runtime with `SQLX_JS_SCHEMA_PATH`. `sql.id(...)` accepts one to three identifier segments. Pass schema-qualified identifiers as separate segments: `sql.id("public", "users")`, not `sql.id("public.users")`.

## `migrate(options)`

Apply pending migrations from application startup with a PostgreSQL advisory lock. Safe to call from multiple replicas.

```ts
import { migrate } from "@onreza/sqlx-js";

await migrate({ dir: "./migrations" });
```

Options:

```ts
type MigrateOptions = {
  dir?: string;
  databaseUrl?: string;
  log?: (msg: string) => void;
  lockKey?: number | bigint;     // overrides DEFAULT_MIGRATE_LOCK_KEY
  lockTimeoutMs?: number;        // pg_try_advisory_lock + polling; default: block
};
```

When `lockTimeoutMs` is set, acquisition uses `pg_try_advisory_lock` in a polling loop and throws if not obtained within the timeout — useful for CI / multi-replica startup to avoid an indefinitely-blocked pod.

## Managed and raw clients

`createSqlClient(...)` owns generations of the integrated connection pool. It
applies operation deadlines, replaces poisoned generations, initializes
runtime codecs, exposes lifecycle state, and performs bounded shutdown. It
deliberately does not expose its raw pool because a retained raw reference
would bypass generation replacement.

TLS configuration belongs to the pool factory and is reapplied to every slot
in every generation. `require`, `verify-ca`, and `verify-full` never dispatch
PostgreSQL startup, authentication, codec discovery, or application SQL until
TLS succeeds; they never downgrade after a negotiation or certificate failure.
A failed or timed-out operation is not replayed during slot replacement or
managed generation recycling.

`createClient(...)` is the explicit raw wire-client escape hatch. It preserves
sqlx-js's built-in bigint and PostgreSQL array codecs, reconnects subsequent
operations after a broken connection, and exposes the integrated pool directly.
It has no managed deadline, generation recovery, lifecycle observers, or
name-based `typeCodecs` guarantees. The caller owns its queries and `end()`
lifecycle.

Upgrading from `0.19.x` requires application changes. See the detailed
[0.20.0 upgrade guide](./upgrades/0.20.0.md) for driver-option migration,
runtime behavior, rollout, and verification.

For dependency injection, read replicas, tests, or several independent pools in one process, create independent managed clients:

```ts
import { createSqlClient } from "@onreza/sqlx-js";
import type { SqlxJsGeneratedRegistry } from "./sqlx-js-env.js";
import queryDescriptors from "./.sqlx-js/runtime-descriptors.json" with { type: "json" };

const primary = createSqlClient<SqlxJsGeneratedRegistry>(
  process.env.DATABASE_URL,
  { queryDescriptors },
);
const replica = createSqlClient<SqlxJsGeneratedRegistry>(
  process.env.REPLICA_DATABASE_URL,
  { execution: "adaptive" },
);

await Promise.all([
  primary.ready({ timeoutMs: 5_000 }),
  replica.ready({ timeoutMs: 5_000 }),
]);

await primary.sql(`INSERT INTO audit_log (message) VALUES ($1)`, "created");
const rows = await replica.sql(`SELECT id, message FROM audit_log ORDER BY id DESC`);

await Promise.all([
  primary.close({ graceMs: 5_000, forceAfterMs: 10_000 }),
  replica.close({ graceMs: 5_000, forceAfterMs: 10_000 }),
]);
```

Each generated `sqlx-js-env.d.ts` exports its own `SqlxJsGeneratedRegistry`. Passing it to `createSqlClient<...>()` keeps a scoped client on that project's query contract even when a monorepo TypeScript program includes declarations for several databases. The global `sql` export remains as a deprecated migration convenience path. Call `configureDefaultTemporalApi(Temporal)` before its first query or lifecycle operation when the runtime has no compatible `globalThis.Temporal`.

When a workspace package exports database source to other TypeScript programs, bind `SqlxJsGeneratedRegistry` at that package's client boundary. A consumer does not automatically include the database package's ambient `.d.ts`; exporting an unscoped client can therefore collapse its literal parameters to `never` outside the package.

The scanner recognizes clients assigned directly from an imported `createSqlClient(...)` (including aliased and namespace imports), so `client.sql(...)`, its cardinality helpers, file queries, and transactions participate in `prepare` exactly like the global `sql` surface.

## Prepared runtime descriptors

`prepare` derives `.sqlx-js/runtime-descriptors.json` for parameterized known
queries from the canonical per-query cache. Parameterless queries already use
one write and need no descriptor. Import the JSON explicitly and pass it to
each managed client that should use the one-write parameter path:

```ts
import { createSqlClient } from "@onreza/sqlx-js";
import type { SqlxJsGeneratedRegistry } from "./sqlx-js-env.js";
import queryDescriptors from "./.sqlx-js/runtime-descriptors.json" with { type: "json" };

const db = createSqlClient<SqlxJsGeneratedRegistry>(
  process.env.DATABASE_URL,
  { queryDescriptors },
);
await db.ready({ timeoutMs: 5_000 });
```

There is no runtime filesystem lookup. The JSON is a generated, committed
artifact and works with the supported Node, Bun, and Deno baselines. For a
profiled client, pass the same JSON together with the exact generated profile;
the runtime selects that profile's query map and verifies its PostgreSQL role.

For a matching query, built-in type OIDs are used directly. Database-local
types are stored as schema-qualified names and resolved once per pool
generation before application SQL is dispatched. Calling `ready()` during
startup makes a missing database-local type fail before the instance accepts
traffic. The descriptor contains parameter metadata only; the driver always
executes the SQL from the current application call. It then sends
`Parse`, `Bind`, `Describe Portal`, `Execute`, and `Sync` in one write while
retaining PostgreSQL's live `RowDescription`.

Generated registries require either `queryDescriptors` or an explicit
`execution: "adaptive"` opt-out. Executing a query absent from the selected map
still uses the adaptive describe path. `doctor` validates unique parameterized
query contracts against the generated artifact independently of whether static
scanning can follow a client through a factory or DI container. A contract is
one query under one connection profile. `doctor` separately reports direct
execution sites that remain adaptive or cannot be classified. A supplied
artifact with an incompatible revision, malformed matching contract, wrong
profile role, or missing database-local type fails closed. PostgreSQL validates
the SQL and declared parameter types during `Parse`; if they no longer fit the
live schema, the following `Execute` is not processed. The descriptor path does
not add named statements, automatic replay, runtime result validation, or
pipelining.

Descriptors are not a complete schema-parity check. PostgreSQL may accept a
cast-compatible parameter change, and live `RowDescription` keeps decoding
correct but does not compare the result to the generated TypeScript contract.
Run `prepare --verify` against the exact schema that will receive the
application deployment, then roll out backward-compatible DDL before the
dependent application version.

Database-local OIDs are immutable for one pool generation. Dropping and
recreating a type underneath a running generation does not silently refresh
that generation or replay a failed query; a new application or replacement
generation resolves the type's current OID during `ready()`. Treat such DDL as
a coordinated rollout boundary.

## `clearSqlFileCache()`

Drops the in-memory cache used by `sql.file(...)`. Files are immutable after their first read by default, avoiding a synchronous `stat` call for every query. Call this after a development-time file change or set `reloadSqlFiles: true` on the client to restore mtime-based reloading.

## Typed errors

```ts
import {
  NoRowsError,
  QueryAbortedError,
  QueryTimeoutError,
  TooManyRowsError,
  TransactionTimeoutError,
  SQLSTATE,
  isPgError,
} from "@onreza/sqlx-js";

try {
  const u = await sql.one(`SELECT id FROM users WHERE id = $1`, 99);
} catch (e) {
  if (e instanceof NoRowsError) return null;
  if (e instanceof TooManyRowsError) console.error("ambiguous query, got", e.actual);
  if (e instanceof QueryTimeoutError) console.error(e.phase, e.outcome, e.generation);
  if (e instanceof QueryAbortedError) console.error(e.outcome, e.reason);
  if (e instanceof TransactionTimeoutError) console.error(e.timeoutMs, e.outcome);
  if (isPgError(e, SQLSTATE.uniqueViolation)) console.error("duplicate:", e.constraint);
  throw e;
}
```

`sql.one` throws `NoRowsError` on 0 rows and `TooManyRowsError` (with `.actual`) on >1. `QueryTimeoutError` and `QueryAbortedError` expose `.phase`, `.outcome`, `.queryId`, and `.generation`. Collateral operations rejected during generation recovery receive `GenerationRecycledError`. `ClientClosingError` carries the same fields when shutdown interrupts an accepted operation; an admission rejected after shutdown begins has no operation fields. An expired transaction throws `TransactionTimeoutError` with `.timeoutMs`, `.generation`, and `.outcome` (`rolled_back` only after a clean rollback is confirmed; otherwise `unknown`). Any database error raised by the default runtime is normalized into a `PgError`; `isPgError(error, code?)` is the concise type guard for SQLSTATE handling. A server-side `statement_timeout` remains PostgreSQL error `57014`, not a managed `QueryTimeoutError`.

## Transactions with options

`sql.transaction(fn)` and `sql.transaction(opts, fn)`:

```ts
await sql.transaction({
  isolation: "serializable",
  readOnly: true,
  timeoutMs: 120_000,
  signal: request.signal,
}, async (tx) => {
  return await tx(`SELECT id FROM accounts WHERE owner = $1`, ownerId);
});
```

Base options are `{ isolation?: "read uncommitted" | "read committed" | "repeatable read" | "serializable"; readOnly?: boolean; deferrable?: boolean; timeoutMs?: number; signal?: AbortSignal }`. Profiled clients add the required `settings` object when their profile declares `transactionSettings`. Transaction characteristics are applied via `SET TRANSACTION` immediately after `BEGIN`, followed by transaction-local settings before the callback. The deadline starts before codec bootstrap and covers pool acquisition, `BEGIN`, context setup, the callback, `COMMIT`, and `ROLLBACK`. On expiration the scoped executor is disabled, active statements are cancelled, and the driver is given `cancelGraceMs` to confirm rollback. A clean rollback produces `outcome: "rolled_back"`; an unconfirmed `BEGIN`, `COMMIT`, or `ROLLBACK` produces `unknown` and retires the entire pool generation. Arbitrary non-database work already running inside the callback cannot be forcibly stopped by JavaScript, so external side effects should observe their own signal or be idempotent.

The transaction-scoped executor is valid only while its callback is active. Capturing `tx` and using it after commit or rollback fails locally without dispatching SQL.

## Namespace imports

In addition to `import { sql } from "@onreza/sqlx-js"`, the scanner recognises `import * as ns from "@onreza/sqlx-js"`. It validates `ns.sql(...)`, `ns.sql.one(...)`, `ns.sql.file(...)`, and `ns.sql.transaction(...)` exactly like the named-import form. Local re-declarations (`const sql = ...`, `const { sql } = ...`) correctly shadow the alias inside their scope.

[Documentation index](./README.md)
