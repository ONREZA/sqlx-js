# Roadmap

Future work, ordered by ROI (0–10) — how much real-world pain each item closes.

Items already shipped live in the [README](./README.md) feature list; this file tracks what's still ahead.

| Feature | ROI | Notes |
|---------|-----|-------|
| pgschema integration hardening | 6 | Managed install/check/plan/apply now has a real pinned-binary PostgreSQL E2E in CI. Continue with schema snapshot handoff and migration guidance for projects that outgrow built-in migrations. |
| Separate runtime package | Deferred | The audited root import already excludes compile-time modules. Making TypeScript an optional peer reduced a clean production install from about 33 MB to 2.4 MB; a second public package and release boundary is not justified for the remaining analyzer dependency unless production consumers demonstrate measurable pressure. |
| Built-in migration lifecycle maintenance | 5 | Keep `migrate run/dev/verify/revert/squash/archive` stable for simple projects and application startup, but avoid expanding it into a full PostgreSQL schema-as-code system. |
| Prisma migration assistant | 7 | Import Prisma Migrate SQL history and Prisma TypedSQL/raw SQL into `sqlx-js`; classify Prisma Client CRUD/nested-write sites as assisted/manual instead of promising a fully automatic ORM rewrite. |
| Self-join precision (unqualified ColumnRef) | 4 | `SELECT name FROM users u1 JOIN users u2 ON ...` with unqualified `name` can't be attributed to a specific alias. PG would reject ambiguous unqualified refs anyway, but explicit aliasing currently has no narrowing benefit in self-joins. |
| Tagged-template literal API (`` sql`SELECT ${x}` ``) | 8 | Restoring sqlx's inline-SQL aesthetic requires either a TS compiler plugin (`ts-patch`) or a Bun preload-time AST rewriter. TS itself hardcodes the first tag argument as `TemplateStringsArray` and refuses to narrow to literal tuples. Significant effort, large UX win. |
| Editor integration / LSP | Deferred | Keep the versioned batch JSON, incremental `prepare --watch --jsonl`, and `sqlx-js-diagnostics` transport stable, but do not build or maintain a VS Code extension or full LSP until real consumer demand justifies the separate editor clients and release lifecycle. |
| Schema-aware `jsonb` runtime validation | 5 | Optional opt-in: pass a Zod / Valibot / ArkType schema, validate rows on read. Currently we are compile-time-only by design. |
| MySQL backend | 5 | Some runtime clients support it, but MySQL has no `Describe Statement` equivalent. Would need a real SQL parser pass + `INFORMATION_SCHEMA` introspection. |
| SQLite backend | 4 | SQLite's column types are dynamic. Would require running `EXPLAIN` and a heuristic mapper, or schema-driven inference per-statement. |
| `EXPLAIN`-based performance hints | 6 | `prepare` could optionally run `EXPLAIN` per query and surface seq-scan / missing-index warnings. Independent feature; pairs well with CI. |
| Multi-statement queries | 2 | One SQL string with multiple statements separated by `;`. PG's `Parse` is single-statement; this would require client-side splitting. |
| Streaming / cursor / COPY typing | 3 | Surface Postgres.js cursor / COPY APIs with proper row types. |

## Long-term

- Editor clients or a full LSP only after repeated consumer demand demonstrates that the separate maintenance and release lifecycle will pay for itself.
- Hooks for ORM-like helpers that build on top of the typed `sql()` primitive (joins, paginated queries, etc.) without becoming an ORM.
- Optional binary protocol support in the underlying wire client for measurable perf gain on large result sets.
