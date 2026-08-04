import { decodeText, parseDatabaseUrl, PgClient } from "../pg/wire";
import { scanProject } from "../scan/scanner";
import { queryId } from "../query-id";
import type { SqlxJsConfig } from "../config";
import { EXTENDED_JSON_PROTOCOL_VERSION } from "../json-value";

type JsonColumn = {
  schema: string;
  relation: string;
  column: string;
  type: "json" | "jsonb";
  selectable: boolean;
  rowSecurityActive: boolean;
};

export type JsonAuditColumn = JsonColumn & {
  collisionRows: number;
  duplicateKeyRows: number;
  error?: string;
};

export type JsonAuditDependency = {
  kind: "constraint" | "generated" | "index" | "view";
  schema: string;
  name: string;
  sourceSchema: string;
  sourceRelation: string;
  sourceColumn: string;
  definition: string;
};

export type JsonAuditSourceUsage = {
  file: string;
  line: number;
  column: number;
  queryId: string;
  indicators: string[];
};

export type JsonAuditReport = {
  formatVersion: 1;
  protocolVersion: typeof EXTENDED_JSON_PROTOCOL_VERSION;
  ok: boolean;
  complete: boolean;
  columns: JsonAuditColumn[];
  dependencies: JsonAuditDependency[];
  sourceUsages: JsonAuditSourceUsage[];
  summary: {
    columns: number;
    scannedColumns: number;
    collisionRows: number;
    duplicateKeyRows: number;
    errors: number;
    dependencies: number;
    sourceUsages: number;
    reviewRequired: boolean;
  };
};

export type JsonAuditOptions = {
  root: string;
  databaseUrl: string;
  config: SqlxJsConfig;
  json?: boolean;
};

const JSON_COLUMNS_QUERY = `
SELECT
  namespace.nspname,
  relation.relname,
  attribute.attname,
  type.typname,
  pg_catalog.has_column_privilege(relation.oid, attribute.attnum, 'SELECT'),
  pg_catalog.row_security_active(relation.oid)
FROM pg_catalog.pg_attribute AS attribute
JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
JOIN pg_catalog.pg_type AS type ON type.oid = attribute.atttypid
WHERE relation.relkind IN ('r', 'm')
  AND attribute.attnum > 0
  AND NOT attribute.attisdropped
  AND type.typname IN ('json', 'jsonb')
  AND namespace.nspname <> 'pg_catalog'
  AND namespace.nspname <> 'information_schema'
  AND namespace.nspname NOT LIKE 'pg_toast%'
  AND namespace.nspname NOT LIKE 'pg_temp_%'
ORDER BY namespace.nspname, relation.relname, attribute.attnum
`;

const JSON_DEPENDENCIES_QUERY = `
WITH json_columns AS (
  SELECT
    relation.oid AS relation_oid,
    namespace.nspname AS source_schema,
    relation.relname AS source_relation,
    attribute.attnum,
    attribute.attname AS source_column
  FROM pg_catalog.pg_attribute AS attribute
  JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  JOIN pg_catalog.pg_type AS type ON type.oid = attribute.atttypid
  WHERE relation.relkind IN ('r', 'm')
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped
    AND type.typname IN ('json', 'jsonb')
    AND namespace.nspname <> 'pg_catalog'
    AND namespace.nspname <> 'information_schema'
    AND namespace.nspname NOT LIKE 'pg_toast%'
    AND namespace.nspname NOT LIKE 'pg_temp_%'
), dependencies AS (
  SELECT DISTINCT
    'index'::text AS kind,
    index_namespace.nspname AS schema_name,
    index_relation.relname AS object_name,
    json_column.source_schema,
    json_column.source_relation,
    json_column.source_column,
    pg_catalog.pg_get_indexdef(index_relation.oid) AS definition
  FROM json_columns AS json_column
  JOIN pg_catalog.pg_depend AS dependency
    ON dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
   AND dependency.refobjid = json_column.relation_oid
   AND dependency.refobjsubid = json_column.attnum
  JOIN pg_catalog.pg_index AS index_info ON index_info.indexrelid = dependency.objid
  JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_info.indexrelid
  JOIN pg_catalog.pg_namespace AS index_namespace ON index_namespace.oid = index_relation.relnamespace

  UNION ALL

  SELECT DISTINCT
    'constraint'::text,
    source_namespace.nspname,
    constraint_info.conname,
    json_column.source_schema,
    json_column.source_relation,
    json_column.source_column,
    pg_catalog.pg_get_constraintdef(constraint_info.oid, true)
  FROM json_columns AS json_column
  JOIN pg_catalog.pg_depend AS dependency
    ON dependency.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass
   AND dependency.refobjid = json_column.relation_oid
   AND dependency.refobjsubid = json_column.attnum
  JOIN pg_catalog.pg_constraint AS constraint_info ON constraint_info.oid = dependency.objid
  JOIN pg_catalog.pg_namespace AS source_namespace ON source_namespace.oid = constraint_info.connamespace

  UNION ALL

  SELECT DISTINCT
    'generated'::text,
    json_column.source_schema,
    target_attribute.attname,
    json_column.source_schema,
    json_column.source_relation,
    json_column.source_column,
    pg_catalog.pg_get_expr(attribute_default.adbin, attribute_default.adrelid, true)
  FROM json_columns AS json_column
  JOIN pg_catalog.pg_depend AS dependency
    ON dependency.classid = 'pg_catalog.pg_attrdef'::pg_catalog.regclass
   AND dependency.refobjid = json_column.relation_oid
   AND dependency.refobjsubid = json_column.attnum
  JOIN pg_catalog.pg_attrdef AS attribute_default ON attribute_default.oid = dependency.objid
  JOIN pg_catalog.pg_attribute AS target_attribute
    ON target_attribute.attrelid = attribute_default.adrelid
   AND target_attribute.attnum = attribute_default.adnum
  WHERE target_attribute.attgenerated <> ''

  UNION ALL

  SELECT DISTINCT
    'view'::text,
    view_namespace.nspname,
    view_relation.relname,
    json_column.source_schema,
    json_column.source_relation,
    json_column.source_column,
    pg_catalog.pg_get_viewdef(view_relation.oid, true)
  FROM json_columns AS json_column
  JOIN pg_catalog.pg_depend AS dependency
    ON dependency.classid = 'pg_catalog.pg_rewrite'::pg_catalog.regclass
   AND dependency.refobjid = json_column.relation_oid
   AND dependency.refobjsubid = json_column.attnum
  JOIN pg_catalog.pg_rewrite AS rewrite_rule ON rewrite_rule.oid = dependency.objid
  JOIN pg_catalog.pg_class AS view_relation ON view_relation.oid = rewrite_rule.ev_class
  JOIN pg_catalog.pg_namespace AS view_namespace ON view_namespace.oid = view_relation.relnamespace
  WHERE view_relation.relkind IN ('v', 'm')
)
SELECT kind, schema_name, object_name, source_schema, source_relation, source_column, definition
FROM dependencies
ORDER BY kind, schema_name, object_name, source_schema, source_relation, source_column
`;

export function inspectJsonSourceUsages(root: string, config: SqlxJsConfig): JsonAuditSourceUsage[] {
  return scanProject(root, config.scan, config.profiles)
    .flatMap((site) => {
      const indicators = jsonSensitiveIndicators(site.query);
      return indicators.length === 0 ? [] : [{
        file: site.file,
        line: site.line,
        column: site.column,
        queryId: queryId(site.query),
        indicators,
      }];
    })
    .filter((usage, index, all) => all.findIndex((candidate) =>
      candidate.file === usage.file
      && candidate.line === usage.line
      && candidate.column === usage.column
      && candidate.queryId === usage.queryId
    ) === index)
    .sort((left, right) => left.file.localeCompare(right.file)
      || left.line - right.line
      || left.column - right.column);
}

export function jsonSensitiveIndicators(query: string): string[] {
  const indicators = new Set<string>();
  const operators: readonly [string, RegExp][] = [
    ["->>", /->>/],
    ["->", /->(?!>)/],
    ["#>>", /#>>/],
    ["#>", /#>(?!>)/],
    ["@>", /@>/],
    ["<@", /<@/],
    ["?|", /\?\|/],
    ["?&", /\?&/],
    ["@?", /@\?/],
    ["@@", /@@/],
  ];
  for (const [operator, pattern] of operators) if (pattern.test(query)) indicators.add(operator);
  if (/(?<!@)\?(?![|&])/.test(query)) indicators.add("?");
  for (const match of query.matchAll(/\b(jsonb?_[a-z_]+)\s*\(/gi)) indicators.add(match[1]!.toLowerCase());
  return [...indicators].sort();
}

export async function inspectJsonAudit(opts: JsonAuditOptions): Promise<JsonAuditReport> {
  const client = new PgClient(parseDatabaseUrl(opts.databaseUrl));
  const columns: JsonAuditColumn[] = [];
  let dependencies: JsonAuditDependency[] = [];
  let complete = true;
  try {
    await client.connect();
    await client.simpleQuery("BEGIN READ ONLY");
    const columnResult = await client.simpleQuery(JSON_COLUMNS_QUERY);
    const inventory: JsonColumn[] = columnResult.rows.map((row) => ({
      schema: requiredText(row[0]),
      relation: requiredText(row[1]),
      column: requiredText(row[2]),
      type: requiredText(row[3]) as "json" | "jsonb",
      selectable: parseBoolean(row[4]),
      rowSecurityActive: parseBoolean(row[5]),
    }));
    for (const column of inventory) {
      if (!column.selectable) {
        columns.push({
          ...column,
          collisionRows: 0,
          duplicateKeyRows: 0,
          error: "current role does not have SELECT privilege on this column",
        });
        complete = false;
        continue;
      }
      if (column.rowSecurityActive) {
        columns.push({
          ...column,
          collisionRows: 0,
          duplicateKeyRows: 0,
          error: "row-level security is active for the current role",
        });
        complete = false;
        continue;
      }
      await client.simpleQuery("SAVEPOINT sqlx_js_json_audit_column");
      try {
        const counts = await inspectColumn(client, column);
        await client.simpleQuery("RELEASE SAVEPOINT sqlx_js_json_audit_column");
        columns.push({ ...column, ...counts });
      } catch (error) {
        await client.simpleQuery("ROLLBACK TO SAVEPOINT sqlx_js_json_audit_column").catch(() => {});
        await client.simpleQuery("RELEASE SAVEPOINT sqlx_js_json_audit_column").catch(() => {});
        columns.push({
          ...column,
          collisionRows: 0,
          duplicateKeyRows: 0,
          error: (error as Error).message,
        });
        complete = false;
      }
    }
    const dependencyResult = await client.simpleQuery(JSON_DEPENDENCIES_QUERY);
    dependencies = dependencyResult.rows.map((row) => ({
      kind: requiredText(row[0]) as JsonAuditDependency["kind"],
      schema: requiredText(row[1]),
      name: requiredText(row[2]),
      sourceSchema: requiredText(row[3]),
      sourceRelation: requiredText(row[4]),
      sourceColumn: requiredText(row[5]),
      definition: requiredText(row[6]),
    }));
    await client.simpleQuery("COMMIT");
  } catch (error) {
    await client.simpleQuery("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end().catch(() => {});
  }

  const sourceUsages = inspectJsonSourceUsages(opts.root, opts.config);
  const collisionRows = columns.reduce((total, column) => total + column.collisionRows, 0);
  const duplicateKeyRows = columns.reduce((total, column) => total + column.duplicateKeyRows, 0);
  const errors = columns.filter((column) => column.error).length;
  const ok = complete && collisionRows === 0 && duplicateKeyRows === 0;
  return {
    formatVersion: 1,
    protocolVersion: EXTENDED_JSON_PROTOCOL_VERSION,
    ok,
    complete,
    columns,
    dependencies,
    sourceUsages,
    summary: {
      columns: columns.length,
      scannedColumns: columns.length - errors,
      collisionRows,
      duplicateKeyRows,
      errors,
      dependencies: dependencies.length,
      sourceUsages: sourceUsages.length,
      reviewRequired: dependencies.length > 0 || sourceUsages.length > 0,
    },
  };
}

export async function runJsonAudit(opts: JsonAuditOptions): Promise<void> {
  const report = await inspectJsonAudit(opts);
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `json audit: ${report.summary.scannedColumns}/${report.summary.columns} column(s) scanned; `
      + `${report.summary.collisionRows} collision row(s); ${report.summary.duplicateKeyRows} duplicate-key row(s)`,
    );
    for (const column of report.columns) {
      if (!column.error && column.collisionRows === 0 && column.duplicateKeyRows === 0) continue;
      const name = `${column.schema}.${column.relation}.${column.column}`;
      if (column.error) console.log(`error   ${name}: ${column.error}`);
      else console.log(
        `blocked ${name}: ${column.collisionRows} collision row(s), ${column.duplicateKeyRows} duplicate-key row(s)`,
      );
    }
    console.log(
      `review: ${report.summary.dependencies} schema dependency item(s), `
      + `${report.summary.sourceUsages} source query usage(s)`,
    );
  }
  if (!report.ok) process.exitCode = 1;
}

async function inspectColumn(
  client: PgClient,
  column: JsonColumn,
): Promise<Pick<JsonAuditColumn, "collisionRows" | "duplicateKeyRows">> {
  const each = column.type === "jsonb" ? "pg_catalog.jsonb_each" : "pg_catalog.json_each";
  const arrayElements = column.type === "jsonb"
    ? "pg_catalog.jsonb_array_elements"
    : "pg_catalog.json_array_elements";
  const typeOf = column.type === "jsonb" ? "pg_catalog.jsonb_typeof" : "pg_catalog.json_typeof";
  const emptyObject = `'{}'::pg_catalog.${column.type}`;
  const emptyArray = `'[]'::pg_catalog.${column.type}`;
  const target = `${quoteIdentifier(column.schema)}.${quoteIdentifier(column.relation)}`;
  const source = quoteIdentifier(column.column);
  const duplicateExpression = column.type === "jsonb"
    ? "false"
    : `EXISTS (
        SELECT 1
        FROM ${each}(CASE WHEN ${typeOf}(walk.value) = 'object' THEN walk.value ELSE ${emptyObject} END) AS duplicate
        GROUP BY duplicate.key
        HAVING count(*) > 1
      )`;
  const result = await client.simpleQuery(`
WITH RECURSIVE walk(row_id, value) AS (
  SELECT tableoid::text || ':' || ctid::text, ${source}
  FROM ${target}
  WHERE ${source} IS NOT NULL

  UNION ALL

  SELECT walk.row_id, child.value
  FROM walk
  CROSS JOIN LATERAL (
    SELECT object_item.value
    FROM ${each}(
      CASE WHEN ${typeOf}(walk.value) = 'object' THEN walk.value ELSE ${emptyObject} END
    ) AS object_item

    UNION ALL

    SELECT array_item.value
    FROM ${arrayElements}(
      CASE WHEN ${typeOf}(walk.value) = 'array' THEN walk.value ELSE ${emptyArray} END
    ) AS array_item
  ) AS child
), affected AS (
  SELECT
    row_id,
    EXISTS (
      SELECT 1
      FROM ${each}(CASE WHEN ${typeOf}(walk.value) = 'object' THEN walk.value ELSE ${emptyObject} END) AS member
      WHERE member.key = '$sqlx'
    ) AS collision,
    ${duplicateExpression} AS duplicate_keys
  FROM walk
)
SELECT
  count(DISTINCT row_id) FILTER (WHERE collision)::text,
  count(DISTINCT row_id) FILTER (WHERE duplicate_keys)::text
FROM affected
  `);
  return {
    collisionRows: parseCount(rowOrThrow(result.rows, 0)[0]),
    duplicateKeyRows: parseCount(rowOrThrow(result.rows, 0)[1]),
  };
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function requiredText(value: Uint8Array | null | undefined): string {
  const text = decodeText(value ?? null);
  if (text === null) throw new Error("sqlx-js json audit: PostgreSQL returned an unexpected NULL");
  return text;
}

function parseBoolean(value: Uint8Array | null | undefined): boolean {
  const text = requiredText(value);
  return text === "t" || text === "true" || text === "1";
}

function parseCount(value: Uint8Array | null | undefined): number {
  const count = Number(requiredText(value));
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("sqlx-js json audit: PostgreSQL returned an invalid row count");
  }
  return count;
}

function rowOrThrow(rows: (Uint8Array | null)[][], index: number): (Uint8Array | null)[] {
  const row = rows[index];
  if (!row) throw new Error("sqlx-js json audit: PostgreSQL returned no audit result");
  return row;
}
