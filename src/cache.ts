import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";

export type CacheColumn = {
  name: string;
  typeOid: number;
  tsType: string;
  nullable: boolean;
  override?: "non-null" | "nullable";
};

export type CacheEntry = {
  query: string;
  paramOids: number[];
  paramTsTypes: string[];
  paramNullable?: boolean[];
  columns: CacheColumn[];
  hasResultSet: boolean;
  hasInline?: boolean;
  filePaths?: string[];
  degraded?: { reason: string };
};

export function fingerprint(query: string): string {
  const norm = query.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(norm).digest("hex").slice(0, 16);
}

export function effectiveNullable(c: CacheColumn): boolean {
  if (c.override === "non-null") return false;
  if (c.override === "nullable") return true;
  return c.nullable;
}

function parseEntryJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`sqlx-js: cannot read cache entry ${path}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`sqlx-js: cache entry ${path} is not valid JSON: ${(err as Error).message}`);
  }
}

function assertEntryShape(fp: string, raw: unknown): CacheEntry {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { columns?: unknown }).columns)) {
    throw new Error(`sqlx-js: cache entry ${fp}.json is malformed`);
  }
  const cols = (raw as { columns: unknown[] }).columns;
  if (cols.length > 0) {
    const c = cols[0] as Record<string, unknown>;
    if ("forceNonNull" in c || "forceNullable" in c) {
      throw new Error(
        `sqlx-js: cache entry ${fp}.json uses an older schema ` +
        `(columns.forceNonNull/forceNullable). Re-run \`sqlx-js prepare\` to regenerate.`,
      );
    }
  }
  return raw as CacheEntry;
}

export class Cache {
  constructor(private dir: string) {}

  ensure(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  has(fp: string): boolean {
    return existsSync(join(this.dir, `${fp}.json`));
  }

  read(fp: string): CacheEntry | null {
    const p = join(this.dir, `${fp}.json`);
    if (!existsSync(p)) return null;
    return assertEntryShape(fp, parseEntryJson(p));
  }

  write(fp: string, entry: CacheEntry): void {
    this.ensure();
    const final = join(this.dir, `${fp}.json`);
    const tmp = `${final}.tmp-${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(entry, null, 2));
    try {
      renameSync(tmp, final);
    } catch (err) {
      try { unlinkSync(tmp); } catch {}
      throw err;
    }
  }

  list(): { fp: string; entry: CacheEntry }[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json") && !f.includes(".tmp-"))
      .map((f) => {
        const fp = f.replace(/\.json$/, "");
        return { fp, entry: assertEntryShape(fp, parseEntryJson(join(this.dir, f))) };
      });
  }

  remove(fp: string): void {
    const p = join(this.dir, `${fp}.json`);
    if (existsSync(p)) unlinkSync(p);
  }

  prune(keep: Iterable<string>): string[] {
    const keepSet = new Set(keep);
    const removed: string[] = [];
    for (const { fp } of this.list()) {
      if (!keepSet.has(fp)) {
        this.remove(fp);
        removed.push(fp);
      }
    }
    return removed;
  }
}
