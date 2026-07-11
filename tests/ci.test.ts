import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPgschemaPlanClean, buildCiSteps } from "../src/commands/ci";

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function options(provider: "builtin" | "pgschema") {
  root = mkdtempSync(join(tmpdir(), "sqlx-js-ci-"));
  return {
    root,
    config: { schema: { provider } },
    schemaPath: join(root, ".sqlx-js/schema/schema.json"),
    migrationsDir: "migrations",
  } as const;
}

test("builtin CI verifies migrations and committed offline artifacts", () => {
  const opts = { ...options("builtin"), dtsPath: "types/generated.d.ts" };
  const steps = buildCiSteps(opts);
  expect(steps.map((step) => step.name)).toEqual(["migrations", "prepare-offline"]);
  expect(steps[0]!.args).toContain("--strict-inference");
  expect(steps[0]!.args).toContain("types/generated.d.ts");
  expect(steps[1]!.args).toContain("types/generated.d.ts");
});

test("pgschema CI checks the provider and performs live prepare verification", () => {
  const steps = buildCiSteps(options("pgschema"));
  expect(steps.map((step) => step.name)).toEqual(["pgschema", "pgschema-plan", "prepare-live", "prepare-offline"]);
  expect(steps[1]!.args).toContain("--output-json");
  expect(steps[2]!.args).toContain("--verify");
});

test("CI checks a maintained schema snapshot", () => {
  const opts = options("builtin");
  mkdirSync(join(root!, ".sqlx-js/schema"), { recursive: true });
  writeFileSync(opts.schemaPath, "{}");
  expect(buildCiSteps(opts).map((step) => step.name)).toEqual(["migrations", "prepare-offline", "schema"]);
});

test("pgschema CI accepts only an empty, well-formed plan", () => {
  const opts = options("pgschema");
  const path = join(opts.root, "plan.json");
  writeFileSync(path, JSON.stringify({ groups: [] }));
  expect(() => assertPgschemaPlanClean(path)).not.toThrow();
  writeFileSync(path, JSON.stringify({ groups: null }));
  expect(() => assertPgschemaPlanClean(path)).not.toThrow();
  writeFileSync(path, JSON.stringify({ groups: [{ steps: [] }] }));
  expect(() => assertPgschemaPlanClean(path)).toThrow(/1 unapplied change group/);
  writeFileSync(path, JSON.stringify({}));
  expect(() => assertPgschemaPlanClean(path)).toThrow(/array or null/);
});
