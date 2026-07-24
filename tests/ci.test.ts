import { expect, test } from "bun:test";
import { buildCiSteps } from "../src/commands/ci";

test("CI runs provider-aware verification and committed offline checks", () => {
  const steps = buildCiSteps({
    root: "/project",
    dtsPath: "types/generated.d.ts",
    migrationsDir: "database/migrations",
    shadowUrl: "postgres://localhost/shadow",
    shadowAdminUrl: "postgres://localhost/postgres",
  });
  expect(steps.map((step) => step.name)).toEqual(["verify", "prepare-offline"]);
  expect(steps[0]!.args[0]).toBe("verify");
  expect(steps[0]!.args).toContain("--strict-inference");
  expect(steps[0]!.args).toContain("types/generated.d.ts");
  expect(steps[0]!.args).toContain("database/migrations");
  expect(steps[0]!.args).toContain("postgres://localhost/shadow");
  expect(steps[0]!.args).toContain("postgres://localhost/postgres");
  expect(steps[1]!.args).toContain("types/generated.d.ts");
});
