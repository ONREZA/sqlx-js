# Type and nullability inference

sqlx-js derives query contracts from PostgreSQL and the query structure. It
does not maintain a second application schema and does not validate result
objects at runtime.

## Validation pipeline

For each unique literal query, `prepare`:

1. sends PostgreSQL `Parse` and `Describe Statement` to obtain parameter OIDs
   and result-column metadata;
2. asks PostgreSQL for a parameter-independent generic plan when the statement
   is accepted by the server-side `PREPARE` surface;
3. loads the referenced table, column, type, enum, domain, and composite
   metadata from PostgreSQL catalogs;
4. parses the SQL AST with `libpg-query` to recover expression provenance,
   join nullability, set-operation branches, and parameter targets;
5. combines the server contract, catalog metadata, SQL analysis, and explicit
   application assertions into TypeScript types.

Planning does not use `ANALYZE` and never executes the query. Statements outside
the server-owned generic-plan surface are recorded as `parse-only`; Parse and
Describe still validate their PostgreSQL contract.

## PostgreSQL type mapping

The OID returned by PostgreSQL is the starting point. Built-in scalar, array,
range, multirange, network, geometric, text-search, JSON, and temporal types
map to their runtime representation. Database-local metadata then resolves:

- PostgreSQL enums to exact string-literal unions;
- domains to their base type;
- composites to object types with nullable attributes;
- arrays to the corresponding element contract;
- supported extension types to their built-in application representation;
- configured `customTypes`, `jsonbTypes`, and `columnTypes` to
  application-owned declarations.

Configuration assertions and runtime codec requirements are documented in
[Configuration and custom types](./configuration.md).

## Result nullability

A direct result column is non-null only when every relevant layer proves it:

1. the source column has a PostgreSQL `NOT NULL` constraint;
2. its relation is not on the nullable side of an outer join;
3. the surrounding expression cannot introduce `NULL`;
4. every contributing branch of a set operation has the same non-null
   guarantee.

If a guarantee is missing, the result is `T | null`. Conservative nullability
is preferable to a generated type that can be violated at runtime.

### Joins

`LEFT`, `RIGHT`, and `FULL` joins make columns on their nullable sides nullable
regardless of the base table constraint. Inner join predicates can narrow
columns because rows that do not satisfy the predicate are removed.

Aliases, CTEs, derived tables, and supported lateral shapes retain source
provenance. Ambiguous multi-relation stars and recursive self-references can
lose enough provenance to require an explicit projection or assertion; see
[Limitations and non-goals](./limitations.md).

### Expressions

Expression nullability follows PostgreSQL semantics. Common examples include:

- `COUNT(*)` and `EXISTS (...)` are non-null;
- `COALESCE(value, non_null_fallback)` is non-null;
- `CASE` is non-null only when every result branch, including `ELSE`, is
  non-null;
- strict functions preserve nullable inputs unless SQL structure narrows them;
- array constructors and supported aggregates track both value and element
  nullability;
- arithmetic and ordinary value-preserving expressions propagate nullable
  inputs.

When an expression cannot be analysed precisely, sqlx-js keeps the PostgreSQL
type and degrades nullability conservatively rather than guessing.

### WHERE and JOIN narrowing

Predicates can prove a result column non-null:

- `col IS NOT NULL`;
- equality and inequality predicates that cannot be true for SQL `NULL`;
- `IN`, `LIKE`, and `BETWEEN`;
- equality chains that transfer a non-null guarantee.

For boolean composition, `AND` combines guarantees from either side while `OR`
retains only guarantees present in every branch. This prevents one optional
branch from incorrectly narrowing the complete result.

### Set operations

`UNION`, `INTERSECT`, and `EXCEPT` align columns by position. A result field is
non-null only when every branch that can contribute that field is non-null.
Compatible configured application types are preserved across direct and
CTE-backed branches; incompatible declarations fall back or fail according to
the contract instead of being selected by traversal order.

### Explicit result assertions

Use a column alias when the application owns a guarantee PostgreSQL metadata
cannot express:

```sql
SELECT id AS "id!" FROM users
SELECT nullable_value AS "nullableValue?" FROM source
```

- `!` forces a non-null result.
- `?` forces a nullable result.

The runtime strips the suffix, so the object keys above are `id` and
`nullableValue`. Assertions should be rare and reviewed with the SQL invariant
that makes them true. They are especially useful for stable database functions
whose `RETURNS TABLE` / `OUT` fields have no PostgreSQL `NOT NULL` metadata.
`queries explain` reports the conservative reason and the alias hint, but
sqlx-js deliberately does not inspect a function body and infer a stronger
contract from implementation details.

## Parameter inference

PostgreSQL's `ParameterDescription` supplies the server-selected parameter
type. sqlx-js then maps each `$N` to its direct SQL use:

- `INSERT` values and `INSERT ... SELECT` targets;
- `UPDATE SET` and row assignments;
- `ON CONFLICT DO UPDATE`;
- data-modifying CTEs;
- value-producing `CASE`, `COALESCE`, `GREATEST`, `LEAST`, and the stored side
  of `NULLIF`;
- `WHERE` and `JOIN` comparisons;
- `IN` list positions.

All compatible targets are aggregated. Conflicting application-owned
declarations fail prepare with the affected columns instead of silently
choosing one.

### Parameter nullability

A parameter becomes `T | null` when its SQL semantics or every stored-value
target accepts SQL `NULL`. Examples include:

- `COALESCE($1, ...)`, `NULLIF($1, ...)`, `IS [NOT] NULL`, and
  `IS [NOT] DISTINCT FROM`;
- a value stored into a nullable `INSERT`, `UPDATE`, or conflict-update target;
- value-preserving expressions that lead to nullable stored targets.

An ordinary predicate such as `WHERE col = $1` remains non-null even when
`col` is nullable: `col = NULL` is never true. Use `IS NOT DISTINCT FROM` or an
explicit nullable-filter pattern when passing `null` is intentional.

For a PostgreSQL function call, `pg_proc` does not contain per-input nullability
metadata. All SQL function inputs can receive SQL `NULL`; `proisstrict` only
changes whether PostgreSQL executes the body. Use a `defineQuery` source
contract such as `{ nullableParams: ["operationId"] }` when the application
allows null but the call expression itself does not prove that fact. The
generated `KnownFunctions` inventory therefore includes `null` in every input
parameter type, independently of the stricter call-site query contract.

Named parameters are rewritten to positional parameters in first-use order.
Repeated names reuse one position. The rewriter understands quoted strings,
comments, identifiers, and dollar-quoted bodies; it does not use a regular
expression.

## Array contracts

PostgreSQL column `NOT NULL` applies to the array value, not its elements.
Consequently, an ordinary `text[] NOT NULL` column is inferred as
`(string | null)[]`.

Elements become non-null only when proven by:

- a SQL constructor or expression whose inputs are all non-null;
- a PostgreSQL element domain declared `NOT NULL`;
- an `arrayElementNullability` assertion for a direct column.

Array value nullability and element nullability remain separate throughout
CTEs, subqueries, aggregates, and set operations. Declared dimensions are not
treated as fixed TypeScript tuple shapes because PostgreSQL does not enforce
them.

Parameters use explicit `sql.array(...)` wrappers so PostgreSQL arrays cannot
be confused with variadic arguments or JSON arrays. JSON values similarly use
`sql.json(...)`; a PostgreSQL `jsonb[]` composes both wrappers.

## Strict inference

`--strict-inference` promotes degraded analysis and unresolved `unknown` query
types to errors. It is intended for CI and for teams that want every generated
contract to be reviewed before merge.

Some conservative types are sound and do not fail the strict gate. An ordinary
array whose element nullability is not represented by PostgreSQL, for example,
correctly remains `(T | null)[]`.

When strict inference fails, prefer in this order:

1. make the invariant explicit in PostgreSQL;
2. project the relevant columns or simplify an ambiguous query shape;
3. use a configuration mapping for an application-owned representation;
4. use an explicit `!` or `?` result assertion when the database cannot expose
   the guarantee.

## Explain and corpus policy

Use the stable query ID from `sqlx-js queries` to inspect a committed inference
contract without a database:

```bash
sqlx-js queries explain 0123456789abcdef
sqlx-js queries explain 0123456789abcdef --json
```

The explanation includes result provenance and source constraints, every DML
and predicate target for each parameter, the reason for nullable or unknown
output, and the narrowest applicable hint. It reads the versioned prepare
cache, so CI and editors see the same reasoning as code generation.

Inference is extended from production corpus evidence rather than by trying to
model the entire PostgreSQL AST. A new rule should start with a real query that
degrades under strict inference, add the smallest sound analysis case, and
finish with a live PostgreSQL regression. Unsupported shapes remain
conservative.

[Documentation index](./README.md)
