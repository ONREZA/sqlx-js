import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { decodeText, parseDatabaseUrl, PgClient, type PgRowResult } from "./pg/wire";

export type SchemaRelationKind = "table" | "partitioned_table" | "view" | "materialized_view" | "foreign_table";
export type SchemaConstraintKind = "primary_key" | "foreign_key" | "unique" | "check" | "exclude";
export type SchemaFunctionKind = "function" | "procedure" | "aggregate" | "window";

export type SchemaColumnSnapshot = {
  name: string;
  ordinal: number;
  type: string;
  typeOid: number;
  nullable: boolean;
  writable: boolean;
  default?: string;
  identity?: "always" | "by_default";
  generated?: "stored";
  generatedExpression?: string;
};

export type SchemaConstraintSnapshot = {
  name: string;
  kind: SchemaConstraintKind;
  columns: string[];
  definition: string;
  expression?: string;
  references?: {
    schema: string;
    table: string;
    columns: string[];
    onUpdate: string;
    onDelete: string;
  };
  deferrable?: boolean;
  initiallyDeferred?: boolean;
};

export type SchemaIndexSnapshot = {
  name: string;
  unique: boolean;
  primary: boolean;
  method: string;
  columns: string[];
  definition: string;
  predicate?: string;
};

export type SchemaRelationSnapshot = {
  schema: string;
  name: string;
  kind: SchemaRelationKind;
  columns: SchemaColumnSnapshot[];
  constraints: SchemaConstraintSnapshot[];
  indexes: SchemaIndexSnapshot[];
  definition?: string;
};

export type SchemaEnumSnapshot = {
  kind: "enum";
  schema: string;
  name: string;
  values: string[];
};

export type SchemaDomainSnapshot = {
  kind: "domain";
  schema: string;
  name: string;
  baseType: string;
  notNull: boolean;
  default?: string;
  checks: string[];
};

export type SchemaCompositeSnapshot = {
  kind: "composite";
  schema: string;
  name: string;
  fields: { name: string; type: string }[];
};

export type SchemaTypeSnapshot = SchemaEnumSnapshot | SchemaDomainSnapshot | SchemaCompositeSnapshot;

export type SchemaFunctionSnapshot = {
  schema: string;
  name: string;
  kind: SchemaFunctionKind;
  identityArguments: string;
  arguments: string;
  returnType: string;
  returnsSet: boolean;
  volatility: "immutable" | "stable" | "volatile";
  strict: boolean;
  securityDefiner: boolean;
  language: string;
};

export type SchemaSnapshot = {
  version: 1;
  schemas: string[];
  relations: SchemaRelationSnapshot[];
  types: SchemaTypeSnapshot[];
  functions: SchemaFunctionSnapshot[];
};

type Row = Record<string, string | null>;

function rows(result: PgRowResult | { rows: (Uint8Array | null)[][]; fields: PgRowResult["fields"] }): Row[] {
  return result.rows.map((r) => {
    const out: Row = {};
    for (let i = 0; i < result.fields.length; i++) {
      out[result.fields[i]!.name] = decodeText(r[i] ?? null);
    }
    return out;
  });
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
}

function bool(value: string | null | undefined): boolean {
  return value === "t";
}

function num(value: string | null | undefined): number {
  return Number(value ?? 0);
}

function relationKind(raw: string | null | undefined): SchemaRelationKind {
  switch (raw) {
    case "r": return "table";
    case "p": return "partitioned_table";
    case "v": return "view";
    case "m": return "materialized_view";
    case "f": return "foreign_table";
    default: return "table";
  }
}

function constraintKind(raw: string | null | undefined): SchemaConstraintKind {
  switch (raw) {
    case "p": return "primary_key";
    case "f": return "foreign_key";
    case "u": return "unique";
    case "x": return "exclude";
    default: return "check";
  }
}

function functionKind(raw: string | null | undefined): SchemaFunctionKind {
  switch (raw) {
    case "p": return "procedure";
    case "a": return "aggregate";
    case "w": return "window";
    default: return "function";
  }
}

function volatility(raw: string | null | undefined): SchemaFunctionSnapshot["volatility"] {
  switch (raw) {
    case "i": return "immutable";
    case "s": return "stable";
    default: return "volatile";
  }
}

function action(raw: string | null | undefined): string {
  switch (raw) {
    case "r": return "restrict";
    case "c": return "cascade";
    case "n": return "set null";
    case "d": return "set default";
    default: return "no action";
  }
}

function byRelationKey<T extends { schema: string; table: string }>(items: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const key = `${item.schema}.${item.table}`;
    const arr = out.get(key) ?? [];
    arr.push(item);
    out.set(key, arr);
  }
  return out;
}

function relationKey(schema: string, name: string): string {
  return `${schema}.${name}`;
}

function systemSchemaFilter(alias = "n"): string {
  return `${alias}.nspname <> 'information_schema' AND ${alias}.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'`;
}

export async function introspectDatabase(databaseUrl: string): Promise<SchemaSnapshot> {
  const client = new PgClient(parseDatabaseUrl(databaseUrl));
  await client.connect();
  try {
    return await introspectConnected(client);
  } finally {
    await client.end();
  }
}

export async function introspectConnected(client: PgClient): Promise<SchemaSnapshot> {
  const relRows = rows(await client.simpleQuery(`
    SELECT
      n.nspname AS schema,
      c.relname AS name,
      c.relkind::text AS kind,
      CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) ELSE NULL END AS definition
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND ${systemSchemaFilter("n")}
    ORDER BY n.nspname, c.relname
  `));

  const colRows = rows(await client.simpleQuery(`
    SELECT
      n.nspname AS schema,
      c.relname AS table,
      a.attnum::int4 AS ordinal,
      a.attname AS name,
      format_type(a.atttypid, a.atttypmod) AS type,
      a.atttypid::int8 AS type_oid,
      a.attnotnull AS not_null,
      CASE WHEN a.attgenerated = '' THEN pg_get_expr(ad.adbin, ad.adrelid) ELSE NULL END AS default_expr,
      a.attidentity AS identity,
      a.attgenerated AS generated,
      CASE WHEN a.attgenerated <> '' THEN pg_get_expr(ad.adbin, ad.adrelid) ELSE NULL END AS generated_expr
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND ${systemSchemaFilter("n")}
      AND a.attnum > 0
      AND NOT a.attisdropped
    ORDER BY n.nspname, c.relname, a.attnum
  `));

  const constraintRows = rows(await client.simpleQuery(`
    SELECT
      n.nspname AS schema,
      c.relname AS table,
      con.conname AS name,
      con.contype::text AS kind,
      COALESCE((
        SELECT json_agg(a.attname ORDER BY u.ord)::text
        FROM unnest(con.conkey) WITH ORDINALITY AS u(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = u.attnum
      ), '[]') AS columns,
      pg_get_constraintdef(con.oid, true) AS definition,
      CASE WHEN con.contype = 'c' THEN pg_get_expr(con.conbin, con.conrelid) ELSE NULL END AS expression,
      rn.nspname AS ref_schema,
      rc.relname AS ref_table,
      COALESCE((
        SELECT json_agg(a.attname ORDER BY u.ord)::text
        FROM unnest(con.confkey) WITH ORDINALITY AS u(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = u.attnum
      ), '[]') AS ref_columns,
      con.confupdtype::text AS on_update,
      con.confdeltype::text AS on_delete,
      con.condeferrable AS deferrable,
      con.condeferred AS initially_deferred
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_class rc ON rc.oid = con.confrelid
    LEFT JOIN pg_namespace rn ON rn.oid = rc.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND ${systemSchemaFilter("n")}
    ORDER BY n.nspname, c.relname, con.conname
  `));

  const indexRows = rows(await client.simpleQuery(`
    SELECT
      n.nspname AS schema,
      tbl.relname AS table,
      idx.relname AS name,
      i.indisunique AS unique,
      i.indisprimary AS primary,
      am.amname AS method,
      COALESCE((
        SELECT json_agg(a.attname ORDER BY u.ord)::text
        FROM unnest(string_to_array(i.indkey::text, ' ')) WITH ORDINALITY AS u(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = u.attnum::int2
        WHERE u.attnum <> '0'
      ), '[]') AS columns,
      pg_get_indexdef(idx.oid) AS definition,
      pg_get_expr(i.indpred, i.indrelid) AS predicate
    FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_class tbl ON tbl.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = tbl.relnamespace
    JOIN pg_am am ON am.oid = idx.relam
    WHERE tbl.relkind IN ('r', 'p', 'm')
      AND ${systemSchemaFilter("n")}
    ORDER BY n.nspname, tbl.relname, idx.relname
  `));

  const enumRows = rows(await client.simpleQuery(`
    SELECT n.nspname AS schema, t.typname AS name, e.enumlabel AS value
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE ${systemSchemaFilter("n")}
    ORDER BY n.nspname, t.typname, e.enumsortorder
  `));

  const domainRows = rows(await client.simpleQuery(`
    SELECT
      n.nspname AS schema,
      t.typname AS name,
      format_type(t.typbasetype, t.typtypmod) AS base_type,
      t.typnotnull AS not_null,
      pg_get_expr(t.typdefaultbin, 0) AS default_expr,
      COALESCE((
        SELECT json_agg(pg_get_constraintdef(c.oid, true) ORDER BY c.conname)::text
        FROM pg_constraint c
        WHERE c.contypid = t.oid
      ), '[]') AS checks
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typtype = 'd'
      AND ${systemSchemaFilter("n")}
    ORDER BY n.nspname, t.typname
  `));

  const compositeRows = rows(await client.simpleQuery(`
    SELECT
      n.nspname AS schema,
      t.typname AS name,
      COALESCE((
        SELECT json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod)) ORDER BY a.attnum)::text
        FROM pg_attribute a
        WHERE a.attrelid = c.oid
          AND a.attnum > 0
          AND NOT a.attisdropped
      ), '[]') AS fields
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    JOIN pg_class c ON c.oid = t.typrelid AND c.relkind = 'c'
    WHERE t.typtype = 'c'
      AND ${systemSchemaFilter("n")}
    ORDER BY n.nspname, t.typname
  `));

  const functionRows = rows(await client.simpleQuery(`
    SELECT
      n.nspname AS schema,
      p.proname AS name,
      p.prokind::text AS kind,
      pg_get_function_identity_arguments(p.oid) AS identity_arguments,
      pg_get_function_arguments(p.oid) AS arguments,
      pg_get_function_result(p.oid) AS return_type,
      p.proretset AS returns_set,
      p.provolatile::text AS volatility,
      p.proisstrict AS strict,
      p.prosecdef AS security_definer,
      l.lanname AS language
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    WHERE ${systemSchemaFilter("n")}
    ORDER BY n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)
  `));

  const columnsByRel = byRelationKey(colRows.map((r) => ({
    schema: r.schema!,
    table: r.table!,
    column: {
      name: r.name!,
      ordinal: num(r.ordinal),
      type: r.type!,
      typeOid: num(r.type_oid),
      nullable: !bool(r.not_null),
      writable: r.generated !== "s" && r.identity !== "a",
      ...(r.default_expr ? { default: r.default_expr } : {}),
      ...(r.identity === "a" ? { identity: "always" as const } : {}),
      ...(r.identity === "d" ? { identity: "by_default" as const } : {}),
      ...(r.generated === "s" ? { generated: "stored" as const } : {}),
      ...(r.generated_expr ? { generatedExpression: r.generated_expr } : {}),
    },
  })));

  const constraintsByRel = byRelationKey(constraintRows.map((r) => {
    const item: { schema: string; table: string; constraint: SchemaConstraintSnapshot } = {
      schema: r.schema!,
      table: r.table!,
      constraint: {
        name: r.name!,
        kind: constraintKind(r.kind),
        columns: parseJsonArray(r.columns),
        definition: r.definition!,
        ...(r.expression ? { expression: r.expression } : {}),
        ...(bool(r.deferrable) ? { deferrable: true } : {}),
        ...(bool(r.initially_deferred) ? { initiallyDeferred: true } : {}),
      },
    };
    if (r.ref_schema && r.ref_table) {
      item.constraint.references = {
        schema: r.ref_schema,
        table: r.ref_table,
        columns: parseJsonArray(r.ref_columns),
        onUpdate: action(r.on_update),
        onDelete: action(r.on_delete),
      };
    }
    return item;
  }));

  const indexesByRel = byRelationKey(indexRows.map((r) => ({
    schema: r.schema!,
    table: r.table!,
    index: {
      name: r.name!,
      unique: bool(r.unique),
      primary: bool(r.primary),
      method: r.method!,
      columns: parseJsonArray(r.columns),
      definition: r.definition!,
      ...(r.predicate ? { predicate: r.predicate } : {}),
    },
  })));

  const relations: SchemaRelationSnapshot[] = relRows.map((r) => {
    const key = relationKey(r.schema!, r.name!);
    return {
      schema: r.schema!,
      name: r.name!,
      kind: relationKind(r.kind),
      columns: (columnsByRel.get(key) ?? []).map((c) => c.column),
      constraints: (constraintsByRel.get(key) ?? []).map((c) => c.constraint),
      indexes: (indexesByRel.get(key) ?? []).map((i) => i.index),
      ...(r.definition ? { definition: r.definition } : {}),
    };
  });

  const enumMap = new Map<string, SchemaEnumSnapshot>();
  for (const r of enumRows) {
    const key = relationKey(r.schema!, r.name!);
    const existing = enumMap.get(key);
    if (existing) existing.values.push(r.value!);
    else enumMap.set(key, { kind: "enum", schema: r.schema!, name: r.name!, values: [r.value!] });
  }

  const domains: SchemaDomainSnapshot[] = domainRows.map((r) => ({
    kind: "domain",
    schema: r.schema!,
    name: r.name!,
    baseType: r.base_type!,
    notNull: bool(r.not_null),
    ...(r.default_expr ? { default: r.default_expr } : {}),
    checks: parseJsonArray(r.checks),
  }));

  const composites: SchemaCompositeSnapshot[] = compositeRows.map((r) => ({
    kind: "composite",
    schema: r.schema!,
    name: r.name!,
    fields: (JSON.parse(r.fields ?? "[]") as unknown[]).flatMap((f) => {
      if (!f || typeof f !== "object") return [];
      const obj = f as Record<string, unknown>;
      return typeof obj.name === "string" && typeof obj.type === "string"
        ? [{ name: obj.name, type: obj.type }]
        : [];
    }),
  }));

  const functions: SchemaFunctionSnapshot[] = functionRows.map((r) => ({
    schema: r.schema!,
    name: r.name!,
    kind: functionKind(r.kind),
    identityArguments: r.identity_arguments ?? "",
    arguments: r.arguments ?? "",
    returnType: r.return_type ?? "void",
    returnsSet: bool(r.returns_set),
    volatility: volatility(r.volatility),
    strict: bool(r.strict),
    securityDefiner: bool(r.security_definer),
    language: r.language!,
  }));

  const schemas = [...new Set([
    ...relations.map((r) => r.schema),
    ...Array.from(enumMap.values()).map((t) => t.schema),
    ...domains.map((t) => t.schema),
    ...composites.map((t) => t.schema),
    ...functions.map((f) => f.schema),
  ])].sort();

  return {
    version: 1,
    schemas,
    relations,
    types: [...Array.from(enumMap.values()), ...domains, ...composites],
    functions,
  };
}

export function stableSchemaJson(snapshot: SchemaSnapshot): string {
  return JSON.stringify(snapshot, null, 2) + "\n";
}

export function writeSchemaSnapshot(path: string, snapshot: SchemaSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stableSchemaJson(snapshot));
}

export function readSchemaSnapshot(path: string): SchemaSnapshot {
  return JSON.parse(readFileSync(path, "utf8")) as SchemaSnapshot;
}

export function schemaSnapshotEqual(a: SchemaSnapshot, b: SchemaSnapshot): boolean {
  return stableSchemaJson(a) === stableSchemaJson(b);
}

export function renderSchemaManifest(snapshot: SchemaSnapshot): string {
  const lines: string[] = [];
  lines.push("# sqlx-js schema manifest");
  lines.push("");
  lines.push("Generated from PostgreSQL introspection. Do not edit by hand.");
  lines.push("");
  lines.push(`Schemas: ${snapshot.schemas.length === 0 ? "(none)" : snapshot.schemas.join(", ")}`);
  lines.push("");

  lines.push("## Relations");
  if (snapshot.relations.length === 0) lines.push("");
  if (snapshot.relations.length === 0) lines.push("(none)");
  for (const rel of snapshot.relations) {
    lines.push("");
    lines.push(`### ${rel.schema}.${rel.name} (${rel.kind})`);
    if (rel.definition) lines.push(`Definition: ${rel.definition.replace(/\s+/g, " ").trim()}`);
    lines.push("");
    lines.push("| Column | Type | Nullable | Writable | Default / Generated |");
    lines.push("|--------|------|----------|----------|---------------------|");
    for (const col of rel.columns) {
      const defaultInfo = col.generatedExpression ?? col.default ?? col.identity ?? "";
      lines.push(`| ${col.name} | ${col.type} | ${col.nullable ? "yes" : "no"} | ${col.writable ? "yes" : "no"} | ${defaultInfo} |`);
    }
    if (rel.constraints.length > 0) {
      lines.push("");
      lines.push("Constraints:");
      for (const c of rel.constraints) {
        const cols = c.columns.length > 0 ? ` [${c.columns.join(", ")}]` : "";
        const ref = c.references ? ` -> ${c.references.schema}.${c.references.table}(${c.references.columns.join(", ")})` : "";
        lines.push(`- ${c.name}: ${c.kind}${cols}${ref}; ${c.definition}`);
      }
    }
    if (rel.indexes.length > 0) {
      lines.push("");
      lines.push("Indexes:");
      for (const idx of rel.indexes) {
        const flags = [idx.primary ? "primary" : "", idx.unique ? "unique" : ""].filter(Boolean).join(", ");
        const cols = idx.columns.length > 0 ? ` [${idx.columns.join(", ")}]` : "";
        lines.push(`- ${idx.name}: ${idx.method}${cols}${flags ? ` (${flags})` : ""}`);
      }
    }
  }

  lines.push("");
  lines.push("## Types");
  if (snapshot.types.length === 0) lines.push("(none)");
  for (const t of snapshot.types) {
    if (t.kind === "enum") {
      lines.push(`- enum ${t.schema}.${t.name}: ${t.values.map((v) => JSON.stringify(v)).join(" | ")}`);
    } else if (t.kind === "domain") {
      const checks = t.checks.length > 0 ? `; checks: ${t.checks.join("; ")}` : "";
      lines.push(`- domain ${t.schema}.${t.name}: ${t.baseType}${t.notNull ? " not null" : ""}${checks}`);
    } else {
      lines.push(`- composite ${t.schema}.${t.name}: ${t.fields.map((f) => `${f.name} ${f.type}`).join(", ")}`);
    }
  }

  lines.push("");
  lines.push("## Functions");
  if (snapshot.functions.length === 0) lines.push("(none)");
  for (const fn of snapshot.functions) {
    const attrs = [
      fn.kind,
      fn.volatility,
      fn.strict ? "strict" : "",
      fn.securityDefiner ? "security definer" : "",
      fn.returnsSet ? "returns set" : "",
    ].filter(Boolean).join(", ");
    lines.push(`- ${fn.schema}.${fn.name}(${fn.identityArguments}) -> ${fn.returnType} [${attrs}]`);
  }

  lines.push("");
  return lines.join("\n");
}

export function writeSchemaManifest(path: string, snapshot: SchemaSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderSchemaManifest(snapshot));
}

export function schemaSnapshotExists(path: string): boolean {
  return existsSync(path);
}
