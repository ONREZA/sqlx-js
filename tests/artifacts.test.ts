import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareArtifacts } from "../src/artifacts";

function writeSet(root: string, query = "SELECT 1") {
  const cacheDir = join(root, ".sqlx-js");
  const dtsPath = join(root, "sqlx-js-env.d.ts");
  mkdirSync(join(cacheDir, "functions"), { recursive: true });
  writeFileSync(join(cacheDir, "cache-manifest.json"), '{"cacheFormat":2}\n');
  writeFileSync(join(cacheDir, "0123456789abcdef.json"), JSON.stringify({ query }));
  writeFileSync(join(cacheDir, "functions/functions.json"), '{"version":1,"functions":[]}');
  writeFileSync(dtsPath, `declare const query: ${JSON.stringify(query)};\n`);
  return { cacheDir, dtsPath };
}

test("compareArtifacts reports exact generated files that changed", () => {
  const leftRoot = mkdtempSync(join(tmpdir(), "sqlx-js-artifacts-left-"));
  const rightRoot = mkdtempSync(join(tmpdir(), "sqlx-js-artifacts-right-"));
  try {
    const left = writeSet(leftRoot);
    const right = writeSet(rightRoot);
    expect(compareArtifacts(left, right)).toEqual({ ok: true, changed: [] });
    writeFileSync(join(right.cacheDir, "0123456789abcdef.json"), JSON.stringify({ query: "SELECT 2" }));
    expect(compareArtifacts(left, right)).toEqual({
      ok: false,
      changed: ["cache/0123456789abcdef.json"],
    });
  } finally {
    rmSync(leftRoot, { recursive: true, force: true });
    rmSync(rightRoot, { recursive: true, force: true });
  }
});
