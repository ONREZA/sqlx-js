# Query API

Detailed contracts for typed queries, reusable definitions, SQL files, cardinality helpers, and explicit PostgreSQL parameter representations.

## `sql(query, ...params)`

The typed query function. New applications obtain it from the generated
client boundary; the package-level `sql` export is deprecated:

```ts
import { db } from "./db.js";

const { sql } = db;
```

The first argument must be a string literal that exists in the active generated
registry (populated by `prepare`).

```ts
const rows = await sql(`SELECT id FROM users WHERE name = $1`, "alice");
//                      ^ literal — checked at compile time
```

Unknown queries, wrong parameter types, and dynamic strings are compile errors. For genuinely dynamic SQL, use `unsafe`.

## `defineQuery`

Define a query once without closing over a global client, then run the same generated contract through a root or transaction executor:

```ts
import {
  defineQuery,
  type QueryParams,
  type QueryResult,
  type QueryRow,
  type SqlExecutor,
} from "@onreza/sqlx-js";
import { db } from "./db.js";

export const findUser = defineQuery.optional(
  "users.findById",
  `SELECT id, email FROM users WHERE id = $id`,
);

type FindUserParams = QueryParams<typeof findUser>;
type FindUserRow = QueryRow<typeof findUser>;
type FindUserResult = QueryResult<typeof findUser>; // FindUserRow | null

await findUser.run(db.sql, { id: userId });
await db.sql.transaction((tx) => findUser.run(tx, { id: userId }));

async function loadUser(executor: SqlExecutor, params: FindUserParams) {
  return findUser.run(executor, params);
}
```

The optional definition name is included in query observer and inventory metadata. The stable `queryId` is derived from the same lexical SQL fingerprint used by prepare/cache. `defineQuery.one`, `.optional`, and `.execute` mirror the cardinality contracts of the corresponding `sql` helpers.

The final options object records source-owned facts that PostgreSQL does not
expose through `Describe`:

```ts
export const retire = defineQuery.one(
  "billing.retire",
  `SELECT retire_subscription($retireAt::timestamptz, $operationId::text) AS result`,
  { nullableParams: ["retireAt", "operationId"] },
);

export const analyze = defineQuery.execute(
  "maintenance.analyze",
  `ANALYZE billing_event`,
  { expectedValidation: "parse-only" },
);

export const claimDelivery = defineQuery.one(
  "delivery.claim",
  `SELECT capabilities AS "capabilities!" FROM claim_delivery()`,
  { resultAssertions: { capabilities: { elements: "non-null" } } },
);
```

For named SQL, `nullableParams` contains parameter names; for positional SQL,
it contains 1-based indexes. The assertion widens the generated input type to
`T | null`. It cannot override a direct `NOT NULL` stored-value target: live
prepare fails instead of generating a contract that PostgreSQL cannot satisfy.

`expectedValidation: "parse-only"` acknowledges a reviewed statement outside
PostgreSQL's generic `PREPARE`/`EXPLAIN EXECUTE` surface. Parse and Describe
still run. If the statement later becomes plannable, prepare warns that the
source expectation is stale; if any call site for the same query/profile has
not acknowledged parse-only validation, the normal plan warning remains and
`--strict-inference` promotes it to an error.

`resultAssertions` records an application-owned result invariant that PostgreSQL
cannot represent. The supported assertion narrows an array result from
`(T | null)[]` to `T[]`; the column key is the emitted object key after `!` or
`?` alias suffix removal. Live prepare fails if the key is not an output column
or its PostgreSQL type is not an array. The assertion is exact-query metadata,
so use it for opaque expressions or `RETURNS TABLE` / `OUT` fields; prefer a
database domain or `arrayElementNullability` for a direct stored column. Prepare
does not execute the query or prove the data invariant.

Changing `nullableParams` or `resultAssertions` makes the committed query cache
stale and requires live prepare. `sqlx-js queries` exposes all source contracts
in its database-free inventory. Keep the options object, its arrays, and nested
assertion objects as inline literals so the database-free scanner can validate
the complete contract; variables and spreads are rejected.

Use `mapParams` when the application input is intentionally narrower or more expressive than PostgreSQL's physical parameters:

```ts
import { defineQuery, type QueryParams, type QueryWireParams } from "@onreza/sqlx-js";

type AnalyticsEvent = { id: string; action: "created" | "deleted" };

export const insertEvents = defineQuery.execute(
  "analytics.insertBatch",
  `INSERT INTO analytics_event (payload)
   SELECT item FROM jsonb_array_elements($events::jsonb) AS item`,
).mapParams((events: readonly AnalyticsEvent[], { json }) => ({
  events: json(events),
}));

type InsertEventsInput = QueryParams<typeof insertEvents>;       // readonly AnalyticsEvent[]
type InsertEventsWire = QueryWireParams<typeof insertEvents>;    // { events: JsonParameter<unknown> }
```

The mapper receives only `json` and `array` parameter helpers. Once `prepare` has emitted `KnownQueries`, its output is checked exactly at the definition against the generated wire contract: missing, extra, and incompatible fields are compile errors. An application input can therefore narrow or reorganize the API without widening PostgreSQL parameters. The mapper executes once per call before named-parameter binding; root, generic scoped, and transaction executors keep the same result, observer, and query-ID behavior. This is the intended boundary for discriminated unions such as `preserve | clear | set`: the application owns the union and maps it to the physical flags and nullable values required by SQL.

## Typed database functions for reusable filtered reads

For a large filtered dataset, keep filtering and pagination in PostgreSQL. Do not fetch `SELECT *` and filter in application code, interpolate clauses through `unsafe`, or copy the same query for parameter-value combinations. When the database owns a stable parameterized read API, call it through one literal `defineQuery` so prepare validates the invocation and emits its exact parameter and row contract:

```ts
export const listFilteredUsers = defineQuery(
  "users.listFiltered",
  `SELECT
     id AS "id!",
     name AS "name!",
     email AS "email!",
     role AS "role!",
     created_at AS "createdAt!"
   FROM public.list_users(
     COALESCE($role, NULL::public.user_role),
     COALESCE($search, NULL::text),
     COALESCE($afterId, NULL::bigint),
     $limit
   )`,
);
```

The example migration owns the function, while application code depends only on the prepared call. The null-aware wrappers make optional filter inputs explicit to sqlx-js without parsing the function body. PostgreSQL does not expose `NOT NULL` metadata for `RETURNS TABLE` fields, so the `!` aliases explicitly assert the non-null contract implemented by this function; keep those assertions aligned with its SQL. `KnownFunctions` remains useful inventory metadata; the executable call contract above comes from PostgreSQL `Describe` of the literal `SELECT`. See [the complete example](../example/v12_database_function.ts) and [its migration](../example/migrations/0004_add_filtered_user_function.up.sql).

This is a sqlx-js usage pattern, not a universal PostgreSQL design. A real workload may need different indexes, keyset pagination, plan inspection, a security model, or a materialized view with an explicit refresh strategy. Choose that database design for the workload rather than hiding it behind dynamic application SQL. Relevant PostgreSQL references: [table functions](https://www.postgresql.org/docs/current/queries-table-expressions.html#QUERIES-TABLEFUNCTIONS), [`EXPLAIN`](https://www.postgresql.org/docs/current/sql-explain.html), [materialized views and refresh](https://www.postgresql.org/docs/current/rules-materializedviews.html), and [function security](https://www.postgresql.org/docs/current/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY).

## `sql.file(path, ...params)`

Load SQL from an external file. The path is root-relative everywhere: prepare resolves it against `--root`, codegen keeps the exact string literal as the `KnownFileQueries` key, and runtime resolves it against `fileRoot` (default: `process.cwd()`). Absolute paths and paths escaping the root are rejected.

```ts
// queries/top_admins.sql
// SELECT id AS "id!", name AS "name!" FROM users WHERE role = $1 ORDER BY id LIMIT $2::int

import { sql } from "@onreza/sqlx-js";

const admins = await sql.file("queries/top_admins.sql", "admin", 5);
//                                                       ^ string  ^ number
// admins: { id: bigint; name: string }[]
```

File-backed queries are emitted into a separate `KnownFileQueries` interface. A call from any nested source directory still uses the same project-root-relative literal.

For a compiled or bundled application, emit a TypeScript asset module and pass it to the client:

```bash
sqlx-js queries --embed src/sqlx-js-files.generated.ts
```

```ts
import { createSqlClient } from "@onreza/sqlx-js";
import type { SqlxJsGeneratedRegistry } from "./sqlx-js-env.js";
import queryDescriptors from "./.sqlx-js/runtime-descriptors.json" with { type: "json" };
import { sqlxJsEmbeddedSql } from "./sqlx-js-files.generated.js";

const db = createSqlClient<SqlxJsGeneratedRegistry>(databaseUrl, {
  queryDescriptors,
  sqlFiles: sqlxJsEmbeddedSql,
});
```

Embedded entries take precedence over filesystem reads. The module contains only referenced external SQL files; inline SQL remains in application code.

## `sql.with(options)(query, ...params)`

Bind a request-scoped deadline or `AbortSignal` to an ordinary typed query
without declaring a reusable `defineQuery`:

```ts
const requestSql = db.sql.with({
  timeoutMs: 2_000,
  signal: request.signal,
});
const user = await requestSql.one(
  `SELECT id, name FROM users WHERE id = $1`,
  userId,
);
```

The returned typed executor also supports `.one`, `.optional`, `.execute`, and
`.file`, and the same form works on transaction executors. Bound executors can
be assigned to a local `const` and reused for one request; chained `.with(...)`
calls merge their options, with the later call taking precedence for duplicate
keys. Options are captured when the executor is created. Execution options
passed by a `defineQuery` call on that bound executor are merged by the same
rule.

The options stay outside PostgreSQL parameters and do not change the query
fingerprint or its generated registry entry. A query-level timeout or abort
inside a transaction expires the whole transaction so the runtime can
establish rollback before reusing its connection.

## `sql.one(query, ...params)` and `sql.optional(query, ...params)`

Convenience wrappers for single-row queries. `one` throws if the row count is not exactly 1; `optional` returns `null` for 0 rows and throws on more than 1. They keep working under `noUncheckedIndexedAccess: true` without `rows[0]!` patterns.

```ts
const user = await sql.one(`SELECT id, name FROM users WHERE id = $1`, 1n);
// user: { id: bigint; name: string }

const maybe = await sql.optional(`SELECT id FROM users WHERE email = $1`, "x@y");
// maybe: { id: bigint } | null
```

Both forms also exist on `sql.file` (`sql.file.one("queries/by_id.sql", ...)`) and inside transactions (`tx.one(...)`, `tx.optional(...)`, `tx.file.one(...)`, `tx.file.optional(...)`). The scanner recognizes every chain — these call sites are added to `KnownQueries` / `KnownFileQueries` just like a plain `sql(...)`.

## `sql.execute(query, ...params)`

Execute a typed statement when rows are not the result contract. It preserves parameter checking and returns Postgres command metadata:

```ts
const result = await sql.execute(
  `UPDATE jobs SET claimed_at = now() WHERE id = $1 AND claimed_at IS NULL`,
  jobId,
);

if (result.rowCount !== 1) throw new Error("job was already claimed");
// result: { rowCount: number; command: string }
```

`sql.file.execute(...)` and `tx.execute(...)` use the same contract. Query hooks receive the affected-row count rather than `0` for DML without `RETURNING`.

Prepare compares the helper to PostgreSQL's described result shape:

- `.one()` and `.optional()` without a result set are errors;
- plain `sql()` without a result set warns, and fails under
  `--strict-inference`;
- `.execute()` with a result set warns because it discards returned rows.

The check is entirely prepare-time. sqlx-js deliberately does not claim that
an arbitrary query returns exactly one row; `.one()` keeps that runtime
cardinality check.

## JSON and PostgreSQL array parameters

Parameter wrappers make the wire representation explicit. Use `sql.array(...)` for PostgreSQL arrays and `sql.json(...)` for `json`/`jsonb` values:

```ts
await sql(
  "SELECT $1::text[] AS tags",
  sql.array(["alpha", "beta,gamma", "with \"quote\""]),
);

await sql(
  "INSERT INTO events (payload) VALUES ($1)",
  sql.json([1, 2, 3]),
);

await sql(
  "SELECT $1::jsonb[] AS payloads",
  sql.array([sql.json({ kind: "created" }), sql.json([1, 2, 3]), null]),
);
```

Generated parameter types require `PgArrayParameter<T, NullableElements>` or `JsonParameter<T>`, so mixing the two representations is a TypeScript error. `sql.array(...)` derives whether its input contains SQL `NULL` elements. Ordinary PostgreSQL array targets accept either form; an array whose element type is a `DOMAIN ... NOT NULL`, or whose source column has an `arrayElementNullability` assertion, accepts only a non-null-element wrapper. A PostgreSQL `json[]` / `jsonb[]` composes both wrappers: the outer `sql.array(...)` selects the PostgreSQL array representation and each non-SQL-NULL element uses `sql.json(...)`. `sql.json(null)` represents JSON `null`; a bare `null` inside `sql.array(...)` represents an SQL `NULL` array element.

PostgreSQL column `NOT NULL` constrains the array value, not its elements. Therefore an ordinary `text[] NOT NULL` result is `(string | null)[]`; `prepare` emits `string[]` only after proving non-null elements from the SQL expression, a `NOT NULL` element domain, or an explicit application assertion. Declared array dimensions are not treated as a fixed TypeScript shape because PostgreSQL does not enforce them.

`sql.json()` accepts ordinary structurally JSON-compatible interfaces and preserves their concrete type in `JsonParameter<T>`. Runtime values must be deterministic plain records or arrays; class instances, binary views, custom `toJSON`, accessors, symbol/named array properties, array holes, and ignored symbol-keyed object properties fail instead of relying on lossy `JSON.stringify` coercion. It also rejects known non-JSON values such as `Date`, Temporal objects, `bigint`, functions, non-finite numbers, unsafe integers, and `undefined` array elements. Result decoding applies the same safe-integer check so a large JSON integer cannot be silently rounded; represent exact integers outside JavaScript's safe range as strings. TypeScript is structurally typed, so it cannot identify every user-defined class solely because it was constructed with `new`; runtime validation remains authoritative.

The built-in `json`/`jsonb` scalar and array codecs own this safety boundary.
Low-level numeric `types` cannot replace them; application-owned custom types
remain configurable through their ordinary codec contract.

Both helpers also work with `unsafe(...)`. `encodePgArrayLiteral(arr)` remains exported for code that explicitly needs a PostgreSQL array literal string.

PostgreSQL `date`, `time`, `timestamp`, and `timestamptz` use
`Temporal.PlainDate`, `Temporal.PlainTime`, `Temporal.PlainDateTime`, and
`Temporal.Instant` respectively. JavaScript `Date`, infinity, PostgreSQL `time`
24:00, and precision that PostgreSQL cannot preserve are rejected rather than coerced. See the
[Temporal boundary](./configuration.md#temporal-boundary) for the UTC session
guarantee and query-local `timestamp without time zone` exception contract.

## Parameter nullability

`prepare` infers param types as `T | null` when:

- `$N` appears inside `COALESCE($N, …)`, `NULLIF($N, …)`, `IS [NOT] NULL`, or `IS [NOT] DISTINCT FROM` — these patterns are only meaningful when the parameter can be `null`.
- `$N` contributes a value to a nullable `INSERT`, `UPDATE`, or `ON CONFLICT DO UPDATE` target, directly or through value-preserving `CASE`, `COALESCE`, `GREATEST`/`LEAST`, or the stored side of `NULLIF`.

`WHERE col = $N` stays non-null even if `col` is nullable: `col = NULL` is always false in SQL, so passing `null` from the caller would be a bug. Use `col IS NOT DISTINCT FROM $N` (or an `OR $N IS NULL` clause) when you want NULL semantics.

PostgreSQL function arguments have types but no per-argument `NOT NULL`
catalog flag. `STRICT` controls whether PostgreSQL calls the function when an
input is null; it does not make null an invalid SQL argument. For a direct
function call whose surrounding SQL has no null-aware expression, use the
`defineQuery` `nullableParams` contract instead of a sentinel such as an empty
string. Keep `CASE`, `COALESCE`, or `NULLIF` only when that expression is part
of the real SQL behavior.

[Documentation index](./README.md)
