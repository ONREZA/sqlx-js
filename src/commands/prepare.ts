// Keep prepare modes together so live, offline, and verification paths share
// one atomic artifact contract.
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
import { SchemaCache } from "../pg/schema";
import { analyzeQuery } from "../pg/analyze";
import { isBuiltinOid } from "../pg/oids";
import { scanProject, type QueryCallSite } from "../scan/scanner";
import {
  assertCacheManifest,
  Cache,
  profileFingerprint,
  effectiveNullable,
  portableCacheOid,
  type CacheEntry,
} from "../cache";
import { emitDts } from "../codegen";
import {
  loadConfig,
  prepareConfigHash,
  type DatabaseProfile,
  type SqlxJsConfig,
} from "../config";
import {
  functionCacheExists,
  readFunctionCache,
  type FunctionEntry,
} from "../function-cache";
import { introspectFunctions } from "../pg/functions";
import {
  buildParamMap,
  effectiveParamTargets,
  type ParamMapResult,
} from "../pg/param-map";
import { mergeExtensionTypes } from "../pg/extensions";
import { compareArtifacts } from "../artifacts";
import {
  assertDistinctEnumCatalogOutput,
  enumCatalogCacheExists,
  enumCatalogOutputPath,
  introspectEnumCatalog,
  readEnumCatalogCache,
  renderEnumCatalog,
  selectedEnumCatalogCount,
  type EnumCatalogEntry,
} from "../enum-catalog";
import { originalPosition, rewriteNamedParameters } from "../sql-params";
import {
  nullableParamOverrides as collectNullableParamOverrides,
  resultElementNonNullOverrides as collectResultElementNonNullOverrides,
  sameNullableParamOverrides,
  sameResultElementNonNullOverrides,
} from "../query-source-intent";
import {
  renderRuntimeDescriptors,
  runtimeDescriptorPath,
} from "../runtime-descriptor-artifact";
import {
  publishOfflinePrepareArtifacts,
  publishPrepareArtifacts,
} from "../prepare-artifacts";
import {
  columnInference,
  duplicateOutputColumns,
  isAliasOrExpression,
  paramInference,
  parseColumnOverride,
  resolveColumnTs,
  resolveParamNullable,
  resolveParamTs,
  resolveResultArrayElementNullability,
  resolveTargetColumn,
} from "./prepare-inference";
import {
  addFunctionContractDiagnostics,
  executionIntentDiagnostics,
  fatal,
  formatPrepareDiagnostic,
  formatPrepareDiagnosticCounts,
  formatPrepareTotals,
  formatQuerySnippet,
  formatQueryTotals,
  formatSite,
  inferenceDiagnostics,
  planningDiagnostics,
  planningValidationTag,
  reportPrepareDiagnostics,
  reportQueryDiagnostics,
  siteDiagnostic,
  temporalPolicyDiagnostics,
  withOutputHints,
  type PrepareDiagnostic,
} from "./prepare-diagnostics";
export {
  PrepareFatalError,
  type PrepareDiagnostic,
  type PrepareDiagnosticPhase,
} from "./prepare-diagnostics";

export type PrepareOptions = {
  root: string;
  databaseUrl: string;
  cacheDir: string;
  dtsPath: string;
  enumOutputPath?: string;
  check: boolean;
  offline?: boolean;
  verify?: boolean;
  json?: boolean;
  warnings?: boolean;
  verbose?: boolean;
  prune?: boolean;
  strictInference?: boolean;
};

export type PrepareResult = {
  sites: number;
  entries: number;
  failures: number;
  pruned: number;
  functions: number;
  enums: number;
  diagnostics: PrepareDiagnostic[];
};

function paramTargetsUseTimestampWithoutTimeZone(
  paramMap: ParamMapResult,
  schema: SchemaCache,
): boolean {
  return [...paramMap.bindings.values()].some((binding) =>
    effectiveParamTargets(binding).some((target) => {
      const tableOid = schema.resolveTable(target.schema, target.table);
      const column = resolveTargetColumn(target, schema);
      const typeOid = tableOid === undefined || column === undefined
        ? undefined
        : schema.columnsOf(tableOid)?.get(column)?.typeOid;
      return typeOid !== undefined && schema.isTimestampWithoutTimeZone(typeOid);
    })
  );
}

function expandProfileSites(sites: QueryCallSite[]): QueryCallSite[] {
  return sites.flatMap((site) =>
    site.profiles && site.profiles.length > 0
      ? site.profiles.map((profile) => ({ ...site, profiles: [profile] }))
      : [site]
  );
}

function siteProfile(site: QueryCallSite): string | undefined {
  return site.profiles?.[0];
}

function siteCacheKey(site: QueryCallSite): string {
  return profileFingerprint(siteProfile(site), site.query);
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
  profiles: Map<string, {
    profile: DatabaseProfile;
    client: PgClient;
    schema: SchemaCache;
  }>;
};

export type PrepareIncrementalInput = {
  sites?: QueryCallSite[];
  reuseCacheFps?: ReadonlySet<string>;
  reuseEnumCatalog?: boolean;
};

export async function openSession(opts: PrepareOptions): Promise<PrepareSession> {
  let userCfg: SqlxJsConfig;
  try {
    userCfg = await loadConfig(opts.root);
  } catch (error) {
    throw fatal("config", error);
  }
  try {
    assertDistinctEnumCatalogOutput(opts.root, userCfg, opts.dtsPath, opts.enumOutputPath);
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
  const profiles = new Map<string, {
    profile: DatabaseProfile;
    client: PgClient;
    schema: SchemaCache;
  }>();
  try {
    for (const profile of Object.values(userCfg.profiles ?? {})) {
      const profileClient = new PgClient(cfg);
      try {
        await profileClient.connect();
        await setRole(profileClient, profile.role);
        const profileSchema = new SchemaCache(profileClient);
        profileSchema.setTypeRegistry(mergeExtensionTypes(userCfg.customTypes), userCfg.customTypes);
        await profileSchema.validateUserTypeRegistry();
        profiles.set(profile.name, { profile, client: profileClient, schema: profileSchema });
      } catch (error) {
        await profileClient.end().catch(() => {});
        throw new Error(
          `sqlx-js: cannot initialize profile ${profile.name} with role ${profile.role}: ${(error as Error).message}`,
          { cause: error },
        );
      }
    }
  } catch (error) {
    await Promise.all([...profiles.values()].map((profile) => profile.client.end().catch(() => {})));
    await client.end().catch(() => {});
    throw fatal("connect", error);
  }
  return { client, schema, userCfg, profiles };
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

async function setRole(client: PgClient, role: string): Promise<void> {
  await client.simpleQuery(`SET ROLE ${quoteIdentifier(role)}`);
}

export async function closePrepareSession(session: PrepareSession): Promise<void> {
  await Promise.all([
    session.client.end().catch(() => {}),
    ...[...session.profiles.values()].map((profile) => profile.client.end().catch(() => {})),
  ]);
}

function prepareContext(
  session: PrepareSession,
  profile: string | undefined,
): { client: PgClient; schema: SchemaCache; role?: string } {
  if (!profile) return { client: session.client, schema: session.schema };
  const context = session.profiles.get(profile);
  if (!context) throw new Error(`sqlx-js: prepare profile ${profile} is not configured`);
  return { client: context.client, schema: context.schema, role: context.profile.role };
}

type ValidationOutcome =
  | {
    ok: true;
    paramOids: number[];
    fields: FieldDescription[];
    hasResultSet: boolean;
    validation: PlanValidation;
  }
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
  role?: string,
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
          results.set(fp, {
            ok: true,
            paramOids: d.paramOids,
            fields: d.fields,
            hasResultSet: d.hasResultSet,
            validation,
          });
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
        if (role) await setRole(c, role);
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
      sites = scanProject(opts.root, session.userCfg.scan, session.userCfg.profiles ?? {});
    } catch (error) {
      throw fatal("scan", error);
    }
  }
  log(`scanned: found ${sites.length} sql() call site(s)`);
  const diagnostics: PrepareDiagnostic[] = [];

  const cache = new Cache(opts.cacheDir);
  let failures = 0;

  const profiledSites = expandProfileSites(sites);
  const unique = new Map<string, {
    fp: string;
    profile?: string;
    query: string;
    paramNames: string[];
    sites: QueryCallSite[];
  }>();
  for (const s of profiledSites) {
    const rewritten = rewriteNamedParameters(s.query);
    const fp = siteCacheKey(s);
    const existing = unique.get(fp);
    if (existing) existing.sites.push(s);
    else unique.set(fp, {
      fp,
      profile: siteProfile(s),
      query: rewritten.query,
      paramNames: rewritten.names,
      sites: [s],
    });
  }

  type Raw = {
    fp: string;
    profile?: string;
    query: string;
    sites: QueryCallSite[];
    paramOids: number[];
    fields: FieldDescription[];
    paramNames: string[];
    hasResultSet: boolean;
    validation: PlanValidation;
    nullableParamOverrides: number[];
    resultElementNonNullOverrides: string[];
  };
  const raw: Raw[] = [];
  const reusedEntries: CacheEntry[] = [];
  const reusedGenerated: { fp: string; entry: CacheEntry }[] = [];
  const { client, userCfg } = session;

  const toPrepare: typeof unique = new Map();
  for (const [fp, item] of unique) {
    const cached = input.reuseCacheFps?.has(fp) ? cache.read(fp) : null;
    const nullableParamOverrides = collectNullableParamOverrides(item.sites);
    const resultElementNonNullOverrides = collectResultElementNonNullOverrides(item.sites);
    if (
      !cached?.validation
      || cached.profile !== item.profile
      || !sameNullableParamOverrides(cached.nullableParamOverrides, nullableParamOverrides)
      || !sameResultElementNonNullOverrides(
        cached.resultElementNonNullOverrides,
        resultElementNonNullOverrides,
      )
    ) {
      toPrepare.set(fp, item);
      continue;
    }
    const entry = { ...cached, ...siteUsage(item.sites) };
    const entryDiagnostics = inferenceDiagnostics(entry, item.sites[0]!, opts.strictInference === true);
    const intentDiagnostics = executionIntentDiagnostics(entry, item.sites, opts.strictInference === true);
    const temporalDiagnostics = temporalPolicyDiagnostics(entry, item.sites, userCfg.temporal);
    diagnostics.push(...entryDiagnostics, ...intentDiagnostics, ...temporalDiagnostics);
    const queryDiagnostics = [...entryDiagnostics, ...intentDiagnostics, ...temporalDiagnostics];
    const queryFailed = reportQueryDiagnostics(queryDiagnostics, item.sites, err);
    const planIssues = planningDiagnostics(entry.validation, item.sites, opts.strictInference === true);
    for (const diagnostic of planIssues) {
      diagnostics.push(diagnostic);
      err(formatPrepareDiagnostic(diagnostic));
    }
    if (queryFailed || planIssues.some((diagnostic) => diagnostic.severity === "error")) {
      failures++;
      continue;
    }
    reusedEntries.push(entry);
    reusedGenerated.push({ fp, entry });
    const validationTag = planningValidationTag(entry.validation, item.sites);
    log(`  ↺ ${formatSite(item.sites[0]!)} → reused ${entry.paramOids.length} param(s), ${entry.columns.length} col(s)${validationTag}`);
  }

  const validationResults = new Map<string, ValidationOutcome>();
  const byProfile = new Map<string | undefined, typeof unique>();
  for (const item of toPrepare.values()) {
    const group = byProfile.get(item.profile) ?? new Map();
    group.set(item.fp, item);
    byProfile.set(item.profile, group);
  }
  for (const [profile, group] of byProfile) {
    const context = prepareContext(session, profile);
    const results = await validateAll(
      parseDatabaseUrl(opts.databaseUrl),
      context.client,
      [...group.values()].map((item) => ({ fp: item.fp, query: item.query })),
      concurrency,
      context.role,
    );
    for (const [fp, result] of results) validationResults.set(fp, result);
  }
  for (const { fp, profile, query, sites: ss } of toPrepare.values()) {
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
        err(`      query: ${formatQuerySnippet(site.query)}`);
        continue;
      }
      const planIssues = planningDiagnostics(outcome.validation, ss, opts.strictInference === true);
      for (const diagnostic of planIssues) {
        diagnostics.push(diagnostic);
        err(formatPrepareDiagnostic(diagnostic));
      }
      if (planIssues.some((diagnostic) => diagnostic.severity === "error")) {
        failures++;
        continue;
      }
      raw.push({
        fp,
        profile,
        query,
        sites: ss,
        paramOids: outcome.paramOids,
        fields: outcome.fields,
        paramNames: toPrepare.get(fp)!.paramNames,
        hasResultSet: outcome.hasResultSet,
        validation: outcome.validation,
        nullableParamOverrides: collectNullableParamOverrides(ss),
        resultElementNonNullOverrides: collectResultElementNonNullOverrides(ss),
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
      err(`      query: ${formatQuerySnippet(site.query)}`);
    } else {
      diagnostics.push({
        severity: "error",
        phase: outcome.phase,
        message: (e as Error).message,
        ...siteDiagnostic(site),
      });
      err(`  ✗ ${formatSite(site)} — ${outcome.phase} failed: ${(e as Error).message}`);
      err(`      query: ${formatQuerySnippet(site.query)}`);
    }
  }

  try {
    const rawByProfile = new Map<string | undefined, Raw[]>();
    for (const item of raw) {
      const group = rawByProfile.get(item.profile) ?? [];
      group.push(item);
      rawByProfile.set(item.profile, group);
    }
    for (const [profile, group] of rawByProfile) {
      const schema = prepareContext(session, profile).schema;
      const allAttrRefs: { tableOid: number; attno: number }[] = [];
      const allTableOids: number[] = [];
      const unknownOids = new Set<number>();
      for (const item of group) {
        for (const field of item.fields) {
          if (field.tableOid !== 0 && field.columnAttr !== 0) {
            allAttrRefs.push({ tableOid: field.tableOid, attno: field.columnAttr });
            allTableOids.push(field.tableOid);
          }
          if (!isBuiltinOid(field.typeOid)) unknownOids.add(field.typeOid);
        }
        for (const oid of item.paramOids) if (!isBuiltinOid(oid)) unknownOids.add(oid);
      }
      await schema.loadAttributes(allAttrRefs);
      await schema.loadTableNamesByOid(allTableOids);
      await schema.loadCustomTypes([...unknownOids]);
    }
  } catch (error) {
    throw fatal("introspect", error);
  }

  const analyses = new Map<string, Awaited<ReturnType<typeof analyzeQuery>>>();
  const paramMaps = new Map<string, ParamMapResult>();
  const failedFps = new Set<string>();
  for (const r of raw) {
    const site = r.sites[0]!;
    const schema = prepareContext(session, r.profile).schema;
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
      err(`      query: ${formatQuerySnippet(site.query)}`);
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
      err(`      query: ${formatQuerySnippet(site.query)}`);
    }
  }

  const paramTablesToLoad = new Map<
    string | undefined,
    Map<string, { schema?: string; name: string }>
  >();
  for (const r of raw) {
    const pm = paramMaps.get(r.fp);
    if (!pm) continue;
    const profileTables = paramTablesToLoad.get(r.profile) ?? new Map();
    for (const binding of pm.bindings.values()) {
      for (const t of effectiveParamTargets(binding)) {
        const key = JSON.stringify([t.schema ?? null, t.table]);
        profileTables.set(key, t.schema ? { schema: t.schema, name: t.table } : { name: t.table });
      }
    }
    paramTablesToLoad.set(r.profile, profileTables);
  }
  try {
    for (const [profile, tables] of paramTablesToLoad) {
      if (tables.size === 0) continue;
      const schema = prepareContext(session, profile).schema;
      const names = [...tables.values()];
      await schema.loadTableNames(names);
      const oids: number[] = [];
      for (const n of names) {
        const oid = schema.resolveTable(n.schema, n.name);
        if (oid !== undefined) oids.push(oid);
      }
      await schema.loadColumnsForTables(oids);
      await schema.loadCustomTypes(oids.flatMap((oid) =>
        [...(schema.columnsOf(oid)?.values() ?? [])].map((column) => column.typeOid)
      ));
    }
  } catch (error) {
    throw fatal("introspect", error);
  }

  const entries: CacheEntry[] = [...reusedEntries];
  const generated: { fp: string; entry: CacheEntry }[] = [...reusedGenerated];
  for (const r of raw) {
    if (failedFps.has(r.fp)) continue;
    const schema = prepareContext(session, r.profile).schema;
    const analysis = analyses.get(r.fp)!;
    const pm: ParamMapResult = paramMaps.get(r.fp) ?? {
      bindings: new Map(),
      forceNullable: new Set(),
    };
    let paramTsTypes: string[];
    let paramNullable: boolean[];
    try {
      paramTsTypes = r.paramOids.map((oid, idx) => resolveParamTs(
        idx + 1,
        r.paramNames[idx] ? `$${r.paramNames[idx]}` : `$${idx + 1}`,
        oid,
        pm.bindings,
        schema,
        userCfg,
      ));
      const explicitNullable = new Set(r.nullableParamOverrides);
      paramNullable = r.paramOids.map((_oid, idx) =>
        resolveParamNullable(idx + 1, pm, schema, explicitNullable.has(idx + 1))
      );
    } catch (e) {
      failures++;
      failedFps.add(r.fp);
      diagnostics.push({
        severity: "error",
        phase: "param-map",
        message: (e as Error).message,
        ...siteDiagnostic(r.sites[0]!),
      });
      err(`  ✗ ${formatSite(r.sites[0]!)} — parameter inference failed: ${(e as Error).message}`);
      err(`      query: ${formatQuerySnippet(r.sites[0]!.query)}`);
      continue;
    }
    let resultArrayElementNullability: ReturnType<typeof resolveResultArrayElementNullability>;
    try {
      resultArrayElementNullability = resolveResultArrayElementNullability(
        r.fields,
        schema,
        analysis.perColumnArrayElementNullability,
        r.resultElementNonNullOverrides,
      );
    } catch (error) {
      failures++;
      failedFps.add(r.fp);
      diagnostics.push({
        severity: "error",
        phase: "result-shape",
        message: (error as Error).message,
        ...siteDiagnostic(r.sites[0]!),
      });
      err(`  ✗ ${formatSite(r.sites[0]!)} — ${(error as Error).message}`);
      err(`      query: ${formatQuerySnippet(r.sites[0]!.query)}`);
      continue;
    }
    const columns: CacheEntry["columns"] = r.fields.map((f, i) => {
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
          resultArrayElementNullability[i] ?? "unknown",
        ),
        nullable: analysis.perColumnNullable[i] ?? true,
        ...(treatAsOverride ? { override: parsed.override } : {}),
      };
    });
    const entry: CacheEntry = {
      query: r.sites[0]!.query,
      ...(r.profile ? { profile: r.profile } : {}),
      validation: r.validation,
      ...siteUsage(r.sites),
      paramOids: r.paramOids.map(portableCacheOid),
      paramTypeIdentities: r.paramOids.map((oid) => {
        if (isBuiltinOid(oid)) return oid;
        const identity = schema.typeIdentity(oid);
        if (!identity) {
          throw new Error(`sqlx-js: PostgreSQL type OID ${oid} has no stable schema-qualified identity`);
        }
        return identity;
      }),
      paramTsTypes,
      paramNullable,
      nullableParamOverrides: r.nullableParamOverrides,
      resultElementNonNullOverrides: r.resultElementNonNullOverrides,
      ...(r.paramNames.length > 0 ? { paramNames: r.paramNames } : {}),
      columns,
      hasResultSet: r.hasResultSet,
      usesTimestampWithoutTimeZone: r.paramOids.some((oid) => schema.isTimestampWithoutTimeZone(oid))
        || r.fields.some((field) => schema.isTimestampWithoutTimeZone(field.typeOid))
        || paramTargetsUseTimestampWithoutTimeZone(pm, schema),
      ...(analysis.degraded ? { degraded: analysis.degraded } : {}),
      inference: {
        columns: columns.map((column, index) =>
          columnInference(
            effectiveNullable(column),
            analysis.perColumnSources[index] ?? null,
            schema,
            analysis.degraded,
            column.override,
          )
        ),
        params: paramNullable.map((nullable, index) =>
          paramInference(index + 1, nullable, pm, r.nullableParamOverrides.includes(index + 1))
        ),
      },
    };
    const entryDiagnostics = inferenceDiagnostics(entry, r.sites[0]!, opts.strictInference === true);
    const intentDiagnostics = executionIntentDiagnostics(entry, r.sites, opts.strictInference === true);
    const temporalDiagnostics = temporalPolicyDiagnostics(entry, r.sites, userCfg.temporal);
    diagnostics.push(...entryDiagnostics, ...intentDiagnostics, ...temporalDiagnostics);
    const queryDiagnostics = [...entryDiagnostics, ...intentDiagnostics, ...temporalDiagnostics];
    if (queryDiagnostics.length > 0) {
      if (reportQueryDiagnostics(queryDiagnostics, r.sites, err)) {
        failures++;
        continue;
      }
    }
    entries.push(entry);
    generated.push({ fp: r.fp, entry });
    const nn = entry.columns.filter((c) => !effectiveNullable(c)).length;
    const inferenceTag = entry.degraded ? ` [degraded: ${entry.degraded.reason}]` : "";
    const validationTag = planningValidationTag(entry.validation, r.sites);
    log(`  ✓ ${formatSite(r.sites[0]!)} → ${r.paramOids.length} param(s), ${r.fields.length} col(s) [${nn} non-null]${inferenceTag}${validationTag}`);
  }

  if (failures > 0) {
    return { sites: sites.length, entries: entries.length, failures, pruned: 0, functions: 0, enums: 0, diagnostics };
  }

  let functions: FunctionEntry[];
  if (userCfg.functionCatalog === false) {
    functions = [];
  } else {
    try {
      functions = await introspectFunctions(client, session.schema, {
        includeExtensionOwned: userCfg.functionCatalog?.includeExtensionOwned === true,
      });
    } catch (error) {
      throw fatal("introspect", error);
    }
  }
  addFunctionContractDiagnostics(functions, diagnostics, err);
  let enums: EnumCatalogEntry[] = [];
  let enumCount = 0;
  let enumModule: { path: string; content: string } | undefined;
  if (userCfg.enumCatalog) {
    if (input.reuseEnumCatalog && enumCatalogCacheExists(opts.cacheDir)) {
      enums = readEnumCatalogCache(opts.cacheDir);
    } else {
      try {
        enums = await introspectEnumCatalog(client, userCfg.enumCatalog.schemas);
      } catch (error) {
        throw fatal("introspect", error);
      }
    }
    const path = enumCatalogOutputPath(opts.root, userCfg, opts.enumOutputPath)!;
    try {
      enumModule = { path, content: renderEnumCatalog(enums, userCfg.enumCatalog) };
      enumCount = selectedEnumCatalogCount(enums, userCfg.enumCatalog);
    } catch (error) {
      throw fatal("introspect", error);
    }
  }
  let pruned: number;
  try {
    const publication = publishPrepareArtifacts({
      cacheDir: opts.cacheDir,
      dtsPath: opts.dtsPath,
      generated,
      entries,
      functions,
      enums,
      enumCatalogEnabled: userCfg.enumCatalog !== undefined,
      enumModule,
      configHash: prepareConfigHash(userCfg),
      customTypes: userCfg.customTypes,
      profiles: userCfg.profiles,
      temporal: userCfg.temporal,
      prune: opts.prune !== false,
    });
    pruned = publication.pruned;
    if (pruned > 0) log(`pruned ${pruned} orphaned cache entry/entries`);
    if (publication.enumCacheRemoved) {
      const message = "enum catalog disabled: removed its cache; delete the previous generated enum module if it is no longer used";
      diagnostics.push({ severity: "warning", phase: "cache", message });
      log(message);
    }
  } catch (error) {
    throw fatal("cache", error);
  }
  return {
    sites: sites.length,
    entries: entries.length,
    failures,
    pruned,
    functions: functions.length,
    enums: enumCount,
    diagnostics,
  };
}

export async function runPrepare(opts: PrepareOptions): Promise<void> {
  if (opts.verify) {
    const compact = opts.json || !opts.verbose;
    const verification = await verifyPrepareArtifacts(
      opts,
      compact ? () => {} : console.log,
      compact ? () => {} : console.error,
    );
    if (opts.json) {
      console.log(JSON.stringify({
        formatVersion: 1,
        ok: verification.ok,
        mode: "verify",
        ...verification.result,
        changed: verification.changed,
      }, null, 2));
    } else if (!opts.verbose) {
      reportPrepareDiagnostics(verification.result.diagnostics, opts.warnings);
      if (verification.changed.length > 0) {
        console.error("sqlx-js prepare --verify: generated artifacts are stale:");
        for (const file of verification.changed) console.error(`  ${file}`);
        console.error("Run `sqlx-js prepare` and commit the regenerated artifacts.");
      }
      const message = verification.ok
        ? `verified ${formatPrepareTotals(verification.result)}; `
          + `${formatPrepareDiagnosticCounts(verification.result.diagnostics)}; generated artifacts are current`
        : `verify failed — prepared ${formatPrepareTotals(verification.result)}; `
          + formatPrepareDiagnosticCounts(verification.result.diagnostics);
      (verification.ok ? console.log : console.error)(
        withOutputHints(message, verification.result.diagnostics, opts.warnings),
      );
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
    try {
      assertDistinctEnumCatalogOutput(opts.root, userCfg, opts.dtsPath, opts.enumOutputPath);
    } catch (error) {
      throw fatal("config", error);
    }
    let sites: QueryCallSite[];
    try {
      sites = scanProject(opts.root, userCfg.scan, userCfg.profiles ?? {});
    } catch (error) {
      throw fatal("scan", error);
    }
    if (!opts.json && opts.verbose) console.log(`scanned: found ${sites.length} sql() call site(s)`);
    const cache = new Cache(opts.cacheDir);
    try {
      assertCacheManifest(opts.cacheDir, prepareConfigHash(userCfg));
    } catch (error) {
      throw fatal("cache", error);
    }
    const unique = new Map<string, {
      fp: string;
      profile?: string;
      query: string;
      sites: QueryCallSite[];
    }>();
    for (const s of expandProfileSites(sites)) {
      const fp = siteCacheKey(s);
      const existing = unique.get(fp);
      if (existing) existing.sites.push(s);
      else unique.set(fp, { fp, profile: siteProfile(s), query: s.query, sites: [s] });
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
        if (!opts.json && opts.verbose) {
          console.error(`stale: ${formatSite(site)} — query not in cache`);
          console.error(`       query: ${formatQuerySnippet(query)}`);
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
          enums: 0,
          diagnostics,
        }, null, 2));
      } else if (!opts.verbose) {
        reportPrepareDiagnostics(diagnostics, opts.warnings);
        console.error(
          `${mode} failed — ${formatQueryTotals(
            sites.length,
            [...unique.keys()].filter((fp) => cache.has(fp)).length,
          )}; `
          + withOutputHints(formatPrepareDiagnosticCounts(diagnostics), diagnostics, opts.warnings),
        );
      } else {
        console.error(`\nsqlx-js prepare --${mode}: ${diagnostics.length} stale/missing entries. Run \`sqlx-js prepare\` against a live DB.`);
      }
      process.exitCode = 1;
      return;
    }
    const entries: CacheEntry[] = [];
    let inferenceFailures = 0;
    let functions: FunctionEntry[];
    let enums: EnumCatalogEntry[] = [];
    let enumCount = 0;
    const enumOutput = enumCatalogOutputPath(opts.root, userCfg, opts.enumOutputPath);
    try {
      for (const u of unique.values()) {
        const entry = cache.read(u.fp);
        if (!entry) continue;
        if (entry.profile !== u.profile) {
          diagnostics.push({
            severity: "error",
            phase: "cache",
            message: "cache entry profile does not match the scanned connection profile; run live `sqlx-js prepare`",
            ...siteDiagnostic(u.sites[0]!),
          });
          inferenceFailures++;
          continue;
        }
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
        const nullableParamOverrides = collectNullableParamOverrides(u.sites);
        if (!sameNullableParamOverrides(entry.nullableParamOverrides, nullableParamOverrides)) {
          diagnostics.push({
            severity: "error",
            phase: "cache",
            message: "source nullable parameter contract changed; run live `sqlx-js prepare`",
            ...siteDiagnostic(u.sites[0]!),
          });
          inferenceFailures++;
          continue;
        }
        const resultElementNonNullOverrides = collectResultElementNonNullOverrides(u.sites);
        if (!sameResultElementNonNullOverrides(
          entry.resultElementNonNullOverrides,
          resultElementNonNullOverrides,
        )) {
          diagnostics.push({
            severity: "error",
            phase: "cache",
            message: "source result assertion contract changed; run live `sqlx-js prepare`",
            ...siteDiagnostic(u.sites[0]!),
          });
          inferenceFailures++;
          continue;
        }
        const current = { ...entry, ...siteUsage(u.sites) };
        const entryDiagnostics = inferenceDiagnostics(current, u.sites[0]!, opts.strictInference === true);
        const intentDiagnostics = executionIntentDiagnostics(current, u.sites, opts.strictInference === true);
        const temporalDiagnostics = temporalPolicyDiagnostics(current, u.sites, userCfg.temporal);
        diagnostics.push(...entryDiagnostics, ...intentDiagnostics, ...temporalDiagnostics);
        const planIssues = planningDiagnostics(current.validation, u.sites, opts.strictInference === true);
        diagnostics.push(...planIssues);
        if (
          (opts.strictInference && entryDiagnostics.length > 0)
          || intentDiagnostics.some((diagnostic) => diagnostic.severity === "error")
          || temporalDiagnostics.some((diagnostic) => diagnostic.severity === "error")
          || planIssues.some((diagnostic) => diagnostic.severity === "error")
        ) {
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
      addFunctionContractDiagnostics(functions, diagnostics);
      if (userCfg.enumCatalog) {
        if (enumCatalogCacheExists(opts.cacheDir)) {
          enums = readEnumCatalogCache(opts.cacheDir);
          enumCount = selectedEnumCatalogCount(enums, userCfg.enumCatalog);
        } else {
          diagnostics.push({
            severity: "error",
            phase: "cache",
            message: "enum catalog cache is missing",
          });
          inferenceFailures++;
        }
      } else if (enumCatalogCacheExists(opts.cacheDir)) {
        diagnostics.push({
          severity: "error",
          phase: "cache",
          message: "enum catalog cache exists but enumCatalog is disabled; run live `sqlx-js prepare`",
        });
        inferenceFailures++;
      }
      if (opts.check && inferenceFailures === 0) {
        const tmp = mkdtempSync(join(tmpdir(), "sqlx-js-check-"));
        const generatedDts = join(tmp, "sqlx-js-env.d.ts");
        try {
          emitDts(
            generatedDts,
            entries,
            functions,
            userCfg.customTypes,
            userCfg.profiles,
            userCfg.temporal,
          );
          if (!existsSync(opts.dtsPath) || readFileSync(opts.dtsPath, "utf8") !== readFileSync(generatedDts, "utf8")) {
            diagnostics.push({
              severity: "error",
              phase: "cache",
              message: "generated declaration is stale or missing",
              file: relative(opts.root, opts.dtsPath).replace(/\\/g, "/"),
            });
            inferenceFailures++;
          }
          const expectedDescriptors = renderRuntimeDescriptors(
            entries,
            prepareConfigHash(userCfg),
            userCfg.profiles,
            userCfg.temporal,
          );
          const descriptorPath = runtimeDescriptorPath(opts.cacheDir);
          if (!existsSync(descriptorPath) || readFileSync(descriptorPath, "utf8") !== expectedDescriptors) {
            diagnostics.push({
              severity: "error",
              phase: "cache",
              message: "generated runtime descriptor is stale or missing",
              file: relative(opts.root, descriptorPath).replace(/\\/g, "/"),
            });
            inferenceFailures++;
          }
          if (enumOutput) {
            const generatedEnums = renderEnumCatalog(enums, userCfg.enumCatalog);
            if (!existsSync(enumOutput) || readFileSync(enumOutput, "utf8") !== generatedEnums) {
              diagnostics.push({
                severity: "error",
                phase: "cache",
                message: "generated enum catalog is stale or missing",
                file: relative(opts.root, enumOutput).replace(/\\/g, "/"),
              });
              inferenceFailures++;
            }
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
            enums: enumCount,
            diagnostics,
          }, null, 2));
        } else if (!opts.verbose) {
          reportPrepareDiagnostics(diagnostics, opts.warnings);
          console.error(
            `${mode} failed — ${formatQueryTotals(sites.length, entries.length)}; `
            + withOutputHints(formatPrepareDiagnosticCounts(diagnostics), diagnostics, opts.warnings),
          );
        } else {
          for (const diagnostic of diagnostics) {
            if (diagnostic.severity === "warning") {
              console.error(formatPrepareDiagnostic(diagnostic));
              continue;
            }
            const location = diagnostic.file
              ? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}:${diagnostic.column ?? 1}` : ""} — `
              : "";
            console.error(`${diagnostic.phase} failed: ${location}${diagnostic.message}`);
          }
        }
        process.exitCode = 1;
        return;
      }
      if (opts.offline) {
        publishOfflinePrepareArtifacts({
          cacheDir: opts.cacheDir,
          dtsPath: opts.dtsPath,
          entries,
          functions,
          enumModule: enumOutput
            ? { path: enumOutput, content: renderEnumCatalog(enums, userCfg.enumCatalog) }
            : undefined,
          configHash: prepareConfigHash(userCfg),
          customTypes: userCfg.customTypes,
          profiles: userCfg.profiles,
          temporal: userCfg.temporal,
        });
      }
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
        enums: enumCount,
        diagnostics,
      }, null, 2));
    } else if (!opts.verbose) {
      reportPrepareDiagnostics(diagnostics, opts.warnings);
      const suffix = opts.offline ? "generated files regenerated" : "generated artifacts are current";
      console.log(
        `ok — ${formatPrepareTotals({
          sites: sites.length,
          entries: entries.length,
          functions: functions.length,
          enums: enumCount,
        })}; `
        + withOutputHints(`${formatPrepareDiagnosticCounts(diagnostics)}; ${suffix}`, diagnostics, opts.warnings),
      );
    } else {
      for (const diagnostic of diagnostics) {
        console.error(formatPrepareDiagnostic(diagnostic));
      }
      const suffix = opts.offline ? ", generated files regenerated" : ", generated artifacts are current";
      console.log(`ok — ${entries.length} unique queries, ${functions.length} function(s), ${enumCount} enum(s)${suffix}`);
    }
    return;
  }

  const session = await openSession(opts);
  try {
    const compact = opts.json || !opts.verbose;
    const r = await prepareOnce(
      opts,
      session,
      compact ? () => {} : console.log,
      compact ? () => {} : console.error,
    );
    if (opts.json) {
      console.log(JSON.stringify({ formatVersion: 1, ok: r.failures === 0, mode: "prepare", ...r }, null, 2));
    } else if (!opts.verbose) {
      reportPrepareDiagnostics(r.diagnostics, opts.warnings);
    }
    if (r.failures > 0) {
      if (!opts.json && !opts.verbose) {
        console.error(
          withOutputHints(
            `prepare failed — ${formatPrepareTotals(r)}; ${formatPrepareDiagnosticCounts(r.diagnostics)}`,
            r.diagnostics,
            opts.warnings,
          ),
        );
      } else if (!opts.json) {
        console.error(`\n${r.failures} query/queries failed to prepare`);
      }
      process.exitCode = 1;
      return;
    }
    if (!opts.json && !opts.verbose) {
      const enumOutput = enumCatalogOutputPath(opts.root, session.userCfg, opts.enumOutputPath);
      console.log(
        withOutputHints(
          `prepared ${formatPrepareTotals(r)}; `
          + `${formatPrepareDiagnosticCounts(r.diagnostics)} → ${opts.dtsPath}`
          + `${enumOutput ? `, ${enumOutput}` : ""}`,
          r.diagnostics,
          opts.warnings,
        ),
      );
    } else if (!opts.json) {
      const enumOutput = enumCatalogOutputPath(opts.root, session.userCfg, opts.enumOutputPath);
      console.log(
        `\nprepared ${r.entries} unique query/queries, ${r.functions} function(s), ${r.enums} enum(s) `
        + `→ ${opts.dtsPath}${enumOutput ? `, ${enumOutput}` : ""}`,
      );
    }
  } finally {
    await closePrepareSession(session);
  }
}

export async function writePrepareArtifacts(
  opts: PrepareOptions,
  log: (msg: string) => void = console.log,
  err: (msg: string) => void = console.error,
): Promise<boolean> {
  const session = await openSession(opts);
  try {
    const result = await prepareOnce(opts, session, log, err);
    if (result.failures > 0) {
      err(`\n${result.failures} query/queries failed to prepare`);
      return false;
    }
    const enumOutput = enumCatalogOutputPath(opts.root, session.userCfg, opts.enumOutputPath);
    log(
      `\nprepared ${result.entries} unique query/queries, ${result.functions} function(s), ${result.enums} enum(s) `
      + `→ ${opts.dtsPath}${enumOutput ? `, ${enumOutput}` : ""}`,
    );
    return true;
  } finally {
    await closePrepareSession(session);
  }
}

export type VerifyPrepareMessages = {
  command: string;
  regenerateCommand: string;
};

export async function verifyPrepareArtifacts(
  opts: PrepareOptions,
  log: (msg: string) => void = console.log,
  err: (msg: string) => void = console.error,
  messages: VerifyPrepareMessages = {
    command: "sqlx-js prepare --verify",
    regenerateCommand: "sqlx-js prepare",
  },
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
    session = await openSession(opts);
    const expectedEnumOutput = enumCatalogOutputPath(opts.root, session.userCfg, opts.enumOutputPath);
    const generatedEnumOutput = expectedEnumOutput ? join(tmp, "sqlx-js-enums.ts") : undefined;
    verifyOpts.enumOutputPath = generatedEnumOutput;
    const result = await prepareOnce(verifyOpts, session, log, err);
    if (result.failures > 0) {
      err(`\n${result.failures} query/queries failed to prepare`);
      return { ok: false, result, changed: [] };
    }
    let comparison: ReturnType<typeof compareArtifacts>;
    try {
      comparison = compareArtifacts(
        {
          cacheDir: opts.cacheDir,
          dtsPath: opts.dtsPath,
          enumOutputPath: expectedEnumOutput,
          enumArtifactName: expectedEnumOutput
            ? relative(opts.root, expectedEnumOutput).replace(/\\/g, "/")
            : undefined,
        },
        {
          cacheDir,
          dtsPath,
          enumOutputPath: generatedEnumOutput,
          enumArtifactName: expectedEnumOutput
            ? relative(opts.root, expectedEnumOutput).replace(/\\/g, "/")
            : undefined,
        },
      );
    } catch (error) {
      throw fatal("verify", error);
    }
    if (!comparison.ok) {
      err(`${messages.command}: generated artifacts are stale:`);
      for (const file of comparison.changed) err(`  ${file}`);
      err(`Run \`${messages.regenerateCommand}\` and commit the regenerated artifacts.`);
      return { ok: false, result, changed: comparison.changed };
    }
    log(
      `verified ${result.entries} query/queries, ${result.functions} function(s), and ${result.enums} enum(s); `
      + "generated artifacts are current",
    );
    return { ok: true, result, changed: [] };
  } finally {
    if (session) await closePrepareSession(session);
    rmSync(tmp, { recursive: true, force: true });
  }
}
