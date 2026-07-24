import { existsSync, watch as fsWatch } from "node:fs";
import { basename, relative, resolve } from "node:path";
import {
  closePrepareSession,
  openSession,
  prepareOnce,
  PrepareFatalError,
  type PrepareOptions,
  type PrepareResult,
  type PrepareSession,
} from "./prepare";
import { configHash, loadConfig } from "../config";
import { profileFingerprint } from "../cache";
import { enumCatalogOutputPath } from "../enum-catalog";
import { findSourceFiles, scanFile, scanProject, type QueryCallSite } from "../scan/scanner";

const EXT_RE = /\.(ts|tsx|mts|cts|sql)$/;
const SKIP_DIRS = ["node_modules", ".git", ".sqlx-js", "dist", "build", ".next"];
const DEBOUNCE_MS = 150;
const CONFIG_FILES = new Set([
  "sqlx-js.config.ts",
  "sqlx-js.config.mts",
  "sqlx-js.config.js",
  "sqlx-js.config.mjs",
]);

export function shouldWatchFile(filename: string, ignoredFiles: readonly string[] = []): boolean {
  const file = filename.replace(/\\/g, "/");
  if (ignoredFiles.some((ignored) => normalizePath(ignored) === normalizePath(file))) return false;
  if (SKIP_DIRS.some((dir) => file === dir || file.startsWith(`${dir}/`) || file.includes(`/${dir}/`))) {
    return false;
  }
  const base = basename(file);
  if (base === "sqlx-js-env.d.ts" || base === "sqlx-js.d.ts") return false;
  if (CONFIG_FILES.has(base) || /^tsconfig(?:\.[^.]+)*\.json$/.test(base)) return true;
  return EXT_RE.test(file);
}

export type WatchOptions = PrepareOptions & {
  jsonl?: boolean;
};

export type WatchState = {
  session: PrepareSession | null;
  sitesByFile?: Map<string, QueryCallSite[]>;
  dirtyFiles?: Set<string>;
  dirtyFps?: Set<string>;
};

export function formatWatchEvent(
  name: string,
  data: Record<string, unknown> = {},
  timestamp = new Date().toISOString(),
): string {
  return JSON.stringify({ formatVersion: 1, event: name, timestamp, ...data });
}

export function watchErrorData(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof PrepareFatalError)) return { message };
  return {
    diagnostic: {
      severity: "error",
      phase: error.phase,
      message,
      ...(error.file === undefined ? {} : { file: error.file }),
      ...(error.line === undefined ? {} : { line: error.line }),
      ...(error.column === undefined ? {} : { column: error.column }),
    },
  };
}

type WatchDeps = {
  openSession: typeof openSession;
  prepareOnce: typeof prepareOnce;
  loadConfig: typeof loadConfig;
  scanProject: typeof scanProject;
  scanFile: typeof scanFile;
  findSourceFiles: typeof findSourceFiles;
};

const DEFAULT_DEPS: WatchDeps = { openSession, prepareOnce, loadConfig, scanProject, scanFile, findSourceFiles };

async function closeSession(session: PrepareSession | null): Promise<void> {
  if (!session) return;
  await closePrepareSession(session);
}

export async function prepareWatchedOnce(
  opts: WatchOptions,
  state: WatchState,
  log: (msg: string) => void,
  err: (msg: string) => void,
  deps: Partial<WatchDeps> = {},
  changedFiles: readonly string[] = [],
): Promise<PrepareResult> {
  const active = { ...DEFAULT_DEPS, ...deps };
  const currentConfig = await active.loadConfig(opts.root);
  const configChanged = state.session !== null && configHash(state.session.userCfg) !== configHash(currentConfig);
  const resetSession = configChanged;
  if (resetSession) {
    await closeSession(state.session);
    state.session = null;
  }
  if (!state.session) state.session = await active.openSession(opts);

  const full = resetSession || !state.sitesByFile || changedFiles.some(isProjectGraphFile);
  let nextSites: Map<string, QueryCallSite[]>;
  let changedFps = new Set<string>();
  if (full) {
    const sites = active.scanProject(opts.root, currentConfig.scan, currentConfig.profiles ?? {});
    nextSites = groupSites(sites);
    changedFps = new Set(sites.flatMap(siteFingerprints));
  } else {
    const previousSites = state.sitesByFile!;
    const dirtyFiles = state.dirtyFiles ?? new Set<string>();
    const requested = new Set([...changedFiles, ...dirtyFiles].map((file) => projectPath(opts.root, file)));
    const affectedSources = new Set<string>();
    for (const changed of requested) {
      if (/\.(ts|tsx|mts|cts)$/.test(changed)) affectedSources.add(changed);
      if (changed.endsWith(".sql")) {
        for (const [source, sites] of previousSites) {
          if (sites.some((site) => site.sqlFilePath && projectPath(opts.root, site.sqlFilePath) === changed)) {
            affectedSources.add(source);
          }
        }
      }
    }
    nextSites = new Map(previousSites);
    const allowed = new Set(active.findSourceFiles(opts.root, currentConfig.scan).map((file) => projectPath(opts.root, file)));
    for (const source of nextSites.keys()) {
      if (!allowed.has(source)) affectedSources.add(source);
    }
    try {
      for (const source of affectedSources) {
        const previous = nextSites.get(source) ?? [];
        for (const site of previous) {
          for (const fp of siteFingerprints(site)) changedFps.add(fp);
        }
        const absolute = resolve(opts.root, source);
        if (!existsSync(absolute) || !allowed.has(source)) {
          nextSites.delete(source);
          continue;
        }
        const scanned = active.scanFile(
          absolute,
          opts.root,
          currentConfig.scan?.modules,
          Object.keys(currentConfig.profiles ?? {}),
          Object.values(currentConfig.profiles ?? {})
            .filter((profile) => profile.transactionSettings !== undefined)
            .map((profile) => profile.name),
        );
        if (scanned.length > 0) nextSites.set(source, scanned);
        else nextSites.delete(source);
        for (const site of scanned) {
          for (const fp of siteFingerprints(site)) changedFps.add(fp);
        }
      }
      for (const source of affectedSources) dirtyFiles.delete(source);
    } catch (error) {
      for (const source of affectedSources) dirtyFiles.add(source);
      state.dirtyFiles = dirtyFiles;
      throw error;
    }
    state.dirtyFiles = dirtyFiles;
  }

  const sites = [...nextSites.values()].flat();
  const dirtyFps = state.dirtyFps ?? new Set<string>();
  const reuseCacheFps = new Set(
    sites
      .flatMap(siteFingerprints)
      .filter((fp) => !changedFps.has(fp) && !dirtyFps.has(fp)),
  );
  const result = await active.prepareOnce(opts, state.session, log, err, 1, {
    sites,
    reuseCacheFps,
    reuseEnumCatalog: !full,
  });
  state.sitesByFile = nextSites;
  if (result.failures === 0) {
    state.dirtyFps = new Set();
  } else {
    state.dirtyFps = new Set([...dirtyFps, ...changedFps]);
  }
  return result;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function projectPath(root: string, path: string): string {
  return normalizePath(relative(resolve(root), resolve(root, path)));
}

function isProjectGraphFile(path: string): boolean {
  const base = basename(path);
  return CONFIG_FILES.has(base) || /^tsconfig(?:\.[^.]+)*\.json$/.test(base);
}

function groupSites(sites: QueryCallSite[]): Map<string, QueryCallSite[]> {
  const grouped = new Map<string, QueryCallSite[]>();
  for (const site of sites) {
    const file = normalizePath(site.file);
    const current = grouped.get(file) ?? [];
    current.push(site);
    grouped.set(file, current);
  }
  return grouped;
}

function siteFingerprints(site: QueryCallSite): string[] {
  return site.profiles && site.profiles.length > 0
    ? site.profiles.map((profile) => profileFingerprint(profile, site.query))
    : [profileFingerprint(undefined, site.query)];
}

export async function runWatch(opts: WatchOptions): Promise<void> {
  const stamp = () => new Date().toTimeString().slice(0, 8);
  const event = (name: string, data: Record<string, unknown> = {}) => {
    console.log(formatWatchEvent(name, data));
  };
  const log = opts.jsonl ? () => {} : (m: string) => console.log(`[${stamp()}] ${m}`);
  const err = opts.jsonl ? () => {} : (m: string) => console.error(`[${stamp()}] ${m}`);
  const state: WatchState = { session: null };

  const report = (result: PrepareResult, durationMs?: number) => {
    if (!opts.jsonl) return;
    for (const diagnostic of result.diagnostics) event("diagnostic", { diagnostic });
    event("prepared", {
      ok: result.failures === 0,
      sites: result.sites,
      entries: result.entries,
      failures: result.failures,
      pruned: result.pruned,
      functions: result.functions,
      enums: result.enums,
      ...(durationMs === undefined ? {} : { durationMs }),
    });
  };

  if (opts.jsonl) event("start", { root: opts.root });
  else log("watch: initial prepare");
  try {
    const r = await prepareWatchedOnce(opts, state, log, err);
    if (opts.jsonl) report(r);
    else log(`watch: ready — ${r.entries} queries, ${r.failures} failures`);
  } catch (e) {
    if (opts.jsonl) event("error", watchErrorData(e));
    else err(`watch: initial prepare failed — ${(e as Error).message}`);
  }
  if (opts.jsonl) event("watching", { root: opts.root });
  else log(`watch: monitoring ${opts.root}`);

  let pending = false;
  let running: Promise<unknown> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const changedFiles = new Set<string>();

  const trigger = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      if (running) {
        pending = true;
        return;
      }
      const start = Date.now();
      const batch = [...changedFiles];
      changedFiles.clear();
      running = (async () => {
        try {
          const r = await prepareWatchedOnce(opts, state, log, err, {}, batch);
          const durationMs = Date.now() - start;
          if (opts.jsonl) report(r, durationMs);
          else log(`watch: re-prepared in ${durationMs}ms (${r.entries} queries, ${r.failures} failures)`);
        } catch (e) {
          if (opts.jsonl) event("error", watchErrorData(e));
          else err(`watch: prepare error — ${(e as Error).message}`);
        }
      })();
      await running;
      running = null;
      if (pending) {
        pending = false;
        trigger();
      }
    }, DEBOUNCE_MS);
  };

  const watcher = fsWatch(opts.root, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const enumOutput = state.session
      ? enumCatalogOutputPath(opts.root, state.session.userCfg)
      : undefined;
    const ignored = enumOutput ? [relative(opts.root, enumOutput)] : [];
    if (!shouldWatchFile(filename.toString(), ignored)) return;
    changedFiles.add(normalizePath(filename.toString()));
    trigger();
  });

  const shutdown = async () => {
    if (opts.jsonl) event("stopping");
    else {
      console.log();
      log("watch: stopping");
    }
    watcher.close();
    await closeSession(state.session);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise<void>(() => {});
}
