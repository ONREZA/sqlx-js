import { join } from "node:path";
import { PgClient, parseDatabaseUrl, PgError, type ConnConfig, type FieldDescription } from "../pg/wire";
import { SchemaCache, compositeLiteral, type CustomTypeInfo } from "../pg/schema";
import { analyzeQuery } from "../pg/analyze";
import { isBuiltinOid, oidToTs } from "../pg/oids";
import { scanProject, type QueryCallSite } from "../scan/scanner";
import { Cache, fingerprint, effectiveNullable, type CacheEntry } from "../cache";
import { emitDts } from "../codegen";
import { loadConfig, lookupJsonbType, type SqlxJsConfig } from "../config";
import { buildParamMap, type ParamMap, type ParamMapResult } from "../pg/param-map";
import { mergeExtensionTypes } from "../pg/extensions";

const JSON_OIDS = new Set([114, 3802]);
const JSON_ARRAY_OIDS = new Set([199, 3807]);
const JSON_INPUT = 'import("@onreza/sqlx-js").JsonInput';

function enumUnion(values: string[]): string {
  if (values.length === 0) return "never";
  return values.map((v) => JSON.stringify(v)).join(" | ");
}

function resolveTs(oid: number, customLookup: (o: number) => CustomTypeInfo | undefined): string {
  const c = customLookup(oid);
  if (c) {
    if (c.kind === "enum") return enumUnion(c.values);
    if (c.kind === "enumArray") return `(${enumUnion(c.element.values)})[]`;
    if (c.kind === "scalar") return c.tsType;
    if (c.kind === "scalarArray") return `(${c.element.tsType})[]`;
    if (c.kind === "composite") return compositeLiteral(c);
    if (c.kind === "compositeArray") return `(${compositeLiteral(c.element)})[]`;
  }
  return oidToTs(oid).ts;
}

function resolveColumnTs(
  f: FieldDescription,
  schema: SchemaCache,
  cfg: SqlxJsConfig,
): string {
  if (f.tableOid !== 0 && f.columnAttr !== 0) {
    const tbl = schema.tableNameByOid(f.tableOid);
    const colName = schema.columnNameByAttno(f.tableOid, f.columnAttr);
    if (tbl && colName) {
      if (JSON_OIDS.has(f.typeOid)) {
        const decl = lookupJsonbType(cfg, tbl.schema, tbl.name, colName);
        if (decl) return decl;
      }
      if (JSON_ARRAY_OIDS.has(f.typeOid)) {
        const decl = lookupJsonbType(cfg, tbl.schema, tbl.name, colName);
        if (decl) return `(${decl})[]`;
      }
    }
  }
  return resolveTs(f.typeOid, (oid) => schema.customType(oid));
}

function resolveParamTs(
  paramIndex: number,
  paramOid: number,
  paramMap: ParamMap,
  schema: SchemaCache,
  cfg: SqlxJsConfig,
): string {
  if (JSON_OIDS.has(paramOid) || JSON_ARRAY_OIDS.has(paramOid)) {
    const target = paramMap.get(paramIndex);
    if (target) {
      const column = resolveTargetColumn(target, schema);
      const decl = column ? lookupJsonbType(cfg, target.schema ?? "public", target.table, column) : undefined;
      if (decl) return JSON_ARRAY_OIDS.has(paramOid) ? `(${decl})[]` : decl;
    }
    return JSON_ARRAY_OIDS.has(paramOid) ? `(${JSON_INPUT})[]` : JSON_INPUT;
  }
  return resolveTs(paramOid, (oid) => schema.customType(oid));
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

export type PrepareOptions = {
  root: string;
  databaseUrl: string;
  cacheDir: string;
  dtsPath: string;
  check: boolean;
  prune?: boolean;
};

function formatSite(s: QueryCallSite): string {
  return `${s.file}:${s.line}:${s.column}`;
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

export type PrepareSession = {
  client: PgClient;
  schema: SchemaCache;
  userCfg: SqlxJsConfig;
};

export async function openSession(opts: PrepareOptions): Promise<PrepareSession> {
  const userCfg = await loadConfig(opts.root);
  const cfg = parseDatabaseUrl(opts.databaseUrl);
  const client = new PgClient(cfg);
  await client.connect();
  const schema = new SchemaCache(client);
  schema.setTypeRegistry(mergeExtensionTypes(userCfg.customTypes));
  return { client, schema, userCfg };
}

type DescribeOutcome =
  | { ok: true; paramOids: number[]; fields: FieldDescription[] }
  | { ok: false; error: unknown };

export function defaultPrepareConcurrency(): number {
  const raw = process.env.SQLX_JS_PREPARE_CONCURRENCY;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 8;
}

// describe() is sequential per PgClient (see wire.ts), so concurrency comes from
// running several short-lived connections in parallel, each draining a shared
// cursor. The session connection is reused as one worker; extras are closed after.
export async function describeAll(
  cfg: ConnConfig,
  sessionClient: PgClient,
  queries: { fp: string; query: string }[],
  concurrency: number,
): Promise<Map<string, DescribeOutcome>> {
  const results = new Map<string, DescribeOutcome>();
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
        results.set(fp, { ok: true, paramOids: d.paramOids, fields: d.fields });
      } catch (error) {
        results.set(fp, { ok: false, error });
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
): Promise<{ entries: number; failures: number; pruned: number }> {
  const sites = scanProject(opts.root);
  log(`scanned: found ${sites.length} sql() call site(s)`);

  const cache = new Cache(opts.cacheDir);

  const unique = new Map<string, { fp: string; query: string; sites: QueryCallSite[] }>();
  for (const s of sites) {
    const fp = fingerprint(s.query);
    const existing = unique.get(fp);
    if (existing) existing.sites.push(s);
    else unique.set(fp, { fp, query: s.query, sites: [s] });
  }

  type Raw = {
    fp: string;
    query: string;
    sites: QueryCallSite[];
    paramOids: number[];
    fields: FieldDescription[];
  };
  const raw: Raw[] = [];
  let failures = 0;
  const { client, schema, userCfg } = session;

  const describeList = [...unique.values()].map((u) => ({ fp: u.fp, query: u.query }));
  const describeResults = await describeAll(parseDatabaseUrl(opts.databaseUrl), client, describeList, concurrency);
  for (const { fp, query, sites: ss } of unique.values()) {
    const site = ss[0]!;
    const outcome = describeResults.get(fp)!;
    if (outcome.ok) {
      raw.push({ fp, query, sites: ss, paramOids: outcome.paramOids, fields: outcome.fields });
      continue;
    }
    failures++;
    const e = outcome.error;
    if (e instanceof PgError) {
      const extras: string[] = [];
      if (e.position) extras.push(`pos ${e.position}`);
      if (e.code) extras.push(`code ${e.code}`);
      const tail = extras.length > 0 ? ` (${extras.join(", ")})` : "";
      err(`  ✗ ${formatSite(site)} — describe failed: ${e.message}${tail}`);
      if (e.hint) err(`      hint: ${e.hint}`);
      err(`      query: ${snippet(query)}`);
    } else {
      err(`  ✗ ${formatSite(site)} — describe failed: ${(e as Error).message}`);
      err(`      query: ${snippet(query)}`);
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
  await schema.loadAttributes(allAttrRefs);
  await schema.loadTableNamesByOid(allTableOids);

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
      err(`  ✗ ${formatSite(site)} — analyze failed: ${(e as Error).message}`);
      err(`      query: ${snippet(r.query)}`);
      continue;
    }
    try {
      paramMaps.set(r.fp, await buildParamMap(r.query));
    } catch (e) {
      failures++;
      failedFps.add(r.fp);
      err(`  ✗ ${formatSite(site)} — paramMap failed: ${(e as Error).message}`);
      err(`      query: ${snippet(r.query)}`);
    }
  }

  const dmlTablesToLoad = new Set<string>();
  for (const pm of paramMaps.values()) {
    for (const idx of pm.dmlBound) {
      const t = pm.targets.get(idx);
      if (t) dmlTablesToLoad.add(`${t.schema ?? "public"}.${t.table}`);
    }
  }
  if (dmlTablesToLoad.size > 0) {
    const names = [...dmlTablesToLoad].map((k) => {
      const [schema, name] = k.split(".");
      return { schema, name: name! };
    });
    await schema.loadTableNames(names);
    const oids: number[] = [];
    for (const n of names) {
      const oid = schema.resolveTable(n.schema, n.name);
      if (oid !== undefined) oids.push(oid);
    }
    await schema.loadColumnsForTables(oids);
  }

  const unknownOids = new Set<number>();
  for (const r of raw) {
    for (const o of r.paramOids) if (!isBuiltinOid(o)) unknownOids.add(o);
    for (const f of r.fields) if (!isBuiltinOid(f.typeOid)) unknownOids.add(f.typeOid);
  }
  await schema.loadCustomTypes([...unknownOids]);

  const entries: CacheEntry[] = [];
  for (const r of raw) {
    if (failedFps.has(r.fp)) continue;
    const analysis = analyses.get(r.fp)!;
    const pm: ParamMapResult = paramMaps.get(r.fp) ?? {
      targets: new Map(),
      forceNullable: new Set(),
      dmlBound: new Set(),
    };
    const entry: CacheEntry = {
      query: r.query,
      ...siteUsage(r.sites),
      paramOids: r.paramOids,
      paramTsTypes: r.paramOids.map((o, idx) => resolveParamTs(idx + 1, o, pm.targets, schema, userCfg)),
      paramNullable: r.paramOids.map((_o, idx) => resolveParamNullable(idx + 1, pm, schema)),
      columns: r.fields.map((f, i) => {
        const parsed = parseColumnOverride(f.name);
        const treatAsOverride = parsed.override !== undefined && isAliasOrExpression(f, schema);
        return {
          name: parsed.name,
          typeOid: f.typeOid,
          tsType: resolveColumnTs(f, schema, userCfg),
          nullable: analysis.perColumnNullable[i] ?? true,
          ...(treatAsOverride ? { override: parsed.override } : {}),
        };
      }),
      hasResultSet: r.fields.length > 0,
      ...(analysis.degraded ? { degraded: analysis.degraded } : {}),
    };
    cache.write(r.fp, entry);
    entries.push(entry);
    const nn = entry.columns.filter((c) => !effectiveNullable(c)).length;
    const tag = entry.degraded ? ` [degraded: ${entry.degraded.reason}]` : "";
    log(`  ✓ ${formatSite(r.sites[0]!)} → ${r.paramOids.length} param(s), ${r.fields.length} col(s) [${nn} non-null]${tag}`);
  }

  let pruned = 0;
  if (opts.prune !== false) {
    pruned = cache.prune(unique.keys()).length;
    if (pruned > 0) log(`pruned ${pruned} orphaned cache entry/entries`);
  }

  emitDts(opts.dtsPath, entries);
  return { entries: entries.length, failures, pruned };
}

export async function runPrepare(opts: PrepareOptions): Promise<void> {
  if (opts.check) {
    const sites = scanProject(opts.root);
    console.log(`scanned: found ${sites.length} sql() call site(s)`);
    const cache = new Cache(opts.cacheDir);
    const unique = new Map<string, { fp: string; query: string; sites: QueryCallSite[] }>();
    for (const s of sites) {
      const fp = fingerprint(s.query);
      const existing = unique.get(fp);
      if (existing) existing.sites.push(s);
      else unique.set(fp, { fp, query: s.query, sites: [s] });
    }
    let stale = 0;
    for (const { fp, query, sites: ss } of unique.values()) {
      if (!cache.has(fp)) {
        stale++;
        console.error(`stale: ${formatSite(ss[0]!)} — query not in cache`);
        console.error(`       query: ${snippet(query)}`);
      }
    }
    if (stale > 0) {
      console.error(`\nsqlx-js prepare --check: ${stale} stale/missing entries. Run \`sqlx-js prepare\` against a live DB.`);
      process.exit(1);
    }
    const entries = [...unique.values()].map((u) => {
      const entry = cache.read(u.fp);
      return entry ? { ...entry, ...siteUsage(u.sites) } : null;
    }).filter((e): e is CacheEntry => e !== null);
    emitDts(opts.dtsPath, entries);
    console.log(`ok — ${entries.length} unique queries, types regenerated`);
    return;
  }

  const session = await openSession(opts);
  try {
    const r = await prepareOnce(opts, session);
    if (r.failures > 0) {
      console.error(`\n${r.failures} query/queries failed to prepare`);
      await session.client.end();
      process.exit(1);
    }
    console.log(`\nprepared ${r.entries} unique query/queries → ${opts.dtsPath}`);
  } finally {
    await session.client.end();
  }
}
