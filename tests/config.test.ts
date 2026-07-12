import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSupportedRuntime,
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
