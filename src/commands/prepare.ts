import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  PgClient,
  parseDatabaseUrl,
  PgError,
  type ConnConfig,
  type FieldDescription,
  type PlanValidation,
} from "../pg/wire";
import { SchemaCache, compositeLiteral, type CustomTypeInfo } from "../pg/schema";
import { analyzeQuery, type ColumnSource } from "../pg/analyze";
import { arrayTsType, isBuiltinOid, oidToTs, type ArrayElementNullability } from "../pg/oids";
import { ScanError, scanProject, type QueryCallSite } from "../scan/scanner";
import {
  assertCacheManifest,
  Cache,
  fingerprint,
  effectiveNullable,
  portableCacheOid,
  writeCacheManifest,
  type CacheEntry,
} from "../cache";
import { emitDts } from "../codegen";
import {
  loadConfig,
  lookupArrayElementNullability,
  lookupColumnType,
  lookupJsonbType,
  prepareConfigHash,
  type SqlxJsConfig,
} from "../config";
import { functionCacheExists, readFunctionCache, writeFunctionCache, type FunctionEntry } from "../function-cache";
import { introspectFunctions } from "../pg/functions";
import { buildParamMap, type ParamMap, type ParamMapResult } from "../pg/param-map";
import { mergeExtensionTypes } from "../pg/extensions";
import { compareArtifacts } from "../artifacts";
import { containsUnknownType } from "../type-inspection";
import { originalPosition, rewriteNamedParameters } from "../sql-params";

const JSON_OIDS = new Set([114, 3802]);
const JSON_ARRAY_OIDS = new Set([199, 3807]);
const JSON_INPUT_VALUE = "unknown";

function jsonParameter(type: string): string {
  return `import("@onreza/sqlx-js").JsonParameter<${type}>`;
}

function arrayParameter(type: string, nonNullElements: boolean): string {
  return `import("@onreza/sqlx-js").PgArrayParameter<${type}, ${nonNullElements ? "false" : "boolean"}>`;
}

function enumUnion(values: string[]): string {
  if (values.length === 0) return "never";
  return values.map((v) => JSON.stringify(v)).join(" | ");
}

function resolveTs(oid: number, customLookup: (o: number) => CustomTypeInfo | undefined): string {
  const c = customLookup(oid);
  if (c) {
    if (c.kind === "enum") return enumUnion(c.values);
    if (c.kind === "enumArray") return arrayTsType(enumUnion(c.element.values));
    if (c.kind === "scalar") return c.tsType;
    if (c.kind === "scalarArray") return arrayTsType(c.element.tsType, c.element.notNull ? "non-null" : "unknown");
    if (c.kind === "composite") return compositeLiteral(c);
    if (c.kind === "compositeArray") return arrayTsType(compositeLiteral(c.element));
  }
  return oidToTs(oid).ts;
}

function isScalarColumnType(oid: number, schema: SchemaCache): boolean {
  if (JSON_OIDS.has(oid) || JSON_ARRAY_OIDS.has(oid) || schema.arrayElement(oid) !== undefined) return false;
  const custom = schema.customType(oid);
  return custom?.kind !== "enumArray" && custom?.kind !== "scalarArray" && custom?.kind !== "compositeArray";
}

function resolveColumnTs(
  f: FieldDescription,
  schema: SchemaCache,
  cfg: SqlxJsConfig,
  sources: ColumnSource[] | null = null,
  arrayElementNullability: ArrayElementNullability = "unknown",
): string {
  const directSource = directColumnSource(f, schema);
  const effectiveSources = directSource ? [directSource] : sources ?? [];
  const schemaArray = schema.arrayElement(f.typeOid);
  const nonNullElements = arrayElementNullability === "non-null"
    || schemaArray?.nullability === "non-null"
    || (effectiveSources.length > 0 && effectiveSources.every((source) =>
      lookupArrayElementNullability(cfg, source.schema, source.table, source.column) === "non-null"));
  if (f.tableOid !== 0 && f.columnAttr !== 0) {
    const tbl = schema.tableNameByOid(f.tableOid);
    const colName = schema.columnNameByAttno(f.tableOid, f.columnAttr);
    if (tbl && colName) {
      const configured = configuredColumnTs(f.typeOid, schema, cfg, {
        schema: tbl.schema,
        table: tbl.name,
        column: colName,
      }, nonNullElements);
      if (configured) return configured;
    }
  }
  if (sources && sources.length > 0) {
    const configured = sources.map((source) => configuredColumnTs(f.typeOid, schema, cfg, source, nonNullElements));
    if (configured.every((type): type is string => type !== undefined) && new Set(configured).size === 1) {
      return configured[0]!;
    }
  }
  if (schemaArray) return arrayTsType(schemaArray.tsType, nonNullElements ? "non-null" : "unknown");
  return resolveTs(f.typeOid, (oid) => schema.customType(oid));
}

function directColumnSource(f: FieldDescription, schema: SchemaCache): ColumnSource | undefined {
  if (f.tableOid === 0 || f.columnAttr === 0) return undefined;
  const table = schema.tableNameByOid(f.tableOid);
  const column = schema.columnNameByAttno(f.tableOid, f.columnAttr);
  return table && column ? { schema: table.schema, table: table.name, column } : undefined;
}

function configuredColumnTs(
  typeOid: number,
  schema: SchemaCache,
  cfg: SqlxJsConfig,
  source: ColumnSource,
  nonNullElements: boolean,
): string | undefined {
  if (JSON_OIDS.has(typeOid)) {
    return lookupJsonbType(cfg, source.schema, source.table, source.column);
  }
  if (JSON_ARRAY_OIDS.has(typeOid)) {
    const declaration = lookupJsonbType(cfg, source.schema, source.table, source.column);
    return declaration ? arrayTsType(declaration, nonNullElements ? "non-null" : "unknown") : undefined;
  }
  if (isScalarColumnType(typeOid, schema)) {
    return lookupColumnType(cfg, source.schema, source.table, source.column);
  }
  return undefined;
}

function resolveParamTs(
  paramIndex: number,
  paramOid: number,
  paramMap: ParamMap,
  schema: SchemaCache,
  cfg: SqlxJsConfig,
): string {
  const target = paramMap.get(paramIndex);
  const targetColumn = target ? resolveTargetColumn(target, schema) : undefined;
  const targetTable = target ? resolvedTargetTable(target, schema) : undefined;
  const configuredNonNullElements = !!(targetColumn && targetTable
    && lookupArrayElementNullability(cfg, targetTable.schema, targetTable.name, targetColumn) === "non-null");
  const schemaNonNullElements = schema.arrayElement(paramOid)?.nullability === "non-null";
  const nonNullElements = configuredNonNullElements || schemaNonNullElements;
  if (isScalarColumnType(paramOid, schema) && target) {
    const column = resolveTargetColumn(target, schema);
    const table = resolvedTargetTable(target, schema);
    const decl = column && table ? lookupColumnType(cfg, table.schema, table.name, column) : undefined;
    if (decl) return decl;
  }
  if (JSON_OIDS.has(paramOid)) {
    if (target) {
      const column = resolveTargetColumn(target, schema);
      const table = resolvedTargetTable(target, schema);
      const decl = column && table ? lookupJsonbType(cfg, table.schema, table.name, column) : undefined;
      if (decl) return jsonParameter(decl);
    }
    return jsonParameter(JSON_INPUT_VALUE);
  }
  if (JSON_ARRAY_OIDS.has(paramOid)) {
    if (target) {
      const column = resolveTargetColumn(target, schema);
      const table = resolvedTargetTable(target, schema);
      const decl = column && table ? lookupJsonbType(cfg, table.schema, table.name, column) : undefined;
      if (decl) return arrayParameter(jsonParameter(decl), nonNullElements);
    }
    return arrayParameter(jsonParameter(JSON_INPUT_VALUE), nonNullElements);
  }
  const array = schema.arrayElement(paramOid);
  if (array) return arrayParameter(array.tsType, nonNullElements);
  const custom = schema.customType(paramOid);
  if (custom) {
    return resolveTs(paramOid, () => custom);
  }
  return resolveTs(paramOid, (oid) => schema.customType(oid));
}

function resolvedTargetTable(
  target: { schema?: string; table: string },
  schema: SchemaCache,
): { schema: string; name: string } | undefined {
  const oid = schema.resolveTable(target.schema, target.table);
  return oid === undefined ? undefined : schema.tableNameByOid(oid);
}

function resolveTargetColumn(target: { schema?: string; table: string; column?: string; columnIndex?: number }, schema: SchemaCache): string | undefined {
  if (target.column) return target.column;
  if (target.columnIndex === undefined) return undefined;
  const oid = schema.resolveTable(target.schema, target.table);
  if (oid === undefined) return undefined;
  const cols = schema.columnsOf(oid);
  if (!cols) return undefined;
  return [...cols.values()].sort((a, b) => a.attnum - b.attnum)[target.columnIndex - 1]?.name;
}

function resolveParamNullable(
  paramIndex: number,
  pm: ParamMapResult,
  schema: SchemaCache,
): boolean {
  if (pm.forceNullable.has(paramIndex)) return true;
  if (pm.dmlBound.has(paramIndex)) {
    const t = pm.targets.get(paramIndex);
    if (!t) return false;
    const oid = schema.resolveTable(t.schema, t.table);
    if (oid === undefined) return false;
    const column = resolveTargetColumn(t, schema);
    if (!column) return false;
    const col = schema.columnsOf(oid)?.get(column);
    if (!col) return false;
    return !col.notNull;
  }
  return false;
}

const ALIAS_OVERRIDE = /^(.+?)([!?])$/;

function parseColumnOverride(name: string): { name: string; override?: "non-null" | "nullable" } {
  const m = ALIAS_OVERRIDE.exec(name);
  if (!m) return { name };
  return { name: m[1]!, override: m[2] === "!" ? "non-null" : "nullable" };
}

function isAliasOrExpression(f: FieldDescription, schema: SchemaCache): boolean {
  if (f.tableOid === 0 || f.columnAttr === 0) return true;
  const real = schema.columnNameByAttno(f.tableOid, f.columnAttr);
  return real !== undefined && real !== f.name;
}

function duplicateOutputColumns(fields: FieldDescription[]): string[] {
  const counts = new Map<string, number>();
  for (const field of fields) {
    const name = parseColumnOverride(field.name).name;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].filter(([, count]) => count > 1).map(([name]) => name).sort();
}

export type PrepareOptions = {
  root: string;
  databaseUrl: string;
  cacheDir: string;
  dtsPath: string;
  check: boolean;
  offline?: boolean;
  verify?: boolean;
  json?: boolean;
  prune?: boolean;
  strictInference?: boolean;
};

export type PrepareDiagnosticPhase =
  | "config"
  | "connect"
  | "shadow"
  | "scan"
  | "describe"
  | "plan"
  | "result-shape"
  | "introspect"
  | "analyze"
  | "param-map"
  | "inference"
  | "cache"
  | "verify";

export class PrepareFatalError extends Error {
  public readonly file?: string;
  public readonly line?: number;
  public readonly column?: number;

  constructor(
    public readonly phase: PrepareDiagnosticPhase,
    message: string,
    location: { file?: string; line?: number; column?: number } = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PrepareFatalError";
    this.file = location.file;
    this.line = location.line;
    this.column = location.column;
  }
}

function fatal(phase: PrepareDiagnosticPhase, error: unknown): PrepareFatalError {
  if (error instanceof PrepareFatalError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const location = error instanceof ScanError
    ? { file: error.file, line: error.line, column: error.column }
    : {};
  return new PrepareFatalError(phase, message, location, { cause: error });
}

export type PrepareDiagnostic = {
  severity: "error" | "warning";
  phase: PrepareDiagnosticPhase;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  query?: string;
  queryId?: string;
  queryName?: string;
  code?: string;
  position?: number;
  hint?: string;
};

export type PrepareResult = {
  sites: number;
  entries: number;
  failures: number;
  pruned: number;
  functions: number;
  diagnostics: PrepareDiagnostic[];
};

function formatSite(s: QueryCallSite): string {
  return `${s.file}:${s.line}:${s.column}${s.queryName ? ` [${s.queryName}]` : ""}`;
}

function siteDiagnostic(site: QueryCallSite): Pick<
  PrepareDiagnostic,
  "file" | "line" | "column" | "query" | "queryId" | "queryName"
> {
  return {
    file: site.file,
    line: site.line,
    column: site.column,
    query: site.query,
    queryId: fingerprint(site.query),
    ...(site.queryName ? { queryName: site.queryName } : {}),
  };
}

function snippet(query: string, max = 80): string {
  const oneLine = query.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

function siteUsage(sites: QueryCallSite[]): Pick<CacheEntry, "hasInline" | "inlineQueries" | "filePaths"> {
  const inlineQueries = Array.from(new Set(
    sites.filter((s) => s.kind !== "file").map((s) => s.query),
  )).sort();
  const filePaths = Array.from(new Set(
    sites.filter((s) => s.kind === "file").map((s) => s.sqlFilePath!).filter(Boolean),
  )).sort();
  return {
    hasInline: inlineQueries.length > 0,
    ...(inlineQueries.length > 0 ? { inlineQueries } : {}),
    ...(filePaths.length > 0 ? { filePaths } : {}),
  };
}

function inferenceIssues(entry: CacheEntry): string[] {
  const issues: string[] = [];
  if (entry.degraded) issues.push(`nullability inference degraded: ${entry.degraded.reason}`);
  entry.paramTsTypes.forEach((type, index) => {
    const parameter = entry.paramNames?.[index] ? `$${entry.paramNames[index]}` : `$${index + 1}`;
    if (containsUnknownType(type)) issues.push(`parameter ${parameter} resolved to ${type}`);
  });
  for (const column of entry.columns) {
    if (containsUnknownType(column.tsType)) {
      issues.push(`result column ${JSON.stringify(column.name)} resolved to ${column.tsType}`);
    }
  }
  return issues;
}

function inferenceDiagnostics(
  entry: CacheEntry,
  site: QueryCallSite,
  strict: boolean,
): PrepareDiagnostic[] {
  return inferenceIssues(entry).map((message) => ({
    severity: strict ? "error" : "warning",
    phase: "inference",
    message,
    ...siteDiagnostic(site),
  }));
}

function planningDiagnostic(entry: CacheEntry, site: QueryCallSite): PrepareDiagnostic | undefined {
  if (entry.validation !== "parse-only") return undefined;
  return {
    severity: "warning",
    phase: "plan",
    message: "statement is outside PostgreSQL's generic planning surface; validation is parse-only",
    ...siteDiagnostic(site),
  };
}

export type PrepareSession = {
  client: PgClient;
  schema: SchemaCache;
  userCfg: SqlxJsConfig;
};

export type PrepareIncrementalInput = {
  sites?: QueryCallSite[];
  reuseCacheFps?: ReadonlySet<string>;
  reuseFunctions?: boolean;
};

export async function openSession(opts: PrepareOptions): Promise<PrepareSession> {
  let userCfg: SqlxJsConfig;
  try {
    userCfg = await loadConfig(opts.root);
  } catch (error) {
    throw fatal("config", error);
  }
  let cfg: ConnConfig;
  try {
    cfg = parseDatabaseUrl(opts.databaseUrl);
  } catch (error) {
    throw fatal("connect", error);
  }
  const client = new PgClient(cfg);
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => {});
    throw fatal("connect", error);
  }
  const schema = new SchemaCache(client);
  schema.setTypeRegistry(mergeExtensionTypes(userCfg.customTypes), userCfg.customTypes);
  try {
    await schema.validateUserTypeRegistry();
  } catch (error) {
    await client.end().catch(() => {});
    throw fatal("config", error);
  }
  return { client, schema, userCfg };
}

type ValidationOutcome =
  | { ok: true; paramOids: number[]; fields: FieldDescription[]; validation: PlanValidation }
  | { ok: false; phase: "describe" | "plan"; error: unknown };

export function defaultPrepareConcurrency(): number {
  const raw = process.env.SQLX_JS_PREPARE_CONCURRENCY;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 8;
}

// describe()/plan() are sequential per PgClient (see wire.ts), so concurrency comes from
// running several short-lived connections in parallel, each draining a shared
// cursor. The session connection is reused as one worker; extras are closed after.
export async function validateAll(
  cfg: ConnConfig,
  sessionClient: PgClient,
  queries: { fp: string; query: string }[],
  concurrency: number,
): Promise<Map<string, ValidationOutcome>> {
  const results = new Map<string, ValidationOutcome>();
  if (queries.length === 0) return results;
  const workerCount = Math.max(1, Math.min(concurrency, queries.length));
  let cursor = 0;
  const drain = async (client: PgClient) => {
    while (true) {
      const i = cursor++;
      if (i >= queries.length) return;
      const { fp, query } = queries[i]!;
      try {
        const d = await client.describe(query);
        try {
          const validation = await client.plan(query, d.paramOids.length);
          results.set(fp, { ok: true, paramOids: d.paramOids, fields: d.fields, validation });
        } catch (error) {
          results.set(fp, { ok: false, phase: "plan", error });
        }
      } catch (error) {
        results.set(fp, { ok: false, phase: "describe", error });
      }
    }
  };
  const extras: PgClient[] = [];
  try {
    // Open extra connections best-effort. The session connection alone is enough
    // to drain the queue, so a connection-limited server (low max_connections,
    // PgBouncer) degrades to fewer workers instead of failing the whole prepare.
    for (let i = 1; i < workerCount; i++) {
      const c = new PgClient(cfg);
      try {
        await c.connect();
      } catch {
        await c.end().catch(() => {});
        break;
      }
      extras.push(c);
    }
    await Promise.all([sessionClient, ...extras].map((c) => drain(c)));
  } finally {
    await Promise.all(extras.map((c) => c.end().catch(() => {})));
  }
  return results;
}

export async function prepareOnce(
  opts: PrepareOptions,
  session: PrepareSession,
  log: (msg: string) => void = console.log,
  err: (msg: string) => void = console.error,
  concurrency: number = defaultPrepareConcurrency(),
  input: PrepareIncrementalInput = {},
): Promise<PrepareResult> {
  let sites: QueryCallSite[];
  if (input.sites) {
    sites = input.sites;
  } else {
    try {
      sites = scanProject(opts.root, session.userCfg.scan);
    } catch (error) {
      throw fatal("scan", error);
    }
  }
  log(`scanned: found ${sites.length} sql() call site(s)`);
  const diagnostics: PrepareDiagnostic[] = [];

  const cache = new Cache(opts.cacheDir);
  let failures = 0;

  const unique = new Map<string, { fp: string; query: string; paramNames: string[]; sites: QueryCallSite[] }>();
  for (const s of sites) {
    const rewritten = rewriteNamedParameters(s.query);
    const fp = fingerprint(s.query);
    const existing = unique.get(fp);
    if (existing) existing.sites.push(s);
    else unique.set(fp, { fp, query: rewritten.query, paramNames: rewritten.names, sites: [s] });
  }

  type Raw = {
    fp: string;
    query: string;
    sites: QueryCallSite[];
    paramOids: number[];
    fields: FieldDescription[];
    paramNames: string[];
    validation: PlanValidation;
  };
  const raw: Raw[] = [];
  const reusedEntries: CacheEntry[] = [];
  const reusedGenerated: { fp: string; entry: CacheEntry }[] = [];
  const { client, schema, userCfg } = session;

  const toPrepare: typeof unique = new Map();
  for (const [fp, item] of unique) {
    const cached = input.reuseCacheFps?.has(fp) ? cache.read(fp) : null;
    if (!cached?.validation) {
      toPrepare.set(fp, item);
      continue;
    }
    const entry = { ...cached, ...siteUsage(item.sites) };
    const entryDiagnostics = inferenceDiagnostics(entry, item.sites[0]!, opts.strictInference === true);
    diagnostics.push(...entryDiagnostics);
    const planDiagnostic = planningDiagnostic(entry, item.sites[0]!);
    if (planDiagnostic) diagnostics.push(planDiagnostic);
    if (opts.strictInference && entryDiagnostics.length > 0) {
      failures++;
      continue;
    }
    reusedEntries.push(entry);
    reusedGenerated.push({ fp, entry });
    const validationTag = entry.validation === "parse-only" ? " [parse-only]" : "";
    log(`  ↺ ${formatSite(item.sites[0]!)} → reused ${entry.paramOids.length} param(s), ${entry.columns.length} col(s)${validationTag}`);
  }

  const validationList = [...toPrepare.values()].map((u) => ({ fp: u.fp, query: u.query }));
  const validationResults = await validateAll(parseDatabaseUrl(opts.databaseUrl), client, validationList, concurrency);
  for (const { fp, query, sites: ss } of toPrepare.values()) {
    const site = ss[0]!;
    const outcome = validationResults.get(fp)!;
    if (outcome.ok) {
      const duplicates = duplicateOutputColumns(outcome.fields);
      if (duplicates.length > 0) {
        failures++;
        const message = `duplicate output column name(s): ${duplicates.join(", ")}. Alias each result column to a unique name`;
        diagnostics.push({
          severity: "error",
          phase: "result-shape",
          message,
          ...siteDiagnostic(site),
        });
        err(`  ✗ ${formatSite(site)} — ${message}`);
        err(`      query: ${snippet(site.query)}`);
        continue;
      }
      if (outcome.validation === "parse-only") diagnostics.push({
        severity: "warning",
        phase: "plan",
        message: "statement is outside PostgreSQL's generic planning surface; validation is parse-only",
        ...siteDiagnostic(site),
      });
      raw.push({
        fp,
        query,
        sites: ss,
        paramOids: outcome.paramOids,
        fields: outcome.fields,
        paramNames: toPrepare.get(fp)!.paramNames,
        validation: outcome.validation,
      });
      continue;
    }
    failures++;
    const e = outcome.error;
    if (e instanceof PgError) {
      const position = e.position ? originalPosition(rewriteNamedParameters(site.query), e.position) : undefined;
      diagnostics.push({
        severity: "error",
        phase: outcome.phase,
        message: e.message,
        ...siteDiagnostic(site),
        ...(e.code ? { code: e.code } : {}),
        ...(position ? { position } : {}),
        ...(e.hint ? { hint: e.hint } : {}),
      });
      const extras: string[] = [];
      if (position) extras.push(`pos ${position}`);
      if (e.code) extras.push(`code ${e.code}`);
      const tail = extras.length > 0 ? ` (${extras.join(", ")})` : "";
      err(`  ✗ ${formatSite(site)} — ${outcome.phase} failed: ${e.message}${tail}`);
      if (e.hint) err(`      hint: ${e.hint}`);
      err(`      query: ${snippet(site.query)}`);
    } else {
      diagnostics.push({
        severity: "error",
        phase: outcome.phase,
        message: (e as Error).message,
        ...siteDiagnostic(site),
      });
      err(`  ✗ ${formatSite(site)} — ${outcome.phase} failed: ${(e as Error).message}`);
      err(`      query: ${snippet(site.query)}`);
    }
  }

  const allAttrRefs: { tableOid: number; attno: number }[] = [];
  const allTableOids: number[] = [];
  for (const r of raw) {
    for (const f of r.fields) {
      if (f.tableOid !== 0 && f.columnAttr !== 0) {
        allAttrRefs.push({ tableOid: f.tableOid, attno: f.columnAttr });
        allTableOids.push(f.tableOid);
      }
    }
  }
  try {
    await schema.loadAttributes(allAttrRefs);
    await schema.loadTableNamesByOid(allTableOids);
    const unknownOids = new Set<number>();
    for (const r of raw) {
      for (const o of r.paramOids) if (!isBuiltinOid(o)) unknownOids.add(o);
      for (const f of r.fields) if (!isBuiltinOid(f.typeOid)) unknownOids.add(f.typeOid);
    }
    await schema.loadCustomTypes([...unknownOids]);
  } catch (error) {
    throw fatal("introspect", error);
  }

  const analyses = new Map<string, Awaited<ReturnType<typeof analyzeQuery>>>();
  const paramMaps = new Map<string, ParamMapResult>();
  const failedFps = new Set<string>();
  for (const r of raw) {
    const site = r.sites[0]!;
    try {
      analyses.set(r.fp, await analyzeQuery(r.query, r.fields, schema));
    } catch (e) {
      failures++;
      failedFps.add(r.fp);
      diagnostics.push({
        severity: "error",
        phase: "analyze",
        message: (e as Error).message,
        ...siteDiagnostic(site),
      });
      err(`  ✗ ${formatSite(site)} — analyze failed: ${(e as Error).message}`);
      err(`      query: ${snippet(site.query)}`);
      continue;
    }
    try {
      paramMaps.set(r.fp, await buildParamMap(r.query));
    } catch (e) {
      failures++;
      failedFps.add(r.fp);
      diagnostics.push({
        severity: "error",
        phase: "param-map",
        message: (e as Error).message,
        ...siteDiagnostic(site),
      });
      err(`  ✗ ${formatSite(site)} — paramMap failed: ${(e as Error).message}`);
      err(`      query: ${snippet(site.query)}`);
    }
  }

  const dmlTablesToLoad = new Map<string, { schema?: string; name: string }>();
  for (const pm of paramMaps.values()) {
    for (const idx of pm.dmlBound) {
      const t = pm.targets.get(idx);
      if (t) {
        const key = JSON.stringify([t.schema ?? null, t.table]);
        dmlTablesToLoad.set(key, t.schema ? { schema: t.schema, name: t.table } : { name: t.table });
      }
    }
  }
  try {
    if (dmlTablesToLoad.size > 0) {
      const names = [...dmlTablesToLoad.values()];
      await schema.loadTableNames(names);
      const oids: number[] = [];
      for (const n of names) {
        const oid = schema.resolveTable(n.schema, n.name);
        if (oid !== undefined) oids.push(oid);
      }
      await schema.loadColumnsForTables(oids);
    }
  } catch (error) {
    throw fatal("introspect", error);
  }

  const entries: CacheEntry[] = [...reusedEntries];
  const generated: { fp: string; entry: CacheEntry }[] = [...reusedGenerated];
  for (const r of raw) {
    if (failedFps.has(r.fp)) continue;
    const analysis = analyses.get(r.fp)!;
    const pm: ParamMapResult = paramMaps.get(r.fp) ?? {
      targets: new Map(),
      forceNullable: new Set(),
      dmlBound: new Set(),
    };
    const entry: CacheEntry = {
      query: r.sites[0]!.query,
      validation: r.validation,
      ...siteUsage(r.sites),
      paramOids: r.paramOids.map(portableCacheOid),
      paramTsTypes: r.paramOids.map((o, idx) => resolveParamTs(idx + 1, o, pm.targets, schema, userCfg)),
      paramNullable: r.paramOids.map((_o, idx) => resolveParamNullable(idx + 1, pm, schema)),
      ...(r.paramNames.length > 0 ? { paramNames: r.paramNames } : {}),
      columns: r.fields.map((f, i) => {
        const parsed = parseColumnOverride(f.name);
        const treatAsOverride = parsed.override !== undefined && isAliasOrExpression(f, schema);
        return {
          name: parsed.name,
          typeOid: portableCacheOid(f.typeOid),
          tsType: resolveColumnTs(
            f,
            schema,
            userCfg,
            analysis.perColumnSources[i] ?? null,
            analysis.perColumnArrayElementNullability[i] ?? "unknown",
          ),
          nullable: analysis.perColumnNullable[i] ?? true,
          ...(treatAsOverride ? { override: parsed.override } : {}),
        };
      }),
      hasResultSet: r.fields.length > 0,
      ...(analysis.degraded ? { degraded: analysis.degraded } : {}),
    };
    const entryDiagnostics = inferenceDiagnostics(entry, r.sites[0]!, opts.strictInference === true);
    diagnostics.push(...entryDiagnostics);
    if (entryDiagnostics.length > 0) {
      for (const diagnostic of entryDiagnostics) {
        const label = diagnostic.severity === "error" ? "inference failed" : "inference warning";
        err(`  ${label}: ${formatSite(r.sites[0]!)} — ${diagnostic.message}`);
      }
      if (opts.strictInference) {
        failures++;
        continue;
      }
    }
    entries.push(entry);
    generated.push({ fp: r.fp, entry });
    const nn = entry.columns.filter((c) => !effectiveNullable(c)).length;
    const inferenceTag = entry.degraded ? ` [degraded: ${entry.degraded.reason}]` : "";
    const validationTag = entry.validation === "parse-only" ? " [parse-only]" : "";
    log(`  ✓ ${formatSite(r.sites[0]!)} → ${r.paramOids.length} param(s), ${r.fields.length} col(s) [${nn} non-null]${inferenceTag}${validationTag}`);
  }

  if (failures > 0) {
    return { sites: sites.length, entries: entries.length, failures, pruned: 0, functions: 0, diagnostics };
  }

  let functions: FunctionEntry[];
  if (userCfg.functionCatalog === false) {
    functions = [];
  } else if (input.reuseFunctions && functionCacheExists(opts.cacheDir)) {
    functions = readFunctionCache(opts.cacheDir);
  } else {
    try {
      functions = await introspectFunctions(client, schema, {
        includeExtensionOwned: userCfg.functionCatalog?.includeExtensionOwned === true,
      });
    } catch (error) {
      throw fatal("introspect", error);
    }
  }
  let pruned: number;
  try {
    pruned = cache.replaceAll(generated, opts.prune !== false).length;
    if (pruned > 0) log(`pruned ${pruned} orphaned cache entry/entries`);
    writeFunctionCache(opts.cacheDir, functions);
    writeCacheManifest(opts.cacheDir, prepareConfigHash(userCfg));
    emitDts(opts.dtsPath, entries, functions, userCfg.customTypes);
  } catch (error) {
    throw fatal("cache", error);
  }
  return { sites: sites.length, entries: entries.length, failures, pruned, functions: functions.length, diagnostics };
}

export async function runPrepare(opts: PrepareOptions): Promise<void> {
  if (opts.verify) {
    const verification = await verifyPrepareArtifacts(
      opts,
      opts.json ? () => {} : console.log,
      opts.json ? () => {} : console.error,
    );
    if (opts.json) {
      console.log(JSON.stringify({
        formatVersion: 1,
        ok: verification.ok,
        mode: "verify",
        ...verification.result,
        changed: verification.changed,
      }, null, 2));
    }
    if (!verification.ok) process.exitCode = 1;
    return;
  }
  if (opts.check || opts.offline) {
    const mode = opts.offline ? "offline" : "check";
    let userCfg: SqlxJsConfig;
    try {
      userCfg = await loadConfig(opts.root);
    } catch (error) {
      throw fatal("config", error);
    }
    let sites: QueryCallSite[];
    try {
      sites = scanProject(opts.root, userCfg.scan);
    } catch (error) {
      throw fatal("scan", error);
    }
    if (!opts.json) console.log(`scanned: found ${sites.length} sql() call site(s)`);
    const cache = new Cache(opts.cacheDir);
    try {
      assertCacheManifest(opts.cacheDir, prepareConfigHash(userCfg));
    } catch (error) {
      throw fatal("cache", error);
    }
    const unique = new Map<string, { fp: string; query: string; sites: QueryCallSite[] }>();
    for (const s of sites) {
      const fp = fingerprint(s.query);
      const existing = unique.get(fp);
      if (existing) existing.sites.push(s);
      else unique.set(fp, { fp, query: s.query, sites: [s] });
    }
    const diagnostics: PrepareDiagnostic[] = [];
    for (const { fp, query, sites: ss } of unique.values()) {
      if (!cache.has(fp)) {
        const site = ss[0]!;
        diagnostics.push({
          severity: "error",
          phase: "cache",
          message: "query is not in the offline cache",
          ...siteDiagnostic(site),
        });
        if (!opts.json) {
          console.error(`stale: ${formatSite(site)} — query not in cache`);
          console.error(`       query: ${snippet(query)}`);
        }
      }
    }
    if (diagnostics.length > 0) {
      if (opts.json) {
        console.log(JSON.stringify({
          formatVersion: 1,
          ok: false,
          mode,
          sites: sites.length,
          entries: [...unique.keys()].filter((fp) => cache.has(fp)).length,
          failures: diagnostics.length,
          pruned: 0,
          functions: 0,
          diagnostics,
        }, null, 2));
      } else {
        console.error(`\nsqlx-js prepare --${mode}: ${diagnostics.length} stale/missing entries. Run \`sqlx-js prepare\` against a live DB.`);
      }
      process.exitCode = 1;
      return;
    }
    const entries: CacheEntry[] = [];
    let inferenceFailures = 0;
    let functions: FunctionEntry[];
    try {
      for (const u of unique.values()) {
        const entry = cache.read(u.fp);
        if (!entry) continue;
        if (!entry.validation) {
          diagnostics.push({
            severity: "error",
            phase: "cache",
            message: "cache entry is missing planner validation metadata; run live `sqlx-js prepare`",
            ...siteDiagnostic(u.sites[0]!),
          });
          inferenceFailures++;
          continue;
        }
        const current = { ...entry, ...siteUsage(u.sites) };
        const entryDiagnostics = inferenceDiagnostics(current, u.sites[0]!, opts.strictInference === true);
        diagnostics.push(...entryDiagnostics);
        const planDiagnostic = planningDiagnostic(current, u.sites[0]!);
        if (planDiagnostic) diagnostics.push(planDiagnostic);
        if (opts.strictInference && entryDiagnostics.length > 0) {
          inferenceFailures++;
          continue;
        }
        entries.push(current);
      }
      functions = readFunctionCache(opts.cacheDir);
      if (!functionCacheExists(opts.cacheDir)) {
        diagnostics.push({
          severity: "error",
          phase: "cache",
          message: "function cache is missing",
        });
        inferenceFailures++;
      }
      if (opts.check && inferenceFailures === 0) {
        const tmp = mkdtempSync(join(tmpdir(), "sqlx-js-check-"));
        const generatedDts = join(tmp, "sqlx-js-env.d.ts");
        try {
          emitDts(generatedDts, entries, functions, userCfg.customTypes);
          if (!existsSync(opts.dtsPath) || readFileSync(opts.dtsPath, "utf8") !== readFileSync(generatedDts, "utf8")) {
            diagnostics.push({
              severity: "error",
              phase: "cache",
              message: "generated declaration is stale or missing",
              file: relative(opts.root, opts.dtsPath).replace(/\\/g, "/"),
            });
            inferenceFailures++;
          }
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      }
      if (inferenceFailures > 0) {
        if (opts.json) {
          console.log(JSON.stringify({
            formatVersion: 1,
            ok: false,
            mode,
            sites: sites.length,
            entries: entries.length,
            failures: inferenceFailures,
            pruned: 0,
            functions: functions.length,
            diagnostics,
          }, null, 2));
        } else {
          for (const diagnostic of diagnostics) {
            const location = diagnostic.file
              ? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}:${diagnostic.column ?? 1}` : ""} — `
              : "";
            console.error(`${diagnostic.phase} failed: ${location}${diagnostic.message}`);
          }
        }
        process.exitCode = 1;
        return;
      }
      if (opts.offline) emitDts(opts.dtsPath, entries, functions, userCfg.customTypes);
    } catch (error) {
      throw fatal("cache", error);
    }
    if (opts.json) {
      console.log(JSON.stringify({
        formatVersion: 1,
        ok: true,
        mode,
        sites: sites.length,
        entries: entries.length,
        failures: 0,
        pruned: 0,
        functions: functions.length,
        diagnostics,
      }, null, 2));
    } else {
      for (const diagnostic of diagnostics) {
        console.error(`${diagnostic.phase} warning: ${diagnostic.file}:${diagnostic.line}:${diagnostic.column} — ${diagnostic.message}`);
      }
      const suffix = opts.offline ? ", types regenerated" : ", generated artifacts are current";
      console.log(`ok — ${entries.length} unique queries, ${functions.length} function(s)${suffix}`);
    }
    return;
  }

  const session = await openSession(opts);
  try {
    const r = await prepareOnce(
      opts,
      session,
      opts.json ? () => {} : console.log,
      opts.json ? () => {} : console.error,
    );
    if (opts.json) {
      console.log(JSON.stringify({ formatVersion: 1, ok: r.failures === 0, mode: "prepare", ...r }, null, 2));
    }
    if (r.failures > 0) {
      if (!opts.json) console.error(`\n${r.failures} query/queries failed to prepare`);
      process.exitCode = 1;
      return;
    }
    if (!opts.json) console.log(`\nprepared ${r.entries} unique query/queries, ${r.functions} function(s) → ${opts.dtsPath}`);
  } finally {
    await session.client.end();
  }
}

export async function verifyPrepareArtifacts(
  opts: PrepareOptions,
  log: (msg: string) => void = console.log,
  err: (msg: string) => void = console.error,
): Promise<{ ok: boolean; result: PrepareResult; changed: string[] }> {
  const tmp = mkdtempSync(join(tmpdir(), "sqlx-js-verify-"));
  const cacheDir = join(tmp, "cache");
  const dtsPath = join(tmp, "sqlx-js-env.d.ts");
  const verifyOpts: PrepareOptions = {
    ...opts,
    cacheDir,
    dtsPath,
    check: false,
    verify: false,
    prune: true,
  };
  let session: PrepareSession | undefined;
  try {
    session = await openSession(verifyOpts);
    const result = await prepareOnce(verifyOpts, session, log, err);
    if (result.failures > 0) {
      err(`\n${result.failures} query/queries failed to prepare`);
      return { ok: false, result, changed: [] };
    }
    let comparison: ReturnType<typeof compareArtifacts>;
    try {
      comparison = compareArtifacts(
        { cacheDir: opts.cacheDir, dtsPath: opts.dtsPath },
        { cacheDir, dtsPath },
      );
    } catch (error) {
      throw fatal("verify", error);
    }
    if (!comparison.ok) {
      err("sqlx-js prepare --verify: generated artifacts are stale:");
      for (const file of comparison.changed) err(`  ${file}`);
      err("Run `sqlx-js prepare` and commit the regenerated artifacts.");
      return { ok: false, result, changed: comparison.changed };
    }
    log(`verified ${result.entries} query/queries and ${result.functions} function(s); generated artifacts are current`);
    return { ok: true, result, changed: [] };
  } finally {
    if (session) await session.client.end();
    rmSync(tmp, { recursive: true, force: true });
  }
}
