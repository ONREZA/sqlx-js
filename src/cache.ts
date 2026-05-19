import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export type CacheEntry = {
  query: string;
  paramOids: number[];
  paramTsTypes: string[];
  paramNullable?: boolean[];
  columns: {
    name: string;
    typeOid: number;
    tsType: string;
    nullable: boolean;
    forceNonNull: boolean;
    forceNullable: boolean;
  }[];
  hasResultSet: boolean;
  hasInline?: boolean;
  filePaths?: string[];
};

export function fingerprint(query: string): string {
  const norm = query.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(norm).digest("hex").slice(0, 16);
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
    return JSON.parse(readFileSync(p, "utf8")) as CacheEntry;
  }

  write(fp: string, entry: CacheEntry): void {
    this.ensure();
    writeFileSync(join(this.dir, `${fp}.json`), JSON.stringify(entry, null, 2));
  }

  list(): { fp: string; entry: CacheEntry }[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({
        fp: f.replace(/\.json$/, ""),
        entry: JSON.parse(readFileSync(join(this.dir, f), "utf8")) as CacheEntry,
      }));
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
