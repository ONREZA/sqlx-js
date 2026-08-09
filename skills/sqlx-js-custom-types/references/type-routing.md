# Type routing guide

| Requirement | Configuration / source |
| --- | --- |
| Built-in PostgreSQL OID | `src/pg/oids.ts` |
| Built-in extension name | `src/pg/extensions.ts` and runtime codecs |
| Direct JSON or scalar application assertion | `columnTypes` |
| Direct array non-null element assertion | `arrayElementNullability` |
| Runtime enum constants | `enumCatalog` |
| Function security/planner inventory | `functionCatalog` |
| Application-defined non-system representation | `customTypes` + `typeCodecs` |
| Raw client database-specific OID | numeric `types` |

## Database-local types

- Enums decode to labels.
- Domains delegate to the base type.
- Composites decode to objects keyed by attributes.
- Scalar array codecs compose from the element codec.
- Built-in vector, halfvec, hstore, citext, and ltree-family mappings are
  name-based but must not capture unrelated user types.

## Assertions

`columnTypes` and `arrayElementNullability` are compile-time
application assertions, not runtime validators. Apply them only to direct
column provenance. Fail on conflicting declarations instead of selecting one
by traversal order.

## Verification

Test scalar and array round-trips, database-local OID discovery, reconnect or
generation replacement, missing configured types, composite nesting, domains,
and TypeScript rejection of incompatible codec values.
