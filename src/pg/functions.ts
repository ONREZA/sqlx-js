import type {
  FunctionEntry,
  FunctionKind,
  FunctionParallelSafety,
  FunctionParamEntry,
  FunctionParamMode,
  FunctionVolatility,
} from "../function-cache";
import { decodeText, type PgClient } from "./wire";
import { SchemaCache } from "./schema";

const JSON_OIDS = new Set([114, 3802]);
const JSON_ARRAY_OIDS = new Set([199, 3807]);
const JSON_INPUT = 'import("@onreza/sqlx-js").JsonInput';

type FunctionRow = {
  schema: string;
  name: string;
  kind: FunctionKind;
  identityArguments: string;
  inputArgOids: number[];
  allArgOids: number[] | null;
  argModes: string[] | null;
  argNames: string[] | null;
  returnOid: number;
  returnsSet: boolean;
  volatility: FunctionVolatility;
  securityDefiner: boolean;
  leakproof: boolean;
  parallelSafety: FunctionParallelSafety;
  owner: string;
  ownerSuperuser: boolean;
  publicExecute: boolean;
  searchPath: string | null;
  extensionOwned: boolean;
};

type CatalogParamEntry = FunctionParamEntry & {
  resultTsType?: string;
};

export async function introspectFunctions(
  client: PgClient,
  schema: SchemaCache,
  options: { includeExtensionOwned?: boolean } = {},
): Promise<FunctionEntry[]> {
  const rows = await loadFunctionRows(client, options.includeExtensionOwned === true);
  const typeOids = new Set<number>();
  for (const row of rows) {
    typeOids.add(row.returnOid);
    for (const oid of row.inputArgOids) typeOids.add(oid);
    for (const oid of row.allArgOids ?? []) typeOids.add(oid);
  }
  await schema.loadCustomTypes([...typeOids]);
  return rows.map((row) => toEntry(row, schema)).sort((a, b) => a.signature.localeCompare(b.signature));
}

async function loadFunctionRows(client: PgClient, includeExtensionOwned: boolean): Promise<FunctionRow[]> {
  const result = await client.simpleQueryAll(`
    SELECT
      n.nspname,
      p.proname,
      p.prokind::text,
      pg_get_function_identity_arguments(p.oid),
      to_json(
        CASE
          WHEN p.proargtypes::text = '' THEN ARRAY[]::oid[]
          ELSE string_to_array(p.proargtypes::text, ' ')::oid[]
        END
      )::text,
      to_json(p.proallargtypes)::text,
      to_json(p.proargmodes)::text,
      to_json(p.proargnames)::text,
      p.prorettype::int8,
      p.proretset,
      p.provolatile::text,
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
      (
        SELECT substring(setting FROM length('search_path=') + 1)
        FROM unnest(p.proconfig) setting
        WHERE setting LIKE 'search_path=%'
        LIMIT 1
      ),
      extension_dependency.objid IS NOT NULL
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles owner ON owner.oid = p.proowner
    LEFT JOIN pg_depend extension_dependency
      ON extension_dependency.classid = 'pg_proc'::regclass
      AND extension_dependency.objid = p.oid
      AND extension_dependency.refclassid = 'pg_extension'::regclass
      AND extension_dependency.deptype = 'e'
    WHERE ${userSchemaFilter("n")}
      ${includeExtensionOwned ? "" : "AND extension_dependency.objid IS NULL"}
    ORDER BY n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)
  `);
  return result.rows.map((row) => ({
    schema: decodeText(row[0]!)!,
    name: decodeText(row[1]!)!,
    kind: functionKind(decodeText(row[2]!)),
    identityArguments: decodeText(row[3]!) ?? "",
    inputArgOids: parseNumberJsonArray(decodeText(row[4]!)),
    allArgOids: parseNullableNumberJsonArray(decodeText(row[5] ?? null)),
    argModes: parseNullableStringJsonArray(decodeText(row[6] ?? null)),
    argNames: parseNullableStringJsonArray(decodeText(row[7] ?? null)),
    returnOid: Number(decodeText(row[8]!)!),
    returnsSet: decodeText(row[9]!) === "t",
    volatility: functionVolatility(decodeText(row[10]!)),
    securityDefiner: decodeText(row[11]!) === "t",
    leakproof: decodeText(row[12]!) === "t",
    parallelSafety: functionParallelSafety(decodeText(row[13]!)),
    owner: decodeText(row[14]!)!,
    ownerSuperuser: decodeText(row[15]!) === "t",
    publicExecute: decodeText(row[16]!) === "t",
    searchPath: decodeText(row[17] ?? null),
    extensionOwned: decodeText(row[18]!) === "t",
  }));
}

function toEntry(row: FunctionRow, schema: SchemaCache): FunctionEntry {
  const allArgOids = row.allArgOids ?? row.inputArgOids;
  const modes = row.argModes ?? allArgOids.map(() => "i");
  const params: CatalogParamEntry[] = allArgOids.map((oid, i) => {
    const mode = paramMode(modes[i]);
    const resultTsType = outputTsType(oid, schema);
    return {
      mode,
      tsType: mode === "out" || mode === "table" ? resultTsType : inputTsType(oid, schema),
      ...(mode === "inout" ? { resultTsType } : {}),
      ...(row.argNames?.[i] ? { name: row.argNames[i] } : {}),
    };
  });
  const output = params.filter((p) => p.mode === "out" || p.mode === "inout" || p.mode === "table");
  return {
    schema: row.schema,
    name: row.name,
    signature: `${row.schema}.${row.name}(${row.identityArguments})`,
    kind: row.kind,
    params: params.map(persistedParam),
    returns: returnTsType(row, output, schema),
    returnsSet: row.returnsSet,
    volatility: row.volatility,
    securityDefiner: row.securityDefiner,
    leakproof: row.leakproof,
    parallelSafety: row.parallelSafety,
    owner: row.owner,
    ownerSuperuser: row.ownerSuperuser,
    publicExecute: row.publicExecute,
    searchPath: row.searchPath,
    extensionOwned: row.extensionOwned,
  };
}

function persistedParam(param: CatalogParamEntry): FunctionParamEntry {
  return {
    mode: param.mode,
    tsType: param.tsType,
    ...(param.name ? { name: param.name } : {}),
  };
}

function returnTsType(row: FunctionRow, output: CatalogParamEntry[], schema: SchemaCache): string {
  if (output.length > 0) return outputObject(output);
  if (row.kind === "procedure") return "void";
  return nullableReturn(schema.tsType(row.returnOid));
}

function outputObject(output: CatalogParamEntry[]): string {
  const fields = output.map((p, i) => {
    const name = p.name && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(p.name) ? p.name : JSON.stringify(p.name ?? `column${i + 1}`);
    return `${name}: ${nullableReturn(p.resultTsType ?? p.tsType)}`;
  });
  return `{ ${fields.join("; ")} }`;
}

function inputTsType(oid: number, schema: SchemaCache): string {
  if (JSON_OIDS.has(oid)) return JSON_INPUT;
  if (JSON_ARRAY_OIDS.has(oid)) return `(${JSON_INPUT} | null)[]`;
  return schema.tsType(oid);
}

function outputTsType(oid: number, schema: SchemaCache): string {
  return schema.tsType(oid);
}

function nullableReturn(tsType: string): string {
  if (tsType === "void") return tsType;
  return `${tsType} | null`;
}

function parseNumberJsonArray(raw: string | null): number[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? parsed.map(Number).filter((n) => Number.isFinite(n)) : [];
}

function parseNullableNumberJsonArray(raw: string | null): number[] | null {
  if (raw === null) return null;
  return parseNumberJsonArray(raw);
}

function parseNullableStringJsonArray(raw: string | null): string[] | null {
  if (raw === null) return null;
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? parsed.map((v) => (typeof v === "string" ? v : "")) : [];
}

function paramMode(raw: string | undefined): FunctionParamMode {
  switch (raw) {
    case "o": return "out";
    case "b": return "inout";
    case "v": return "variadic";
    case "t": return "table";
    default: return "in";
  }
}

function functionKind(raw: string | null): FunctionKind {
  switch (raw) {
    case "p": return "procedure";
    case "a": return "aggregate";
    case "w": return "window";
    default: return "function";
  }
}

function functionVolatility(raw: string | null): FunctionVolatility {
  switch (raw) {
    case "i": return "immutable";
    case "s": return "stable";
    default: return "volatile";
  }
}

function functionParallelSafety(raw: string | null): FunctionParallelSafety {
  switch (raw) {
    case "s": return "safe";
    case "r": return "restricted";
    default: return "unsafe";
  }
}

function userSchemaFilter(alias: string): string {
  return `${alias}.nspname <> 'information_schema' AND ${alias}.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'`;
}
