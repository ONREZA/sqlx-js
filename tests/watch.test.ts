import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatWatchEvent,
  prepareWatchedOnce,
  shouldWatchFile,
  watchErrorData,
  type WatchOptions,
  type WatchState,
} from "../src/commands/watch";
import { PrepareFatalError, type PrepareIncrementalInput, type PrepareResult, type PrepareSession } from "../src/commands/prepare";
import { profileFingerprint } from "../src/cache";
import { formatDatabaseTarget } from "../src/pg/target-summary";

const target = {
  database: "watch",
  user: "watch",
  serverVersion: "18.0",
  searchPath: "public",
  currentSchema: "public",
  catalogFunctions: 0,
  catalogEnums: 0,
};

function result(entries = 1): PrepareResult {
  return { target, sites: entries, entries, failures: 0, pruned: 0, functions: 0, enums: 0, diagnostics: [] };
}

function session(name: string, closed: string[]): PrepareSession {
  return {
    client: { end: async () => { closed.push(name); } } as unknown as PrepareSession["client"],
    target,
    schema: {} as PrepareSession["schema"],
    userCfg: {},
    profiles: new Map(),
  };
}

function opts(): WatchOptions {
  return {
    root: ".",
    databaseUrl: "postgres://example",
    cacheDir: ".sqlx-js",
    dtsPath: "sqlx-js-env.d.ts",
    check: false,
  };
}

test("prepareWatchedOnce reuses its session when config is unchanged", async () => {
  const closed: string[] = [];
  const opened: string[] = [];
  const logs: string[] = [];
  let prepares = 0;
  const state: WatchState = { session: null };
  const currentOpts = opts();

  const deps = {
    loadConfig: async () => ({}),
    scanProject: () => [],
    findSourceFiles: () => [],
    openSession: async () => {
      opened.push("s1");
      return session("s1", closed);
    },
    prepareOnce: async () => {
      prepares++;
      return result();
    },
  };

  await prepareWatchedOnce(currentOpts, state, (message) => logs.push(message), () => {}, deps);
  await prepareWatchedOnce(currentOpts, state, (message) => logs.push(message), () => {}, deps);

  expect(prepares).toBe(2);
  expect(opened).toEqual(["s1"]);
  expect(closed).toEqual([]);
  expect(logs.filter((message) => message.startsWith("target:"))).toHaveLength(1);
});

test("prepareWatchedOnce resets the session when config changes", async () => {
  const closed: string[] = [];
  const opened: string[] = [];
  const state: WatchState = { session: session("old", closed) };
  state.session!.userCfg = { scan: { include: ["old.ts"] } };
  const currentOpts = opts();

  const deps = {
    loadConfig: async () => ({ scan: { include: ["new.ts"] } }),
    scanProject: () => [],
    findSourceFiles: () => [],
    openSession: async () => {
      opened.push("new");
      return session("new", closed);
    },
    prepareOnce: async (_opts: WatchOptions, current: PrepareSession) => {
      expect(current).toBe(state.session);
      return result();
    },
  };

  await prepareWatchedOnce(currentOpts, state, () => {}, () => {}, deps);

  expect(closed).toEqual(["old"]);
  expect(opened).toEqual(["new"]);
});

test("watch reuses unchanged fingerprints and scans only the changed source", async () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-watch-"));
  const closed: string[] = [];
  const state: WatchState = { session: null };
  const oldA = {
    file: "a.ts",
    line: 1,
    column: 1,
    query: "SELECT ARRAY[COALESCE($1::text, 'x')] AS values",
    paramCount: 1,
    kind: "inline" as const,
  };
  const newA = {
    ...oldA,
    nullableParams: [1],
    resultAssertions: { values: { elements: "non-null" as const } },
  };
  const stableB = {
    file: "b.ts",
    line: 1,
    column: 1,
    query: "SELECT 3",
    paramCount: 0,
    kind: "inline" as const,
    profiles: ["api", "worker"],
  };
  const inputs: PrepareIncrementalInput[] = [];
  writeFileSync(join(root, "a.ts"), "export {};\n");
  writeFileSync(join(root, "b.ts"), "export {};\n");
  try {
    const currentOpts = { ...opts(), root };
    const deps = {
      loadConfig: async () => ({}),
      openSession: async () => session("watch", closed),
      scanProject: () => [oldA, stableB],
      scanFile: (path: string) => path.endsWith("a.ts") ? [newA] : [stableB],
      findSourceFiles: () => [join(root, "a.ts"), join(root, "b.ts")],
      prepareOnce: async (...args: unknown[]) => {
        inputs.push(args[5] as PrepareIncrementalInput);
        return result(2);
      },
    };

    await prepareWatchedOnce(currentOpts, state, () => {}, () => {}, deps);
    await prepareWatchedOnce(currentOpts, state, () => {}, () => {}, deps, ["a.ts"]);

    expect(inputs[1]!.sites?.find((site) => site.file === "a.ts")?.nullableParams).toEqual([1]);
    expect(inputs[1]!.sites?.find((site) => site.file === "a.ts")?.resultAssertions).toEqual({
      values: { elements: "non-null" },
    });
    expect(inputs[1]!.reuseCacheFps).toEqual(new Set([
      profileFingerprint("api", "SELECT 3"),
      profileFingerprint("worker", "SELECT 3"),
    ]));
    expect(inputs[1]!.reuseEnumCatalog).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("watch preserves rescanned sites and dirty fingerprints after a fatal prepare", async () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-watch-fatal-"));
  const state: WatchState = { session: null };
  const oldA = { file: "a.ts", line: 1, column: 1, query: "SELECT old", paramCount: 0, kind: "inline" as const };
  const newA = { ...oldA, query: "SELECT new" };
  const stableB = { file: "b.ts", line: 1, column: 1, query: "SELECT stable", paramCount: 0, kind: "inline" as const };
  const inputs: PrepareIncrementalInput[] = [];
  let prepares = 0;
  writeFileSync(join(root, "a.ts"), "export {};\n");
  writeFileSync(join(root, "b.ts"), "export {};\n");
  try {
    const deps = {
      loadConfig: async () => ({}),
      openSession: async () => session("watch", []),
      scanProject: () => [oldA, stableB],
      scanFile: (path: string) => path.endsWith("a.ts") ? [newA] : [stableB],
      findSourceFiles: () => [join(root, "a.ts"), join(root, "b.ts")],
      prepareOnce: async (...args: unknown[]) => {
        inputs.push(args[5] as PrepareIncrementalInput);
        prepares++;
        if (prepares === 2) throw new Error("artifact publish failed");
        return result(2);
      },
    };
    const currentOpts = { ...opts(), root };

    await prepareWatchedOnce(currentOpts, state, () => {}, () => {}, deps);
    await expect(
      prepareWatchedOnce(currentOpts, state, () => {}, () => {}, deps, ["a.ts"]),
    ).rejects.toThrow("artifact publish failed");
    await prepareWatchedOnce(currentOpts, state, () => {}, () => {}, deps, ["b.ts"]);

    expect(inputs[2]!.sites?.map((site) => site.query).sort()).toEqual([
      "SELECT new",
      "SELECT stable",
    ]);
    expect(inputs[2]!.reuseCacheFps).not.toContain(profileFingerprint(undefined, "SELECT new"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("watch fully rescans consumers when a local client binding changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-watch-client-"));
  const state: WatchState = { session: null };
  const descriptorSite = {
    file: "a.ts",
    line: 1,
    column: 1,
    query: "SELECT $1",
    paramCount: 1,
    kind: "inline" as const,
    execution: "descriptor" as const,
  };
  const adaptiveSite = {
    ...descriptorSite,
    execution: "adaptive" as const,
  };
  let projectScans = 0;
  let fileScans = 0;
  writeFileSync(join(root, "a.ts"), "export {};\n");
  writeFileSync(
    join(root, "db.ts"),
    'import { createSqlClient } from "@onreza/sqlx-js";\nexport const db = createSqlClient();\n',
  );
  try {
    const deps = {
      loadConfig: async () => ({}),
      openSession: async () => session("watch", []),
      scanProject: () => {
        projectScans++;
        return projectScans === 1 ? [descriptorSite] : [adaptiveSite];
      },
      scanFile: () => {
        fileScans++;
        return [];
      },
      findSourceFiles: () => [join(root, "a.ts"), join(root, "db.ts")],
      prepareOnce: async () => result(),
    };

    await prepareWatchedOnce({ ...opts(), root }, state, () => {}, () => {}, deps);
    await prepareWatchedOnce({ ...opts(), root }, state, () => {}, () => {}, deps, ["db.ts"]);

    expect(projectScans).toBe(2);
    expect(fileScans).toBe(0);
    expect(state.sitesByFile?.get("a.ts")?.[0]?.execution).toBe("adaptive");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("watch fully rescans consumers when a local client binding is removed", async () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-watch-client-remove-"));
  const state: WatchState = { session: null };
  const descriptorSite = {
    file: "a.ts",
    line: 1,
    column: 1,
    query: "SELECT $1",
    paramCount: 1,
    kind: "inline" as const,
    execution: "descriptor" as const,
  };
  let projectScans = 0;
  let fileScans = 0;
  writeFileSync(join(root, "a.ts"), "export {};\n");
  writeFileSync(
    join(root, "db.ts"),
    'import { createSqlClient } from "@onreza/sqlx-js";\nexport const db = createSqlClient();\n',
  );
  try {
    const deps = {
      loadConfig: async () => ({}),
      openSession: async () => session("watch", []),
      scanProject: () => {
        projectScans++;
        return projectScans === 1 ? [descriptorSite] : [];
      },
      scanFile: () => {
        fileScans++;
        return [];
      },
      findSourceFiles: () => [join(root, "a.ts"), join(root, "db.ts")],
      prepareOnce: async () => result(),
    };

    await prepareWatchedOnce({ ...opts(), root }, state, () => {}, () => {}, deps);
    writeFileSync(join(root, "db.ts"), "export const db = {};\n");
    await prepareWatchedOnce({ ...opts(), root }, state, () => {}, () => {}, deps, ["db.ts"]);

    expect(projectScans).toBe(2);
    expect(fileScans).toBe(0);
    expect(state.sitesByFile?.has("a.ts")).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("watch fully rescans when a deleted client module also owned query sites", async () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-watch-client-delete-"));
  const state: WatchState = { session: null };
  const consumerSite = {
    file: "a.ts",
    line: 1,
    column: 1,
    query: "SELECT $1",
    paramCount: 1,
    kind: "inline" as const,
    execution: "descriptor" as const,
  };
  const clientSite = {
    ...consumerSite,
    file: "db.ts",
    query: "SELECT $2",
  };
  let projectScans = 0;
  let fileScans = 0;
  writeFileSync(join(root, "a.ts"), "export {};\n");
  writeFileSync(
    join(root, "db.ts"),
    'import { createSqlClient } from "@onreza/sqlx-js";\nexport const db = createSqlClient();\n',
  );
  try {
    const deps = {
      loadConfig: async () => ({}),
      openSession: async () => session("watch", []),
      scanProject: () => {
        projectScans++;
        return projectScans === 1 ? [consumerSite, clientSite] : [consumerSite];
      },
      scanFile: () => {
        fileScans++;
        return [];
      },
      findSourceFiles: () => [join(root, "a.ts")],
      prepareOnce: async () => result(),
    };

    await prepareWatchedOnce({ ...opts(), root }, state, () => {}, () => {}, deps);
    rmSync(join(root, "db.ts"));
    await prepareWatchedOnce({ ...opts(), root }, state, () => {}, () => {}, deps, ["db.ts"]);

    expect(projectScans).toBe(2);
    expect(fileScans).toBe(0);
    expect(state.sitesByFile?.has("db.ts")).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("watch prunes deleted sources even when the filesystem reports only a different file", async () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-watch-delete-"));
  const state: WatchState = { session: null };
  const oldA = { file: "a.ts", line: 1, column: 1, query: "SELECT old", paramCount: 0, kind: "inline" as const };
  const stableB = { file: "b.ts", line: 1, column: 1, query: "SELECT stable", paramCount: 0, kind: "inline" as const };
  const newC = { file: "c.ts", line: 1, column: 1, query: "SELECT new", paramCount: 0, kind: "inline" as const };
  let latest: PrepareIncrementalInput | undefined;
  writeFileSync(join(root, "b.ts"), "export {};\n");
  writeFileSync(join(root, "c.ts"), "export {};\n");
  try {
    const deps = {
      loadConfig: async () => ({}),
      openSession: async () => session("watch", []),
      scanProject: () => [oldA, stableB],
      scanFile: () => [newC],
      findSourceFiles: () => [join(root, "b.ts"), join(root, "c.ts")],
      prepareOnce: async (...args: unknown[]) => {
        latest = args[5] as PrepareIncrementalInput;
        return result(2);
      },
    };

    await prepareWatchedOnce({ ...opts(), root }, state, () => {}, () => {}, deps);
    await prepareWatchedOnce({ ...opts(), root }, state, () => {}, () => {}, deps, ["c.ts"]);

    expect(latest?.sites?.map((site) => site.query).sort()).toEqual(["SELECT new", "SELECT stable"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("watch resolves SQL file events to normalized root-relative paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-watch-sql-"));
  const state: WatchState = { session: null };
  const oldSite = {
    file: "a.ts",
    line: 1,
    column: 1,
    query: "SELECT old",
    paramCount: 0,
    kind: "file" as const,
    sqlFilePath: "queries/../queries/q.sql",
  };
  const newSite = { ...oldSite, query: "SELECT new" };
  let scans = 0;
  writeFileSync(join(root, "a.ts"), "export {};\n");
  try {
    const deps = {
      loadConfig: async () => ({}),
      openSession: async () => session("watch", []),
      scanProject: () => [oldSite],
      scanFile: () => {
        scans++;
        return [newSite];
      },
      findSourceFiles: () => [join(root, "a.ts")],
      prepareOnce: async () => result(),
    };

    await prepareWatchedOnce({ ...opts(), root }, state, () => {}, () => {}, deps);
    await prepareWatchedOnce({ ...opts(), root }, state, () => {}, () => {}, deps, ["queries/q.sql"]);

    expect(scans).toBe(1);
    expect(state.sitesByFile?.get("a.ts")?.[0]?.query).toBe("SELECT new");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("watch reacts to source, SQL, config, and tsconfig graph changes", () => {
  expect(shouldWatchFile("packages/app/src/index.ts")).toBe(true);
  expect(shouldWatchFile("queries/user.sql")).toBe(true);
  expect(shouldWatchFile("sqlx-js.config.mjs")).toBe(true);
  expect(shouldWatchFile("packages/app/tsconfig.build.json")).toBe(true);
  expect(shouldWatchFile("package.json")).toBe(false);
  expect(shouldWatchFile("dist/sqlx-js.config.js")).toBe(false);
  expect(shouldWatchFile("sqlx-js-env.d.ts")).toBe(false);
  expect(shouldWatchFile("types/generated.d.ts", ["types/generated.d.ts"])).toBe(false);
  expect(shouldWatchFile("src/db-enums.ts", ["src/db-enums.ts"])).toBe(false);
  expect(shouldWatchFile("src/sql-files.generated.ts", ["src/sql-files.generated.ts"])).toBe(false);
});

test("watch JSONL events are one versioned document per line", () => {
  expect(JSON.parse(formatWatchEvent("prepared", { ok: true, entries: 2 }, "2026-07-11T00:00:00.000Z"))).toEqual({
    formatVersion: 1,
    event: "prepared",
    timestamp: "2026-07-11T00:00:00.000Z",
    ok: true,
    entries: 2,
  });
  expect(formatWatchEvent("error", { message: "broken" })).not.toContain("\n");
  expect(formatDatabaseTarget({ ...target, database: "watch\nspoof", searchPath: "public\u001b[31m" }))
    .toBe("target: database watch\\nspoof as watch; PostgreSQL 18.0; schema public; search_path public\\u001b[31m; 0 function(s), 0 enum(s)");
  expect(watchErrorData(new PrepareFatalError("scan", "broken", {
    file: "src/a.ts",
    line: 4,
    column: 7,
  }))).toEqual({
    diagnostic: {
      severity: "error",
      message: "broken",
      phase: "scan",
      file: "src/a.ts",
      line: 4,
      column: 7,
    },
  });
  expect(watchErrorData(new PrepareFatalError(
    "config",
    "wrong target",
    {},
    undefined,
    target,
  ))).toMatchObject({ target });
});
