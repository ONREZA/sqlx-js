# Connection profiles and RLS

Bind prepared queries to PostgreSQL roles and require transaction-local RLS context without leaking pooled session state.

## Connection profiles and PostgreSQL roles

Use connection profiles when one application process owns several static pools with different PostgreSQL privileges. Define and export the profile objects directly from the config so the CLI and runtime import the same cache-busted source of truth:

```ts
// sqlx-js.config.ts
import { defineConfig, defineDatabaseProfiles } from "@onreza/sqlx-js";

export const databaseProfiles = defineDatabaseProfiles({
  api: {
    role: "app_api",
    transactionSettings: ["app.tenant_id", "app.user_id"],
  },
  worker: { role: "app_worker" },
});

export default defineConfig({
  profiles: databaseProfiles,
});
```

```ts
import { createSqlClient } from "@onreza/sqlx-js";
import { databaseProfiles } from "../sqlx-js.config";

export const apiDb = createSqlClient(process.env.DATABASE_URL, {
  profile: databaseProfiles.api,
});

export const workerDb = createSqlClient(process.env.DATABASE_URL, {
  profile: databaseProfiles.worker,
});

const users = await apiDb.sql.transaction({
  settings: {
    "app.tenant_id": tenantId,
    "app.user_id": userId,
  },
}, async (tx) => await tx("SELECT id, name FROM users"));
await workerDb.sql.execute("UPDATE jobs SET claimed_at = now() WHERE id = $1", 1n);
```

Once `profiles` is configured, every scanned query must have an explicit profile. Direct client queries inherit profiles without `transactionSettings`; transaction callbacks inherit every profile. Profiles with required settings reject direct query sites during scanning. Reusable definitions declare their complete allowlist because the scanner deliberately does not guess dependency-injection dataflow:

```ts
export const findJob = defineQuery
  .for("api", "worker")
  .optional("jobs.find", "SELECT id, state FROM jobs WHERE id = $id");
```

`prepare` opens a session for each configured profile, applies its role, and runs the normal `Parse`/`Describe`/generic-plan pipeline in that session. The cache key includes both the SQL fingerprint and profile, so the same SQL can resolve through different `search_path`, RLS, type, and privilege contexts. Generated `KnownProfiles` registries make `createSqlClient(..., { profile })` infer only that profile's query set and require the exact configured role. The runtime sends the role as a startup parameter on every pool connection, including replacement generations. The login in `DATABASE_URL` must be allowed to `SET ROLE` to every configured role.

The live `prepare` connection must reach PostgreSQL directly or through a session-pooling proxy: role validation requires `SET ROLE`, `Describe`, and planning to stay on the same backend session. Transaction- or statement-pooling proxies cannot preserve that contract. A runtime proxy must likewise accept and preserve the configured startup role on each pooled connection.

Profile names and role names are static generated-contract inputs. Keep them identical across prepare/CI and deployed runtime environments. Shadow-database workflows use cluster roles rather than database-local objects, so every configured role must already exist on the shadow cluster; keep table/schema grants in migrations.

This is a strong preflight for privileges PostgreSQL checks while parsing and generically planning ordinary `SELECT`/DML, including relation, column, and directly referenced function access. It is not proof that every possible execution will succeed: sequence access, trigger or dynamic-SQL effects, value-dependent RLS `WITH CHECK`, and statements reported as `parse-only` can still fail at runtime. Privilege changes also require a new live `prepare` or `prepare --verify`; offline `prepare --check` only verifies committed artifacts.

## PostgreSQL RLS transaction context

Keep RLS policy DDL in migrations or `schema.sql`; sqlx-js owns only the role, connection, and transaction context. A typical fail-closed policy reads a custom setting:

```sql
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON projects
  AS PERMISSIVE
  FOR ALL
  TO app_api
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
```

`NULLIF(..., '')` matters because PostgreSQL can expose a transaction-local custom setting as an empty string after it resets. Missing or reset context therefore evaluates to `NULL` and denies rows instead of failing the UUID cast.

Declare every request-owned setting in the profile's `transactionSettings`. Names must be unique lower-case custom PostgreSQL setting names with at least one dot, such as `app.tenant_id`. Generated profile types require the complete string-valued `settings` object on every transaction:

```ts
await apiDb.sql.transaction({
  settings: {
    "app.tenant_id": tenantId,
    "app.user_id": userId,
  },
  timeoutMs: 5_000,
}, async (tx) => {
  return await tx.optional(
    "SELECT id, name FROM projects WHERE id = $1",
    projectId,
  );
});
```

The runtime validates the exact allowlist carried by the passed profile before opening the transaction, applies transaction characteristics first, then calls parameterized `set_config(name, value, true)` on the same connection before invoking the callback. Values expire at transaction end and are never installed at session scope. A profile with declared settings exposes SQL execution only through `transaction({ settings }, fn)`: the scanner rejects root query sites, root queries and `unsafe` fail before dispatch, and there is no typed `transaction(fn)` overload. Runtime checks preserve that fail-closed execution boundary for JavaScript or erased types, but JavaScript cannot verify an ad-hoc profile object against generated declarations; import the same `defineDatabaseProfiles(...)` value in config and runtime. These guarantees belong to managed `createSqlClient(...)`; raw `createClient(...)` intentionally exposes the wire client without transaction-context guardrails. Use a separate managed profile without `transactionSettings` for operations that intentionally need no request context. Generic client wrappers can accept `SqlTransactionOptions<Registry>` to preserve the active profile contract.

RLS can make a physically existing row invisible, so use `.optional()` unless visibility itself is an application invariant. `prepare` still cannot prove value-dependent `USING` or `WITH CHECK` outcomes.

`sqlx-js doctor` audits RLS-enabled, non-system tables accessible to each configured profile. It reports applicable policies and warns when:

- the effective role is superuser or has `BYPASSRLS`;
- the profile role has direct or inherited owner privileges on an RLS table without `FORCE ROW LEVEL SECURITY`;
- a granted `SELECT`/`INSERT`/`UPDATE`/`DELETE` command has no applicable permissive policy and therefore defaults to deny.

The audit is read-only and intentionally does not interpret arbitrary policy expressions. Role membership follows PostgreSQL's effective `INHERIT`/`USAGE` semantics, so membership through `NOINHERIT` neither applies a group policy nor grants owner bypass. Keep runtime roles separate from schema owners and migration/admin roles; do not grant runtime roles `BYPASSRLS`.

`createSqlClient(url, options)` accepts the integrated pool options `max`,
`password`, `connectTimeoutMs`, `idleTimeoutMs`, `maxLifetimeMs`,
`statementTimeoutMs`, `applicationName`, `startupOptions`, `onNotice`, and
numeric `types`, plus the managed runtime options below. `password` may be a
string or an async provider resolved separately for every new connection.
`connectTimeoutMs` is one deadline for password resolution, TCP, TLS, and
PostgreSQL authentication.
`onNotice` receives structured PostgreSQL notices and isolates observer
failures from protocol state. `operationTimeoutMs` is opt-in because the
library cannot choose one correct wall-clock limit for both interactive
queries and long-running jobs.

The `schema` query parameter used by Prisma PostgreSQL URLs is accepted
directly: sqlx-js removes it before parsing the connection URL. Supported URL
parameters include `sslmode`, `sslrootcert`, `sslcert`, `sslkey`,
`application_name`, `options`, `role`, `connect_timeout`, and
`statement_timeout`.

```ts
const db = createSqlClient(process.env.DATABASE_URL, {
  // Server-side per-connection statement timeout (ms). Also settable via
  // ?statement_timeout=5000 in DATABASE_URL.
  statementTimeoutMs: 5000,
  // Retire unused connections and bound the age of backend sessions.
  idleTimeoutMs: 60_000,
  maxLifetimeMs: 30 * 60_000,
  // Entire managed path: codec bootstrap, pool/connect wait, execution, and
  // decode. A timeout after driver dispatch has outcome "unknown".
  operationTimeoutMs: 15_000,
  // Best-effort cancellation window before the old generation is destroyed.
  cancelGraceMs: 1_000,
  // Base directory for root-relative sql.file(...) calls.
  fileRoot: import.meta.dirname,
  // Development-only: re-stat sql.file() files on every call. The default
  // immutable cache avoids synchronous filesystem work in the query hot path.
  reloadSqlFiles: true,
  // Optional generated map from `sqlx-js queries --embed ...`. When present,
  // sql.file() needs no runtime filesystem asset for those paths.
  sqlFiles: sqlxJsEmbeddedSql,
  // Name-based runtime codecs. Schema-qualified keys disambiguate duplicate
  // type names; PostgreSQL OIDs are discovered for the active database.
  typeCodecs: {
    geometry: {
      parse: (text) => parseWkt(text),
      serialize: (value) => toWkt(value),
    },
  },
  // Fires after every query/transaction statement, success or failure.
  onQuery: ({ queryId, queryName, query, params, durationMs, rowCount, error }) => {
    if (error) logger.error({ queryId, queryName, query, error });
    else if (durationMs > 200) logger.warn({ queryId, queryName, durationMs, rowCount });
  },
  onQueryStart: ({ queryId, queryName, generation }) => {
    metrics.databaseStarted.add(1, { queryId, queryName, generation });
  },
  onQueryTimeout: ({ queryId, queryName, generation, durationMs, phase, outcome }) => {
    logger.error({ queryId, queryName, generation, durationMs, phase, outcome });
  },
  onClientStateChange: ({ from, to, generation }) => {
    logger.info({ from, to, generation }, "database client state changed");
  },
  onQueryHookError: (error) => logger.error({ error }, "query observer failed"),
  onLifecycleHookError: (error) => logger.error({ error }, "database lifecycle observer failed"),
});
```

The `onQuery` hook is the integration point for metrics, tracing, and slow-query logging — sqlx-js does not log queries itself. `queryId` is the stable prepare/cache fingerprint and is suitable for metric labels; `queryName` is present for named `defineQuery` calls. Profiled managed clients also attach the stable `profile` name and PostgreSQL `role` to query, query-start/timeout, client-state, and lifecycle-hook-error events, including events emitted by replacement pool generations. The hook is a non-blocking observer: synchronous throws and asynchronous rejections preserve the database result/error and are passed to `onQueryHookError` when configured. The event preserves source-level parameters for direct queries (including the named-parameter object); mapped definitions report the mapper output rather than their application input. Parameters may contain personal or sensitive data — don't log them blindly; redact or omit `params` in shared sinks. Database errors are normalized to `PgError`; transport and non-database errors pass through unchanged.

Lifecycle events intentionally omit SQL text and parameters. `onQueryStart` fires before codec bootstrap. `onQueryTimeout` reports the stable ID, generation, phase, and outcome while the managed runtime cancels the query and retires the poisoned generation. `onClientStateChange` reports `healthy`, `poisoned`, `recycling`, `failed`, `closing`, and `closed` transitions.

`db.snapshot()` synchronously returns `{ generation, state, activeOperations, lastSuccessAt, lastTimeoutAt, recycleCount }`. `db.ready({ timeoutMs })` bounds codec discovery. `db.ping({ timeoutMs })` performs `SELECT 1` through the same bootstrap, deadline, pool, and observer path as application SQL.

`db.close({ graceMs, forceAfterMs })` is terminal for that scoped client: admission stops immediately, active operations receive the grace window, and remaining promises plus pools are forcibly terminated within the total `forceAfterMs` bound. Repeated calls share the same close promise.

`query.cancel()` is best-effort. Once a user statement has been sent to
PostgreSQL, a timeout is always reported as `outcome: "unknown"`: the statement
may have completed, so sqlx-js never retries it automatically. All active
operations from a poisoned generation are rejected and late driver results are
ignored. A hundred concurrent timeouts from one generation still create only
one replacement pool.

Name-based and mapped query definitions accept execution options without mixing them into SQL parameters. Positional definitions use `runWith(...)` because a trailing object may itself be a valid PostgreSQL parameter:

```ts
await findUser.run(db.sql, { id }, { signal: request.signal });
await positionalQuery.runWith({ signal: request.signal }, db.sql, id);
```

Execution options fail closed when the supplied executor is not a managed sqlx-js executor; they are never silently ignored by a structural test double or third-party adapter.
Inside a transaction, a query-level timeout or abort expires the whole scoped transaction so the driver can confirm rollback before the connection is reused.

[Documentation index](./README.md)
