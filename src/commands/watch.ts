import { watch as fsWatch } from "node:fs";
import { basename } from "node:path";
import { openSession, prepareOnce, type PrepareOptions } from "./prepare";

const EXT_RE = /\.(ts|tsx|mts|cts|sql)$/;
const SKIP_DIRS = ["node_modules", ".git", ".bun-sqlx", "dist", "build", ".next"];
const DEBOUNCE_MS = 150;

export async function runWatch(opts: PrepareOptions): Promise<void> {
  const session = await openSession(opts);

  const stamp = () => new Date().toTimeString().slice(0, 8);
  const log = (m: string) => console.log(`[${stamp()}] ${m}`);
  const err = (m: string) => console.error(`[${stamp()}] ${m}`);

  log("watch: initial prepare");
  try {
    const r = await prepareOnce(opts, session, log, err);
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
          const r = await prepareOnce(opts, session, log, err);
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
    const f = filename.toString();
    if (SKIP_DIRS.some((d) => f.startsWith(`${d}/`) || f.includes(`/${d}/`))) return;
    const base = basename(f);
    if (base === "bun-sqlx-env.d.ts" || base === "bun-sqlx.d.ts") return;
    if (!EXT_RE.test(f)) return;
    trigger();
  });

  const shutdown = async () => {
    console.log();
    log("watch: stopping");
    watcher.close();
    try { await session.client.end(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise<void>(() => {});
}
