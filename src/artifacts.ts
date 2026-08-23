import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_DESCRIPTOR_FILE } from "./artifact-versions";
import { CACHE_MANIFEST_FILE, isQueryCacheFileName } from "./cache";

export type ArtifactSet = {
  cacheDir: string;
  dtsPath: string;
  functionOutputPath?: string;
  functionArtifactName?: string;
  enumOutputPath?: string;
  enumArtifactName?: string;
  errorOutputPath?: string;
  errorArtifactName?: string;
  embeddedSqlOutputPath?: string;
  embeddedSqlArtifactName?: string;
};

export type ArtifactComparison = {
  ok: boolean;
  changed: string[];
};

function readGeneratedFiles(set: ArtifactSet): Map<string, string> {
  const files = new Map<string, string>();
  if (existsSync(set.cacheDir)) {
    for (const name of readdirSync(set.cacheDir).sort()) {
      if (
        name !== CACHE_MANIFEST_FILE
        && name !== RUNTIME_DESCRIPTOR_FILE
        && !isQueryCacheFileName(name)
      ) continue;
      files.set(`cache/${name}`, readFileSync(join(set.cacheDir, name), "utf8"));
    }
    for (const name of ["functions/functions.json", "enums/enums.json", "errors/errors.json"]) {
      const path = join(set.cacheDir, name);
      if (existsSync(path)) files.set(`cache/${name}`, readFileSync(path, "utf8"));
    }
  }
  if (existsSync(set.dtsPath)) files.set("sqlx-js-env.d.ts", readFileSync(set.dtsPath, "utf8"));
  if (set.functionOutputPath && existsSync(set.functionOutputPath)) {
    files.set(
      set.functionArtifactName ?? "sqlx-js-functions.ts",
      readFileSync(set.functionOutputPath, "utf8"),
    );
  }
  if (set.enumOutputPath && existsSync(set.enumOutputPath)) {
    files.set(set.enumArtifactName ?? "sqlx-js-enums.ts", readFileSync(set.enumOutputPath, "utf8"));
  }
  if (set.errorOutputPath && existsSync(set.errorOutputPath)) {
    files.set(set.errorArtifactName ?? "sqlx-js-errors.ts", readFileSync(set.errorOutputPath, "utf8"));
  }
  if (set.embeddedSqlOutputPath && existsSync(set.embeddedSqlOutputPath)) {
    files.set(
      set.embeddedSqlArtifactName ?? "sqlx-js-sql-files.ts",
      readFileSync(set.embeddedSqlOutputPath, "utf8"),
    );
  }
  return files;
}

export function compareArtifacts(expected: ArtifactSet, actual: ArtifactSet): ArtifactComparison {
  const left = readGeneratedFiles(expected);
  const right = readGeneratedFiles(actual);
  const names = new Set([...left.keys(), ...right.keys()]);
  const changed = [...names].filter((name) => left.get(name) !== right.get(name)).sort();
  return { ok: changed.length === 0, changed };
}
