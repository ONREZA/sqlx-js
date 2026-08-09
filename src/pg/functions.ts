import type {
  FunctionEntry,
  FunctionKind,
  FunctionParallelSafety,
  FunctionParamEntry,
  FunctionParamMode,
  FunctionVolatility,
} from "../function-cache";
import { functionSettingValue, normalizeFunctionSettings } from "../function-cache";
import type { PgClient } from "./wire";
import { inputTsType } from "./input-types";
import { canonicalCompositeFields, SchemaCache, typeScriptPropertyName } from "./schema";
import { loadFunctionCatalogRows } from "./catalog";

type FunctionRow = {
  schema: string;
  name: string;
  kind: FunctionKind;
  identityArguments: string;
  language: string;
  inputArgOids: number[];
  allArgOids: number[] | null;
  argModes: string[] | null;
  argNames: string[] | null;
  returnOid: number;
  returnsSet: boolean;
  volatility: FunctionVolatility;
  strict: boolean;
  securityDefiner: boolean;
  leakproof: boolean;
  parallelSafety: FunctionParallelSafety;
  owner: string;
  ownerSuperuser: boolean;
  publicExecute: boolean;
  settings: string[];
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
  const rows: FunctionRow[] = (await loadFunctionCatalogRows(client, {
    includeExtensionOwned: options.includeExtensionOwned === true,
  })).map((row) => {
    const settings = normalizeFunctionSettings(row.settings);
    return {
      ...row,
      kind: functionKind(row.kind),
      volatility: functionVolatility(row.volatility),
      parallelSafety: functionParallelSafety(row.parallelSafety),
      settings,
      searchPath: functionSettingValue(settings, "search_path"),
    };
  });
  const typeOids = new Set<number>();
  for (const row of rows) {
    typeOids.add(row.returnOid);
    for (const oid of row.inputArgOids) typeOids.add(oid);
    for (const oid of row.allArgOids ?? []) typeOids.add(oid);
  }
  await schema.loadCustomTypes([...typeOids]);
  return rows.map((row) => toEntry(row, schema)).sort((a, b) => a.signature.localeCompare(b.signature));
}

function toEntry(row: FunctionRow, schema: SchemaCache): FunctionEntry {
  const allArgOids = row.allArgOids ?? row.inputArgOids;
  const modes = row.argModes ?? allArgOids.map(() => "i");
  const params: CatalogParamEntry[] = allArgOids.map((oid, i) => {
    const mode = paramMode(modes[i]);
    const resultTsType = outputTsType(oid, schema);
    return {
      mode,
      tsType: mode === "out" || mode === "table" ? resultTsType : nullableInput(inputTsType(oid, schema)),
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
    language: row.language,
    params: params.map(persistedParam),
    returns: returnTsType(row, output, schema),
    returnsSet: row.returnsSet,
    volatility: row.volatility,
    strict: row.strict,
    securityDefiner: row.securityDefiner,
    leakproof: row.leakproof,
    parallelSafety: row.parallelSafety,
    owner: row.owner,
    ownerSuperuser: row.ownerSuperuser,
    publicExecute: row.publicExecute,
    settings: row.settings,
    searchPath: row.searchPath,
    extensionOwned: row.extensionOwned,
  };
}

function nullableInput(type: string): string {
  return `${type} | null`;
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
  const fields = canonicalCompositeFields(output.map((param, index) => ({
    name: param.name ?? `column${index + 1}`,
    type: nullableReturn(param.resultTsType ?? param.tsType),
  }))).map((field) => `${typeScriptPropertyName(field.name)}: ${field.type}`);
  return `{ ${fields.join("; ")} }`;
}

function outputTsType(oid: number, schema: SchemaCache): string {
  return schema.tsType(oid);
}

function nullableReturn(tsType: string): string {
  if (tsType === "void") return tsType;
  return `${tsType} | null`;
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
