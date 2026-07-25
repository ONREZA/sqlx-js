---
name: sqlx-js-query-api
description: Write and review typed sqlx-js application queries using sql, defineQuery, cardinality helpers, named parameters, transactions, SQL files, JSON and array wrappers, identifiers, and scoped clients. Use for query authoring and public runtime API usage, not for changing the prepare inference engine.
---

# sqlx-js query API

Express one stable SQL contract that prepare and TypeScript can both identify.

## Workflow

1. Choose a literal inline query, root-relative SQL file, or reusable
   `defineQuery`.
2. Choose cardinality intentionally: rows, `one`, `optional`, or `execute`.
3. Use either positional or named parameters; never mix them.
4. Wrap JSON with `sql.json(...)` and PostgreSQL arrays with
   `sql.array(...)`.
5. Keep dynamic values parameterized. Use `sql.id(...)` only for identifiers
   present in the generated snapshot.
6. Run live prepare after changing query or schema contracts.
7. Type-check the consumer.

Read [the contract selection guide](references/contracts.md) when choosing an
API surface.

## Invariants

- Keep the exact SQL literal stable; generated registries are keyed by source
  text, not the normalized fingerprint.
- Prefer `defineQuery` for reuse across root and transaction executors.
- Use `mapParams` to map an application input into the generated wire contract,
  not to widen PostgreSQL parameters.
- Use `unsafe` only when dynamic SQL cannot be represented by literal queries
  and safe identifiers.
- Keep `sql.file` roots aligned between prepare and runtime or embed the files.
- Do not fetch a large dataset merely to implement dynamic filtering in
  application code; prefer a stable parameterized SQL or database function
  contract.

## Routing

Use `sqlx-js-inference` when generated types are wrong or the analyzer needs a
new rule. Use `sqlx-js-profiles-rls` when a query is bound to a profile or
requires transaction settings.
