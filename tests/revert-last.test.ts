import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { checkLastDownMigration, revertLast } from "../src/commands/migrate";
import type { PgClient } from "../src/pg/wire";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const newDir = () => { const d = mkdtempSync(join(tmpdir(), "sqlx-js-revert-")); dirs.push(d); return d; };

const utf8 = (s: string) => new TextEncoder().encode(s);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

type AppliedRow = { version: number; name: string; hash: string };

class MockClient {
  applied: AppliedRow[] = [];
  migrationTableExists = false;
  failOnDownSql: string | null = null;
  failOnRollback = false;
  calls: string[] = [];

  async simpleQuery(sql: string): Promise<any> {
    this.calls.push(sql.trim().split(/\s+/)[0]!);
    if (/to_regclass\('_sqlx_js_migrations'\)/i.test(sql)) {
      const rows = this.migrationTableExists ? [[utf8("app"), utf8("_sqlx_js_migrations")]] : [];
      return { rows, fields: [], tag: "SELECT" };
    }
    if (/CREATE TABLE/i.test(sql)) {
      this.migrationTableExists = true;
      return { rows: [], fields: [], tag: "OK" };
    }
    if (/^SELECT version, name, up_hash/i.test(sql.trim())) {
      const rows = this.applied
        .slice().sort((a, b) => a.version - b.version)
        .map((r) => [utf8(String(r.version)), utf8(r.name), utf8(r.hash)]);
      return { rows, fields: [], tag: "SELECT" };
    }
    if (sql.trim() === "BEGIN" || sql.trim() === "COMMIT") return { rows: [], fields: [], tag: "OK" };
    if (sql.trim() === "ROLLBACK") {
      if (this.failOnRollback) throw new Error("rollback boom");
      return { rows: [], fields: [], tag: "ROLLBACK" };
    }
    if (this.failOnDownSql !== null && sql.includes(this.failOnDownSql)) {
      throw new Error(`down boom on "${this.failOnDownSql}"`);
    }
    return { rows: [], fields: [], tag: "OK" };
  }

  async execParamsText(sql: string, params: (string | null)[]): Promise<any> {
    this.calls.push("execParamsText");
    if (/DELETE FROM .*_sqlx_js_migrations/i.test(sql)) {
      const v = Number(params[0]);
      this.applied = this.applied.filter((r) => r.version !== v);
    }
    return { rows: [], fields: [], tag: "OK" };
  }
}

const asClient = (m: unknown): PgClient => m as PgClient;

function writeMig(dir: string, version: number, name: string, up: string, down?: string): void {
  const padded = String(version).padStart(4, "0");
  writeFileSync(join(dir, `${padded}_${name}.up.sql`), up);
  if (down !== undefined) writeFileSync(join(dir, `${padded}_${name}.down.sql`), down);
}

describe("revertLast", () => {
  test("noop when nothing applied", async () => {
    const d = newDir();
    writeMig(d, 1, "x", "CREATE TABLE t (id int)", "DROP TABLE t");
    const m = new MockClient();
    const r = await revertLast(asClient(m), d);
    expect(r.kind).toBe("noop");
  });

  test("reverts the last applied migration and deletes its row", async () => {
    const d = newDir();
    writeMig(d, 1, "create_t", "CREATE TABLE t (id int)", "DROP TABLE t");
    writeMig(d, 2, "add_idx", "CREATE INDEX i ON t (id)", "DROP INDEX i");
    const m = new MockClient();
    m.applied.push({ version: 1, name: "create_t", hash: hash("CREATE TABLE t (id int)") });
    m.applied.push({ version: 2, name: "add_idx", hash: hash("CREATE INDEX i ON t (id)") });

    const r = await revertLast(asClient(m), d);
    expect(r.kind).toBe("reverted");
    if (r.kind === "reverted") expect(r.version).toBe(2);
    expect(m.applied.map((x) => x.version)).toEqual([1]);
    expect(m.calls).toContain("execParamsText");
  });

  test("no-down when last applied migration lacks .down.sql", async () => {
    const d = newDir();
    writeMig(d, 1, "no_down", "CREATE TABLE t (id int)");
    const m = new MockClient();
    m.applied.push({ version: 1, name: "no_down", hash: hash("CREATE TABLE t (id int)") });
    const r = await revertLast(asClient(m), d);
    expect(r.kind).toBe("no-down");
  });

  test("failed event when down SQL throws (and triggers rollback)", async () => {
    const d = newDir();
    writeMig(d, 1, "explode", "CREATE TABLE t (id int)", "DROP TABLE BOOM");
    const m = new MockClient();
    m.failOnDownSql = "DROP TABLE BOOM";
    m.applied.push({ version: 1, name: "explode", hash: hash("CREATE TABLE t (id int)") });
    const r = await revertLast(asClient(m), d);
    expect(r.kind).toBe("failed");
    if (r.kind !== "failed") throw new Error("unreachable");
    expect(r.error).toContain("down boom");
    expect(m.calls).toContain("ROLLBACK");
    expect(m.applied).toHaveLength(1);
  });

  test("rollback failure is surfaced in the error message", async () => {
    const d = newDir();
    writeMig(d, 1, "explode", "CREATE TABLE t (id int)", "DROP TABLE BOOM");
    const m = new MockClient();
    m.failOnDownSql = "DROP TABLE BOOM";
    m.failOnRollback = true;
    m.applied.push({ version: 1, name: "explode", hash: hash("CREATE TABLE t (id int)") });
    const r = await revertLast(asClient(m), d);
    if (r.kind !== "failed") throw new Error("unreachable");
    expect(r.error).toContain("rollback also failed");
    expect(r.error).toContain("rollback boom");
  });
});

describe("checkLastDownMigration", () => {
  test("noop when no migration files exist", async () => {
    const d = newDir();
    const m = new MockClient();

    const r = await checkLastDownMigration(asClient(m), d);

    expect(r).toEqual({ kind: "noop" });
    expect(m.calls).not.toContain("BEGIN");
  });

  test("no-down when latest migration lacks .down.sql", async () => {
    const d = newDir();
    writeMig(d, 1, "base", "CREATE TABLE t (id int)", "DROP TABLE t");
    writeMig(d, 2, "latest", "ALTER TABLE t ADD COLUMN name text");
    const m = new MockClient();

    const r = await checkLastDownMigration(asClient(m), d);

    expect(r).toEqual({ kind: "no-down", version: 2, name: "latest" });
    expect(m.calls).not.toContain("BEGIN");
  });
});
