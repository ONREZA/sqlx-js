import { randomBytes } from "node:crypto";
import {
  cpSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Cache, type CacheEntry, writeCacheManifest } from "./cache";
import { emitDts } from "./codegen";
import type { DatabaseProfiles } from "./config";
import {
  enumCatalogCacheExists,
  removeEnumCatalogCache,
  writeEnumCatalogCache,
  writeEnumCatalogModule,
  type EnumCatalogEntry,
} from "./enum-catalog";
import { writeFunctionCache, type FunctionEntry } from "./function-cache";
import { writeRuntimeDescriptors } from "./runtime-descriptor-artifact";
import type { TemporalPolicyOptions } from "./temporal";

type GeneratedOutputPublication = {
  dtsPath: string;
  entries: CacheEntry[];
  functions: FunctionEntry[];
  enumModule?: { path: string; content: string };
  customTypes?: Readonly<Record<string, string>>;
  profiles?: DatabaseProfiles;
  temporal?: TemporalPolicyOptions;
};

export type PrepareArtifactPublication = GeneratedOutputPublication & {
  cacheDir: string;
  generated: readonly { fp: string; entry: CacheEntry }[];
  enums: EnumCatalogEntry[];
  enumCatalogEnabled: boolean;
  configHash: string;
  prune: boolean;
};

export type PrepareArtifactPublicationResult = {
  pruned: number;
  enumCacheRemoved: boolean;
};

export type OfflinePrepareArtifactPublication = GeneratedOutputPublication & {
  cacheDir: string;
  configHash: string;
};

type StagedTarget = {
  target: string;
  staged: string;
};

type PublicationState = StagedTarget & {
  backup?: string;
  published: boolean;
};

type StagedCacheSnapshot = {
  logical: string;
  publication: string;
  staged: string;
};

type CacheBoundary = Omit<StagedCacheSnapshot, "staged">;

type PublicationLock = {
  path: string;
  token: string;
};

const LOCK_OWNER_FILE = "owner.json";
const INCOMPLETE_LOCK_GRACE_MS = 30_000;

export function publishPrepareArtifacts(
  input: PrepareArtifactPublication,
): PrepareArtifactPublicationResult {
  return withPublicationLock(input.cacheDir, (cache) => {
    const externalTargets: StagedTarget[] = [];
    try {
      assertSafeManagedCachePaths(cache.staged);
      const stagedCache = new Cache(cache.staged);
      const pruned = stagedCache.replaceAll(input.generated, input.prune).length;
      writeFunctionCache(cache.staged, input.functions);
      const enumCacheRemoved = !input.enumCatalogEnabled
        && enumCatalogCacheExists(input.cacheDir);
      if (input.enumCatalogEnabled) writeEnumCatalogCache(cache.staged, input.enums);
      else removeEnumCatalogCache(cache.staged);
      writeRuntimeDescriptors(
        cache.staged,
        input.entries,
        input.configHash,
        input.profiles,
        input.temporal,
      );
      writeCacheManifest(cache.staged, input.configHash);

      stageGeneratedOutputs(input, cache, externalTargets);

      // The manifest inside cacheDir is the commit marker, so external outputs publish first.
      publishTargets([...externalTargets, { target: cache.publication, staged: cache.staged }]);
      return { pruned, enumCacheRemoved };
    } finally {
      removePath(cache.staged);
      for (const target of externalTargets) removePath(target.staged);
    }
  });
}

export function publishOfflinePrepareArtifacts(
  input: OfflinePrepareArtifactPublication,
): void {
  withPublicationLock(input.cacheDir, (cache) => {
    const externalTargets: StagedTarget[] = [];
    try {
      assertSafeManagedCachePaths(cache.staged);
      writeRuntimeDescriptors(
        cache.staged,
        input.entries,
        input.configHash,
        input.profiles,
        input.temporal,
      );
      stageGeneratedOutputs(input, cache, externalTargets);
      publishTargets([...externalTargets, { target: cache.publication, staged: cache.staged }]);
    } finally {
      removePath(cache.staged);
      for (const target of externalTargets) removePath(target.staged);
    }
  });
}

export function withGeneratedArtifactLock(cacheDir: string, write: () => void): void {
  const boundary = resolveCacheBoundary(cacheDir);
  withResolvedArtifactLock(boundary, write);
}

function withResolvedArtifactLock<T>(boundary: CacheBoundary, write: () => T): T {
  const lock = acquirePublicationLock(boundary.publication);
  try {
    return write();
  } finally {
    releasePublicationLock(lock);
  }
}

function stageGeneratedOutputs(
  input: GeneratedOutputPublication,
  cache: StagedCacheSnapshot,
  externalTargets: StagedTarget[],
): void {
  const dtsPath = resolvePublicationPath(input.dtsPath);
  const enumModule = input.enumModule
    ? { ...input.enumModule, path: resolvePublicationPath(input.enumModule.path) }
    : undefined;
  assertGeneratedOutputPaths([dtsPath, enumModule?.path], cache);
  stageOutput(dtsPath, cache, externalTargets, (path) => {
    emitDts(
      path,
      input.entries,
      input.functions,
      input.customTypes,
      input.profiles,
      input.temporal,
    );
  });
  if (enumModule) {
    stageOutput(
      enumModule.path,
      cache,
      externalTargets,
      (path) => writeEnumCatalogModule(path, enumModule.content),
    );
  }
}

function assertGeneratedOutputPaths(
  candidates: readonly (string | undefined)[],
  cache: StagedCacheSnapshot,
): void {
  const outputs = candidates.filter(
    (path): path is string => path !== undefined,
  );
  for (const output of outputs) {
    if (samePath(cache.logical, output) || samePath(cache.publication, output)) {
      throw new Error(`sqlx-js: generated output must not equal the cache directory: ${output}`);
    }
    if (
      descendantPath(output, cache.logical) !== null
      || descendantPath(output, cache.publication) !== null
    ) {
      throw new Error(`sqlx-js: generated output must not contain the cache directory: ${output}`);
    }
    if (existsSync(output) && statSync(output).isDirectory()) {
      throw new Error(`sqlx-js: generated output path is a directory: ${output}`);
    }
  }
  if (outputs.length === 2 && (
    samePath(outputs[0]!, outputs[1]!)
    || descendantPath(outputs[0]!, outputs[1]!) !== null
    || descendantPath(outputs[1]!, outputs[0]!) !== null
  )) {
    throw new Error("sqlx-js: generated output paths must not overlap");
  }
}

function resolvePublicationPath(path: string): string {
  const target = resolve(path);
  const suffix = [basename(target)];
  let parent = dirname(target);
  while (!existsSync(parent)) {
    const next = dirname(parent);
    if (next === parent) return target;
    suffix.unshift(basename(parent));
    parent = next;
  }
  return join(realpathSync(parent), ...suffix);
}

function withPublicationLock<T>(
  cacheDir: string,
  publish: (cache: StagedCacheSnapshot) => T,
): T {
  const boundary = resolveCacheBoundary(cacheDir);
  return withResolvedArtifactLock(boundary, () => publish(stageCacheSnapshot(boundary)));
}

function resolveCacheBoundary(cacheDir: string): CacheBoundary {
  const logical = resolve(cacheDir);
  const cacheExists = existsSync(logical);
  if (!cacheExists && pathExists(logical)) {
    throw new Error(`sqlx-js: cache path is a dangling symbolic link: ${cacheDir}`);
  }
  const publication = cacheExists ? realpathSync(logical) : resolvePublicationPath(logical);
  mkdirSync(dirname(publication), { recursive: true });
  if (cacheExists && !statSync(publication).isDirectory()) {
    throw new Error(`sqlx-js: cache path is not a directory: ${cacheDir}`);
  }
  return { logical, publication };
}

function stageCacheSnapshot(boundary: CacheBoundary): StagedCacheSnapshot {
  const cacheExists = existsSync(boundary.publication);
  const { logical, publication } = boundary;
  const staged = uniqueSibling(publication, "stage");
  mkdirSync(staged);
  try {
    if (cacheExists) {
      cpSync(publication, staged, { recursive: true });
      chmodSync(staged, statSync(publication).mode);
    }
    return { logical, publication, staged };
  } catch (error) {
    removePath(staged);
    throw error;
  }
}

function stageOutput(
  target: string,
  cache: StagedCacheSnapshot,
  externalTargets: StagedTarget[],
  write: (path: string) => void,
): void {
  const cacheRelative = descendantPath(cache.publication, target)
    ?? descendantPath(cache.logical, target);
  if (cacheRelative !== null) {
    assertNoSymlinkParents(cache.staged, cacheRelative);
    write(join(cache.staged, cacheRelative));
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  const staged = uniqueSibling(target, "stage");
  write(staged);
  externalTargets.push({ target, staged });
}

function samePath(left: string, right: string): boolean {
  return relative(left, right) === "";
}

function descendantPath(parent: string, child: string): string | null {
  const path = relative(parent, child);
  if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    return null;
  }
  return path;
}

function publishTargets(targets: readonly StagedTarget[]): void {
  for (const target of targets) {
    if (!existsSync(target.staged)) {
      throw new Error(`sqlx-js: staged artifact is missing: ${target.staged}`);
    }
  }
  const states: PublicationState[] = [];
  try {
    for (const target of targets) {
      const state: PublicationState = { ...target, published: false };
      states.push(state);
      if (pathExists(target.target)) {
        state.backup = uniqueSibling(target.target, "backup");
        renameSync(target.target, state.backup);
      }
      renameSync(target.staged, target.target);
      state.published = true;
    }
  } catch (error) {
    const rollbackErrors = rollbackPublications(states);
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "sqlx-js: artifact publication failed and rollback was incomplete",
      );
    }
    throw error;
  }
  for (const state of states) {
    if (state.backup) removePath(state.backup);
  }
}

function assertSafeManagedCachePaths(cacheDir: string): void {
  for (const name of ["functions", "enums"]) {
    const path = join(cacheDir, name);
    if (pathExists(path) && lstatSync(path).isSymbolicLink()) {
      throw new Error(`sqlx-js: managed cache path must not be a symbolic link: ${path}`);
    }
  }
}

function assertNoSymlinkParents(cacheDir: string, cacheRelative: string): void {
  let current = cacheDir;
  const parent = dirname(cacheRelative);
  if (parent === ".") return;
  for (const segment of parent.split(sep)) {
    current = join(current, segment);
    if (pathExists(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`sqlx-js: generated output parent must not be a symbolic link: ${current}`);
    }
  }
}

function acquirePublicationLock(publication: string): PublicationLock {
  const path = join(dirname(publication), hiddenSiblingName(publication, "prepare-lock"));
  for (;;) {
    try {
      mkdirSync(path);
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      if (!reclaimStalePublicationLock(path)) {
        throw new Error(
          `sqlx-js: another prepare is publishing artifacts for ${publication} (lock: ${path})`,
          { cause: error },
        );
      }
      continue;
    }
    const token = randomBytes(12).toString("hex");
    try {
      writeFileSync(
        join(path, LOCK_OWNER_FILE),
        `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`,
      );
      return { path, token };
    } catch (error) {
      removePath(path);
      throw error;
    }
  }
}

function reclaimStalePublicationLock(path: string): boolean {
  let owner: { pid?: unknown } | undefined;
  try {
    owner = JSON.parse(readFileSync(join(path, LOCK_OWNER_FILE), "utf8"));
  } catch {
    try {
      if (Date.now() - statSync(path).mtimeMs < INCOMPLETE_LOCK_GRACE_MS) return false;
    } catch (error) {
      return hasErrorCode(error, "ENOENT");
    }
  }
  if (typeof owner?.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
    if (processIsRunning(owner.pid)) return false;
  }
  const stale = uniqueSibling(path, "stale");
  try {
    renameSync(path, stale);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return true;
    return false;
  }
  removePath(stale);
  return true;
}

function releasePublicationLock(lock: PublicationLock): void {
  try {
    const owner = JSON.parse(readFileSync(join(lock.path, LOCK_OWNER_FILE), "utf8")) as {
      token?: unknown;
    };
    if (owner.token === lock.token) removePath(lock.path);
  } catch {}
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, "ESRCH");
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && (error as { code?: unknown }).code === code;
}

function rollbackPublications(states: readonly PublicationState[]): unknown[] {
  const errors: unknown[] = [];
  for (const state of [...states].reverse()) {
    try {
      if (state.published) rmSync(state.target, { recursive: true, force: true });
      if (state.backup) renameSync(state.backup, state.target);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function uniqueSibling(path: string, label: string): string {
  let candidate: string;
  do {
    candidate = join(
      dirname(path),
      `${hiddenSiblingName(path, label)}-${randomBytes(6).toString("hex")}`,
    );
  } while (pathExists(candidate));
  return candidate;
}

function hiddenSiblingName(path: string, label: string): string {
  const name = basename(path);
  return `${name.startsWith(".") ? "" : "."}${name}.${label}`;
}

function removePath(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {}
}
