import { decodeText, type PgClient } from "./wire";

export type PgEnumCatalogRow = {
  schema: string;
  name: string;
  value: string | null;
};

export type PgRoutineErrorSourceRow = {
  signature: string;
  source: string;
};

export type PgFunctionCatalogRow = {
  schema: string;
  name: string;
  kind: string;
  identityArguments: string;
  identity: string;
  arguments: string;
  returnType: string;
  inputArgOids: number[];
  allArgOids: number[] | null;
  argModes: string[] | null;
  argNames: string[] | null;
  returnOid: number;
  returnsSet: boolean;
  volatility: string;
  strict: boolean;
  securityDefiner: boolean;
  leakproof: boolean;
  parallelSafety: string;
  owner: string;
  ownerSuperuser: boolean;
  publicExecute: boolean;
  settings: string[];
  extensionOwned: boolean;
  language: string;
};

export function userSchemaFilter(alias = "n"): string {
  return `${alias}.nspname <> 'information_schema' AND ${alias}.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'`;
}

function canonicalRoutineIdentitySql(procedureAlias: string, namespaceAlias: string): string {
  return `pg_catalog.format(
    '%I.%I(%s)',
    ${namespaceAlias}.nspname,
    ${procedureAlias}.proname,
    COALESCE((
      SELECT pg_catalog.string_agg(
        CASE
          WHEN argument_type.typcategory = 'A' AND argument_type.typelem <> 0
            THEN pg_catalog.format('%I.%I[]', element_namespace.nspname, element_type.typname)
          ELSE pg_catalog.format('%I.%I', argument_namespace.nspname, argument_type.typname)
        END,
        ',' ORDER BY argument.ordinality
      )
      FROM pg_catalog.unnest(${routineInputOidsSql(procedureAlias)})
        WITH ORDINALITY AS argument(type_oid, ordinality)
      JOIN pg_catalog.pg_type argument_type ON argument_type.oid = argument.type_oid
      JOIN pg_catalog.pg_namespace argument_namespace ON argument_namespace.oid = argument_type.typnamespace
      LEFT JOIN pg_catalog.pg_type element_type ON element_type.oid = argument_type.typelem
      LEFT JOIN pg_catalog.pg_namespace element_namespace ON element_namespace.oid = element_type.typnamespace
    ), '')
  )`;
}

function routineInputOidsSql(procedureAlias: string): string {
  return `${procedureAlias}.proargtypes::pg_catalog.oid[]`;
}

export async function loadEnumCatalogRows(
  client: PgClient,
  schemas?: readonly string[],
): Promise<PgEnumCatalogRow[]> {
  const schemaFilter = schemas
    ? `n.nspname IN (${schemas.map(quoteLiteral).join(", ")})`
    : userSchemaFilter("n");
  const result = await client.simpleQueryAll(`
    SELECT n.nspname, t.typname, e.enumlabel
    FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    LEFT JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
    WHERE t.typtype = 'e'
      AND ${schemaFilter}
    ORDER BY n.nspname, t.typname, e.enumsortorder
  `);
  return result.rows.map((row) => ({
    schema: decodeText(row[0]!)!,
    name: decodeText(row[1]!)!,
    value: decodeText(row[2] ?? null),
  }));
}

export async function loadRoutineErrorSources(
  client: PgClient,
  schemas: readonly string[],
): Promise<PgRoutineErrorSourceRow[]> {
  const result = await client.simpleQueryAll(`
    SELECT
      ${canonicalRoutineIdentitySql("p", "n")} AS signature,
      p.prosrc
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid = p.prolang
    LEFT JOIN pg_catalog.pg_depend extension_dependency
      ON extension_dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
      AND extension_dependency.objid = p.oid
      AND extension_dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
      AND extension_dependency.deptype = 'e'
    WHERE l.lanname = 'plpgsql'
      AND n.nspname IN (${schemas.map(quoteLiteral).join(", ")})
      AND extension_dependency.objid IS NULL
    ORDER BY signature
  `);
  return result.rows.map((row) => ({
    signature: decodeText(row[0]!)!,
    source: decodeText(row[1]!) ?? "",
  }));
}

export async function loadFunctionCatalogRows(
  client: PgClient,
  options: { includeExtensionOwned?: boolean } = {},
): Promise<PgFunctionCatalogRow[]> {
  const result = await client.simpleQueryAll(`
    SELECT
      n.nspname,
      p.proname,
      p.prokind::text,
      pg_get_function_identity_arguments(p.oid),
      pg_get_function_arguments(p.oid),
      pg_get_function_result(p.oid),
      pg_catalog.to_json(${routineInputOidsSql("p")})::pg_catalog.text,
      to_json(p.proallargtypes)::text,
      to_json(p.proargmodes)::text,
      to_json(p.proargnames)::text,
      p.prorettype::int8,
      p.proretset,
      p.provolatile::text,
      p.proisstrict,
      p.prosecdef,
      p.proleakproof,
      p.proparallel::text,
      owner.rolname,
      owner.rolsuper,
      EXISTS (
        SELECT 1
        FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) privilege
        WHERE privilege.grantee = 0
          AND privilege.privilege_type = 'EXECUTE'
      ),
      to_json(COALESCE(p.proconfig, ARRAY[]::text[]))::text,
      extension_dependency.objid IS NOT NULL,
      l.lanname,
      ${canonicalRoutineIdentitySql("p", "n")}
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    JOIN pg_roles owner ON owner.oid = p.proowner
    LEFT JOIN pg_depend extension_dependency
      ON extension_dependency.classid = 'pg_proc'::regclass
      AND extension_dependency.objid = p.oid
      AND extension_dependency.refclassid = 'pg_extension'::regclass
      AND extension_dependency.deptype = 'e'
    WHERE ${userSchemaFilter("n")}
      ${options.includeExtensionOwned ? "" : "AND extension_dependency.objid IS NULL"}
    ORDER BY n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)
  `);
  return result.rows.map((row) => ({
    schema: decodeText(row[0]!)!,
    name: decodeText(row[1]!)!,
    kind: decodeText(row[2]!)!,
    identityArguments: decodeText(row[3]!) ?? "",
    arguments: decodeText(row[4]!) ?? "",
    returnType: decodeText(row[5]!) ?? "void",
    inputArgOids: parseNumberArray(decodeText(row[6]!)),
    allArgOids: parseNullableNumberArray(decodeText(row[7] ?? null)),
    argModes: parseNullableStringArray(decodeText(row[8] ?? null)),
    argNames: parseNullableStringArray(decodeText(row[9] ?? null)),
    returnOid: Number(decodeText(row[10]!)!),
    returnsSet: decodeText(row[11]!) === "t",
    volatility: decodeText(row[12]!)!,
    strict: decodeText(row[13]!) === "t",
    securityDefiner: decodeText(row[14]!) === "t",
    leakproof: decodeText(row[15]!) === "t",
    parallelSafety: decodeText(row[16]!)!,
    owner: decodeText(row[17]!)!,
    ownerSuperuser: decodeText(row[18]!) === "t",
    publicExecute: decodeText(row[19]!) === "t",
    settings: parseNullableStringArray(decodeText(row[20] ?? null)) ?? [],
    extensionOwned: decodeText(row[21]!) === "t",
    language: decodeText(row[22]!)!,
    identity: decodeText(row[23]!)!,
  }));
}

function parseNumberArray(raw: string | null): number[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
}

function parseNullableNumberArray(raw: string | null): number[] | null {
  return raw === null ? null : parseNumberArray(raw);
}

function parseNullableStringArray(raw: string | null): string[] | null {
  if (raw === null) return null;
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? parsed.map((value) => typeof value === "string" ? value : "") : [];
}

function quoteLiteral(value: string): string {
  return `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}
