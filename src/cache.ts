import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { isBuiltinOid } from "./pg/oids";
import { queryId } from "./query-id";
import { rewriteNamedParameters } from "./sql-params";

export const CACHE_FORMAT_VERSION = 3;
export const GENERATOR_REVISION = 16;
export const CACHE_MANIFEST_FILE = "cache-manifest.json";

export class CacheManifestStaleError extends Error {
  constructor(path: string) {
    super(`sqlx-js: cache manifest is stale: ${path}. Run \`sqlx-js prepare\`.`);
    this.name = "CacheManifestStaleError";
  }
}

export type CacheManifest = {
  cacheFormat: typeof CACHE_FORMAT_VERSION;
  generatorRevision: typeof GENERATOR_REVISION;
  configHash: string;
};

export type CacheColumn = {
  name: string;
  typeOid: number;
  tsType: string;
  nullable: boolean;
  override?: "non-null" | "nullable";
};

export type CacheEntry = {
  query: string;
  profile?: string;
  validation?: "planned" | "parse-only";
  inlineQueries?: string[];
  paramOids: number[];
  paramTsTypes: string[];
  paramNullable?: boolean[];
  paramNames?: string[];
  columns: CacheColumn[];
  hasResultSet: boolean;
  hasInline?: boolean;
  filePaths?: string[];
  degraded?: { reason: string };
};

export function portableCacheOid(oid: number): number {
  return isBuiltinOid(oid) ? oid : 0;
}

export function fingerprint(query: string): string {
  return queryId(query);
}

export function profileFingerprint(profile: string | undefined, query: string): string {
  if (!profile) return fingerprint(query);
  return createHash("sha256")
    .update(profile)
    .update("\0")
    .update(fingerprint(query))
    .digest("hex")
    .slice(0, 16);
}


export function effectiveNullable(c: CacheColumn): boolean {
  if (c.override === "non-null") return false;
  if (c.override === "nullable") return true;
  return c.nullable;
}

function parseEntryJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`sqlx-js: cannot read cache entry ${path}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`sqlx-js: cache entry ${path} is not valid JSON: ${(err as Error).message}`);
  }
}

function assertEntryShape(fp: string, raw: unknown): CacheEntry {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { columns?: unknown }).columns)) {
    throw new Error(`sqlx-js: cache entry ${fp}.json is malformed`);
  }
  const cols = (raw as { columns: unknown[] }).columns;
  const entry = raw as Record<string, unknown>;
  if (entry.validation !== undefined && entry.validation !== "planned" && entry.validation !== "parse-only") {
    throw new Error(`sqlx-js: cache entry ${fp}.json has invalid validation metadata. Run \`sqlx-js prepare\`.`);
  }
  if (entry.profile !== undefined && (typeof entry.profile !== "string" || entry.profile.trim() === "")) {
    throw new Error(`sqlx-js: cache entry ${fp}.json has invalid profile metadata. Run \`sqlx-js prepare\`.`);
  }
  let expectedNames: string[];
  try {
    if (typeof entry.query !== "string") throw new Error("query must be a string");
    expectedNames = rewriteNamedParameters(entry.query).names;
  } catch {
    throw new Error(`sqlx-js: cache entry ${fp}.json has malformed named parameter metadata. Run \`sqlx-js prepare\`.`);
  }
  if (entry.paramNames !== undefined || expectedNames.length > 0) {
    if (
      !Array.isArray(entry.paramNames) ||
      !entry.paramNames.every((name) => typeof name === "string") ||
      !Array.isArray(entry.paramTsTypes) ||
      entry.paramNames.length !== entry.paramTsTypes.length ||
      new Set(entry.paramNames).size !== entry.paramNames.length ||
      entry.paramNames.length !== expectedNames.length ||
      entry.paramNames.some((name, index) => name !== expectedNames[index])
    ) {
      throw new Error(`sqlx-js: cache entry ${fp}.json has malformed named parameter metadata. Run \`sqlx-js prepare\`.`);
    }
  }
  if (cols.length > 0) {
    const c = cols[0] as Record<string, unknown>;
    if ("forceNonNull" in c || "forceNullable" in c) {
      throw new Error(
        `sqlx-js: cache entry ${fp}.json uses an older schema ` +
        `(columns.forceNonNull/forceNullable). Re-run \`sqlx-js prepare\` to regenerate.`,
      );
    }
  }
  return raw as CacheEntry;
}

export class Cache {
  constructor(private dir: string) {}

  ensure(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  has(fp: string): boolean {
    return existsSync(join(this.dir, `${fp}.json`));
  }

  read(fp: string): CacheEntry | null {
    const p = join(this.dir, `${fp}.json`);
    if (!existsSync(p)) return null;
    return assertEntryShape(fp, parseEntryJson(p));
  }

  write(fp: string, entry: CacheEntry): void {
    this.ensure();
    const final = join(this.dir, `${fp}.json`);
    const tmp = `${final}.tmp-${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(entry, null, 2));
    try {
      renameSync(tmp, final);
    } catch (err) {
      try { unlinkSync(tmp); } catch {}
      throw err;
    }
  }

  replaceAll(entries: Iterable<{ fp: string; entry: CacheEntry }>, prune = true): string[] {
    this.ensure();
    const staged: { fp: string; tmp: string; final: string }[] = [];
    try {
      for (const { fp, entry } of entries) {
        const final = join(this.dir, `${fp}.json`);
        const tmp = `${final}.tmp-${randomBytes(4).toString("hex")}`;
        writeFileSync(tmp, JSON.stringify(entry, null, 2));
        staged.push({ fp, tmp, final });
      }
      for (const item of staged) renameSync(item.tmp, item.final);
    } catch (err) {
      for (const item of staged) {
        try { unlinkSync(item.tmp); } catch {}
      }
      throw err;
    }
    return prune ? this.prune(staged.map((item) => item.fp)) : [];
  }

  list(): { fp: string; entry: CacheEntry }[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f !== CACHE_MANIFEST_FILE && f.endsWith(".json") && !f.includes(".tmp-"))
      .map((f) => {
        const fp = f.replace(/\.json$/, "");
        return { fp, entry: assertEntryShape(fp, parseEntryJson(join(this.dir, f))) };
      });
  }

  remove(fp: string): void {
    const p = join(this.dir, `${fp}.json`);
    if (existsSync(p)) unlinkSync(p);
  }

  prune(keep: Iterable<string>): string[] {
    const keepSet = new Set(keep);
    const removed: string[] = [];
    for (const { fp } of this.list()) {
      if (!keepSet.has(fp)) {
        this.remove(fp);
        removed.push(fp);
      }
    }
    return removed;
  }
}

export function cacheManifestPath(cacheDir: string): string {
  return join(cacheDir, CACHE_MANIFEST_FILE);
}

export function writeCacheManifest(cacheDir: string, configHash: string): void {
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const path = cacheManifestPath(cacheDir);
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  const manifest: CacheManifest = {
    cacheFormat: CACHE_FORMAT_VERSION,
    generatorRevision: GENERATOR_REVISION,
    configHash,
  };
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n");
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

export function readCacheManifest(cacheDir: string): CacheManifest | null {
  const path = cacheManifestPath(cacheDir);
  if (!existsSync(path)) return null;
  const raw = parseEntryJson(path);
  if (!raw || typeof raw !== "object") {
    throw new Error(`sqlx-js: cache manifest is malformed: ${path}`);
  }
  const value = raw as Partial<CacheManifest>;
  if (
    value.cacheFormat !== CACHE_FORMAT_VERSION ||
    value.generatorRevision !== GENERATOR_REVISION ||
    typeof value.configHash !== "string"
  ) {
    throw new CacheManifestStaleError(path);
  }
  return value as CacheManifest;
}

export function assertCacheManifest(cacheDir: string, configHash: string): CacheManifest {
  const manifest = readCacheManifest(cacheDir);
  if (!manifest) {
    throw new Error(`sqlx-js: cache manifest is missing. Run \`sqlx-js prepare\` to regenerate the cache.`);
  }
  if (manifest.configHash !== configHash) {
    throw new Error(
      "sqlx-js: cache was generated with different type-affecting config, connection profiles, "
      + "or function catalog settings. Run `sqlx-js prepare`.",
    );
  }
  return manifest;
}
