import type { SqlxJsConfig } from "./config";
import { jsonScalarOid } from "./pg/input-types";
import type { ColumnMatch, SchemaCache } from "./pg/schema";

type ColumnAssertion = {
  configKey: "jsonbTypes" | "columnTypes" | "arrayElementNullability";
  key: string;
  schema?: string;
  table: string;
  column: string;
};

export async function validateColumnAssertions(
  config: SqlxJsConfig,
  configPath: string | undefined,
  schema: SchemaCache,
): Promise<void> {
  const assertions = collectAssertions(config, configPath);
  if (assertions.length === 0) return;

  const matches = await schema.findColumns(assertions);
  const resolved = assertions.map((assertion) => {
    const candidates = matches.filter((match) => matchesAssertion(match, assertion));
    if (candidates.length === 0) {
      throw assertionError(configPath, assertion, "does not resolve to a PostgreSQL column");
    }
    if (candidates.length > 1) {
      const names = candidates.map((match) => `${match.schema}.${match.table}.${match.column.name}`).join(", ");
      throw assertionError(
        configPath,
        assertion,
        `is ambiguous across ${names}; use schema.table.column`,
      );
    }
    return { assertion, match: candidates[0]! };
  });
  const seen = new Map<string, ColumnAssertion>();
  for (const { assertion, match } of resolved) {
    const physicalKey = `${assertion.configKey}:${match.column.attrelid}/${match.column.attnum}`;
    const previous = seen.get(physicalKey);
    if (previous) {
      throw assertionError(
        configPath,
        assertion,
        `duplicates ${previous.configKey}.${previous.key}; keep one schema-qualified key`,
      );
    }
    seen.set(physicalKey, assertion);
  }
  await schema.loadCustomTypes(resolved.map(({ match }) => match.column.typeOid));

  for (const { assertion, match: { column } } of resolved) {
    const array = schema.arrayElement(column.typeOid);
    if (assertion.configKey === "arrayElementNullability" && !array) {
      throw assertionError(configPath, assertion, "must reference a PostgreSQL array column");
    }
    if (assertion.configKey === "jsonbTypes") {
      const jsonOid = array
        ? jsonScalarOid(array.typeOid, schema)
        : jsonScalarOid(column.typeOid, schema);
      if (!jsonOid) {
        throw assertionError(configPath, assertion, "must reference a PostgreSQL JSON column or JSON array column");
      }
    }
    if (assertion.configKey === "columnTypes") {
      const directJson = column.typeOid === 114 || column.typeOid === 3802;
      if (array) {
        throw assertionError(configPath, assertion, "does not support PostgreSQL array columns");
      }
      if (directJson) {
        throw assertionError(configPath, assertion, "must use jsonbTypes for a direct json or jsonb column");
      }
    }
  }
}

function matchesAssertion(match: ColumnMatch, assertion: ColumnAssertion): boolean {
  return match.table === assertion.table
    && match.column.name === assertion.column
    && (assertion.schema === undefined || match.schema === assertion.schema);
}

function collectAssertions(config: SqlxJsConfig, configPath: string | undefined): ColumnAssertion[] {
  const assertions: ColumnAssertion[] = [];
  for (const configKey of ["jsonbTypes", "columnTypes", "arrayElementNullability"] as const) {
    for (const key of Object.keys(config[configKey] ?? {}).sort()) {
      const parts = key.split(".");
      if ((parts.length !== 2 && parts.length !== 3) || parts.some((part) => part.length === 0)) {
        throw new Error(
          `sqlx-js: ${configPath ?? "config"} ${configKey}.${key} must use table.column or schema.table.column`,
        );
      }
      const [schema, table, column] = parts.length === 3
        ? parts
        : [undefined, parts[0], parts[1]];
      assertions.push({ configKey, key, schema, table: table!, column: column! });
    }
  }
  return assertions;
}

function assertionError(
  configPath: string | undefined,
  assertion: ColumnAssertion,
  message: string,
): Error {
  return new Error(`sqlx-js: ${configPath ?? "config"} ${assertion.configKey}.${assertion.key} ${message}`);
}
