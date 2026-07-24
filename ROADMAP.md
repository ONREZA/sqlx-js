# Roadmap

Future work, ordered by ROI (0–10) — how much real-world pain each item closes.

Items already shipped live in the [README](./README.md) feature list; this file tracks what's still ahead.

| Feature | ROI | Notes |
|---------|-----|-------|
| Prisma migration assistant | 7 | Import Prisma Migrate SQL history and Prisma TypedSQL/raw SQL into `sqlx-js`; classify Prisma Client CRUD/nested-write sites as assisted/manual instead of promising a fully automatic ORM rewrite. The shipped `queries --json` inventory covers sqlx-js definitions/call sites after conversion, not Prisma reference-graph discovery. |
| Query-plan inventory | 6 | Capture normalized generic `EXPLAIN` metadata in a separate, environment-scoped snapshot. Local databases provide structural feedback; cost and scan comparisons are advisory and become meaningful only against controlled seed data or a representative database. |
| pgschema snapshot and migration handoff | 6 | Provider-aware `dev` / `verify` validates application SQL against `schema.sql` in disposable shadow databases. Next, automate snapshot handoff for teams migrating from built-in migrations without creating two DDL authorities. |
| Generated function call API | 5 | Consider a typed callable surface only after function identity, default arguments, named arguments, procedures, overload resolution, and security metadata are represented soundly. The existing `KnownFunctions` catalog remains the lower-risk foundation. |
| Built-in migration lifecycle maintenance | 5 | Keep provider-aware `dev` / `verify` and `migrate run/revert/squash/archive` stable for simple projects and application startup, but avoid expanding the built-in provider into a full PostgreSQL schema-as-code system. |
| Schema-aware `jsonb` runtime validation | 5 | Optional opt-in: pass a Zod / Valibot / ArkType schema, validate rows on read. Currently we are compile-time-only by design. |
| MySQL backend | 5 | Some runtime clients support it, but MySQL has no `Describe Statement` equivalent. Would need a real SQL parser pass + `INFORMATION_SCHEMA` introspection. |
| Multidimensional array contracts | 4 | Preserve runtime dimensions in generated row and parameter types without treating declared `int[2][2]` bounds as enforced shape. The text codec already handles nested values and explicit lower bounds; the public typed wrapper remains one-dimensional until both input and output contracts can stay sound. |
| SQLite backend | 4 | SQLite's column types are dynamic. Would require running `EXPLAIN` and a heuristic mapper, or schema-driven inference per-statement. |
| Streaming / cursor / COPY typing | 4 | Surface Postgres.js cursor and COPY APIs with proper row types once a concrete large-result or bulk-ingest consumer justifies expanding the runtime surface. |
| Query-plan policy gates | 4 | Allow explicit blocking rules only for teams that maintain a representative planning database and accept environment-specific baselines. Generic-plan cost changes and sequential scans should never fail CI by default. |
| Multi-statement queries | 2 | One SQL string with multiple statements separated by `;`. PG's `Parse` is single-statement; this would require client-side splitting. |
| LISTEN / NOTIFY typing | 2 | Channel-name and payload typing is useful but sits outside the core compile-time query contract and adds long-lived connection lifecycle concerns. |
| Tagged-template literal API (`` sql`SELECT ${x}` ``) | Deferred | A runtime tag can bind values, but TypeScript does not expose literal template fragments to the tag's type, so it cannot select the generated query registry entry. Do not require `ts-patch`, a Bun-only source rewriter, or build-tool-specific transforms for syntax that is only marginally shorter than the portable typed function call. Revisit when TypeScript provides native literal-tuple inference for tagged templates or a standard cross-runtime transform boundary exists. |
| Separate runtime package | Deferred | The audited root import already excludes compile-time modules. Making TypeScript an optional peer reduced a clean production install from about 33 MB to 2.4 MB; a second public package and release boundary is not justified for the remaining analyzer dependency unless production consumers demonstrate measurable pressure. |
| Editor integration / LSP | Deferred | Keep the versioned batch JSON, incremental `prepare --watch --jsonl`, and `sqlx-js-diagnostics` transport stable, but do not build or maintain a VS Code extension or full LSP until real consumer demand justifies the separate editor clients and release lifecycle. |

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
TypeScript, works under Node and Bun without a build plugin, and preserves the
exact literal key used by generated types. The tagged API should remain deferred
until it can preserve those properties without making sqlx-js own the consumer's
compiler pipeline.

The missing TypeScript capability is tracked in
[`microsoft/TypeScript#33304`](https://github.com/microsoft/TypeScript/issues/33304)
and [`microsoft/TypeScript#31422`](https://github.com/microsoft/TypeScript/issues/31422).
An attempted implementation was
[closed without merge](https://github.com/microsoft/TypeScript/pull/49552).

## Query-plan inventory and conditional policy gates

The goal is not to predict production latency from a developer laptop. It is to
make PostgreSQL's estimated plan structure reviewable and catch regressions in a
controlled environment before deployment. Inventory is useful as advisory
evidence; policy enforcement is a separate, lower-ROI capability for teams that
already maintain a representative planning database.

| Database used for planning | Useful signals | Boundary |
|----------------------------|----------------|----------|
| Empty or small local database | Query is generically plannable; relations and any indexes selected by the planner appear in the plan; a join or scan shape changed. | PostgreSQL can reasonably prefer a sequential scan for a small table, so cost and scan choices are not representative. |
| Local database with deterministic seed data followed by `ANALYZE` | Stable relative cost, row-estimate, scan, and join-strategy comparisons for the seeded workload. | Synthetic distributions can miss tenant skew, hot values, and production cardinalities. |
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
  version, and compatible planner configuration.
- Persist normalized node types, relation/index names, join strategies,
  estimated rows, and startup/total cost. Estimated cost is a planner unit, not
  milliseconds, so compare it within the same controlled environment.
- Report plan changes and cost ratios by default. Only a representative
  environment may opt into explicit failures, such as losing a required index
  or introducing a sequential scan above a configured estimated-row threshold.
- Keep value-sensitive performance testing outside `prepare`: generic plans do
  not know the real parameter distribution.
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
