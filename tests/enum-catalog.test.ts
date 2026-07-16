import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import {
  assertDistinctEnumCatalogOutput,
  enumCatalogCacheExists,
  enumCatalogOutputPath,
  readEnumCatalogCache,
  removeEnumCatalogCache,
  renderEnumCatalog,
  selectedEnumCatalogCount,
  writeEnumCatalogCache,
  writeEnumCatalogModule,
  type EnumCatalogEntry,
} from "../src/enum-catalog";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "sqlx-js-enums-"));
  roots.push(value);
  return value;
}

test("enum catalog emits stable as-const objects and matching union types", () => {
  const text = renderEnumCatalog([
    { schema: "public", name: "user_role", values: ["admin", "in-progress"] },
    { schema: "app", name: "2fa_status", values: ["required", "verified"] },
  ]);

  expect(text).toContain("export const UserRole = {");
  expect(text).toContain('  ["in-progress"]: "in-progress",');
  expect(text).toContain("export type UserRole = (typeof UserRole)[keyof typeof UserRole];");
  expect(text).toContain("export const Pg2faStatus = {");
  expect(text).not.toContain("export const DbEnums");
  expect(text.indexOf("Pg2faStatus")).toBeLessThan(text.indexOf("UserRole"));
});

test("enum catalog emits valid TypeScript for arbitrary labels and deterministic Unicode names", () => {
  const text = renderEnumCatalog([
    { schema: "public", name: "ä_state", values: ["__proto__", "quoted\"value", "line\nbreak"] },
    { schema: "public", name: "z_state", values: ["ready"] },
  ], { registry: true });
  const diagnostics = ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  }).diagnostics ?? [];

  expect(diagnostics).toEqual([]);
  expect(text.indexOf("ZState")).toBeLessThan(text.indexOf("ÄState"));
  expect(text).toContain('["__proto__"]: "__proto__"');
});

test("enum catalog rejects ambiguous generated export names", () => {
  expect(() => renderEnumCatalog([
    { schema: "app", name: "user-role", values: ["admin"] },
    { schema: "public", name: "user_role", values: ["member"] },
  ])).toThrow(/UserRole is ambiguous between app\.user-role and public\.user_role/);
});

test("enum catalog applies schema-qualified aliases and emits an opt-in registry", () => {
  const text = renderEnumCatalog([
    { schema: "public", name: "status", values: ["active", "disabled"] },
    { schema: "billing", name: "status", values: ["pending", "paid"] },
  ], {
    aliases: {
      "public.status": "AccountStatus",
      "billing.status": "BillingStatus",
    },
    registry: true,
  });

  expect(text).toContain("export const AccountStatus = {");
  expect(text).toContain("export const BillingStatus = {");
  expect(text).toContain('  ["billing.status"]: BillingStatus,');
  expect(text).toContain('  ["public.status"]: AccountStatus,');
  expect(text).toContain("export type DbEnumName = keyof typeof DbEnums;");
  expect(text).toContain("export type DbEnumValue<Name extends DbEnumName> =");
  expect(text).toContain("  Name extends DbEnumName");

  expect(() => renderEnumCatalog([
    { schema: "public", name: "db_enums", values: ["ready"] },
  ], { registry: true })).toThrow(/conflicts with the generated registry/);
});

test("enum catalog selects exact schema-qualified includes or excludes", () => {
  const enums: EnumCatalogEntry[] = [
    { schema: "billing", name: "status", values: ["pending", "paid"] },
    { schema: "public", name: "status", values: ["active", "disabled"] },
    { schema: "public", name: "user_role", values: ["admin", "viewer"] },
  ];
  const included = renderEnumCatalog(enums, {
    include: ["public.status", "public.user_role"],
    registry: true,
  });
  const excluded = renderEnumCatalog(enums, {
    exclude: ["public.status", "public.user_role"],
  });

  expect([...included.matchAll(/^export const (\w+)/gm)].map((match) => match[1])).toEqual([
    "Status",
    "UserRole",
    "DbEnums",
  ]);
  const registry = included.slice(included.indexOf("export const DbEnums"));
  expect([...registry.matchAll(/^  \["([^"]+)"\]:/gm)].map((match) => match[1])).toEqual([
    "public.status",
    "public.user_role",
  ]);
  expect([...excluded.matchAll(/^export const (\w+)/gm)].map((match) => match[1])).toEqual(["Status"]);
  expect(selectedEnumCatalogCount(enums, { include: ["public.status", "public.user_role"] })).toBe(2);
  expect(selectedEnumCatalogCount(enums, { exclude: ["public.status", "public.user_role"] })).toBe(1);
});

test("enum catalog rejects ambiguous registry keys and duplicate labels", () => {
  expect(() => renderEnumCatalog([
    { schema: "a.b", name: "status", values: ["active"] },
    { schema: "a", name: "b.status", values: ["inactive"] },
  ])).toThrow(/ambiguous key "a\.b\.status"/);
  expect(() => renderEnumCatalog([
    { schema: "public", name: "status", values: ["active", "active"] },
  ])).toThrow(/duplicate labels for "public\.status"/);
});

test("enum catalog rejects unknown selections", () => {
  expect(() => renderEnumCatalog([
    { schema: "public", name: "status", values: ["active"] },
  ], {
    include: ["billing.status"],
  })).toThrow(/include billing\.status does not match an enum in the configured schemas/);
});

test("enum catalog rejects aliases outside the selected catalog", () => {
  expect(() => renderEnumCatalog([
    { schema: "public", name: "status", values: ["active"] },
  ], {
    aliases: { "billing.status": "BillingStatus" },
  })).toThrow(/alias billing\.status does not match a selected enum/);
  expect(() => renderEnumCatalog([
    { schema: "public", name: "status", values: ["active"] },
  ], {
    aliases: { "public.status": "as" },
  })).toThrow(/must use a valid TypeScript export name/);
});

test("enum catalog cache and module round-trip generated values", () => {
  const dir = root();
  const cacheDir = join(dir, ".sqlx-js");
  const entries: EnumCatalogEntry[] = [
    { schema: "public", name: "user_role", values: ["admin", "viewer"] },
    { schema: "app", name: "state", values: ["z", "a"] },
  ];
  const output = enumCatalogOutputPath(dir, {
    enumCatalog: { output: "src/db-enums.ts", schemas: ["public"] },
  })!;

  writeEnumCatalogCache(cacheDir, entries);
  writeEnumCatalogModule(output, renderEnumCatalog(entries));

  expect(enumCatalogCacheExists(cacheDir)).toBe(true);
  expect(readEnumCatalogCache(cacheDir)).toEqual([
    { schema: "app", name: "state", values: ["z", "a"] },
    { schema: "public", name: "user_role", values: ["admin", "viewer"] },
  ]);
  expect(readFileSync(output, "utf8")).toContain('["viewer"]: "viewer"');
  expect(existsSync(output)).toBe(true);

  removeEnumCatalogCache(cacheDir);
  expect(enumCatalogCacheExists(cacheDir)).toBe(false);
});

test("enum catalog cache rejects duplicate schema-qualified entries", () => {
  const dir = root();
  const cacheDir = join(dir, ".sqlx-js");
  const path = join(cacheDir, "enums/enums.json");
  mkdirSync(join(cacheDir, "enums"), { recursive: true });
  writeFileSync(path, JSON.stringify({
    version: 1,
    enums: [
      { schema: "public", name: "status", values: ["active"] },
      { schema: "public", name: "status", values: ["disabled"] },
    ],
  }));

  expect(() => readEnumCatalogCache(cacheDir)).toThrow(/malformed.*ambiguous key "public\.status"/);
});

test("enum catalog output cannot overwrite a custom declaration output", () => {
  const dir = root();
  const config = {
    enumCatalog: { output: "generated/types.ts", schemas: ["public"] },
  };

  expect(() => assertDistinctEnumCatalogOutput(
    dir,
    config,
    join(dir, "generated/types.ts"),
  )).toThrow(/must differ from the declaration output/);
  expect(() => assertDistinctEnumCatalogOutput(
    dir,
    config,
    join(dir, "generated/sqlx-js-env.d.ts"),
  )).not.toThrow();
});
