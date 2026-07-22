# Pre-0.15 generated-artifact migrations

This is the archived upgrade guidance that previously lived in the root
README. It covers cumulative pre-`0.15.0` cache, generator, parameter,
observer, and SQL-file contract changes.

Generated cache includes `.sqlx-js/cache-manifest.json` with an explicit cache
format, generator revision, and hash of type/function contracts plus enum
schema selection. Cache without this manifest is rejected. Delete `.sqlx-js/`
and re-run `sqlx-js prepare` against your database — there is no data loss
because the cache is generated.

Generated JSON and PostgreSQL array parameters require `sql.json(...)` and
`sql.array(...)`. This removes the ambiguous runtime guess where a JavaScript
array could mean either a PostgreSQL array or a JSON array. Replace raw array
JSON params with `sql.json(value)` and PostgreSQL arrays with `sql.array(value)`
before regenerating declarations.

CI (`prepare --check`) fails until the cache is regenerated so stale schema
metadata cannot silently emit incorrect generated files.

## Generator revisions

### Revision 4

The declaration layout exports `SqlxJsGeneratedRegistry` for scoped clients
while continuing to augment the global `KnownQueries` convenience API. Re-run
live `sqlx-js prepare` after upgrading. `prepare --check` is strictly read-only;
use `prepare --offline` when deliberate cache-to-declaration regeneration is
required.

### Revision 6

`columnTypes` and function-catalog scope are part of the generated contract.
Extension-owned functions are no longer emitted by default. Re-run live
`sqlx-js prepare`; set `functionCatalog.includeExtensionOwned: true` only when
application code intentionally indexes those signatures.

### Revision 7

Strict nullability inference and compatible application-owned type provenance
cover `UNION`, `INTERSECT`, and `EXCEPT`, including inherited/sequential CTE
scopes and `VALUES` branches. Re-run live `sqlx-js prepare` so committed cache
entries use the branch-combined row contracts.

### Revision 8

`ARRAY[...]`, `ARRAY(SELECT ...)`, and `EXISTS(...)` expressions are non-null,
including typed empty-array fallbacks inside `COALESCE`. Re-run live
`sqlx-js prepare` so generated row contracts remove obsolete `| null` branches.

### Revision 9

Array-value nullability is separate from element nullability. Ordinary
PostgreSQL arrays emit `(T | null)[]`; SQL expression proofs, `NOT NULL` element
domains, and `arrayElementNullability` assertions narrow them to `T[]`.
`PgArrayParameter` carries an element-nullability flag inferred by
`sql.array(...)`. Re-run live `sqlx-js prepare`, review widened result types,
and add assertions only for invariants the application enforces.

### Revision 10

Live prepare performs non-executing generic-plan validation after `Describe`.
It catches planner-only PostgreSQL errors such as an `ON CONFLICT` target
without a matching unique or exclusion constraint, including errors hidden by
value-dependent custom-plan simplification. Cache entries record whether a
statement was `planned` or only `parse-only`; re-run live `sqlx-js prepare`
before relying on `--check` or `--offline`. This revision also raised the
supported database baseline to PostgreSQL 16.

### Revision 11

Generated declarations contain a scoped runtime codec contract. Every explicit
`customTypes` mapping requires matching name-based `typeCodecs` or typed numeric
Postgres.js `types` when the generated registry is bound to a client. Explicit
enum and composite mappings affect query types and the runtime codec contract.
Domain-specific mappings are rejected because PostgreSQL exposes the base type
OID for domain results. Re-run live `sqlx-js prepare` to validate declarations
and the cache manifest.

### Revision 12

DML target provenance flows through value-producing `CASE`, `COALESCE`,
`GREATEST`/`LEAST`, the stored side of `NULLIF`, set-operation inputs, and
multi-column row assignments. Conditional parameters inherit application-owned
column types and nullable-column contracts without typing control predicates or
`NULLIF` sentinels as stored values. Unambiguous single-relation star
projections inside CTEs and derived tables preserve non-null base columns.
Re-run live `sqlx-js prepare`.

### Revision 13

Direct parameter provenance inside data-modifying CTEs retains every DML target
for reused parameters. Generated inputs allow SQL `NULL` only when every
stored-value use accepts or safely handles it and predicate use is null-aware.
Compatible `jsonbTypes` / `columnTypes` declarations survive across all DML
targets; conflicting declarations fail instead of selecting the last visited
column. Re-run live `sqlx-js prepare`.

### Revision 14

Pre-update predicate narrowing is separate from post-update `RETURNING` values.
`UPDATE` target columns use live schema nullability because `RETURNING` observes
the new row, including trigger changes, while unchanged `FROM` rows retain
valid `WHERE` refinements. The same rule applies inside data-modifying CTEs.
Re-run live `sqlx-js prepare`.

### Revision 15

The opt-in PostgreSQL enum catalog persists selected schemas in
`.sqlx-js/enums/enums.json` and emits root-relative `as const` object/type pairs.
Exact `include`/`exclude` filters select exports, schema-qualified `aliases`
resolve collisions, and `registry: true` adds dynamic access through `DbEnums`.
Offline, check, verify, watch, and shadow migration workflows treat both files
as generated artifacts. Re-run live `sqlx-js prepare` before enabling or
validating a catalog.

## Runtime observer and SQL-file changes

An exception from `onQuery` no longer replaces a successful query result;
handle it through `onQueryHookError`. `sql.file()` no longer performs an mtime
check on every call — use `reloadSqlFiles: true` during development or call
`clearSqlFileCache()` explicitly after changing a file.
