# Inference pipeline source map

| Stage | Primary source | Evidence / output |
| --- | --- | --- |
| Scan | `src/scan/scanner.ts` | Literal query sites, files, profiles, cardinality |
| Fingerprint | `src/query-id.ts`, `src/cache.ts` | Stable query ID and cache key |
| Describe / plan | `src/pg/wire.ts` | Parameter OIDs, row metadata, generic plan |
| Schema | `src/pg/schema.ts` | Tables, columns, types, enums, domains, composites |
| Expression analysis | `src/pg/analyze.ts` | Provenance and result nullability |
| Predicate narrowing | `src/pg/narrow.ts` | Forced non-null column keys |
| Parameter targets | `src/pg/param-map.ts` | DML and predicate bindings |
| Type resolution | `src/commands/prepare.ts` | Final parameter and row declarations |
| Persistence | `src/cache.ts`, `src/codegen.ts` | Cache and `sqlx-js-env.d.ts` |

## Test routing

- Scanner syntax, imports, shadowing: `tests/scanner*.test.ts`.
- AST expressions and joins: `tests/analyze*.test.ts`.
- Narrowing predicates: `tests/narrow.test.ts`.
- Parameter targets: `tests/param-map.test.ts`.
- Cache compatibility: `tests/cache.test.ts`.
- Generated declarations and live PostgreSQL behavior:
  `tests/prepare.integration.test.ts`.
- Production query compatibility: `bun run test:corpus`.

## Common failure classification

- Query absent from declarations: scan stage.
- Wrong PostgreSQL base type: Describe, schema, or OID resolution.
- Correct base type but wrong `null`: analyze, narrow, or DML post-state.
- Wrong parameter application type: param mapping or config provenance.
- Correct cache but stale declaration: persistence or artifact comparison.
- Only profile-specific failure: profile scan propagation or role-bound
  prepare session.
