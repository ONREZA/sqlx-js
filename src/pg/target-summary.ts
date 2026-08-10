import { userSchemaFilter } from "./catalog";
import { decodeText, type PgClient } from "./wire";

export type DatabaseTargetSummary = {
  database: string;
  user: string;
  serverVersion: string;
  searchPath: string;
  currentSchema: string | null;
  catalogFunctions: number;
  catalogEnums: number;
};

export async function inspectDatabaseTarget(
  client: PgClient,
  options: { includeExtensionOwnedFunctions?: boolean } = {},
): Promise<DatabaseTargetSummary> {
  const extensionFilter = options.includeExtensionOwnedFunctions
    ? ""
    : `AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend dependency
        WHERE dependency.classid = 'pg_proc'::regclass
          AND dependency.objid = p.oid
          AND dependency.refclassid = 'pg_extension'::regclass
          AND dependency.deptype = 'e'
      )`;
  const result = await client.simpleQueryAll(`
    SELECT
      current_database(),
      current_user,
      current_setting('server_version'),
      current_setting('search_path'),
      current_schema(),
      (
        SELECT count(*)::text
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE ${userSchemaFilter("n")}
          ${extensionFilter}
      ),
      (
        SELECT count(*)::text
        FROM pg_catalog.pg_type t
        JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
        WHERE t.typtype = 'e'
          AND ${userSchemaFilter("n")}
      )
  `);
  const row = result.rows[0];
  if (!row) throw new Error("sqlx-js: PostgreSQL target summary returned no rows");
  return {
    database: decodeText(row[0]!)!,
    user: decodeText(row[1]!)!,
    serverVersion: decodeText(row[2]!)!,
    searchPath: decodeText(row[3]!)!,
    currentSchema: decodeText(row[4] ?? null),
    catalogFunctions: Number(decodeText(row[5]!)!),
    catalogEnums: Number(decodeText(row[6]!)!),
  };
}

function diagnosticValue(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, (character) => JSON.stringify(character).slice(1, -1));
}

export function formatDatabaseTarget(target: DatabaseTargetSummary): string {
  return `target: database ${diagnosticValue(target.database)} as ${diagnosticValue(target.user)}; `
    + `PostgreSQL ${diagnosticValue(target.serverVersion)}; `
    + `schema ${target.currentSchema === null ? "<none>" : diagnosticValue(target.currentSchema)}; `
    + `search_path ${diagnosticValue(target.searchPath)}; `
    + `${target.catalogFunctions} function(s), ${target.catalogEnums} enum(s)`;
}
