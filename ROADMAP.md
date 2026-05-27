# Roadmap

Future work, ordered by ROI (0–10) — how much real-world pain each item closes.

Items already shipped live in the [README](./README.md) feature list; this file tracks what's still ahead.

| Feature | ROI | Notes |
|---------|-----|-------|
| Migration lifecycle improvements | 8 | Squash baseline MVP, `migrate run --dry-run`, read-only `migrate info`, archive/restore helpers, JSON operator output, filesystem-only `migrate check`, and shadow-based `migrate revert --dry-run` exist; continue with safer migration lifecycle guardrails. This is the foundation for reliable external migration import. |
| Prisma migration assistant | 7 | Import Prisma Migrate SQL history and Prisma TypedSQL/raw SQL into `sqlx-js`; classify Prisma Client CRUD/nested-write sites as assisted/manual instead of promising a fully automatic ORM rewrite. |
| Composite & domain types | 6 | Resolve PG `CREATE TYPE foo AS (...)` and `CREATE DOMAIN` via `pg_type` recursion. Domain → base type's TS (`email DOMAIN AS text` → `string`). Composite → struct literal type. Currently both fall through to `unknown`. |
| Self-join precision (unqualified ColumnRef) | 4 | `SELECT name FROM users u1 JOIN users u2 ON ...` with unqualified `name` can't be attributed to a specific alias. PG would reject ambiguous unqualified refs anyway, but explicit aliasing currently has no narrowing benefit in self-joins. |
| `INSERT INTO t VALUES (...)` without column list | 3 | Map params by `pg_attribute attnum` ordering. Rare in practice — most teams use explicit column lists. |
| Tagged-template literal API (`` sql`SELECT ${x}` ``) | 8 | Restoring sqlx's inline-SQL aesthetic requires either a TS compiler plugin (`ts-patch`) or a Bun preload-time AST rewriter. TS itself hardcodes the first tag argument as `TemplateStringsArray` and refuses to narrow to literal tuples. Significant effort, large UX win. |
| LSP server | 6 | Realtime diagnostics, hover with column types, autocomplete on schema names. Two-to-four weeks for beta, separate VS Code / Neovim extensions. Watch mode covers ~85% of the value today. |
| Schema-aware `jsonb` runtime validation | 5 | Optional opt-in: pass a Zod / Valibot / ArkType schema, validate rows on read. Currently we are compile-time-only by design. |
| MySQL backend | 5 | Some runtime clients support it, but MySQL has no `Describe Statement` equivalent. Would need a real SQL parser pass + `INFORMATION_SCHEMA` introspection. |
| SQLite backend | 4 | SQLite's column types are dynamic. Would require running `EXPLAIN` and a heuristic mapper, or schema-driven inference per-statement. |
| `EXPLAIN`-based performance hints | 6 | `prepare` could optionally run `EXPLAIN` per query and surface seq-scan / missing-index warnings. Independent feature; pairs well with CI. |
| `NOT (col IS NULL)` narrowing | 2 | Symmetric inversion in WHERE walker. Niche pattern. |
| Multi-statement queries | 2 | One SQL string with multiple statements separated by `;`. PG's `Parse` is single-statement; this would require client-side splitting. |
| Stored procedure / function typing | 3 | `CALL proc(...)` and `SELECT func(...)` with parameter and return-type binding from `pg_proc`. |
| Streaming / cursor / COPY typing | 3 | Surface Postgres.js cursor / COPY APIs with proper row types. |

## Long-term

- Full LSP with schema-driven autocomplete.
- Hooks for ORM-like helpers that build on top of the typed `sql()` primitive (joins, paginated queries, etc.) without becoming an ORM.
- Optional binary protocol support in the underlying wire client for measurable perf gain on large result sets.
