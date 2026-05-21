import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { applyPending, type ApplyOutcome } from "../src/commands/migrate";
import type { PgClient } from "../src/pg/wire";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "bun-sqlx-apply-"));
  dirs.push(d);
  return d;
}

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

type AppliedRecord = { version: number; name: string; hash: string };

class MockClient {
  applied: AppliedRecord[] = [];
  inTx = false;
  txInserts: AppliedRecord[] = [];
  failOnUpSql: string | null = null;
  failOnRollback = false;
  calls: string[] = [];

  async simpleQuery(sql: string): Promise<any> {
    this.calls.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
    if (/CREATE TABLE/i.test(sql)) return { rows: [], fields: [], tag: "CREATE TABLE" };
    if (/^SELECT version, name, up_hash/i.test(sql.trim())) {
      const rows = this.applied
        .slice()
        .sort((a, b) => a.version - b.version)
        .map((r) => [utf8(String(r.version)), utf8(r.name), utf8(r.hash)]);
      return { rows, fields: [], tag: "SELECT" };
    }
    if (sql.trim() === "BEGIN") { this.inTx = true; this.txInserts = []; return { rows: [], fields: [], tag: "BEGIN" }; }
    if (sql.trim() === "COMMIT") {
      this.inTx = false;
      this.applied.push(...this.txInserts);
      this.txInserts = [];
      return { rows: [], fields: [], tag: "COMMIT" };
    }
    if (sql.trim() === "ROLLBACK") {
      if (this.failOnRollback) throw new Error("rollback boom");
      this.inTx = false;
      this.txInserts = [];
      return { rows: [], fields: [], tag: "ROLLBACK" };
    }
    if (this.failOnUpSql !== null && sql.includes(this.failOnUpSql)) {
      throw new Error(`mock failure on up SQL containing "${this.failOnUpSql}"`);
    }
    return { rows: [], fields: [], tag: "OK" };
  }

  async execParamsText(sql: string, params: (string | null)[]): Promise<any> {
    this.calls.push("execParamsText");
    if (/INSERT INTO _bun_sqlx_migrations/i.test(sql)) {
      const [version, name, h] = params;
      this.txInserts.push({ version: Number(version), name: name!, hash: h! });
      return { rows: [], fields: [], tag: "INSERT 0 1" };
    }
    return { rows: [], fields: [], tag: "OK" };
  }
}

function asClient(m: MockClient): PgClient {
  return m as unknown as PgClient;
}

function writeMigration(dir: string, version: number, name: string, sql: string): void {
  const padded = String(version).padStart(4, "0");
  writeFileSync(join(dir, `${padded}_${name}.up.sql`), sql);
}

describe("applyPending with mock client", () => {
  test("applies pending migrations and records them", async () => {
    const d = newDir();
    writeMigration(d, 1, "create_users", "CREATE TABLE users (id int)");
    writeMigration(d, 2, "add_index", "CREATE INDEX users_idx ON users(id)");

    const mock = new MockClient();
    const events: ApplyOutcome[] = [];
    const result = await applyPending(asClient(mock), d, (e) => events.push(e));

    expect(result).toEqual({ applied: 2, tampered: 0, failed: 0 });
    expect(mock.applied.map((r) => r.version)).toEqual([1, 2]);
    expect(events.map((e) => e.kind)).toEqual(["applied", "applied"]);
  });

  test("is idempotent: second run applies nothing", async () => {
    const d = newDir();
    writeMigration(d, 1, "create_users", "CREATE TABLE users (id int)");
    const mock = new MockClient();
    await applyPending(asClient(mock), d);
    const r2 = await applyPending(asClient(mock), d);
    expect(r2).toEqual({ applied: 0, tampered: 0, failed: 0 });
    expect(mock.applied).toHaveLength(1);
  });

  test("emits tampered event when up_hash diverged from disk", async () => {
    const d = newDir();
    writeMigration(d, 1, "x", "CREATE TABLE t1 (id int)");
    const mock = new MockClient();
    mock.applied.push({ version: 1, name: "x", hash: hash("DIFFERENT") });
    writeMigration(d, 2, "y", "CREATE TABLE t2 (id int)");

    const events: ApplyOutcome[] = [];
    const result = await applyPending(asClient(mock), d, (e) => events.push(e));

    expect(result).toEqual({ applied: 0, tampered: 1, failed: 0 });
    expect(events[0]!.kind).toBe("tampered");
    expect(mock.applied).toHaveLength(1);
  });

  test("mid-batch failure rolls back and stops", async () => {
    const d = newDir();
    writeMigration(d, 1, "ok_one", "SELECT 1 -- ok_one");
    writeMigration(d, 2, "boom", "SELECT 2 -- boom");
    writeMigration(d, 3, "ok_three", "SELECT 3 -- ok_three");

    const mock = new MockClient();
    mock.failOnUpSql = "boom";
    const events: ApplyOutcome[] = [];
    const result = await applyPending(asClient(mock), d, (e) => events.push(e));

    expect(result).toEqual({ applied: 1, tampered: 0, failed: 1 });
    expect(mock.applied.map((r) => r.name)).toEqual(["ok_one"]);
    expect(events[1]!.kind).toBe("failed");
    expect(mock.calls).toContain("ROLLBACK");
  });

  test("rollback failure surfaces in the failed-event message", async () => {
    const d = newDir();
    writeMigration(d, 1, "explode", "SELECT 1 -- explode");
    const mock = new MockClient();
    mock.failOnUpSql = "explode";
    mock.failOnRollback = true;
    const events: ApplyOutcome[] = [];
    await applyPending(asClient(mock), d, (e) => events.push(e));
    const failed = events.find((e) => e.kind === "failed");
    expect(failed).toBeDefined();
    if (failed?.kind !== "failed") throw new Error("unreachable");
    expect(failed.error).toContain("rollback also failed");
    expect(failed.error).toContain("rollback boom");
  });

  test("INSERT goes through execParamsText (no SQL string interpolation of name)", async () => {
    const d = newDir();
    writeMigration(d, 1, "evil_quote", "CREATE TABLE t (id int)");
    const mock = new MockClient();
    await applyPending(asClient(mock), d);
    expect(mock.applied[0]!.name).toBe("evil_quote");
    expect(mock.calls).toContain("execParamsText");
  });
});
