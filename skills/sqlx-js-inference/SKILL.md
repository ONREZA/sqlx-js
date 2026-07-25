---
name: sqlx-js-inference
description: Diagnose or implement sqlx-js scanning, PostgreSQL describe and planning, result nullability, WHERE narrowing, parameter mapping, type resolution, cache, and code generation. Use when generated query types are wrong, prepare degrades, a SQL AST rule is missing, or source under scan, pg analysis, param mapping, cache, or codegen changes.
---

# sqlx-js inference

Preserve the contract from literal source through PostgreSQL evidence to
generated TypeScript.

## Diagnose first

1. Reproduce the incorrect generated contract with the smallest supported SQL
   and schema.
2. Identify the first pipeline stage that loses information.
3. Dump the `libpg-query` AST for unfamiliar nodes.
4. Inspect PostgreSQL `ParameterDescription`, `RowDescription`, and catalog
   provenance before changing heuristics.
5. Add a positive regression test for the intended supported contract.
6. Implement the narrowest rule and run adjacent inference gates.

Read [the pipeline source map](references/source-map.md) before editing.

## Invariants

- PostgreSQL owns parsing and parameter/result metadata.
- Planning uses a generic plan and must never execute application SQL.
- Conservative nullability is sound; unsupported inference must not guess.
- `AND` unions narrowing evidence while `OR` intersects it.
- DML targets outrank predicate-only references for stored parameter
  nullability and application type provenance.
- Aggregate every compatible parameter target and fail on conflicts.
- Keep named placeholder rewriting lexical; never replace with a regex.
- The runtime registry uses the exact SQL literal; normalization is only for
  cache deduplication.
- Incompatible cache or generator changes require a revision bump and
  actionable regeneration failure.

## Verification

Run the narrow unit test, affected integration cases, `bun run test:corpus`,
type-check, and example type-check. Run the complete suite when the rule crosses
multiple pipeline stages.
