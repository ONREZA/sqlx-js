import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const manifests = execFileSync("git", ["ls-files", "-z", "*cache-manifest.json"], { cwd: repo, encoding: "utf8" })
  .split("\0").filter(Boolean);

for (const manifest of manifests) {
  const root = dirname(dirname(resolve(repo, manifest)));
  test(`committed prepare artifacts satisfy the current strict offline contract: ${manifest}`, () => {
    const result = spawnSync("bun", [resolve(repo, "bin/sqlx-js.ts"), "prepare", "--root", root, "--check", "--strict-inference"], {
      cwd: repo, encoding: "utf8",
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
}
