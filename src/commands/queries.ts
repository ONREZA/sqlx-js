import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import {
  Cache,
  CacheManifestStaleError,
  effectiveNullable,
  profileFingerprint,
  readCacheManifest,
  type CacheEntry,
} from "../cache";
import { loadConfig, prepareConfigHash, type SqlxJsConfig } from "../config";
import { queryId } from "../query-id";
import type { QueryExecutionMode } from "../query";
import {
  nullableParamOverrides as collectNullableParamOverrides,
  resultElementNonNullOverrides as collectResultElementNonNullOverrides,
  sameNullableParamOverrides,
  sameResultElementNonNullOverrides,
} from "../query-source-intent";
import type { QueryResultAssertions } from "../query";
import { ScanError, scanProject, type QueryCallSite } from "../scan/scanner";

export type QueriesPhase = "config" | "scan" | "cache" | "embed" | "explain" | "audit" | "similarity" | "functions";

export class QueriesError extends Error {
  constructor(
    public readonly phase: QueriesPhase,
    message: string,
    public readonly file?: string,
    public readonly line?: number,
    public readonly column?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "QueriesError";
  }
}

function queriesError(phase: QueriesPhase, error: unknown): QueriesError {
  if (error instanceof QueriesError) return error;
  if (error instanceof ScanError) {
    return new QueriesError(phase, error.message, error.file, error.line, error.column, { cause: error });
  }
  return new QueriesError(
    phase,
    error instanceof Error ? error.message : String(error),
    undefined,
    undefined,
    undefined,
    { cause: error },
  );
}

export async function loadQuerySources(root: string): Promise<{
  config: SqlxJsConfig;
  sites: QueryCallSite[];
}> {
  let config: SqlxJsConfig;
  try {
    config = await loadConfig(root);
  } catch (error) {
    throw queriesError("config", error);
  }
  try {
    return {
      config,
      sites: scanProject(root, config.scan, config.profiles ?? {}),
    };
  } catch (error) {
    throw queriesError("scan", error);
  }
}

export type QueryInventoryItem = {
  queryId: string;
  queryNames: string[];
  query: string;
  profiles: string[];
  cardinalities: QueryExecutionMode[];
  sqlFilePaths: string[];
  callSites: {
    file: string;
    line: number;
    column: number;
    profiles: string[];
    nullableParams?: number[];
    expectedValidation?: "parse-only";
    resultAssertions?: QueryResultAssertions;
    timestampWithoutTimeZone?: "allow" | "reject";
    temporalReason?: string;
  }[];
  nullableParamOverrides: number[];
  resultAssertions: QueryResultAssertions;
  expectedValidation: "parse-only" | "mixed" | null;
  cacheStatus: "current" | "stale" | "missing";
  validation: "planned" | "parse-only" | null;
};

export type QueryInventory = {
  formatVersion: 1;
  ok: true;
  queries: QueryInventoryItem[];
  orphanedCacheIds: string[];
};

export type QueryExplanation = {
  formatVersion: 1;
  ok: true;
  query: QueryInventoryItem;
  contracts: {
    profile: string | null;
    resultAssertions: QueryResultAssertions;
    params: {
      name: string;
      type: string;
      nullable: boolean;
      targets: CacheEntry["inference"]["params"][number]["targets"];
      reason: string;
      hint?: string;
    }[];
    columns: {
      name: string;
      type: string;
      nullable: boolean;
      sources: CacheEntry["inference"]["columns"][number]["sources"];
      reason: string;
      hint?: string;
    }[];
  }[];
};

function resultAssertionsForColumns(columns: readonly string[]): QueryResultAssertions {
  return Object.fromEntries(columns.map((column) => [column, { elements: "non-null" as const }]));
}

export async function buildQueryInventory(root: string, cacheDir: string): Promise<QueryInventory> {
  const { config, sites } = await loadQuerySources(root);
  const cache = new Cache(cacheDir);
  let manifestCurrent = false;
  try {
    const manifest = readCacheManifest(cacheDir);
    manifestCurrent = manifest?.configHash === prepareConfigHash(config);
  } catch (error) {
    if (!(error instanceof CacheManifestStaleError)) {
      throw queriesError("cache", error);
    }
    manifestCurrent = false;
  }

  let cacheEntries: ReturnType<Cache["list"]>;
  try {
    cacheEntries = cache.list();
  } catch (error) {
    throw queriesError("cache", error);
  }
  const cached = new Map(cacheEntries.map(({ fp, entry }) => [fp, entry]));
  const grouped = new Map<string, typeof sites>();
  for (const site of sites) {
    const id = queryId(site.query);
    const group = grouped.get(id) ?? [];
    group.push(site);
    grouped.set(id, group);
  }
  const queries = [...grouped.entries()].map(([id, group]): QueryInventoryItem => {
    const profiles = [...new Set(group.flatMap((site) => site.profiles ?? []))].sort();
    const cacheProfiles: (string | undefined)[] = [
      ...(group.some((site) => !site.profiles || site.profiles.length === 0) ? [undefined] : []),
      ...profiles,
    ];
    const cachedEntries = cacheProfiles.map((profile) => ({
      profile,
      entry: cached.get(profileFingerprint(profile, group[0]!.query)),
      sites: group.filter((site) => profile === undefined
        ? !site.profiles || site.profiles.length === 0
        : site.profiles?.includes(profile)),
    }));
    const presentEntries = cachedEntries.flatMap(({ entry }) => entry ? [entry] : []);
    const nullableParamOverrides = collectNullableParamOverrides(group);
    const resultAssertions = resultAssertionsForColumns(collectResultElementNonNullOverrides(group));
    const cacheStatus = presentEntries.length !== cacheProfiles.length
      ? "missing"
      : manifestCurrent && cachedEntries.every(({ entry, sites: profileSites }) =>
        entry?.validation
        && sameNullableParamOverrides(entry.nullableParamOverrides, collectNullableParamOverrides(profileSites))
        && sameResultElementNonNullOverrides(
          entry.resultElementNonNullOverrides,
          collectResultElementNonNullOverrides(profileSites),
        )
      )
        ? "current"
        : "stale";
    const validation = presentEntries.length === 0 || presentEntries.some((entry) => !entry.validation)
      ? null
      : presentEntries.every((entry) => entry.validation === "planned")
        ? "planned"
        : "parse-only";
    return {
      queryId: id,
      queryNames: [...new Set(group.flatMap((site) => site.queryName ? [site.queryName] : []))].sort(),
      query: group[0]!.query,
      profiles,
      cardinalities: [...new Set(group.map((site) => site.cardinality ?? "many"))].sort(),
      sqlFilePaths: [...new Set(group.flatMap((site) => site.sqlFilePath ? [site.sqlFilePath] : []))].sort(),
      callSites: group
        .map((site) => ({
          file: site.file,
          line: site.line,
          column: site.column,
          profiles: site.profiles ?? [],
          ...(site.nullableParams ? { nullableParams: site.nullableParams } : {}),
          ...(site.expectedValidation ? { expectedValidation: site.expectedValidation } : {}),
          ...(site.resultAssertions ? { resultAssertions: site.resultAssertions } : {}),
          ...(site.timestampWithoutTimeZone
            ? { timestampWithoutTimeZone: site.timestampWithoutTimeZone }
            : {}),
          ...(site.temporalReason ? { temporalReason: site.temporalReason } : {}),
        }))
        .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column),
      nullableParamOverrides,
      resultAssertions,
      expectedValidation: group.some((site) => site.expectedValidation === "parse-only")
        ? group.every((site) => site.expectedValidation === "parse-only") ? "parse-only" : "mixed"
        : null,
      cacheStatus,
      validation,
    };
  }).sort((a, b) => a.queryId.localeCompare(b.queryId));
  const active = new Set(sites.flatMap((site) =>
    site.profiles && site.profiles.length > 0
      ? site.profiles.map((profile) => profileFingerprint(profile, site.query))
      : [profileFingerprint(undefined, site.query)]
  ));
  const orphanedCacheIds = cacheEntries.map(({ fp }) => fp).filter((fp) => !active.has(fp)).sort();
  return { formatVersion: 1, ok: true, queries, orphanedCacheIds };
}

export async function buildQueryExplanation(
  root: string,
  cacheDir: string,
  id: string,
): Promise<QueryExplanation> {
  if (!/^[0-9a-f]{16}$/.test(id)) {
    throw new QueriesError("explain", `query ID must be 16 lowercase hexadecimal characters, got ${JSON.stringify(id)}`);
  }
  const inventory = await buildQueryInventory(root, cacheDir);
  const query = inventory.queries.find((item) => item.queryId === id);
  if (!query) throw new QueriesError("explain", `query ${id} was not found in the scanned project`);
  if (query.cacheStatus !== "current") {
    throw new QueriesError(
      "explain",
      `query ${id} has ${query.cacheStatus} inference artifacts. Run \`sqlx-js prepare\``,
    );
  }
  const cache = new Cache(cacheDir);
  const profiles: (string | undefined)[] = [
    ...(query.callSites.some((site) => site.profiles.length === 0) ? [undefined] : []),
    ...query.profiles,
  ];
  const contracts = profiles.map((profile) => {
    const entry = cache.read(profileFingerprint(profile, query.query));
    if (!entry) {
      throw new QueriesError(
        "explain",
        `query ${id} is missing inference explanations. Run \`sqlx-js prepare\``,
      );
    }
    const inference = entry.inference;
    return {
      profile: profile ?? null,
      resultAssertions: resultAssertionsForColumns(entry.resultElementNonNullOverrides),
      params: entry.paramTsTypes.map((type, index) => ({
        name: entry.paramNames?.[index] ?? `$${index + 1}`,
        type,
        nullable: entry.paramNullable[index]!,
        targets: inference.params[index]!.targets,
        reason: inference.params[index]!.reason,
        ...(inference.params[index]!.hint ? { hint: inference.params[index]!.hint } : {}),
      })),
      columns: entry.columns.map((column, index) => ({
        name: column.name,
        type: column.tsType,
        nullable: effectiveNullable(column),
        sources: inference.columns[index]!.sources,
        reason: inference.columns[index]!.reason,
        ...(inference.columns[index]!.hint ? { hint: inference.columns[index]!.hint } : {}),
      })),
    };
  });
  return { formatVersion: 1, ok: true, query, contracts };
}

export function emitEmbeddedSqlModule(path: string, inventory: QueryInventory): void {
  const sqlFiles = Object.fromEntries(
    inventory.queries
      .flatMap((query) => query.sqlFilePaths.map((file) => [file, query.query] as const))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const content = [
    "// AUTO-GENERATED by sqlx-js. Do not edit.",
    "// Run `sqlx-js queries --embed <path>` to regenerate.",
    "",
    `export const sqlxJsEmbeddedSql = ${JSON.stringify(sqlFiles, null, 2)} as const;`,
    "",
  ].join("\n");
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, content);
  try {
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch {}
    throw error;
  }
}

export async function runQueries(options: {
  root: string;
  cacheDir: string;
  json?: boolean;
  embedPath?: string;
  explainQueryId?: string;
}): Promise<void> {
  if (options.explainQueryId) {
    const explanation = await buildQueryExplanation(options.root, options.cacheDir, options.explainQueryId);
    if (options.json) {
      console.log(JSON.stringify(explanation, null, 2));
      return;
    }
    console.log(`${explanation.query.queryId} ${explanation.query.cardinalities.join(",")} ${explanation.query.validation}`);
    for (const site of explanation.query.callSites) console.log(`  site: ${site.file}:${site.line}:${site.column}`);
    for (const contract of explanation.contracts) {
      console.log(`  profile: ${contract.profile ?? "default"}`);
      for (const param of contract.params) {
        console.log(`    parameter ${param.name}: ${param.type}${param.nullable ? " | null" : ""}`);
        for (const target of param.targets) {
          const column = target.column ?? (target.columnIndex ? `#${target.columnIndex}` : "?");
          console.log(`      ${target.kind}: ${target.schema ? `${target.schema}.` : ""}${target.table}.${column}`);
        }
        console.log(`      reason: ${param.reason}`);
        if (param.hint) console.log(`      hint: ${param.hint}`);
      }
      for (const column of contract.columns) {
        console.log(`    result ${column.name}: ${column.type}${column.nullable ? " | null" : ""}`);
        const resultAssertion = Object.hasOwn(contract.resultAssertions, column.name)
          ? contract.resultAssertions[column.name]
          : undefined;
        if (resultAssertion) console.log(`      assertion: elements ${resultAssertion.elements}`);
        for (const source of column.sources ?? []) {
          const constraint = source.notNull === undefined ? "" : source.notNull ? " NOT NULL" : " nullable";
          console.log(`      source: ${source.schema}.${source.table}.${source.column}${constraint}`);
        }
        console.log(`      reason: ${column.reason}`);
        if (column.hint) console.log(`      hint: ${column.hint}`);
      }
    }
    return;
  }
  const inventory = await buildQueryInventory(options.root, options.cacheDir);
  if (options.embedPath) {
    try {
      emitEmbeddedSqlModule(options.embedPath, inventory);
    } catch (error) {
      throw queriesError("embed", error);
    }
  }
  if (options.json) {
    console.log(JSON.stringify({
      ...inventory,
      ...(options.embedPath ? { embeddedModule: relative(options.root, options.embedPath).replace(/\\/g, "/") } : {}),
    }, null, 2));
    return;
  }
  for (const query of inventory.queries) {
    const names = query.queryNames.length > 0 ? ` ${query.queryNames.join(",")}` : "";
    const validation = query.validation ? ` ${query.validation}` : "";
    const expectedValidation = query.expectedValidation ? ` expected=${query.expectedValidation}` : "";
    const nullableParams = query.nullableParamOverrides.length > 0
      ? ` nullableParams=${query.nullableParamOverrides.join(",")}`
      : "";
    const resultAssertions = Object.keys(query.resultAssertions).length > 0
      ? ` resultAssertions=${Object.keys(query.resultAssertions)
        .map((column) => `${column}.elements:non-null`)
        .join(",")}`
      : "";
    const profiles = query.profiles.length > 0 ? ` profiles=${query.profiles.join(",")}` : "";
    console.log(
      `${query.queryId}${names} ${query.cardinalities.join(",")} ${query.cacheStatus}${validation}`
      + `${expectedValidation}${nullableParams}${resultAssertions}${profiles}`,
    );
    for (const site of query.callSites) console.log(`  ${site.file}:${site.line}:${site.column}`);
  }
  if (inventory.queries.length === 0) console.log("no sqlx-js queries found");
  if (inventory.orphanedCacheIds.length > 0) console.log(`orphaned cache: ${inventory.orphanedCacheIds.join(", ")}`);
  if (options.embedPath) console.log(`embedded SQL module: ${relative(options.root, options.embedPath).replace(/\\/g, "/")}`);
}
