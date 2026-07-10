import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CACHE_MANIFEST_FILE } from "./cache";

export type ArtifactSet = {
  cacheDir: string;
  dtsPath: string;
};

export type ArtifactComparison = {
  ok: boolean;
  changed: string[];
};

function readGeneratedFiles(set: ArtifactSet): Map<string, string> {
  const files = new Map<string, string>();
  if (existsSync(set.cacheDir)) {
    for (const name of readdirSync(set.cacheDir).sort()) {
      if (name !== CACHE_MANIFEST_FILE && !/^[0-9a-f]{16}\.json$/.test(name)) continue;
      files.set(`cache/${name}`, readFileSync(join(set.cacheDir, name), "utf8"));
    }
    const functions = join(set.cacheDir, "functions/functions.json");
    if (existsSync(functions)) files.set("cache/functions/functions.json", readFileSync(functions, "utf8"));
  }
  if (existsSync(set.dtsPath)) files.set("sqlx-js-env.d.ts", readFileSync(set.dtsPath, "utf8"));
  return files;
}

export function compareArtifacts(expected: ArtifactSet, actual: ArtifactSet): ArtifactComparison {
  const left = readGeneratedFiles(expected);
  const right = readGeneratedFiles(actual);
  const names = new Set([...left.keys(), ...right.keys()]);
  const changed = [...names].filter((name) => left.get(name) !== right.get(name)).sort();
  return { ok: changed.length === 0, changed };
}
