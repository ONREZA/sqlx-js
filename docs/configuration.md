# Configuration and custom types

Configure scanning, schema ownership, application type assertions, enum generation, function metadata, and runtime codecs.

`sqlx-js.config.ts` at the project root is optional.

Under Node.js, TypeScript config is loaded through Node 24's native type stripping, so keep it to erasable TypeScript syntax. The generated `defineConfig(...)` form works on both Node and Bun; use `.mjs` if the config needs runtime constructs that Node cannot strip.

```ts
import { defineConfig } from "@onreza/sqlx-js";

export default defineConfig({
  scan: {
    include: ["apps/*/src/**/*", "packages/*/src/**/*"],
    exclude: ["**/*.generated.ts"],
    modules: ["@onreza/sqlx-js", "@app/database"],
  },
  schema: {
    provider: "pgschema",
    file: "schema.sql",
    schemas: ["public"],
  },
  jsonbTypes: {
    "users.settings":     'import("@app/shared/database-json").UserSettings',
    "posts.meta":         'import("@app/shared/database-json").PostMeta',
    "posts.attachments":  'import("@app/shared/database-json").Attachment[]',
  },
  // Explicit application-owned assertions for direct scalar columns only.
  columnTypes: {
    "analytics_event.action": "AnalyticsAction",
  },
  // Assert an application-enforced invariant for a direct array column.
  arrayElementNullability: {
    "analytics_event.tags": "non-null",
  },
  functionCatalog: {
    // Extension-owned functions and their contract warnings are excluded by default.
    includeExtensionOwned: false,
  },
  enumCatalog: {
    output: "src/database/db-enums.ts",
    schemas: ["public", "billing"],
    include: ["public.user_role", "public.status", "billing.status"],
    aliases: {
      "public.status": "AccountStatus",
      "billing.status": "BillingStatus",
    },
    registry: true,
  },
});
```

By default the scanner uses the root `tsconfig.json` file list and follows TypeScript project references, so a referenced monorepo is scanned without walking unrelated folders. `scan.include` replaces that source-file universe with TypeScript glob patterns; `scan.exclude` is added to the built-in dependency/build exclusions. `scan.modules` replaces the default `@onreza/sqlx-js` import source list, which lets an application re-export `sql` through a shared database module without requiring arbitrary re-export graph analysis. Include `@onreza/sqlx-js` explicitly when direct imports and application-module imports are both used. If there is no root `tsconfig.json`, the fallback is a recursive TypeScript scan.

The `schema` block is optional. Use `provider: "pgschema"` when sqlx-js should delegate schema planning/apply commands to pgschema. `command` can override the managed binary lookup and point at another executable. With the pinned pgschema 1.12.0 CLI, `schemas` must contain exactly one schema name.

Point mappings directly at the application's canonical exported types. The strings are emitted as TypeScript type expressions, so `import("...").Type` keeps the generated declaration self-contained and avoids a duplicate ambient schema:

```ts
// packages/shared/src/database-json.ts
export type UserSettings = {
  theme: "light" | "dark";
  lang: string;
  notifications?: { email: boolean; push: boolean };
};
export type PostMeta = { tags?: string[]; pinned?: boolean };
export type Attachment = { url: string; kind: "image" | "video" | "file"; sizeBytes: number };
```

After re-running `prepare`, every direct `jsonb` column or mapped parameter uses the corresponding application-owned TypeScript type. Set operations preserve that type through direct or CTE-backed branches when every contributing source resolves to the same configured declaration; incompatible or partially unmapped result branches fall back to the PostgreSQL type instead of guessing. Parameters retain every direct-column target across data-modifying CTEs; conflicting configured declarations for one parameter fail prepare with the affected columns instead of choosing one by traversal order. This is a compile-time assertion, not runtime JSON validation; the application schema remains the source of truth. Columns without a custom mapping use `JsonValue` for result rows and `JsonParameter<unknown>` for parameters: the existential parameter type accepts any wrapper already proven JSON-safe by `sql.json(value)` without requiring domain interfaces to declare a string index signature. `--strict-inference` accepts this intentional wrapper while continuing to reject unresolved `unknown` elsewhere in generated query contracts. Non-JSON inputs such as `Date`, functions, and `bigint` are rejected by TypeScript while plain JSON objects, arrays, strings, numbers, booleans, and nested JSON `null` values are accepted. A bare top-level `null` remains SQL `NULL` and is allowed only when every stored-value target for that parameter accepts it; use `sql.json(null)` for JSON `null`.

## Direct scalar `columnTypes`

`columnTypes` is an explicit application-owned type assertion for a direct scalar table column. It affects result fields that PostgreSQL attributes to that exact column, compatible set-operation branches reconstructed by sqlx-js, and parameters mapped back through `INSERT`, `UPDATE`, data-modifying CTE, `WHERE`, or `JOIN` analysis. For stored values, sqlx-js aggregates every DML target and accepts one unique configured declaration; when no DML target exists, predicate references provide the parameter declaration instead. Conflicting declarations within the effective target set fail prepare rather than depending on traversal order. It never changes arbitrary expressions such as `upper(action)`, and it does not apply to PostgreSQL/JSON array columns. Use a schema-qualified key when table names can collide. Mapping the same logical column through both `jsonbTypes` and `columnTypes` is rejected.

This assertion does not validate stored values at runtime. Prefer a PostgreSQL enum/domain when the database truly owns a closed value set; use `columnTypes` when the database deliberately stores a broader scalar such as `text` and the application accepts responsibility for the narrower TypeScript contract.

## Generated enum catalog

Query parameters and rows use PostgreSQL enum labels as literal unions automatically. Enable `enumCatalog` when application code also needs reusable runtime values for forms, validators, tests, or business logic:

```ts
export default defineConfig({
  enumCatalog: {
    output: "src/database/db-enums.ts",
    schemas: ["public", "billing"],
    include: ["public.user_role", "public.status", "billing.status"],
    aliases: {
      "public.status": "AccountStatus",
      "billing.status": "BillingStatus",
    },
    registry: true,
  },
});
```

`prepare` introspects every enum in the explicitly listed schemas, including types not referenced by a scanned query, and writes a root-relative TypeScript module:

```ts
export const UserRole = {
  ["admin"]: "admin",
  ["editor"]: "editor",
  ["viewer"]: "viewer",
} as const;

export type UserRole = (typeof UserRole)[keyof typeof UserRole];
```

The generated object is an ordinary runtime value while its same-named type remains the exact string union, so `UserRole.admin` is directly assignable to an enum-typed SQL parameter. PostgreSQL labels are preserved verbatim as computed string keys, including special JavaScript property names such as `__proto__`; no native TypeScript `enum` or runtime validation is introduced. PostgreSQL type names are converted to PascalCase exports (`user_role` → `UserRole`), with `Pg` prefixed when a name starts with a digit. If selected schemas contain names that normalize to the same export, prepare fails with both schema-qualified types. Resolve intentional collisions with `aliases`, keyed by the exact schema-qualified PostgreSQL name.

Use `include` as an exact schema-qualified allowlist or `exclude` as an exact blocklist; they cannot be combined. With neither option, every enum from `schemas` is generated. Unknown selections fail instead of silently producing an incomplete catalog, aliases must target selected enums, and registry entries follow the same filtered set. The committed cache still keeps every enum from `schemas`, so changing either filter remains an offline generation operation:

```ts
enumCatalog: {
  output: "src/database/db-enums.ts",
  schemas: ["public"],
  exclude: ["public.internal_status", "public.legacy_state"],
}
```

`registry: true` additionally emits an opt-in schema-qualified registry for dynamic access. It is disabled by default:

```ts
export const DbEnums = {
  ["billing.status"]: BillingStatus,
  ["public.status"]: AccountStatus,
  ["public.user_role"]: UserRole,
} as const;

export type DbEnumName = keyof typeof DbEnums;
export type DbEnumValue<Name extends DbEnumName> = /* exact value union */;
```

Use `DbEnums["public.user_role"].admin` when code chooses a database enum dynamically; prefer the direct `UserRole.admin` export for ordinary imports.

The catalog snapshot is committed at `.sqlx-js/enums/enums.json`. `prepare --offline` regenerates the configured module from that snapshot, `prepare --check` verifies both files without writing, and `prepare --verify` compares them against `DATABASE_URL` without touching the worktree. Changing only `output`, `include`, `exclude`, `aliases`, or `registry` can therefore be completed with `prepare --offline`; changing `schemas` requires a live prepare.

The enum module and declaration output must be different files. If `--dts` overrides the declaration destination, prepare and doctor reject a colliding `enumCatalog.output` before writing either artifact.

Moving `output` or disabling the catalog does not delete the previous TypeScript module, because the new configuration no longer identifies that path safely. Update imports and remove the old generated file explicitly; the next live prepare removes a disabled catalog's cache and prints a reminder.

## Array element nullability assertions

`arrayElementNullability` is an application-owned assertion for direct PostgreSQL array columns whose elements are guaranteed non-null outside PostgreSQL's type system. Use `"non-null"` only when writes and existing data enforce that invariant. It follows direct-column provenance through CTEs, derived tables, compatible set-operation branches, and mapped parameters; arbitrary expressions are not narrowed by column name.

Prefer a database-owned element contract when possible:

```sql
CREATE DOMAIN non_null_tag AS text NOT NULL;
CREATE TABLE events (tags non_null_tag[] NOT NULL);
```

Arrays of that domain are inferred as `string[]` without config. Ordinary `text[]` remains `(string | null)[]` when no SQL or configuration proof exists. This uncertainty is a sound result type and does not fail `--strict-inference`.

## Function catalog scope

Application-owned functions and procedures from non-system schemas are generated into `KnownFunctions`. Each signature records approximate parameter/return types together with `volatility`, `securityDefiner`, `leakproof`, `parallelSafety`, `owner`, `ownerSuperuser`, `publicExecute`, `searchPath`, and `extensionOwned`. A `null` `searchPath` means the function has no function-local `SET search_path` clause and inherits the session setting. `publicExecute` reflects the effective PostgreSQL function ACL, including the default `EXECUTE TO PUBLIC` grant when `proacl` is null.

The same metadata is committed in `.sqlx-js/functions/functions.json`, so `prepare --check` and `prepare --offline` reproduce the live diagnostics from cache, while `prepare --verify` detects database drift without modifying the worktree. Catalog and generator revisions fail closed with regeneration guidance after an incompatible upgrade; run one live `prepare`. Schema snapshots carry the same metadata and likewise require `snapshot dump` when their format changes.

Owner attributes and effective ACLs are intentionally environment-sensitive contract data. A shadow or verification database must create routines under the intended owner and apply the same grants, or the committed artifacts will drift. Prefer explicit `ALTER FUNCTION ... OWNER TO ...` / `ALTER PROCEDURE ... OWNER TO ...`, `REVOKE`, and `GRANT` statements when those boundaries must be identical across environments.

`prepare` emits non-blocking `function-contract` warnings for these high-risk application-owned declarations:

| Diagnostic code | Review required |
|-----------------|-----------------|
| `security-definer-missing-search-path` | Add a function-local path containing only trusted schemas with `pg_temp` last. |
| `security-definer-unsafe-search-path` | Move explicit `pg_temp` to the final path position. |
| `security-definer-superuser-owner` | Prefer a dedicated least-privilege owner for the privilege boundary. |
| `security-definer-public-execute` | Revoke `PUBLIC` access and grant `EXECUTE` only to intended roles. |
| `leakproof` | Confirm the function cannot reveal argument information before security barriers. |
| `volatile-parallel-safe` | Confirm worker safety or mark the function `PARALLEL UNSAFE`. |

These diagnostics validate declared metadata, not function bodies. In particular, sqlx-js cannot infer which application roles may create objects in an arbitrary schema, so an explicit path ending in `pg_temp` still requires a human review that every preceding schema is trusted. The `PUBLIC` check also cannot prove that the remaining role grants are the intended least-privilege set.

Objects owned by installed extensions are excluded through `pg_depend`, preventing extension internals from dominating committed artifacts or warnings. Set `functionCatalog.includeExtensionOwned: true` only when those approximate signatures and metadata are needed; extension-owned entries remain exempt from application diagnostics. Set `functionCatalog: false` to disable catalog generation entirely.

## Extension types, `customTypes`, and `typeCodecs`

sqlx-js ships with built-in compile-time and runtime codecs for popular PostgreSQL extension types:

| `pg_type.typname` | TS type                            | Source extension |
|-------------------|------------------------------------|-------------------|
| `vector`          | `number[]`                         | pgvector          |
| `halfvec`         | `number[]`                         | pgvector          |
| `sparsevec`       | `string`                           | pgvector          |
| `hstore`          | `Record<string, string \| null>`   | hstore            |
| `citext`          | `string`                           | citext            |
| `ltree`           | `string`                           | ltree             |
| `lquery`          | `string`                           | ltree             |
| `ltxtquery`       | `string`                           | ltree             |

Add or override mappings via `customTypes` in `sqlx-js.config.ts`. Keys are non-system `pg_type.typname` values (the bare element type name, not `_typename` array names). Live prepare verifies that every configured type exists and rejects system, array, and domain targets before publishing artifacts. The registry is global by type name, so two schemas with the same `typname` cannot be mapped differently:

```ts
import { defineConfig } from "@onreza/sqlx-js";

export default defineConfig({
  customTypes: {
    vector: "Float32Array",         // override pgvector default
    geometry: "GeoJSON.Geometry",   // postgis (not built-in by design)
    myapp_color: "`#${string}`",    // application representation of an enum
  },
});
```

Domains resolve to their base type through `pg_type.typbasetype`. `CREATE DOMAIN positive_int AS integer CHECK (VALUE > 0)` → `number`, `CREATE DOMAIN tagged AS hstore` → `Record<string, string | null>`. PostgreSQL reports domain result columns with the base type OID, so domain-specific `customTypes` / `typeCodecs` overrides are rejected rather than producing a read/write contract that only works for parameters. Use `columnTypes` for a runtime-compatible branded assertion on a direct domain column. Array variants of any registered scalar are wired up automatically — `vector[]` → `(number[])[]`.

Composite types (`CREATE TYPE foo AS (a int, b text)`) resolve to a struct literal — `{ a: number | null; b: string | null }` — with each attribute typed (enums, domains, and nested composites included) and nullable unless the attribute is `NOT NULL`. Array variants (`foo[]`) resolve too.

PostgreSQL assigns database-local OIDs to enums, domains, composites, and
extension types. The runtime resolves those OIDs once per pool generation
before the first application query, then installs both scalar and array
parsers/serializers in the integrated driver. Enums use their string labels,
domains delegate to their base type, composites become objects keyed by
attribute name, and built-in `vector`/`halfvec`/`hstore` mappings match the
TypeScript table above. Existing numeric `types` entries remain authoritative.
Apply migrations before creating the application pool; recreate the client
after adding or replacing database types so discovery sees the new catalog.

For an application-defined `customTypes` representation, provide the matching name-based runtime codec. Explicit mappings can override non-system base/extension, enum, range, and composite representations. Every configured `customTypes` entry is emitted into `SqlxJsGeneratedRegistry["runtimeTypes"]`; binding that registry to `createSqlClient<SqlxJsGeneratedRegistry>(...)` makes missing codecs and incompatible parser/serializer values TypeScript errors:

```ts
import { createSqlClient } from "@onreza/sqlx-js";
import type { SqlxJsGeneratedRegistry } from "./sqlx-js-env.js";
import queryDescriptors from "./.sqlx-js/runtime-descriptors.json" with { type: "json" };
import { parseGeometry, serializeGeometry } from "./geometry-codec.js";

const db = createSqlClient<SqlxJsGeneratedRegistry>(process.env.DATABASE_URL, {
  queryDescriptors,
  typeCodecs: {
    vector: {
      parse: (value) => new Float32Array(
        value === "[]" ? [] : value.slice(1, -1).split(",").map(Number),
      ),
      serialize: (value) => `[${Array.from(value).join(",")}]`,
    },
    geometry: {
      parse: parseGeometry,
      serialize: serializeGeometry,
    },
    myapp_color: {
      parse: (value) => value as `#${string}`,
      serialize: String,
    },
  },
});
```

Raw clients do not perform name-to-OID discovery. Bind generated custom types
to explicit numeric `types` when raw access is required:

```ts
import { createClient } from "@onreza/sqlx-js";
import type { SqlxJsGeneratedRegistry } from "./sqlx-js-env.js";

const raw = createClient<SqlxJsGeneratedRegistry>(process.env.DATABASE_URL, {
  types: {
    geometry: {
      to: 50_000,
      from: [50_000],
      parse: parseGeometry,
      serialize: serializeGeometry,
    },
  },
});
```

The contract is scoped rather than ambient, so separate database packages can use the same PostgreSQL type name with different application representations. Prefer the registry-bound managed client for strict end-to-end discovery, deadline, and recovery guarantees.

Generated `customTypes` contracts use bare keys matching `pg_type.typname`. Bare codec keys apply to every matching type name; schema-qualified keys such as `postgis.geometry` are available for additional manually configured codecs but do not replace a generated bare-key requirement. A configured key that does not exist fails during bootstrap instead of silently leaving a mismatched runtime value. Codecs receive the scalar PostgreSQL text representation; their parser and serializer are composed automatically for composite attributes and arrays.

Database-specific numeric codecs remain a fully typed alternative. Pass
`types` keyed by the generated `customTypes` names; each value is checked as
the integrated driver's `PostgresType<T>` for that application type. The
numeric OIDs remain application-owned and take runtime precedence. If both
mechanisms are needed, satisfy the generated contract with `typeCodecs` and add
unrelated numeric `types` alongside it.

[Documentation index](./README.md)
