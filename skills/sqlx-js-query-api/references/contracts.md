# Query contract selection

| Need | Surface |
| --- | --- |
| Zero or more rows | `sql(...)` |
| Exactly one row | `sql.one(...)` |
| Zero or one row | `sql.optional(...)` |
| Command metadata / affected rows | `sql.execute(...)` |
| Root-relative SQL asset | `sql.file(...)` and its cardinality helpers |
| Reusable query | `defineQuery`, `.one`, `.optional`, or `.execute` |
| Dynamic application input | `defineQuery(...).mapParams(...)` |
| Transaction | `sql.transaction(...)` or a scoped client transaction |
| Dynamic allowlisted identifier | `sql.id(...)` |
| Genuinely dynamic SQL | `unsafe(...)` with parameterized values |

## Parameter rules

- Positional form uses `$1`, `$2`, and separate arguments.
- Named form uses `$name` and one exact object.
- Repeated named parameters reuse their first position.
- A bare `null` is SQL `NULL`.
- `sql.json(null)` is JSON `null`.
- `sql.array([...])` is a PostgreSQL array.
- A `jsonb[]` value composes `sql.array([sql.json(...), ...])`.

## Cardinality behavior

- `one` throws unless exactly one row is returned.
- `optional` returns `null` for zero rows and throws for more than one.
- `execute` returns command and row-count metadata.
- Plain `sql` returns an array even for DML without `RETURNING`; prefer
  `execute` for that contract.

## SQL files

Prepare resolves paths against `--root`; runtime resolves against `fileRoot`.
Absolute paths and root escapes are rejected. For bundled applications, use
`queries --embed` and provide the generated SQL map to the client.
