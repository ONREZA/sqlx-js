import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const binPath = join(repoRoot, "bin/bun-sqlx.ts");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string };

test("CLI --version is sourced from package metadata", () => {
  const r = spawnSync("bun", [binPath, "--version"], { encoding: "utf8" });
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe(pkg.version);
});

test("CLI help prints package metadata version", () => {
  const r = spawnSync("bun", [binPath, "--help"], { encoding: "utf8" });
  expect(r.status).toBe(2);
  expect(r.stderr).toContain(`v${pkg.version}`);
});
