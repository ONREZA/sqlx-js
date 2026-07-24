import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { Cache, CacheManifestStaleError, profileFingerprint, readCacheManifest } from "../cache";
import { loadConfig, prepareConfigHash } from "../config";
import { queryId } from "../query-id";
import type { QueryExecutionMode } from "../query";
import { ScanError, scanProject } from "../scan/scanner";

export type QueriesPhase = "config" | "scan" | "cache" | "embed";

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

export type QueryInventoryItem = {
  queryId: string;
  queryNames: string[];
  query: string;
  profiles: string[];
  cardinalities: QueryExecutionMode[];
  sqlFilePaths: string[];
  callSites: { file: string; line: number; column: number; profiles: string[] }[];
  cacheStatus: "current" | "stale" | "missing";
  validation: "planned" | "parse-only" | null;
};

export type QueryInventory = {
  formatVersion: 1;
  ok: true;
  queries: QueryInventoryItem[];
  orphanedCacheIds: string[];
};

export async function buildQueryInventory(root: string, cacheDir: string): Promise<QueryInventory> {
  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = await loadConfig(root);
  } catch (error) {
    throw queriesError("config", error);
  }
  let sites: ReturnType<typeof scanProject>;
  try {
    sites = scanProject(root, config.scan, config.profiles ?? {});
  } catch (error) {
    throw queriesError("scan", error);
  }
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
    const cacheProfiles = profiles.length > 0 ? profiles : [undefined];
    const cachedEntries = cacheProfiles.map((profile) => cached.get(profileFingerprint(profile, group[0]!.query)));
    const presentEntries = cachedEntries.filter((entry) => entry !== undefined);
    const cacheStatus = presentEntries.length !== cacheProfiles.length
      ? "missing"
      : manifestCurrent && presentEntries.every((entry) => entry.validation)
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
        .map(({ file, line, column, profiles: siteProfiles }) => ({
          file,
          line,
          column,
          profiles: siteProfiles ?? [],
        }))
        .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column),
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
}): Promise<void> {
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
    const profiles = query.profiles.length > 0 ? ` profiles=${query.profiles.join(",")}` : "";
    console.log(`${query.queryId}${names} ${query.cardinalities.join(",")} ${query.cacheStatus}${validation}${profiles}`);
    for (const site of query.callSites) console.log(`  ${site.file}:${site.line}:${site.column}`);
  }
  if (inventory.queries.length === 0) console.log("no sqlx-js queries found");
  if (inventory.orphanedCacheIds.length > 0) console.log(`orphaned cache: ${inventory.orphanedCacheIds.join(", ")}`);
  if (options.embedPath) console.log(`embedded SQL module: ${relative(options.root, options.embedPath).replace(/\\/g, "/")}`);
}
