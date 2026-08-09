import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint, type CacheEntry } from "../src/cache";
import { renderEmbeddedSqlModule } from "../src/embedded-sql";
import {
  publishOfflinePrepareArtifacts,
  publishPrepareArtifacts,
} from "../src/prepare-artifacts";

function entry(query: string, filePaths: string[]): CacheEntry {
  return {
    query,
    filePaths,
    hasInline: false,
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

test("embedded SQL module is deterministic and rejects divergent file contracts", () => {
  const module = renderEmbeddedSqlModule([
    entry("SELECT 2", ["queries/z.sql"]),
    entry("SELECT 1", ["queries/a.sql"]),
  ]);
  expect(module.indexOf('"queries/a.sql"')).toBeLessThan(module.indexOf('"queries/z.sql"'));
  expect(module).toContain('"queries/a.sql": "SELECT 1"');
  expect(() => renderEmbeddedSqlModule([
    entry("SELECT 1", ["queries/a.sql"]),
    entry("SELECT 2", ["queries/a.sql"]),
  ])).toThrow(/resolves to multiple query texts/);
});

test("prepare and offline regeneration publish embedded SQL with generated artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-embedded-artifacts-"));
  try {
    const cacheDir = join(root, ".sqlx-js");
    const dtsPath = join(root, "sqlx-js-env.d.ts");
    const output = join(root, "generated/sql-files.ts");
    const query = entry("SELECT 1", ["queries/one.sql"]);
    const content = renderEmbeddedSqlModule([query]);
    publishPrepareArtifacts({
      cacheDir,
      dtsPath,
      generated: [{ fp: fingerprint(query.query), entry: query }],
      entries: [query],
      functions: [],
      enums: [],
      enumCatalogEnabled: false,
      embeddedSqlModule: { path: output, content },
      configHash: "config",
      customTypes: {},
      profiles: {},
      prune: true,
    });
    expect(readFileSync(output, "utf8")).toBe(content);

    rmSync(output);
    publishOfflinePrepareArtifacts({
      cacheDir,
      dtsPath,
      entries: [query],
      functions: [],
      embeddedSqlModule: { path: output, content },
      configHash: "config",
      customTypes: {},
      profiles: {},
    });
    expect(existsSync(output)).toBe(true);
    expect(readFileSync(output, "utf8")).toBe(content);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
