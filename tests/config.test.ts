import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSupportedRuntime,
  defineDatabaseProfiles,
  loadConfig,
  loadRootEnv,
  prepareConfigHash,
} from "../src/config";
import { inspectDoctor } from "../src/commands/doctor";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.SQLX_JS_TEST_FROM_FILE;
  delete process.env.SQLX_JS_TEST_PRESET;
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "sqlx-js-config-"));
  roots.push(value);
  return value;
}

test("loadRootEnv loads .env without overriding the process environment", () => {
  const dir = root();
  writeFileSync(join(dir, ".env"), "SQLX_JS_TEST_FROM_FILE=loaded\nSQLX_JS_TEST_PRESET=file\n");
  process.env.SQLX_JS_TEST_PRESET = "process";

  expect(loadRootEnv(dir)).toBe(join(dir, ".env"));
  expect(process.env.SQLX_JS_TEST_FROM_FILE).toBe("loaded");
  expect(process.env.SQLX_JS_TEST_PRESET).toBe("process");
});

test("loadConfig imports an erasable TypeScript config", async () => {
  const dir = root();
  writeFileSync(join(dir, "sqlx-js.config.ts"), `
    import { defineConfig } from "${join(import.meta.dir, "../src/index.ts")}";
    export default defineConfig({ scan: { include: ["src/**/*.ts"] } });
  `);

  expect(await loadConfig(dir)).toEqual({ scan: { include: ["src/**/*.ts"] } });
});

test("database profiles share exact names and roles between config and runtime", async () => {
  const profiles = defineDatabaseProfiles({
    api: { role: "app_api" },
    worker: { role: "app_worker" },
  });
  expect(profiles).toEqual({
    api: { name: "api", role: "app_api" },
    worker: { name: "worker", role: "app_worker" },
  });
  expect(Object.isFrozen(profiles)).toBe(true);
  expect(Object.values(profiles).every(Object.isFrozen)).toBe(true);

  const dir = root();
  writeFileSync(join(dir, "sqlx-js.config.mjs"), `export default {
    profiles: {
      api: { name: "api", role: "app_api" },
      worker: { name: "worker", role: "app_worker" },
    },
  };\n`);
  expect((await loadConfig(dir)).profiles).toEqual(profiles);
});

test("loadConfig rejects malformed database profile contracts", async () => {
  const wrongName = root();
  writeFileSync(join(wrongName, "sqlx-js.config.mjs"), `export default {
    profiles: { api: { name: "worker", role: "app_api" } },
  };\n`);
  await expect(loadConfig(wrongName)).rejects.toThrow(/profiles\.api\.name must be "api"/);

  const emptyRole = root();
  writeFileSync(join(emptyRole, "sqlx-js.config.mjs"), `export default {
    profiles: { api: { name: "api", role: " " } },
  };\n`);
  await expect(loadConfig(emptyRole)).rejects.toThrow(/profiles\.api\.role must be a non-empty PostgreSQL role/);
});

test("loadConfig rejects malformed JavaScript config with an actionable path", async () => {
  const dir = root();
  writeFileSync(join(dir, "sqlx-js.config.mjs"), `export default {
    jsonbTypes: { "users.settings": 42 },
    scan: { include: "src/**/*.ts" },
  };
  `);

  await expect(loadConfig(dir)).rejects.toThrow(/sqlx-js\.config\.mjs jsonbTypes\.users\.settings must be a non-empty string/);
});

test("loadConfig rejects empty declarations and qualified custom type keys", async () => {
  const empty = root();
  writeFileSync(join(empty, "sqlx-js.config.mjs"), `export default {
    customTypes: { geometry: " " },
  };\n`);
  await expect(loadConfig(empty)).rejects.toThrow(/customTypes\.geometry must be a non-empty string/);

  const qualified = root();
  writeFileSync(join(qualified, "sqlx-js.config.mjs"), `export default {
    customTypes: { "postgis.geometry": "GeoJSON.Geometry" },
  };\n`);
  await expect(loadConfig(qualified)).rejects.toThrow(/customTypes keys must be bare PostgreSQL type names/);
});

test("loadConfig requires a default export", async () => {
  const dir = root();
  writeFileSync(join(dir, "sqlx-js.config.mjs"), "export const scan = {};\n");
  await expect(loadConfig(dir)).rejects.toThrow(/must default-export a config object/);
});

test("prepare config hash is independent of object key order", () => {
  expect(prepareConfigHash({
    customTypes: { vector: "number[]", geometry: "GeoJSON.Geometry" },
    jsonbTypes: { "users.settings": "Settings" },
  })).toBe(prepareConfigHash({
    jsonbTypes: { "users.settings": "Settings" },
    customTypes: { geometry: "GeoJSON.Geometry", vector: "number[]" },
  }));
});

test("prepare config hash includes column and function catalog contracts", () => {
  const base = prepareConfigHash({});
  expect(prepareConfigHash({ functionCatalog: { includeExtensionOwned: false } })).toBe(base);
  expect(prepareConfigHash({ columnTypes: { "users.status": "Status" } })).not.toBe(base);
  expect(prepareConfigHash({ arrayElementNullability: { "users.tags": "non-null" } })).not.toBe(base);
  expect(prepareConfigHash({ functionCatalog: false })).not.toBe(base);
  expect(prepareConfigHash({ functionCatalog: { includeExtensionOwned: true } })).not.toBe(base);
  expect(prepareConfigHash({ enumCatalog: { output: "src/db-enums.ts", schemas: ["public"] } })).not.toBe(base);
  expect(prepareConfigHash({
    profiles: { api: { name: "api", role: "app_api" } },
  })).not.toBe(base);
});

test("enum catalog config requires a project output and explicit schemas", async () => {
  const valid = root();
  writeFileSync(join(valid, "sqlx-js.config.mjs"), `export default {
    enumCatalog: {
      output: "src/db-enums.ts",
      schemas: ["public", "app"],
      include: ["public.status"],
      aliases: { "public.status": "AccountStatus" },
      registry: true,
    },
  };\n`);
  expect(await loadConfig(valid)).toEqual({
    enumCatalog: {
      output: "src/db-enums.ts",
      schemas: ["public", "app"],
      include: ["public.status"],
      aliases: { "public.status": "AccountStatus" },
      registry: true,
    },
  });

  const outside = root();
  writeFileSync(join(outside, "sqlx-js.config.mjs"), `export default {
    enumCatalog: { output: "../db-enums.ts", schemas: ["public"] },
  };\n`);
  await expect(loadConfig(outside)).rejects.toThrow(/root-relative \.ts, \.mts, or \.cts path inside the project/);

  const outputDirectory = root();
  mkdirSync(join(outputDirectory, "db-enums.ts"));
  writeFileSync(join(outputDirectory, "sqlx-js.config.mjs"), `export default {
    enumCatalog: { output: "db-enums.ts", schemas: ["public"] },
  };\n`);
  await expect(loadConfig(outputDirectory)).rejects.toThrow(/output must resolve to a file/);

  const invalidParent = root();
  writeFileSync(join(invalidParent, "generated"), "not a directory\n");
  writeFileSync(join(invalidParent, "sqlx-js.config.mjs"), `export default {
    enumCatalog: { output: "generated/db-enums.ts", schemas: ["public"] },
  };\n`);
  await expect(loadConfig(invalidParent)).rejects.toThrow(/output parent must resolve to a directory/);

  const noSchemas = root();
  writeFileSync(join(noSchemas, "sqlx-js.config.mjs"), `export default {
    enumCatalog: { output: "src/db-enums.ts", schemas: [] },
  };\n`);
  await expect(loadConfig(noSchemas)).rejects.toThrow(/must contain at least one non-empty schema name/);

  const invalidAlias = root();
  writeFileSync(join(invalidAlias, "sqlx-js.config.mjs"), `export default {
    enumCatalog: {
      output: "src/db-enums.ts",
      schemas: ["public"],
      aliases: { "public.status": "default" },
    },
  };\n`);
  await expect(loadConfig(invalidAlias)).rejects.toThrow(/must be a valid TypeScript export name/);

  const unqualifiedNames = root();
  writeFileSync(join(unqualifiedNames, "sqlx-js.config.mjs"), `export default {
    enumCatalog: {
      output: "src/db-enums.ts",
      schemas: ["public"],
      include: ["status"],
    },
  };\n`);
  await expect(loadConfig(unqualifiedNames)).rejects.toThrow(/include must contain.*schema-qualified enum name/);

  const unqualifiedAlias = root();
  writeFileSync(join(unqualifiedAlias, "sqlx-js.config.mjs"), `export default {
    enumCatalog: {
      output: "src/db-enums.ts",
      schemas: ["public"],
      aliases: { status: "Status" },
    },
  };\n`);
  await expect(loadConfig(unqualifiedAlias)).rejects.toThrow(/aliases keys must be schema-qualified enum names/);

  const conflictingSelection = root();
  writeFileSync(join(conflictingSelection, "sqlx-js.config.mjs"), `export default {
    enumCatalog: {
      output: "src/db-enums.ts",
      schemas: ["public"],
      include: ["public.status"],
      exclude: ["public.internal_status"],
    },
  };\n`);
  await expect(loadConfig(conflictingSelection)).rejects.toThrow(/include and enumCatalog\.exclude cannot be used together/);
});

test("enum catalog cache hash follows schemas rather than output-only options", () => {
  expect(prepareConfigHash({
    enumCatalog: {
      output: "src/db-enums.ts",
      schemas: ["app", "public"],
      include: ["public.status"],
      aliases: { "public.status": "AccountStatus" },
      registry: true,
    },
  })).toBe(prepareConfigHash({
    enumCatalog: {
      output: "generated/enums.ts",
      schemas: ["public", "app"],
      exclude: ["app.internal_status"],
      aliases: { "public.status": "Status" },
      registry: false,
    },
  }));
});

test("loadConfig validates array element nullability assertions", async () => {
  const dir = root();
  writeFileSync(join(dir, "sqlx-js.config.mjs"), `export default {
    arrayElementNullability: { "users.tags": "sometimes" },
  };\n`);
  await expect(loadConfig(dir)).rejects.toThrow(/arrayElementNullability\.users\.tags must be non-null/);
});

test("loadConfig rejects conflicting column type assertions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sqlx-js-config-conflict-"));
  roots.push(dir);
  writeFileSync(join(dir, "sqlx-js.config.mjs"), `export default {
    jsonbTypes: { "public.users.payload": "Payload" },
    columnTypes: { "users.payload": "Payload" },
  };\n`);
  await expect(loadConfig(dir)).rejects.toThrow(/same column/);
});

test("loadConfig validates function catalog settings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sqlx-js-config-functions-"));
  roots.push(dir);
  writeFileSync(join(dir, "sqlx-js.config.mjs"), `export default {
    functionCatalog: { includeExtensionOwned: "yes" },
  };\n`);
  await expect(loadConfig(dir)).rejects.toThrow(/includeExtensionOwned must be a boolean/);
});

test("current development runtime satisfies the supported baseline", () => {
  expect(() => assertSupportedRuntime()).not.toThrow();
});

test("doctor follows tsconfig project references when checking generated declarations", async () => {
  const dir = root();
  mkdirSync(join(dir, "packages/app"), { recursive: true });
  writeFileSync(join(dir, "sqlx-js-env.d.ts"), "export {};\n");
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
    files: [],
    references: [{ path: "./packages/app" }],
  }));
  writeFileSync(join(dir, "packages/app/tsconfig.json"), JSON.stringify({
    include: ["../../sqlx-js-env.d.ts"],
  }));

  const checks = await inspectDoctor({
    root: dir,
    databaseUrl: "",
    cacheDir: join(dir, ".sqlx-js"),
    dtsPath: join(dir, "sqlx-js-env.d.ts"),
  });
  expect(checks.find((check) => check.name === "tsconfig")).toMatchObject({ status: "ok" });
});

test("doctor checks the configured enum catalog output", async () => {
  const dir = root();
  writeFileSync(join(dir, "sqlx-js.config.mjs"), `export default {
    enumCatalog: { output: "db-enums.ts", schemas: ["public"] },
  };\n`);

  let checks = await inspectDoctor({
    root: dir,
    databaseUrl: "",
    cacheDir: join(dir, ".sqlx-js"),
    dtsPath: join(dir, "sqlx-js-env.d.ts"),
  });
  expect(checks.find((check) => check.name === "enumCatalog")).toMatchObject({
    status: "error",
    message: expect.stringContaining("generated enum catalog not found"),
  });

  writeFileSync(join(dir, "db-enums.ts"), "export {};\n");
  checks = await inspectDoctor({
    root: dir,
    databaseUrl: "",
    cacheDir: join(dir, ".sqlx-js"),
    dtsPath: join(dir, "sqlx-js-env.d.ts"),
  });
  expect(checks.find((check) => check.name === "enumCatalog")).toMatchObject({ status: "ok" });
});

test("doctor does not treat an unrelated .env file as DATABASE_URL configuration", async () => {
  const dir = root();
  writeFileSync(join(dir, ".env"), "OTHER=value\n");
  const checks = await inspectDoctor({
    root: dir,
    databaseUrl: "",
    cacheDir: join(dir, ".sqlx-js"),
    dtsPath: join(dir, "sqlx-js-env.d.ts"),
  });
  expect(checks.find((check) => check.name === "env")).toMatchObject({
    status: "error",
    message: `${join(dir, ".env")} exists but DATABASE_URL is missing`,
  });
});

test("doctor avoids cascading cache and provider errors after invalid config", async () => {
  const dir = root();
  writeFileSync(join(dir, "sqlx-js.config.mjs"), "export default { scan: [] };\n");
  const checks = await inspectDoctor({
    root: dir,
    databaseUrl: "",
    cacheDir: join(dir, ".sqlx-js"),
    dtsPath: join(dir, "sqlx-js-env.d.ts"),
  });
  expect(checks.find((check) => check.name === "config")?.status).toBe("error");
  expect(checks.find((check) => check.name === "cache")?.status).toBe("warning");
  expect(checks.find((check) => check.name === "pgschema")?.status).toBe("warning");
});
