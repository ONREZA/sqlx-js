import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const binPath = join(repoRoot, "bin/sqlx-js.ts");
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
  expect(r.stderr).toContain("--dry-run");
  expect(r.stderr).toContain("--json");
  expect(r.stderr).toContain("check [--json]");
  expect(r.stderr).toContain("migrate dev");
  expect(r.stderr).toContain("verify [--shadow-admin-url");
  expect(r.stderr).toContain("--shadow-admin-url");
  expect(r.stderr).toContain("revert [--dry-run]");
  expect(r.stderr).toContain("archive restore");
});

test("CLI migrate check --json does not require DATABASE_URL", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-cli-"));
  try {
    const r = spawnSync("bun", [binPath, "migrate", "check", "--json", "--root", root], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "" },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, migrations: 0, archives: 0, issues: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI rejects migrate run --json without dry-run before connecting", () => {
  const r = spawnSync("bun", [binPath, "migrate", "run", "--json"], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: "postgres://user:pass@example.invalid:5432/db" },
  });
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("--json for migrate run requires --dry-run");
});

test("CLI rejects migrate revert --json without dry-run before connecting", () => {
  const r = spawnSync("bun", [binPath, "migrate", "revert", "--json"], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: "postgres://user:pass@example.invalid:5432/db" },
  });
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("--json for migrate revert requires --dry-run");
});
