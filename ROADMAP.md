# Roadmap

Future work, ordered by ROI (0–10) — how much real-world pain each item closes.

Items already shipped live in the [README](./README.md) feature list; this file tracks what's still ahead.

## Current implementation target

The next breaking contract slice is being delivered as one coherent boundary:

- Temporal-only PostgreSQL I/O: exact `PlainDate`, `PlainTime`,
  `PlainDateTime`, and `Instant` mappings; UTC sessions; preserved
  returned microseconds; rejected `Date`, infinity, leap seconds, PostgreSQL
  `time` 24:00, and sub-microsecond inputs; and an explicit application-owned Temporal provider when no
  compatible native API exists.
- Query I/O temporal policy: `timestamp without time zone` fails closed by
  default through direct parameters/results, parameter-mapped physical
  columns, arrays, domains, ranges, multiranges, and composites. A named
  `defineQuery` may carry a source-local allow reason or strengthen a globally
  permissive policy. Fingerprint deduplication never transfers the waiver to a
  different call site.
- JSON numeric safety policy: non-finite inputs and unsafe integer inputs or
  results fail instead of being coerced or rounded. Exact larger quantities
  remain strings or PostgreSQL `numeric`; ordinary fractional JSON numbers
  retain JavaScript `number` semantics rather than claiming arbitrary decimal
  precision.

These items remain recorded here until the release containing the new cache,
generator, and runtime descriptor revisions is published.

| Feature | ROI | Notes |
|---------|-----|-------|
| Prisma migration assistant | 7 | Import Prisma Migrate SQL history and Prisma TypedSQL/raw SQL into `sqlx-js`; classify Prisma Client CRUD/nested-write sites as assisted/manual instead of promising a fully automatic ORM rewrite. The shipped `queries --json` inventory covers sqlx-js definitions/call sites after conversion, not Prisma reference-graph discovery. |
| Planning datasets and query-plan inventory | 6 | Let applications seed a disposable planning database before `ANALYZE`, then capture normalized generic `EXPLAIN` metadata in a separate environment-scoped snapshot. sqlx-js owns safe orchestration and fingerprints; the application owns representative data. Without a declared planning dataset or representative database, only structural plan changes are meaningful. |
| pgschema snapshot and migration handoff | 6 | Provider-aware `dev` / `verify` validates application SQL against `schema.sql` in disposable shadow databases. Next, automate snapshot handoff for teams migrating from built-in migrations without creating two DDL authorities. |
| Generated function call API | 5 | Consider a typed callable surface only after function identity, default arguments, named arguments, procedures, overload resolution, and security metadata are represented soundly. The existing `KnownFunctions` catalog remains the lower-risk foundation. |
| Built-in migration lifecycle maintenance | 5 | Keep provider-aware `dev` / `verify` and `migrate run/revert/squash/archive` stable for simple projects and application startup, but avoid expanding the built-in provider into a full PostgreSQL schema-as-code system. |
| Multidimensional array contracts | 4 | Preserve runtime dimensions in generated row and parameter types without treating declared `int[2][2]` bounds as enforced shape. The text codec already handles nested values and explicit lower bounds; the public typed wrapper remains one-dimensional until both input and output contracts can stay sound. |
| Streaming / cursor / COPY typing | 4 | Extend the integrated wire runtime with proper row types, backpressure, and connection ownership once a concrete large-result or bulk-ingest consumer justifies expanding the public surface. |
| Query-plan policy gates | 4 | Allow explicit blocking rules only for teams that maintain a representative planning database and accept environment-specific baselines. Generic-plan cost changes and sequential scans should never fail CI by default. |
| Multi-statement queries | 2 | One SQL string with multiple statements separated by `;`. PG's `Parse` is single-statement; this would require client-side splitting. |
| LISTEN / NOTIFY typing | 2 | Channel-name and payload typing is useful but sits outside the core compile-time query contract and adds long-lived connection lifecycle concerns. |
| PostgreSQL `timetz` and interval Temporal mapping | Deferred | `time with time zone` has no date or IANA zone and therefore no faithful Temporal counterpart. PostgreSQL intervals can contain mixed-sign calendar and clock fields that `Temporal.Duration` cannot represent. Keep both lossless as strings until a sound dedicated public representation exists; never cast them into misleading Temporal objects. |
| Tagged-template literal API (`` sql`SELECT ${x}` ``) | Rejected | A runtime tag can bind values, but TypeScript does not expose literal template fragments to the tag's type, so it cannot select the generated query registry entry. sqlx-js will not own `ts-patch`, a runtime-specific source rewriter, or the consumer build pipeline for syntax that is only marginally shorter than the portable typed function call. |
| Separate runtime package | Deferred | The audited root import already excludes compile-time modules. Making TypeScript an optional peer reduced a clean production install from about 33 MB to 2.4 MB; a second public package and release boundary is not justified for the remaining analyzer dependency unless production consumers demonstrate measurable pressure. |
| Editor integration / LSP | Deferred | Keep the versioned batch JSON, incremental `prepare --watch --jsonl`, and `sqlx-js-diagnostics` transport stable, but do not build or maintain a VS Code extension or full LSP until real consumer demand justifies the separate editor clients and release lifecycle. |

## Permanent boundaries

- PostgreSQL remains the only backend. MySQL and SQLite would replace the
  server-owned Describe/plan contract with heuristic parsing and dilute the
  library's strict-prepare model.
- Runtime SQL parsing, automatic descriptor discovery, result-schema
  validation, automatic replay, named prepared-statement caches, and implicit
  pipelining are rejected for the default path.
- Legacy JavaScript `Date` is rejected at the public SQL parameter/result
  boundary. Internal monotonic/deadline bookkeeping may continue to use numeric
  epoch milliseconds; it is not a database value contract.
- Inference grows only from real production-corpus shapes. A new sound rule
  requires a degraded strict-inference case plus a live PostgreSQL regression;
  completing the entire PostgreSQL AST is not a goal.
- Full editor/LSP ownership remains deferred. Versioned JSON diagnostics,
  watch JSONL, and `queries explain` are the portable editor and CI boundary.

## Tagged-template literal API

The desired syntax is straightforward at runtime:

```ts
const rows = await sql`SELECT id FROM users WHERE email = ${email}`;
```

The scanner could reconstruct `SELECT id FROM users WHERE email = $1`, and the
runtime tag could bind `email`. The blocking issue is the public return type:
TypeScript passes the static fragments to the tag as `TemplateStringsArray`
rather than a literal tuple such as
`readonly ["SELECT id FROM users WHERE email = ", ""]`. The generated registry
is keyed by the exact SQL literal, so the tag cannot select its row and parameter
contract.

A source transform could rewrite the tag to the existing typed call:

```ts
const rows = await sql("SELECT id FROM users WHERE email = $1", email);
```

That would introduce several project-wide costs:

- `tsc` needs a patched compiler or custom build wrapper, while editor type
  checking needs a matching language-service integration.
- Bun runtime/build plugins do not cover Node, `tsc`, editors, or other
  transpilers with the same transform.
- Source maps, diagnostics, watch mode, transactions, cardinality helpers, and
  query IDs must all agree on the transformed SQL.
- Interpolations need a new contract distinguishing bound values from trusted
  identifiers or SQL fragments, while the existing `$name` / `$N`,
  `sql.json(...)`, `sql.array(...)`, and `sql.id(...)` surfaces are explicit.

The current function call is slightly more verbose but remains ordinary
TypeScript, works under Node, Bun, and Deno without a build plugin, and
preserves the exact literal key used by generated types. The tagged API is a
permanent non-goal because making it sound would require sqlx-js to own the
consumer's compiler pipeline.

The missing TypeScript capability is tracked in
[`microsoft/TypeScript#33304`](https://github.com/microsoft/TypeScript/issues/33304)
and [`microsoft/TypeScript#31422`](https://github.com/microsoft/TypeScript/issues/31422).
An attempted implementation was
[closed without merge](https://github.com/microsoft/TypeScript/pull/49552).

## Planning datasets, query-plan inventory, and conditional policy gates

The goal is not to predict production latency from an empty developer database.
It is to let an application build a reproducible planning environment, make
PostgreSQL's estimated plan structure reviewable, and catch regressions in that
same controlled environment before deployment.

sqlx-js should own the disposable-database lifecycle because `dev` and `verify`
already create a shadow database and apply the selected schema provider. The
application must own the planning data and its domain meaning. sqlx-js must not
grow a fixture DSL, faker library, production-data snapshotter, or general
development/provisioning seed command.

The intended planning workflow is:

1. Create or isolate a disposable shadow database.
2. Apply the configured migrations or `schema.sql` desired state.
3. Run an explicit application-owned planning seed against only that database.
4. Run `ANALYZE` after the seed completes.
5. Prepare application queries and capture normalized generic
   `EXPLAIN (FORMAT JSON)` plans.
6. Bind the snapshot to the environment name, PostgreSQL major version,
   compatible planner settings, schema identity, and seed identity.
7. Drop the automatic shadow database after capture or verification.

The first seed boundary should stay deliberately small: a versioned SQL file or
an argv-array application command executed without a shell. The command should
receive the generated shadow URL only through its child `DATABASE_URL`
environment; sqlx-js must neither append credentials to argv nor mutate the
parent process environment. The hook must be opt-in for plan capture, never run
implicitly against the ordinary target `DATABASE_URL`, redact the generated URL
from diagnostics, and fail the planning run when it cannot complete. A command
hook permits existing application seed code without making sqlx-js responsible
for its framework or business invariants. A stable declared identity or digest
must change whenever inputs outside the configured seed entrypoint change.

Representative planning data is more than a handful of valid fixture rows. It
should preserve the orders of magnitude and important distributions that drive
planner selectivity: tenant skew, common and rare statuses, nullable fractions,
and relationships used by joins. A deterministic but unrepresentative seed
still produces reproducible misleading plans.

Inventory remains advisory by default. Policy enforcement is a separate,
lower-ROI capability for teams that maintain a representative planning
environment and accept its baseline as an operational contract.

| Database used for planning | Useful signals | Boundary |
|----------------------------|----------------|----------|
| Empty or small local database | Query is generically plannable; referenced relations and indexes exist; a join or scan shape changed. | PostgreSQL can reasonably prefer a sequential scan for a small table, so cost, row estimates, and scan choices are not representative. This mode must not establish a performance baseline. |
| Disposable database with an application-owned deterministic planning seed followed by `ANALYZE` | Stable relative cost, row-estimate, scan, and join-strategy comparisons for the seeded workload. | Synthetic scale or distributions can still miss tenant skew, hot values, and production cardinalities. The snapshot is valid only for the recorded seed identity. |
| Read-only staging or production-like database with current statistics | Highest-signal estimated plan regression check without executing application SQL. | A generic plan still cannot model parameter-specific custom plans or actual runtime, cache, lock, and I/O behavior. |

For example, removing an index may change a representative baseline from:

```text
Index Scan using orders_customer_id_idx on orders
  estimated rows: 120
  total cost: 18.40
```

to:

```text
Seq Scan on orders
  estimated rows: 120
  total cost: 18420.65
```

That is a useful review signal. The same sequential scan on a 20-row lookup
table is not a regression and should not fail CI.

The intended guardrails are:

- Store plan snapshots separately from the portable query/type cache and bind
  comparisons to a named environment, connection profile, PostgreSQL major
  version, compatible planner configuration, schema identity, and optional seed
  identity.
- Never compare a seeded baseline with an empty database, a different seed, or
  a different environment as if it were the same planning contract.
- Persist normalized node types, relation/index names, join strategies,
  estimated rows, and startup/total cost. Estimated cost is a planner unit, not
  milliseconds, so compare it within the same controlled environment.
- Report plan changes and cost ratios by default. Only a representative
  environment may opt into explicit failures, such as losing a required index
  or introducing a sequential scan above a configured estimated-row threshold.
- Keep value-sensitive performance testing outside `prepare`: generic plans do
  not know the real parameter distribution.
- Keep ordinary application/default-data seeding outside sqlx-js. The planning
  hook exists only to assemble a reproducible validation database.
- Never use `EXPLAIN ANALYZE` during prepare or policy checks because it executes
  the statement, including DML. Runtime benchmarks belong in a separate,
  explicitly execution-enabled workflow.

See PostgreSQL's [`EXPLAIN`](https://www.postgresql.org/docs/current/using-explain.html)
and prepared-statement [generic/custom plan](https://www.postgresql.org/docs/current/sql-prepare.html)
documentation for the underlying planner boundaries.

## Long-term

- Editor clients or a full LSP only after repeated consumer demand demonstrates that the separate maintenance and release lifecycle will pay for itself.
- Hooks for ORM-like helpers that build on top of the typed `sql()` primitive (joins, paginated queries, etc.) without becoming an ORM.
- Optional binary protocol support in the underlying wire client for measurable perf gain on large result sets.
