# Roadmap

Future work, ordered by ROI (0–10) — how much real-world pain each item closes.

Items already shipped live in the [README](./README.md) feature list; this file tracks what's still ahead.

| Feature | ROI | Notes |
|---------|-----|-------|
| Query-plan inventory and policy gates | 8 | Persist normalized generic `EXPLAIN` metadata per query and report high-cost or sequential-scan regressions against a representative database. Keep it opt-in and policy-based: generic plans do not know production parameter distributions, and `ANALYZE` must never run during prepare. |
| Tagged-template literal API (`` sql`SELECT ${x}` ``) | 8 | Restoring sqlx's inline-SQL aesthetic requires either a TS compiler plugin (`ts-patch`) or a Bun preload-time AST rewriter. TS itself hardcodes the first tag argument as `TemplateStringsArray` and refuses to narrow to literal tuples. Significant effort, large UX win. |
| PostgreSQL function contract integrity | 7 | Strengthen the existing catalog with volatility, security-definer, leakproof, parallel-safety, owner, and `search_path` metadata. Add reviewable diagnostics for unsafe application-owned functions before considering a generated call API. |
| RLS session-context guardrails | 7 | Add transaction-local helpers and doctor checks for application settings used by RLS policies. Keep tenant context explicit and bound to a transaction; profile-scoped planning already proves role permissions but cannot prove runtime policy outcomes. |
| Prisma migration assistant | 7 | Import Prisma Migrate SQL history and Prisma TypedSQL/raw SQL into `sqlx-js`; classify Prisma Client CRUD/nested-write sites as assisted/manual instead of promising a fully automatic ORM rewrite. The shipped `queries --json` inventory covers sqlx-js definitions/call sites after conversion, not Prisma reference-graph discovery. |
| pgschema snapshot and migration handoff | 6 | Provider-aware `dev` / `verify` validates application SQL against `schema.sql` in disposable shadow databases. Next, automate snapshot handoff for teams migrating from built-in migrations without creating two DDL authorities. |
| Generated function call API | 5 | Consider a typed callable surface only after function identity, default arguments, named arguments, procedures, overload resolution, and security metadata are represented soundly. The existing `KnownFunctions` catalog remains the lower-risk foundation. |
| Built-in migration lifecycle maintenance | 5 | Keep provider-aware `dev` / `verify` and `migrate run/revert/squash/archive` stable for simple projects and application startup, but avoid expanding the built-in provider into a full PostgreSQL schema-as-code system. |
| Schema-aware `jsonb` runtime validation | 5 | Optional opt-in: pass a Zod / Valibot / ArkType schema, validate rows on read. Currently we are compile-time-only by design. |
| MySQL backend | 5 | Some runtime clients support it, but MySQL has no `Describe Statement` equivalent. Would need a real SQL parser pass + `INFORMATION_SCHEMA` introspection. |
| Multidimensional array contracts | 4 | Preserve runtime dimensions in generated row and parameter types without treating declared `int[2][2]` bounds as enforced shape. The text codec already handles nested values and explicit lower bounds; the public typed wrapper remains one-dimensional until both input and output contracts can stay sound. |
| SQLite backend | 4 | SQLite's column types are dynamic. Would require running `EXPLAIN` and a heuristic mapper, or schema-driven inference per-statement. |
| Streaming / cursor / COPY typing | 4 | Surface Postgres.js cursor and COPY APIs with proper row types once a concrete large-result or bulk-ingest consumer justifies expanding the runtime surface. |
| Multi-statement queries | 2 | One SQL string with multiple statements separated by `;`. PG's `Parse` is single-statement; this would require client-side splitting. |
| LISTEN / NOTIFY typing | 2 | Channel-name and payload typing is useful but sits outside the core compile-time query contract and adds long-lived connection lifecycle concerns. |
| Separate runtime package | Deferred | The audited root import already excludes compile-time modules. Making TypeScript an optional peer reduced a clean production install from about 33 MB to 2.4 MB; a second public package and release boundary is not justified for the remaining analyzer dependency unless production consumers demonstrate measurable pressure. |
| Editor integration / LSP | Deferred | Keep the versioned batch JSON, incremental `prepare --watch --jsonl`, and `sqlx-js-diagnostics` transport stable, but do not build or maintain a VS Code extension or full LSP until real consumer demand justifies the separate editor clients and release lifecycle. |

## Long-term

- Editor clients or a full LSP only after repeated consumer demand demonstrates that the separate maintenance and release lifecycle will pay for itself.
- Hooks for ORM-like helpers that build on top of the typed `sql()` primitive (joins, paginated queries, etc.) without becoming an ORM.
- Optional binary protocol support in the underlying wire client for measurable perf gain on large result sets.
