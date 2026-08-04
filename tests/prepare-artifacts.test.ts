import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache, fingerprint, readCacheManifest, type CacheEntry } from "../src/cache";
import type { FunctionEntry } from "../src/function-cache";
import {
  publishOfflinePrepareArtifacts,
  publishPrepareArtifacts,
} from "../src/prepare-artifacts";

function emptyEntry(query: string): CacheEntry {
  return {
    query,
    validation: "planned",
    paramOids: [],
    paramTypeIdentities: [],
    paramTsTypes: [],
    paramNullable: [],
    nullableParamOverrides: [],
    resultElementNonNullOverrides: [],
    columns: [],
    hasResultSet: true,
    usesTimestampWithoutTimeZone: false,
    inference: { columns: [], params: [] },
  };
}

test("prepare artifact publication replaces a legacy cache as one snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-artifact-publication-"));
  try {
    const cacheDir = join(root, ".sqlx-js");
    const dtsPath = join(root, "sqlx-js-env.d.ts");
    const enumPath = join(root, "db-enums.ts");
    const cache = new Cache(cacheDir);
    const oldQuery = "SELECT old_value";
    cache.write(fingerprint(oldQuery), emptyEntry(oldQuery));
    const legacyQuery = "SELECT legacy_value";
    const legacy = { ...emptyEntry(legacyQuery) } as Partial<CacheEntry>;
    delete legacy.resultElementNonNullOverrides;
    writeFileSync(join(cacheDir, `${fingerprint(legacyQuery)}.json`), JSON.stringify(legacy));
    writeFileSync(join(cacheDir, "provider-state.bin"), "preserved");
    chmodSync(cacheDir, 0o750);
    writeFileSync(dtsPath, "old declarations\n");
    writeFileSync(enumPath, "old enums\n");

    const query = "SELECT current_value";
    const entry = emptyEntry(query);
    const result = publishPrepareArtifacts({
      cacheDir,
      dtsPath,
      generated: [{ fp: fingerprint(query), entry }],
      entries: [entry],
      functions: [],
      enums: [{ schema: "public", name: "role", values: ["admin"] }],
      enumCatalogEnabled: true,
      enumModule: { path: enumPath, content: "export const Role = { Admin: \"admin\" } as const;\n" },
      configHash: "current-config",
      customTypes: {},
      profiles: {},
      prune: true,
    });

    expect(result).toEqual({ pruned: 2, enumCacheRemoved: false });
    expect(
      readdirSync(cacheDir).filter((name) => /^[0-9a-f]{16}\.json$/.test(name)),
    ).toEqual([`${fingerprint(query)}.json`]);
    expect(readFileSync(join(cacheDir, "provider-state.bin"), "utf8")).toBe("preserved");
    expect(statSync(cacheDir).mode & 0o777).toBe(0o750);
    expect(readCacheManifest(cacheDir)?.configHash).toBe("current-config");
    expect(readFileSync(dtsPath, "utf8")).toContain(JSON.stringify(query));
    expect(readFileSync(enumPath, "utf8")).toContain("export const Role");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepare artifact staging failure preserves the committed snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-artifact-staging-"));
  try {
    const cacheDir = join(root, ".sqlx-js");
    const dtsPath = join(root, "sqlx-js-env.d.ts");
    const oldQuery = "SELECT committed_value";
    const oldFp = fingerprint(oldQuery);
    new Cache(cacheDir).write(oldFp, emptyEntry(oldQuery));
    writeFileSync(dtsPath, "committed declarations\n");
    const query = "SELECT replacement_value";
    const entry = emptyEntry(query);

    expect(() => publishPrepareArtifacts({
      cacheDir,
      dtsPath,
      generated: [{ fp: fingerprint(query), entry }],
      entries: [entry],
      functions: [{ schema: "broken" } as FunctionEntry],
      enums: [],
      enumCatalogEnabled: false,
      configHash: "replacement-config",
      customTypes: {},
      profiles: {},
      prune: true,
    })).toThrow(/refusing to write malformed function catalog cache/);

    expect(existsSync(join(cacheDir, `${oldFp}.json`))).toBe(true);
    expect(existsSync(join(cacheDir, `${fingerprint(query)}.json`))).toBe(false);
    expect(readFileSync(dtsPath, "utf8")).toBe("committed declarations\n");
    expect(readdirSync(root).some((name) => name.includes(".stage-"))).toBe(false);
    expect(readdirSync(root).some((name) => name.endsWith(".prepare-lock"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepare artifact publication preserves a symlinked cache boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-artifact-symlink-"));
  try {
    const cacheTarget = join(root, "cache-store");
    const cacheDir = join(root, ".sqlx-js");
    const dtsPath = join(cacheTarget, "sqlx-js-env.d.ts");
    mkdirSync(cacheTarget);
    symlinkSync(cacheTarget, cacheDir, "dir");
    const query = "SELECT symlinked_value";
    const entry = emptyEntry(query);

    publishPrepareArtifacts({
      cacheDir,
      dtsPath,
      generated: [{ fp: fingerprint(query), entry }],
      entries: [entry],
      functions: [],
      enums: [],
      enumCatalogEnabled: false,
      configHash: "symlink-config",
      customTypes: {},
      profiles: {},
      prune: true,
    });

    expect(lstatSync(cacheDir).isSymbolicLink()).toBe(true);
    expect(realpathSync(cacheDir)).toBe(realpathSync(cacheTarget));
    expect(existsSync(join(cacheTarget, `${fingerprint(query)}.json`))).toBe(true);
    expect(readFileSync(dtsPath, "utf8")).toContain(JSON.stringify(query));
    expect(readCacheManifest(cacheDir)?.configHash).toBe("symlink-config");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("offline artifact publication preserves the cache source while replacing outputs", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-artifact-offline-"));
  try {
    const cacheDir = join(root, ".sqlx-js");
    const dtsPath = join(root, "sqlx-js-env.d.ts");
    const query = "SELECT offline_value";
    const fp = fingerprint(query);
    const entry = emptyEntry(query);
    new Cache(cacheDir).write(fp, entry);

    publishOfflinePrepareArtifacts({
      cacheDir,
      dtsPath,
      entries: [entry],
      functions: [],
      configHash: "offline-config",
      customTypes: {},
      profiles: {},
    });

    expect(existsSync(join(cacheDir, `${fp}.json`))).toBe(true);
    expect(readFileSync(dtsPath, "utf8")).toContain(JSON.stringify(query));
    expect(readFileSync(join(cacheDir, "runtime-descriptors.json"), "utf8"))
      .toContain('"configHash": "offline-config"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepare artifact publication never replaces an output directory", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-artifact-output-directory-"));
  try {
    const cacheDir = join(root, ".sqlx-js");
    const outputDir = join(root, "generated");
    const marker = join(outputDir, "owned.txt");
    const oldQuery = "SELECT committed_directory_value";
    const oldFp = fingerprint(oldQuery);
    new Cache(cacheDir).write(oldFp, emptyEntry(oldQuery));
    mkdirSync(outputDir);
    writeFileSync(marker, "preserved\n");
    const query = "SELECT replacement_directory_value";
    const entry = emptyEntry(query);

    expect(() => publishPrepareArtifacts({
      cacheDir,
      dtsPath: outputDir,
      generated: [{ fp: fingerprint(query), entry }],
      entries: [entry],
      functions: [],
      enums: [],
      enumCatalogEnabled: false,
      configHash: "directory-config",
      customTypes: {},
      profiles: {},
      prune: true,
    })).toThrow(/generated output path is a directory/);

    expect(readFileSync(marker, "utf8")).toBe("preserved\n");
    expect(existsSync(join(cacheDir, `${oldFp}.json`))).toBe(true);
    expect(existsSync(join(cacheDir, `${fingerprint(query)}.json`))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepare artifact publication rejects a concurrent publisher", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-artifact-lock-"));
  try {
    const cacheDir = join(root, ".sqlx-js");
    const dtsPath = join(root, "sqlx-js-env.d.ts");
    const lockDir = join(root, ".sqlx-js.prepare-lock");
    const oldQuery = "SELECT locked_value";
    const oldFp = fingerprint(oldQuery);
    new Cache(cacheDir).write(oldFp, emptyEntry(oldQuery));
    writeFileSync(dtsPath, "locked declarations\n");
    mkdirSync(lockDir);
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({ pid: process.pid, token: "active", createdAt: new Date().toISOString() }),
    );
    const query = "SELECT concurrent_value";
    const entry = emptyEntry(query);

    expect(() => publishPrepareArtifacts({
      cacheDir,
      dtsPath,
      generated: [{ fp: fingerprint(query), entry }],
      entries: [entry],
      functions: [],
      enums: [],
      enumCatalogEnabled: false,
      configHash: "concurrent-config",
      customTypes: {},
      profiles: {},
      prune: true,
    })).toThrow(/another prepare is publishing artifacts/);

    expect(existsSync(join(cacheDir, `${oldFp}.json`))).toBe(true);
    expect(readFileSync(dtsPath, "utf8")).toBe("locked declarations\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepare artifact publication reclaims an abandoned lock", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-artifact-stale-lock-"));
  try {
    const cacheDir = join(root, ".sqlx-js");
    const dtsPath = join(root, "sqlx-js-env.d.ts");
    const lockDir = join(root, ".sqlx-js.prepare-lock");
    mkdirSync(lockDir);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockDir, old, old);
    const query = "SELECT reclaimed_value";
    const entry = emptyEntry(query);

    publishPrepareArtifacts({
      cacheDir,
      dtsPath,
      generated: [{ fp: fingerprint(query), entry }],
      entries: [entry],
      functions: [],
      enums: [],
      enumCatalogEnabled: false,
      configHash: "reclaimed-config",
      customTypes: {},
      profiles: {},
      prune: true,
    });

    expect(existsSync(join(cacheDir, `${fingerprint(query)}.json`))).toBe(true);
    expect(existsSync(lockDir)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepare artifact staging never writes through managed cache symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-artifact-managed-symlink-"));
  try {
    const cacheDir = join(root, ".sqlx-js");
    const outside = join(root, "outside-functions");
    const outsideCache = join(outside, "functions.json");
    mkdirSync(cacheDir);
    mkdirSync(outside);
    writeFileSync(outsideCache, "outside\n");
    symlinkSync(outside, join(cacheDir, "functions"), "dir");
    const query = "SELECT managed_symlink_value";
    const entry = emptyEntry(query);

    expect(() => publishPrepareArtifacts({
      cacheDir,
      dtsPath: join(root, "sqlx-js-env.d.ts"),
      generated: [{ fp: fingerprint(query), entry }],
      entries: [entry],
      functions: [],
      enums: [],
      enumCatalogEnabled: false,
      configHash: "managed-symlink-config",
      customTypes: {},
      profiles: {},
      prune: true,
    })).toThrow(/managed cache path must not be a symbolic link/);

    expect(readFileSync(outsideCache, "utf8")).toBe("outside\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepare artifact staging resolves output parent symlinks into the cache snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-artifact-output-symlink-"));
  try {
    const cacheDir = join(root, ".sqlx-js");
    const outputAlias = join(root, "generated-alias");
    mkdirSync(cacheDir);
    symlinkSync(cacheDir, outputAlias, "dir");
    const dtsPath = join(outputAlias, "sqlx-js-env.d.ts");
    const query = "SELECT output_symlink_value";
    const entry = emptyEntry(query);

    publishPrepareArtifacts({
      cacheDir,
      dtsPath,
      generated: [{ fp: fingerprint(query), entry }],
      entries: [entry],
      functions: [],
      enums: [],
      enumCatalogEnabled: false,
      configHash: "output-symlink-config",
      customTypes: {},
      profiles: {},
      prune: true,
    });

    expect(lstatSync(outputAlias).isSymbolicLink()).toBe(true);
    expect(readFileSync(dtsPath, "utf8")).toContain(JSON.stringify(query));
    expect(readCacheManifest(cacheDir)?.configHash).toBe("output-symlink-config");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
