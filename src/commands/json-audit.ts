import { decodeText, parseDatabaseUrl, PgClient } from "../pg/wire";
import { scanProject } from "../scan/scanner";
import { queryId } from "../query-id";
import type { SqlxJsConfig } from "../config";
import { EXTENDED_JSON_PROTOCOL_VERSION } from "../json-value";
import { JSON_NUMBER_LIMITS } from "../json-number";

type JsonLeafStep =
  | { kind: "domain"; schema: string; name: string }
  | { kind: "array" }
  | { kind: "field"; name: string };

export type JsonAuditLeaf = {
  path: string;
  type: "json" | "jsonb";
};

type JsonLeafInventory = JsonAuditLeaf & {
  steps: JsonLeafStep[];
};

type JsonColumn = {
  schema: string;
  relation: string;
  column: string;
  type: string;
  jsonLeaves: JsonAuditLeaf[];
  selectable: boolean;
  rowSecurityActive: boolean;
};

type JsonColumnInventory = JsonColumn & {
  leafInventory: JsonLeafInventory[];
};

export type JsonAuditColumn = JsonColumn & {
  collisionRows: number;
  duplicateKeyRows: number;
  invalidNumberRows: number;
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
    invalidNumberRows: number;
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

const JSON_COLUMN_GRAPH_CTES = `
user_columns AS (
  SELECT
    relation.oid AS relation_oid,
    namespace.nspname AS source_schema,
    relation.relname AS source_relation,
    attribute.attnum,
    attribute.attname AS source_column,
    attribute.atttypid AS root_type_oid,
    pg_catalog.format_type(attribute.atttypid, NULL) AS root_type,
    pg_catalog.has_column_privilege(relation.oid, attribute.attnum, 'SELECT') AS selectable,
    pg_catalog.row_security_active(relation.oid) AS row_security_active
  FROM pg_catalog.pg_attribute AS attribute
  JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE relation.relkind IN ('r', 'm')
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped
    AND namespace.nspname <> 'pg_catalog'
    AND namespace.nspname <> 'information_schema'
    AND namespace.nspname NOT LIKE 'pg_toast%'
    AND namespace.nspname NOT LIKE 'pg_temp_%'
), type_edges AS (
  SELECT
    container_type.oid AS container_oid,
    child_type.oid AS child_oid,
    'domain'::text AS edge_kind,
    NULL::text AS field_name,
    child_namespace.nspname AS child_schema,
    child_type.typname AS child_name
  FROM pg_catalog.pg_type AS container_type
  JOIN pg_catalog.pg_type AS child_type ON child_type.oid = container_type.typbasetype
  JOIN pg_catalog.pg_namespace AS child_namespace ON child_namespace.oid = child_type.typnamespace
  WHERE container_type.typtype = 'd'
    AND container_type.typbasetype <> 0

  UNION ALL

  SELECT
    container_type.oid,
    child_type.oid,
    'array'::text,
    NULL::text,
    child_namespace.nspname,
    child_type.typname
  FROM pg_catalog.pg_type AS container_type
  JOIN pg_catalog.pg_type AS child_type ON child_type.oid = container_type.typelem
  JOIN pg_catalog.pg_namespace AS child_namespace ON child_namespace.oid = child_type.typnamespace
  WHERE container_type.typcategory = 'A'
    AND container_type.typelem <> 0

  UNION ALL

  SELECT
    container_type.oid,
    child_type.oid,
    'field'::text,
    attribute.attname,
    child_namespace.nspname,
    child_type.typname
  FROM pg_catalog.pg_type AS container_type
  JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = container_type.typrelid
  JOIN pg_catalog.pg_type AS child_type ON child_type.oid = attribute.atttypid
  JOIN pg_catalog.pg_namespace AS child_namespace ON child_namespace.oid = child_type.typnamespace
  WHERE container_type.typtype = 'c'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped
), type_walk AS (
  SELECT
    user_column.*,
    user_column.root_type_oid AS current_type_oid,
    '[]'::pg_catalog.jsonb AS steps,
    ARRAY[user_column.root_type_oid]::pg_catalog.oid[] AS seen_oids
  FROM user_columns AS user_column

  UNION ALL

  SELECT
    type_walk.relation_oid,
    type_walk.source_schema,
    type_walk.source_relation,
    type_walk.attnum,
    type_walk.source_column,
    type_walk.root_type_oid,
    type_walk.root_type,
    type_walk.selectable,
    type_walk.row_security_active,
    type_edge.child_oid,
    type_walk.steps || pg_catalog.jsonb_build_array(
      CASE type_edge.edge_kind
        WHEN 'domain' THEN pg_catalog.jsonb_build_object(
          'kind', 'domain',
          'schema', type_edge.child_schema,
          'name', type_edge.child_name
        )
        WHEN 'array' THEN pg_catalog.jsonb_build_object('kind', 'array')
        ELSE pg_catalog.jsonb_build_object('kind', 'field', 'name', type_edge.field_name)
      END
    ),
    type_walk.seen_oids || type_edge.child_oid
  FROM type_walk
  JOIN type_edges AS type_edge ON type_edge.container_oid = type_walk.current_type_oid
  WHERE NOT type_edge.child_oid = ANY(type_walk.seen_oids)
), json_leaf_columns AS (
  SELECT *
  FROM type_walk
  WHERE current_type_oid IN (114, 3802)
)
`;

const JSON_COLUMNS_QUERY = `
WITH RECURSIVE ${JSON_COLUMN_GRAPH_CTES}
SELECT
  source_schema,
  source_relation,
  source_column,
  root_type,
  selectable,
  row_security_active,
  pg_catalog.jsonb_agg(DISTINCT pg_catalog.jsonb_build_object(
    'type', CASE current_type_oid WHEN 114 THEN 'json' ELSE 'jsonb' END,
    'steps', steps
  ))::text
FROM json_leaf_columns
GROUP BY
  relation_oid,
  source_schema,
  source_relation,
  attnum,
  source_column,
  root_type,
  selectable,
  row_security_active
ORDER BY source_schema, source_relation, attnum
`;

const JSON_DEPENDENCIES_QUERY = `
WITH RECURSIVE ${JSON_COLUMN_GRAPH_CTES}, json_columns AS (
  SELECT DISTINCT
    relation_oid,
    source_schema,
    source_relation,
    attnum,
    source_column
  FROM json_leaf_columns
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
    const inventory: JsonColumnInventory[] = columnResult.rows.map((row) => {
      const leafInventory = parseJsonLeafInventory(row[6]);
      return {
        schema: requiredText(row[0]),
        relation: requiredText(row[1]),
        column: requiredText(row[2]),
        type: requiredText(row[3]),
        jsonLeaves: leafInventory.map(({ path, type }) => ({ path, type })),
        selectable: parseBoolean(row[4]),
        rowSecurityActive: parseBoolean(row[5]),
        leafInventory,
      };
    });
    for (const inventoryColumn of inventory) {
      const { leafInventory, ...column } = inventoryColumn;
      if (!column.selectable) {
        columns.push({
          ...column,
          collisionRows: 0,
          duplicateKeyRows: 0,
          invalidNumberRows: 0,
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
          invalidNumberRows: 0,
          error: "row-level security is active for the current role",
        });
        complete = false;
        continue;
      }
      await client.simpleQuery("SAVEPOINT sqlx_js_json_audit_column");
      try {
        const counts = await inspectColumn(client, column, leafInventory);
        await client.simpleQuery("RELEASE SAVEPOINT sqlx_js_json_audit_column");
        columns.push({ ...column, ...counts });
      } catch (error) {
        await client.simpleQuery("ROLLBACK TO SAVEPOINT sqlx_js_json_audit_column").catch(() => {});
        await client.simpleQuery("RELEASE SAVEPOINT sqlx_js_json_audit_column").catch(() => {});
        columns.push({
          ...column,
          collisionRows: 0,
          duplicateKeyRows: 0,
          invalidNumberRows: 0,
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
  const invalidNumberRows = columns.reduce((total, column) => total + column.invalidNumberRows, 0);
  const errors = columns.filter((column) => column.error).length;
  const ok = complete && collisionRows === 0 && duplicateKeyRows === 0 && invalidNumberRows === 0;
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
      invalidNumberRows,
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
      + `${report.summary.collisionRows} collision row(s); `
      + `${report.summary.duplicateKeyRows} duplicate-key row(s); `
      + `${report.summary.invalidNumberRows} invalid-number row(s)`,
    );
    for (const column of report.columns) {
      if (
        !column.error
        && column.collisionRows === 0
        && column.duplicateKeyRows === 0
        && column.invalidNumberRows === 0
      ) continue;
      const name = `${column.schema}.${column.relation}.${column.column}`;
      if (column.error) console.log(`error   ${name}: ${column.error}`);
      else console.log(
        `blocked ${name}: ${column.collisionRows} collision row(s), `
        + `${column.duplicateKeyRows} duplicate-key row(s), `
        + `${column.invalidNumberRows} invalid-number row(s)`,
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
  leaves: JsonLeafInventory[],
): Promise<Pick<JsonAuditColumn, "collisionRows" | "duplicateKeyRows" | "invalidNumberRows">> {
  const jsonLeaves = leaves.filter((leaf) => leaf.type === "json");
  const jsonbLeaves = leaves.filter((leaf) => leaf.type === "jsonb");
  const result = await client.simpleQuery(`
WITH RECURSIVE
${renderJsonRoots(column, "json", jsonLeaves)},
${renderJsonRoots(column, "jsonb", jsonbLeaves)},
${renderJsonWalk("json")},
${renderJsonWalk("jsonb")},
affected AS (
  SELECT row_id, collision, duplicate_keys, invalid_number FROM json_affected
  UNION ALL
  SELECT row_id, collision, duplicate_keys, invalid_number FROM jsonb_affected
), affected_rows AS (
  SELECT
    row_id,
    pg_catalog.bool_or(collision) AS collision,
    pg_catalog.bool_or(duplicate_keys) AS duplicate_keys,
    pg_catalog.bool_or(invalid_number) AS invalid_number
  FROM affected
  GROUP BY row_id
)
SELECT
  count(*) FILTER (WHERE collision)::text,
  count(*) FILTER (WHERE duplicate_keys)::text,
  count(*) FILTER (WHERE invalid_number)::text
FROM affected_rows
  `);
  return {
    collisionRows: parseCount(rowOrThrow(result.rows, 0)[0]),
    duplicateKeyRows: parseCount(rowOrThrow(result.rows, 0)[1]),
    invalidNumberRows: parseCount(rowOrThrow(result.rows, 0)[2]),
  };
}

function renderJsonRoots(
  column: JsonColumn,
  type: "json" | "jsonb",
  leaves: JsonLeafInventory[],
): string {
  const selects = leaves.map((leaf, index) => renderJsonRootSelect(column, leaf, index));
  const body = selects.length > 0
    ? selects.join("\nUNION ALL\n")
    : `SELECT NULL::text AS row_id, NULL::pg_catalog.${type} AS value WHERE false`;
  return `${type}_roots(row_id, value) AS (\n${body}\n)`;
}

function renderJsonRootSelect(
  column: JsonColumn,
  leaf: JsonLeafInventory,
  leafIndex: number,
): string {
  const target = `${quoteIdentifier(column.schema)}.${quoteIdentifier(column.relation)}`;
  let expression = `source_row.${quoteIdentifier(column.column)}`;
  const joins: string[] = [];
  let arrayIndex = 0;
  for (const step of leaf.steps) {
    if (step.kind === "domain") {
      expression = `(${expression})::${quoteIdentifier(step.schema)}.${quoteIdentifier(step.name)}`;
    } else if (step.kind === "field") {
      expression = `(${expression}).${quoteIdentifier(step.name)}`;
    } else {
      const alias = `array_${leafIndex}_${arrayIndex++}`;
      const element = `${alias}_element`;
      joins.push(`CROSS JOIN LATERAL (
  SELECT ${element} AS value
  FROM pg_catalog.unnest(${expression}) AS ${element}
) AS ${alias}`);
      expression = `${alias}.value`;
    }
  }
  return `SELECT
  source_row.tableoid::text || ':' || source_row.ctid::text AS row_id,
  (${expression})::pg_catalog.${leaf.type} AS value
FROM ONLY ${target} AS source_row
${joins.join("\n")}
WHERE ${expression} IS NOT NULL`;
}

function renderJsonWalk(type: "json" | "jsonb"): string {
  const each = `pg_catalog.${type}_each`;
  const arrayElements = `pg_catalog.${type}_array_elements`;
  const typeOf = `pg_catalog.${type}_typeof`;
  const emptyObject = `'{}'::pg_catalog.${type}`;
  const emptyArray = `'[]'::pg_catalog.${type}`;
  const duplicateExpression = type === "jsonb"
    ? "false"
    : `EXISTS (
      SELECT 1
      FROM ${each}(
        CASE WHEN ${typeOf}(${type}_walk.value) = 'object'
          THEN ${type}_walk.value ELSE ${emptyObject} END
      ) AS duplicate
      GROUP BY duplicate.key
      HAVING count(*) > 1
    )`;
  const invalidNumberExpression = type === "jsonb"
    ? "false"
    : `CASE WHEN ${typeOf}(${type}_walk.value) = 'number'
      THEN pg_catalog.length(pg_catalog.btrim(${type}_walk.value::text, E' \\t\\r\\n'))
        > ${JSON_NUMBER_LIMITS.tokenLength}
        OR NOT pg_catalog.pg_input_is_valid(${type}_walk.value::text, 'pg_catalog.jsonb')
      ELSE false
    END`;
  return `${type}_walk(row_id, value) AS (
  SELECT row_id, value FROM ${type}_roots

  UNION ALL

  SELECT ${type}_walk.row_id, child.value
  FROM ${type}_walk
  CROSS JOIN LATERAL (
    SELECT object_item.value
    FROM ${each}(
      CASE WHEN ${typeOf}(${type}_walk.value) = 'object'
        THEN ${type}_walk.value ELSE ${emptyObject} END
    ) AS object_item

    UNION ALL

    SELECT array_item.value
    FROM ${arrayElements}(
      CASE WHEN ${typeOf}(${type}_walk.value) = 'array'
        THEN ${type}_walk.value ELSE ${emptyArray} END
    ) AS array_item
  ) AS child
), ${type}_affected AS (
  SELECT
    row_id,
    EXISTS (
      SELECT 1
      FROM ${each}(
        CASE WHEN ${typeOf}(${type}_walk.value) = 'object'
          THEN ${type}_walk.value ELSE ${emptyObject} END
      ) AS member
      WHERE member.key = '$sqlx'
    ) AS collision,
    ${duplicateExpression} AS duplicate_keys,
    ${invalidNumberExpression} AS invalid_number
  FROM ${type}_walk
)`;
}

function parseJsonLeafInventory(value: Uint8Array | null | undefined): JsonLeafInventory[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requiredText(value));
  } catch {
    throw new Error("sqlx-js json audit: PostgreSQL returned malformed JSON leaf metadata");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("sqlx-js json audit: PostgreSQL returned invalid JSON leaf metadata");
  }
  const leaves = parsed.map((candidate): JsonLeafInventory => {
    if (!isRecord(candidate) || (candidate.type !== "json" && candidate.type !== "jsonb")) {
      throw new Error("sqlx-js json audit: PostgreSQL returned invalid JSON leaf metadata");
    }
    if (!Array.isArray(candidate.steps)) {
      throw new Error("sqlx-js json audit: PostgreSQL returned invalid JSON leaf steps");
    }
    const steps = candidate.steps.map((step): JsonLeafStep => {
      if (!isRecord(step) || typeof step.kind !== "string") {
        throw new Error("sqlx-js json audit: PostgreSQL returned invalid JSON leaf steps");
      }
      if (step.kind === "array") return { kind: "array" };
      if (step.kind === "field" && typeof step.name === "string") {
        return { kind: "field", name: step.name };
      }
      if (
        step.kind === "domain"
        && typeof step.schema === "string"
        && typeof step.name === "string"
      ) {
        return { kind: "domain", schema: step.schema, name: step.name };
      }
      throw new Error("sqlx-js json audit: PostgreSQL returned invalid JSON leaf steps");
    });
    return {
      type: candidate.type,
      path: renderJsonLeafPath(steps),
      steps,
    };
  });
  return leaves.sort((left, right) => left.path.localeCompare(right.path) || left.type.localeCompare(right.type));
}

function renderJsonLeafPath(steps: JsonLeafStep[]): string {
  let path = "$";
  for (const step of steps) {
    if (step.kind === "array") path += "[]";
    else if (step.kind === "field") {
      path += /^[A-Za-z_][A-Za-z0-9_]*$/.test(step.name)
        ? `.${step.name}`
        : `[${JSON.stringify(step.name)}]`;
    }
  }
  return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
