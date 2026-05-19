import { join } from "node:path";
import { PgClient, parseDatabaseUrl, PgError, type FieldDescription } from "../pg/wire";
import { SchemaCache, type CustomTypeInfo } from "../pg/schema";
import { analyzeQuery } from "../pg/analyze";
import { isBuiltinOid, oidToTs } from "../pg/oids";
import { scanProject, type QueryCallSite } from "../scan/scanner";
import { Cache, fingerprint, type CacheEntry } from "../cache";
import { emitDts } from "../codegen";
import { loadConfig, lookupJsonbType, type BunSqlxConfig } from "../config";
import { buildParamMap, type ParamMap, type ParamMapResult } from "../pg/param-map";
import { mergeExtensionTypes } from "../pg/extensions";

const JSON_OIDS = new Set([114, 3802]);
const JSON_ARRAY_OIDS = new Set([199, 3807]);

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
  }
  return oidToTs(oid).ts;
}

function resolveColumnTs(
  f: FieldDescription,
  schema: SchemaCache,
  cfg: BunSqlxConfig,
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
  cfg: BunSqlxConfig,
): string {
  if (JSON_OIDS.has(paramOid) || JSON_ARRAY_OIDS.has(paramOid)) {
    const target = paramMap.get(paramIndex);
    if (target) {
      const decl = lookupJsonbType(cfg, target.schema ?? "public", target.table, target.column);
      if (decl) return JSON_ARRAY_OIDS.has(paramOid) ? `(${decl})[]` : decl;
    }
  }
  return resolveTs(paramOid, (oid) => schema.customType(oid));
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
    const col = schema.columnsOf(oid)?.get(t.column);
    if (!col) return false;
    return !col.notNull;
  }
  return false;
}

const ALIAS_OVERRIDE = /^(.+?)([!?])$/;

function parseColumnOverride(name: string): { name: string; forceNonNull: boolean; forceNullable: boolean } {
  const m = ALIAS_OVERRIDE.exec(name);
  if (!m) return { name, forceNonNull: false, forceNullable: false };
  return {
    name: m[1]!,
    forceNonNull: m[2] === "!",
    forceNullable: m[2] === "?",
  };
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

export type PrepareSession = {
  client: PgClient;
  schema: SchemaCache;
  userCfg: BunSqlxConfig;
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

export async function prepareOnce(
  opts: PrepareOptions,
  session: PrepareSession,
  log: (msg: string) => void = console.log,
  err: (msg: string) => void = console.error,
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

  for (const { fp, query, sites: ss } of unique.values()) {
    const site = ss[0]!;
    try {
      const d = await client.describe(query);
      raw.push({ fp, query, sites: ss, paramOids: d.paramOids, fields: d.fields });
    } catch (e) {
      failures++;
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
    const fileSites = r.sites.filter((s) => s.kind === "file");
    const hasInline = r.sites.some((s) => s.kind !== "file");
    const filePaths = fileSites.length > 0
      ? Array.from(new Set(fileSites.map((s) => s.sqlFilePath!))).sort()
      : undefined;
    const entry: CacheEntry = {
      query: r.query,
      paramOids: r.paramOids,
      paramTsTypes: r.paramOids.map((o, idx) => resolveParamTs(idx + 1, o, pm.targets, schema, userCfg)),
      paramNullable: r.paramOids.map((_o, idx) => resolveParamNullable(idx + 1, pm, schema)),
      columns: r.fields.map((f, i) => {
        const parsed = parseColumnOverride(f.name);
        return {
          name: parsed.name,
          typeOid: f.typeOid,
          tsType: resolveColumnTs(f, schema, userCfg),
          nullable: analysis.perColumnNullable[i] ?? true,
          forceNonNull: parsed.forceNonNull,
          forceNullable: parsed.forceNullable,
        };
      }),
      hasResultSet: r.fields.length > 0,
      hasInline,
      ...(filePaths ? { filePaths } : {}),
    };
    cache.write(r.fp, entry);
    entries.push(entry);
    const nn = entry.columns.filter((c) => !(c.forceNonNull ? false : c.forceNullable ? true : c.nullable)).length;
    log(`  ✓ ${formatSite(r.sites[0]!)} → ${r.paramOids.length} param(s), ${r.fields.length} col(s) [${nn} non-null]`);
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
      console.error(`\nbun-sqlx prepare --check: ${stale} stale/missing entries. Run \`bun-sqlx prepare\` against a live DB.`);
      process.exit(1);
    }
    const entries = [...unique.values()].map((u) => cache.read(u.fp)!).filter(Boolean);
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
