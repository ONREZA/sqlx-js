import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  CACHE_FORMAT_VERSION,
  GENERATOR_REVISION,
  JSON_PROTOCOL_VERSION,
} from "./artifact-versions";
import { arrayElementOid, isBuiltinOid } from "./pg/oids";
import { queryId } from "./query-id";
import { ReservedNamedParameterError, rewriteNamedParameters } from "./sql-params";

export { CACHE_FORMAT_VERSION, GENERATOR_REVISION };
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
  jsonProtocol: typeof JSON_PROTOCOL_VERSION;
  configHash: string;
  complete: boolean;
};

export class CacheManifestIncompleteError extends Error {
  constructor(path: string) {
    super(
      `sqlx-js: cache manifest is incomplete after focused prepare: ${path}. `
      + "Run a full `sqlx-js prepare` before check or release.",
    );
    this.name = "CacheManifestIncompleteError";
  }
}

export type CacheColumn = {
  name: string;
  typeOid: number;
  tsType: string;
  nullable: boolean;
  override?: "non-null" | "nullable";
};

export type CacheInferenceSource = {
  schema: string;
  table: string;
  column: string;
  notNull?: boolean;
};

export type CacheInferenceTarget = {
  kind: "dml" | "predicate";
  schema?: string;
  table: string;
  column?: string;
  columnIndex?: number;
  nullSafe?: boolean;
};

export type CacheInference = {
  columns: {
    sources: CacheInferenceSource[] | null;
    reason: string;
    hint?: string;
  }[];
  params: {
    targets: CacheInferenceTarget[];
    reason: string;
    hint?: string;
  }[];
};

export type CacheEntry = {
  query: string;
  profile?: string;
  validation?: "planned" | "parse-only";
  inlineQueries?: string[];
  paramOids: number[];
  paramTypeIdentities: (number | { schema: string; name: string })[];
  paramTsTypes: string[];
  paramNullable: boolean[];
  nullableParamOverrides: number[];
  resultElementNonNullOverrides: string[];
  paramNames?: string[];
  columns: CacheColumn[];
  hasResultSet: boolean;
  usesTimestampWithoutTimeZone: boolean;
  hasInline?: boolean;
  filePaths?: string[];
  degraded?: { reason: string };
  inference: CacheInference;
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

export function isQueryCacheFileName(file: string): boolean {
  return /^[0-9a-f]{16}\.json$/.test(file);
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
  if (
    !Array.isArray(entry.paramOids)
    || !Array.isArray(entry.paramTypeIdentities)
    || !Array.isArray(entry.paramTsTypes)
  ) {
    throw new Error(
      `sqlx-js: cache entry ${fp}.json has invalid parameter type identities. Run \`sqlx-js prepare\`.`,
    );
  }
  const paramOids = entry.paramOids;
  const paramTypeIdentities = entry.paramTypeIdentities;
  const paramTsTypes = entry.paramTsTypes;
  if (
    paramOids.some((oid) => !Number.isSafeInteger(oid) || oid < 0)
    || paramTsTypes.some((type) => typeof type !== "string" || type.length === 0)
    || paramOids.length !== paramTsTypes.length
    || paramTypeIdentities.length !== paramTsTypes.length
    || paramTypeIdentities.some((identity, index) => {
      if (typeof identity === "number") {
        return !isBuiltinOid(identity) || paramOids[index] !== identity;
      }
      return (
        paramOids[index] !== 0
        || !identity
        || typeof identity !== "object"
        || typeof (identity as { schema?: unknown }).schema !== "string"
        || !(identity as { schema: string }).schema
        || typeof (identity as { name?: unknown }).name !== "string"
        || !(identity as { name: string }).name
      );
    })
  ) {
    throw new Error(
      `sqlx-js: cache entry ${fp}.json has invalid parameter type identities. Run \`sqlx-js prepare\`.`,
    );
  }
  if (entry.validation !== undefined && entry.validation !== "planned" && entry.validation !== "parse-only") {
    throw new Error(`sqlx-js: cache entry ${fp}.json has invalid validation metadata. Run \`sqlx-js prepare\`.`);
  }
  if (typeof entry.usesTimestampWithoutTimeZone !== "boolean") {
    throw new Error(`sqlx-js: cache entry ${fp}.json is missing its temporal contract. Run \`sqlx-js prepare\`.`);
  }
  if (entry.profile !== undefined && (typeof entry.profile !== "string" || entry.profile.trim() === "")) {
    throw new Error(`sqlx-js: cache entry ${fp}.json has invalid profile metadata. Run \`sqlx-js prepare\`.`);
  }
  if (
    typeof entry.query === "string"
    && /^[0-9a-f]{16}$/.test(fp)
    && profileFingerprint(
      typeof entry.profile === "string" ? entry.profile : undefined,
      entry.query,
    ) !== fp
  ) {
    throw new Error(`sqlx-js: cache entry ${fp}.json does not match its query/profile fingerprint. Run \`sqlx-js prepare\`.`);
  }
  let expectedNames: string[];
  try {
    if (typeof entry.query !== "string") throw new Error("query must be a string");
    expectedNames = rewriteNamedParameters(entry.query).names;
  } catch (error) {
    if (error instanceof ReservedNamedParameterError) {
      throw new Error(
        `sqlx-js: cache entry ${fp}.json uses reserved named parameter "${error.parameterName}". `
        + "Rename the parameter in the source SQL and its parameter object, then run `sqlx-js prepare`.",
      );
    }
    const detail = error instanceof Error
      ? `: ${error.message.replace(/^sqlx-js: /, "")}`
      : "";
    throw new Error(
      `sqlx-js: cache entry ${fp}.json has malformed named parameter metadata${detail}. Run \`sqlx-js prepare\`.`,
    );
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
  if (
    typeof entry.hasResultSet !== "boolean"
    || cols.some((column) => {
      if (!column || typeof column !== "object" || Array.isArray(column)) return true;
      const value = column as Record<string, unknown>;
      return (
        typeof value.name !== "string"
        || value.name.length === 0
        || !Number.isSafeInteger(value.typeOid)
        || (value.typeOid as number) < 0
        || typeof value.tsType !== "string"
        || value.tsType.length === 0
        || typeof value.nullable !== "boolean"
        || (
          value.override !== undefined
          && value.override !== "non-null"
          && value.override !== "nullable"
        )
      );
    })
  ) {
    throw new Error(`sqlx-js: cache entry ${fp}.json has invalid result metadata. Run \`sqlx-js prepare\`.`);
  }
  if (
    !Array.isArray(entry.paramNullable)
    || entry.paramNullable.length !== paramTsTypes.length
    || entry.paramNullable.some((nullable) => typeof nullable !== "boolean")
  ) {
    throw new Error(`sqlx-js: cache entry ${fp}.json has invalid parameter nullability. Run \`sqlx-js prepare\`.`);
  }
  if (
    !Array.isArray(entry.nullableParamOverrides)
    || entry.nullableParamOverrides.some((index) =>
      !Number.isSafeInteger(index)
      || (index as number) < 1
      || (index as number) > paramTsTypes.length
    )
    || entry.nullableParamOverrides.some((index, position) =>
      position > 0 && (entry.nullableParamOverrides as number[])[position - 1]! >= (index as number)
    )
  ) {
    throw new Error(`sqlx-js: cache entry ${fp}.json has invalid nullable parameter overrides. Run \`sqlx-js prepare\`.`);
  }
  const columnsByName = new Map(cols.map((column) => {
    const value = column as Record<string, unknown>;
    return [value.name as string, value] as const;
  }));
  if (
    !Array.isArray(entry.resultElementNonNullOverrides)
    || entry.resultElementNonNullOverrides.some((column) =>
      typeof column !== "string" || column.length === 0
    )
    || entry.resultElementNonNullOverrides.some((column, position) =>
      position > 0
      && (entry.resultElementNonNullOverrides as string[])[position - 1]! >= (column as string)
    )
    || entry.resultElementNonNullOverrides.some((column) =>
      !columnsByName.has(column as string)
    )
    || entry.resultElementNonNullOverrides.some((column) => {
      const oid = columnsByName.get(column as string)!.typeOid as number;
      return oid !== 0 && arrayElementOid(oid) === undefined;
    })
  ) {
    throw new Error(`sqlx-js: cache entry ${fp}.json has invalid result assertion metadata. Run \`sqlx-js prepare\`.`);
  }
  const inference = entry.inference;
  const validOptionalString = (value: unknown) =>
    value === undefined || (typeof value === "string" && value.length > 0);
  const validSource = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const source = value as Record<string, unknown>;
    return (
      typeof source.schema === "string"
      && source.schema.length > 0
      && typeof source.table === "string"
      && source.table.length > 0
      && typeof source.column === "string"
      && source.column.length > 0
      && (source.notNull === undefined || typeof source.notNull === "boolean")
    );
  };
  const validTarget = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const target = value as Record<string, unknown>;
    return (
      (target.kind === "dml" || target.kind === "predicate")
      && typeof target.table === "string"
      && target.table.length > 0
      && validOptionalString(target.schema)
      && validOptionalString(target.column)
      && (
        target.columnIndex === undefined
        || (Number.isSafeInteger(target.columnIndex) && (target.columnIndex as number) > 0)
      )
      && (target.nullSafe === undefined || typeof target.nullSafe === "boolean")
    );
  };
  if (
    !inference
    || typeof inference !== "object"
    || Array.isArray(inference)
    || !Array.isArray((inference as Record<string, unknown>).columns)
    || !Array.isArray((inference as Record<string, unknown>).params)
  ) {
    throw new Error(`sqlx-js: cache entry ${fp}.json has no inference explanations. Run \`sqlx-js prepare\`.`);
  }
  const inferenceColumns = (inference as { columns: unknown[] }).columns;
  const inferenceParams = (inference as { params: unknown[] }).params;
  const validExplanation = (value: unknown) =>
    !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).reason === "string"
    && ((value as Record<string, unknown>).reason as string).length > 0
    && validOptionalString((value as Record<string, unknown>).hint);
  if (
    inferenceColumns.length !== cols.length
    || inferenceParams.length !== paramTsTypes.length
    || inferenceColumns.some((value) => {
      if (!validExplanation(value)) return true;
      const sources = (value as Record<string, unknown>).sources;
      return sources !== null && (!Array.isArray(sources) || sources.some((source) => !validSource(source)));
    })
    || inferenceParams.some((value) => {
      if (!validExplanation(value)) return true;
      const targets = (value as Record<string, unknown>).targets;
      return !Array.isArray(targets) || targets.some((target) => !validTarget(target));
    })
  ) {
    throw new Error(`sqlx-js: cache entry ${fp}.json has invalid inference explanations. Run \`sqlx-js prepare\`.`);
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
    assertEntryShape(fp, entry);
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
        assertEntryShape(fp, entry);
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
    return this.entryFiles().map((f) => {
      const fp = f.slice(0, -".json".length);
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
    for (const file of this.entryFiles()) {
      const fp = file.slice(0, -".json".length);
      if (!keepSet.has(fp)) {
        this.remove(fp);
        removed.push(fp);
      }
    }
    return removed;
  }

  private entryFiles(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter(isQueryCacheFileName);
  }
}

export function cacheManifestPath(cacheDir: string): string {
  return join(cacheDir, CACHE_MANIFEST_FILE);
}

export function writeCacheManifest(cacheDir: string, configHash: string, complete = true): void {
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const path = cacheManifestPath(cacheDir);
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  const manifest: CacheManifest = {
    cacheFormat: CACHE_FORMAT_VERSION,
    generatorRevision: GENERATOR_REVISION,
    jsonProtocol: JSON_PROTOCOL_VERSION,
    configHash,
    complete,
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
    value.jsonProtocol !== JSON_PROTOCOL_VERSION ||
    typeof value.configHash !== "string" ||
    typeof value.complete !== "boolean"
  ) {
    throw new CacheManifestStaleError(path);
  }
  return value as CacheManifest;
}

export function assertCacheManifest(
  cacheDir: string,
  configHash: string,
  options: { allowIncomplete?: boolean } = {},
): CacheManifest {
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
  if (!manifest.complete && !options.allowIncomplete) {
    throw new CacheManifestIncompleteError(cacheManifestPath(cacheDir));
  }
  return manifest;
}
