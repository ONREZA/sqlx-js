import { watch as fsWatch } from "node:fs";
import { basename } from "node:path";
import { openSession, prepareOnce, type PrepareOptions, type PrepareSession } from "./prepare";

const EXT_RE = /\.(ts|tsx|mts|cts|sql)$/;
const SKIP_DIRS = ["node_modules", ".git", ".sqlx-js", "dist", "build", ".next"];
const DEBOUNCE_MS = 150;

export type WatchPrepareHookResult = {
  resetSession?: boolean;
};

export type WatchOptions = PrepareOptions & {
  beforePrepare?: () => Promise<WatchPrepareHookResult | void>;
};

export type WatchState = {
  session: PrepareSession | null;
};

type WatchDeps = {
  openSession: typeof openSession;
  prepareOnce: typeof prepareOnce;
};

const DEFAULT_DEPS: WatchDeps = { openSession, prepareOnce };

async function closeSession(session: PrepareSession | null): Promise<void> {
  if (!session) return;
  try { await session.client.end(); } catch {}
}

export async function prepareWatchedOnce(
  opts: WatchOptions,
  state: WatchState,
  log: (msg: string) => void,
  err: (msg: string) => void,
  deps: WatchDeps = DEFAULT_DEPS,
): Promise<{ entries: number; failures: number; pruned: number }> {
  const hookResult = await opts.beforePrepare?.();
  if (hookResult?.resetSession === true) {
    await closeSession(state.session);
    state.session = null;
  }
  if (!state.session) state.session = await deps.openSession(opts);
  return await deps.prepareOnce(opts, state.session, log, err, 1);
}

export async function runWatch(opts: WatchOptions): Promise<void> {
  const stamp = () => new Date().toTimeString().slice(0, 8);
  const log = (m: string) => console.log(`[${stamp()}] ${m}`);
  const err = (m: string) => console.error(`[${stamp()}] ${m}`);
  const state: WatchState = { session: null };

  log("watch: initial prepare");
  try {
    const r = await prepareWatchedOnce(opts, state, log, err);
    log(`watch: ready — ${r.entries} queries, ${r.failures} failures`);
  } catch (e) {
    err(`watch: initial prepare failed — ${(e as Error).message}`);
  }
  log(`watch: monitoring ${opts.root}`);

  let pending = false;
  let running: Promise<unknown> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const trigger = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      if (running) {
        pending = true;
        return;
      }
      const start = Date.now();
      running = (async () => {
        try {
          const r = await prepareWatchedOnce(opts, state, log, err);
          log(`watch: re-prepared in ${Date.now() - start}ms (${r.entries} queries, ${r.failures} failures)`);
        } catch (e) {
          err(`watch: prepare error — ${(e as Error).message}`);
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
    const raw = filename.toString();
    const f = raw.replace(/\\/g, "/");
    if (SKIP_DIRS.some((d) => f === d || f.startsWith(`${d}/`) || f.includes(`/${d}/`))) return;
    const base = basename(f);
    if (base === "sqlx-js-env.d.ts" || base === "sqlx-js.d.ts") return;
    if (!EXT_RE.test(f)) return;
    trigger();
  });

  const shutdown = async () => {
    console.log();
    log("watch: stopping");
    watcher.close();
    await closeSession(state.session);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise<void>(() => {});
}
