---
name: sqlx-js-custom-types
description: Configure or implement sqlx-js PostgreSQL type handling, including built-in OIDs, enums, domains, composites, arrays, jsonbTypes, columnTypes, array element assertions, customTypes, typeCodecs, numeric raw codecs, enum catalogs, and function catalogs. Use when generated and runtime representations differ or a PostgreSQL type needs support.
---

# sqlx-js custom types

Choose the narrowest mapping whose compile-time and runtime representations can
remain aligned.

## Decision order

1. Prefer a database-owned PostgreSQL type or constraint.
2. Use the built-in OID or extension registry when supported.
3. Use `jsonbTypes` for direct JSON/JSONB column contracts.
4. Use `columnTypes` for an application-owned direct scalar assertion.
5. Use `arrayElementNullability` only for a real externally enforced invariant.
6. Use `customTypes` plus matching managed `typeCodecs` for a non-system type
   representation.
7. Use explicit numeric `types` only when the raw client owns database-local
   OIDs.

Read [the type routing guide](references/type-routing.md) before adding a
mapping or codec.

## Invariants

- Keep compile-time generated types and runtime parser/serializer values equal.
- Resolve database-local OIDs once per managed generation.
- Reject missing configured type names during bootstrap.
- Treat PostgreSQL array value nullability separately from element nullability.
- Domains inherit their base runtime OID; do not create domain-specific codecs.
- Preserve `int8` as native `bigint`.
- Do not guess whether an application array is JSON or PostgreSQL; require
  explicit wrappers.
- Add built-in OIDs in `src/pg/oids.ts` and cover them in OID tests.
- Changing generated type contracts may require cache/generator compatibility
  work through `sqlx-js-upgrades`.
