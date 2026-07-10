import { expect, test } from "bun:test";
import { prepareWatchedOnce, shouldWatchFile, type WatchOptions, type WatchState } from "../src/commands/watch";
import type { PrepareSession } from "../src/commands/prepare";

function session(name: string, closed: string[]): PrepareSession {
  return {
    client: { end: async () => { closed.push(name); } } as unknown as PrepareSession["client"],
    schema: {} as PrepareSession["schema"],
    userCfg: {},
  };
}

function opts(beforePrepare?: WatchOptions["beforePrepare"]): WatchOptions {
  return {
    root: ".",
    databaseUrl: "postgres://example",
    cacheDir: ".sqlx-js",
    dtsPath: "sqlx-js-env.d.ts",
    check: false,
    beforePrepare,
  };
}

test("prepareWatchedOnce runs beforePrepare before every prepare and reuses session by default", async () => {
  const closed: string[] = [];
  const opened: string[] = [];
  let hooks = 0;
  let prepares = 0;
  const state: WatchState = { session: null };
  const currentOpts = opts(async () => {
    hooks++;
  });

  const deps = {
    openSession: async () => {
      opened.push("s1");
      return session("s1", closed);
    },
    prepareOnce: async () => {
      prepares++;
      return { entries: 1, failures: 0, pruned: 0 };
    },
  };

  await prepareWatchedOnce(currentOpts, state, () => {}, () => {}, deps);
  await prepareWatchedOnce(currentOpts, state, () => {}, () => {}, deps);

  expect(hooks).toBe(2);
  expect(prepares).toBe(2);
  expect(opened).toEqual(["s1"]);
  expect(closed).toEqual([]);
});

test("prepareWatchedOnce resets the session when beforePrepare reports schema changes", async () => {
  const closed: string[] = [];
  const opened: string[] = [];
  const state: WatchState = { session: session("old", closed) };
  const currentOpts = opts(async () => ({ resetSession: true }));

  const deps = {
    openSession: async () => {
      opened.push("new");
      return session("new", closed);
    },
    prepareOnce: async (_opts: WatchOptions, current: PrepareSession) => {
      expect(current).toBe(state.session);
      return { entries: 1, failures: 0, pruned: 0 };
    },
  };

  await prepareWatchedOnce(currentOpts, state, () => {}, () => {}, deps);

  expect(closed).toEqual(["old"]);
  expect(opened).toEqual(["new"]);
});

test("watch reacts to source, SQL, config, and tsconfig graph changes", () => {
  expect(shouldWatchFile("packages/app/src/index.ts")).toBe(true);
  expect(shouldWatchFile("queries/user.sql")).toBe(true);
  expect(shouldWatchFile("sqlx-js.config.mjs")).toBe(true);
  expect(shouldWatchFile("packages/app/tsconfig.build.json")).toBe(true);
  expect(shouldWatchFile("package.json")).toBe(false);
  expect(shouldWatchFile("dist/sqlx-js.config.js")).toBe(false);
  expect(shouldWatchFile("sqlx-js-env.d.ts")).toBe(false);
});
