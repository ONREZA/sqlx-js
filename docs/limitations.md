# Limitations and non-goals

Known boundaries of the scanner, PostgreSQL runtime, migrations, and supported environments.

`sqlx-js` is a young library. Known gaps:

- PostgreSQL only (no MySQL or SQLite).
- The scanner follows direct named imports and namespace imports from configured `scan.modules` (default: `@onreza/sqlx-js`), plus one direct named-import hop to an exported local `const` created by `createSqlClient`. It also follows request-local `const` executors created directly by a recognized `sql.with(...)` call. Mutable option executors, factories, returned wrappers, re-export graphs, and other dynamic aliases are not inferred. Tagged-template calls are deliberately unsupported because they cannot select the exact generated registry entry without a compiler transform.
- Profile inference follows direct `const client = createSqlClient(..., { profile: profiles.name })` bindings, direct imports of those exported local bindings, and their transaction callbacks. Factories, returned clients, mutable aliases, re-exports, and dependency-injection graphs require a direct profiled binding at the scanned query site; reusable definitions use `defineQuery.for(...)`.
- Star projections fall back to conservative nullability when their relation shape is ambiguous. Single-relation CTE and derived-table stars are expanded from the live schema, including `MATERIALIZED` CTEs used with lateral joins; multi-relation unqualified stars and recursive stars may still need explicit columns.
- Plain `sql(...)` keeps returning rows, so statements without `RETURNING` produce an empty typed array. Prepare warns and `--strict-inference` rejects this intent mismatch; use `sql.execute(...)`. `.one()` and `.optional()` without a result set are always rejected, while `.execute()` with returned rows warns.
- Self-references inside `WITH RECURSIVE` are not analysed transitively — at worst this produces extra `T | null`. Ordinary later CTEs can reference earlier CTEs in the same `WITH`. Use `AS "id!"` overrides if recursive output needs an explicit contract.
- Column names whose **real** name (not an alias) ends with `!` or `?` are not supported — the runtime strips those suffixes assuming an override. Use `AS "alias"` if you have such a column.
- Result columns must have unique names because the runtime returns object rows. Alias join projections such as `users.id AS user_id, posts.id AS post_id`; `prepare` rejects duplicate output names before generating declarations.
- Migrations run inside `BEGIN/COMMIT`. DDL that disallows transactions (`CREATE INDEX CONCURRENTLY`, `VACUUM`, `REINDEX CONCURRENTLY`, …) will fail; split such operations into separate migrations executed outside the runner.
- The shared resolver supports one TCP host, a separate numeric `hostaddr`, the documented URL/`PG*` settings, and standard password files. It does not implement libpq multi-host failover, service files, Unix-domain sockets, GSSAPI, or `target_session_attrs`. Pool sizing, TCP keepalive, and connection retirement use typed client options; `keepAliveMs` only detects idle half-open pooled connections, `statementTimeoutMs` maps to a per-connection server timeout, and `operationTimeoutMs` bounds the managed end-to-end path.
- Known unsupported libpq connection-policy environment variables and URL parameters fail during resolution instead of being inherited only by `pg_dump`/pgschema or silently ignored by the wire client. Default libpq client certificate and CRL discovery is not implemented; configure supported certificate paths explicitly.
- pgschema's upstream connection API has one host field. sqlx-js therefore rejects a distinct `hostaddr` and `host` for every TLS mode before starting pgschema; `sslmode=disable` is available only for a trusted path. Its target and plan connections also share process-level startup options, so explicit target `application_name`, `options`, `role`, and `statement_timeout` settings fail before execution. The built-in wire paths and `pg_dump` preserve the complete connection contract.
- `connect_timeout` bounds the entire internal-client connect, including the TLS handshake and SCRAM authentication.
- Cloudflare Workers are not currently supported because the shared wire client uses Node-compatible TCP/TLS modules. Adding Workers requires a dedicated socket adapter rather than a second protocol implementation.
- JavaScript timers cannot preempt synchronous application code or a synchronous custom codec that blocks the event loop. Managed deadlines are checked again after bootstrap and driver completion, but their wall-clock delivery still requires the event loop to make progress.
- Runtime `sql.file(path)` resolves against `fileRoot` while prepare resolves against `--root`. They are both root-relative, but applications started outside the project root must set `fileRoot` explicitly or provide the generated `sqlFiles` map.
- Descriptor artifacts are imported explicitly by application code. Runtime
  filesystem discovery is a permanent non-goal because it weakens monorepo,
  profile, deployment, and startup ownership.
- Runtime row-schema validation and SQL parsing are permanent non-goals for the
  default query path. Application validation belongs at an explicit boundary;
  generated query execution stays allocation- and branch-minimal.

See the [Postgres.js compatibility matrix](./postgres-js-feature-matrix.md)
for the replacement boundary and explicit permanent non-goals. The
[open issue and pull request audit](./postgres-js-upstream-audit.md)
records which upstream reliability and DX findings were adopted or rejected.
See [ROADMAP.md](../ROADMAP.md) for what's planned.

[Documentation index](./README.md)
