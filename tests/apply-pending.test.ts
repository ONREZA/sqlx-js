import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  applyPending,
  inspectMigrationPlan,
  inspectMigrations,
  planPending,
  type ApplyOutcome,
  type PlanOutcome,
} from "../src/commands/migrate";
import type { PgClient } from "../src/pg/wire";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sqlx-js-apply-"));
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
  migrationSchema = "app";
  migrationTableExists = false;
  inTx = false;
  txInserts: AppliedRecord[] = [];
  txDeletes: number[] = [];
  failOnUpSql: string | null = null;
  failOnRollback = false;
  calls: string[] = [];
  paramSql: string[] = [];

  async simpleQuery(sql: string): Promise<any> {
    this.calls.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
    if (/to_regclass\('_sqlx_js_migrations'\)/i.test(sql)) {
      const rows = this.migrationTableExists
        ? [[utf8(this.migrationSchema), utf8("_sqlx_js_migrations")]]
        : [];
      return { rows, fields: [], tag: "SELECT" };
    }
    if (/CREATE TABLE/i.test(sql)) {
      this.migrationTableExists = true;
      return { rows: [], fields: [], tag: "CREATE TABLE" };
    }
    if (/^SELECT version, name, up_hash/i.test(sql.trim())) {
      const rows = this.applied
        .slice()
        .sort((a, b) => a.version - b.version)
        .map((r) => [utf8(String(r.version)), utf8(r.name), utf8(r.hash)]);
      return { rows, fields: [], tag: "SELECT" };
    }
    if (sql.trim() === "BEGIN") { this.inTx = true; this.txInserts = []; this.txDeletes = []; return { rows: [], fields: [], tag: "BEGIN" }; }
    if (sql.trim() === "COMMIT") {
      this.inTx = false;
      this.applied = this.applied.filter((r) => !this.txDeletes.includes(r.version));
      this.applied.push(...this.txInserts);
      this.txInserts = [];
      this.txDeletes = [];
      return { rows: [], fields: [], tag: "COMMIT" };
    }
    if (sql.trim() === "ROLLBACK") {
      if (this.failOnRollback) throw new Error("rollback boom");
      this.inTx = false;
      this.txInserts = [];
      this.txDeletes = [];
      return { rows: [], fields: [], tag: "ROLLBACK" };
    }
    if (this.failOnUpSql !== null && sql.includes(this.failOnUpSql)) {
      throw new Error(`mock failure on up SQL containing "${this.failOnUpSql}"`);
    }
    return { rows: [], fields: [], tag: "OK" };
  }

  async execParamsText(sql: string, params: (string | null)[]): Promise<any> {
    this.calls.push("execParamsText");
    this.paramSql.push(sql);
    if (/INSERT INTO .*_sqlx_js_migrations/i.test(sql)) {
      const [version, name, h] = params;
      this.txInserts.push({ version: Number(version), name: name!, hash: h! });
      return { rows: [], fields: [], tag: "INSERT 0 1" };
    }
    if (/DELETE FROM .*_sqlx_js_migrations/i.test(sql)) {
      const [version] = params;
      this.txDeletes.push(Number(version));
      return { rows: [], fields: [], tag: "DELETE 1" };
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

  test("planPending validates pending migrations without creating the migration table or applying DDL", async () => {
    const d = newDir();
    writeMigration(d, 1, "create_users", "CREATE TABLE users (id int)");
    writeMigration(d, 2, "add_index", "CREATE INDEX users_idx ON users(id)");
    const mock = new MockClient();
    const events: PlanOutcome[] = [];

    const result = await planPending(asClient(mock), d, (e) => events.push(e));

    expect(result.pending).toBe(2);
    expect(result.adoptable).toBe(0);
    expect(result.steps).toEqual([
      { kind: "apply", version: 1, name: "create_users" },
      { kind: "apply", version: 2, name: "add_index" },
    ]);
    expect(events.map((e) => e.kind)).toEqual(["pending", "pending"]);
    expect(mock.calls).not.toContain("CREATE TABLE IF");
    expect(mock.calls).not.toContain("BEGIN");
    expect(mock.applied).toHaveLength(0);
  });

  test("inspectMigrations reports a read-only status summary", async () => {
    const d = newDir();
    writeMigration(d, 1, "create_users", "CREATE TABLE users (id int)");
    writeMigration(d, 2, "add_index", "CREATE INDEX users_idx ON users(id)");
    const mock = new MockClient();
    mock.migrationTableExists = true;
    mock.applied.push({ version: 1, name: "create_users", hash: hash("CREATE TABLE users (id int)") });

    const info = await inspectMigrations(asClient(mock), d);

    expect(info.historyTable).toBe('"app"."_sqlx_js_migrations"');
    expect(info.summary).toMatchObject({ applied: 1, pending: 1, adoptable: 0, superseded: 0, tampered: 0, failed: 0 });
    expect(info.items.map((i) => `${i.version}:${i.status}`)).toEqual(["1:applied", "2:pending"]);
    expect(mock.calls).not.toContain("CREATE TABLE IF");
  });

  test("inspectMigrationPlan returns structured dry-run diagnostics", async () => {
    const d = newDir();
    const original = "SELECT 1 -- original";
    const changed = "SELECT 1 -- changed";
    writeMigration(d, 1, "one", original);
    const metadata = {
      format: 1,
      replaces: [{ version: 1, name: "one", upHash: hash(original) }],
    };
    writeMigration(d, 2, "baseline", `-- sqlx-js-squash: ${JSON.stringify(metadata)}\nCREATE TABLE users (id int);\n`);
    writeMigration(d, 1, "one", changed);
    const mock = new MockClient();

    const plan = await inspectMigrationPlan(asClient(mock), d);

    expect(plan.ok).toBe(false);
    expect(plan).toMatchObject({ pending: 0, adoptable: 0, tampered: 1, failed: 0, steps: [] });
    expect(plan.diagnostics).toHaveLength(1);
    expect(plan.diagnostics[0]).toMatchObject({ kind: "tampered", version: 1, name: "one" });
    expect(mock.calls).not.toContain("CREATE TABLE IF");
    expect(mock.calls).not.toContain("BEGIN");
  });

  test("uses the resolved migration table instead of hard-coding public", async () => {
    const d = newDir();
    writeMigration(d, 1, "create_users", "CREATE TABLE users (id int)");
    const mock = new MockClient();
    mock.migrationSchema = "app";

    await applyPending(asClient(mock), d);

    expect(mock.paramSql[0]).toContain('"app"."_sqlx_js_migrations"');
  });

  test("reuses an existing visible migration table before creating a new one", async () => {
    const d = newDir();
    writeMigration(d, 1, "create_users", "CREATE TABLE users (id int)");
    const mock = new MockClient();
    mock.migrationSchema = "legacy";
    mock.migrationTableExists = true;

    await applyPending(asClient(mock), d);

    expect(mock.calls).not.toContain("CREATE TABLE IF");
    expect(mock.paramSql[0]).toContain('"legacy"."_sqlx_js_migrations"');
  });

  test("adopts squash migration when all replaced rows are already applied", async () => {
    const d = newDir();
    const one = "CREATE TABLE users (id int)";
    const two = "CREATE INDEX users_idx ON users(id)";
    writeMigration(d, 1, "create_users", one);
    writeMigration(d, 2, "add_index", two);
    const metadata = {
      format: 1,
      replaces: [
        { version: 1, name: "create_users", upHash: hash(one) },
        { version: 2, name: "add_index", upHash: hash(two) },
      ],
    };
    writeMigration(d, 3, "baseline", `-- sqlx-js-squash: ${JSON.stringify(metadata)}\nCREATE TABLE users (id int);\n`);

    const mock = new MockClient();
    mock.applied.push(
      { version: 1, name: "create_users", hash: hash(one) },
      { version: 2, name: "add_index", hash: hash(two) },
    );
    const events: ApplyOutcome[] = [];
    const result = await applyPending(asClient(mock), d, (e) => events.push(e));

    expect(result).toEqual({ applied: 1, tampered: 0, failed: 0 });
    expect(mock.applied.map((r) => r.version)).toEqual([3]);
    expect(events.map((e) => e.kind)).toEqual(["adopted"]);

    mock.failOnUpSql = "CREATE TABLE users";
    const second = await applyPending(asClient(mock), d);
    expect(second).toEqual({ applied: 0, tampered: 0, failed: 0 });
    expect(mock.applied.map((r) => r.version)).toEqual([3]);
  });

  test("squash migration runs as a normal baseline on an empty database", async () => {
    const d = newDir();
    const metadata = {
      format: 1,
      replaces: [{ version: 1, name: "old", upHash: hash("SELECT 1") }],
    };
    writeMigration(d, 2, "baseline", `-- sqlx-js-squash: ${JSON.stringify(metadata)}\nCREATE TABLE users (id int);\n`);

    const mock = new MockClient();
    const events: ApplyOutcome[] = [];
    const result = await applyPending(asClient(mock), d, (e) => events.push(e));

    expect(result).toEqual({ applied: 1, tampered: 0, failed: 0 });
    expect(mock.applied.map((r) => r.version)).toEqual([2]);
    expect(events.map((e) => e.kind)).toEqual(["applied"]);
  });

  test("squash migration fails closed on partially applied replacement history", async () => {
    const d = newDir();
    const one = "SELECT 1";
    const metadata = {
      format: 1,
      replaces: [
        { version: 1, name: "one", upHash: hash(one) },
        { version: 2, name: "two", upHash: hash("SELECT 2") },
      ],
    };
    writeMigration(d, 3, "baseline", `-- sqlx-js-squash: ${JSON.stringify(metadata)}\nCREATE TABLE users (id int);\n`);

    const mock = new MockClient();
    mock.applied.push({ version: 1, name: "one", hash: hash(one) });
    const events: ApplyOutcome[] = [];
    const result = await applyPending(asClient(mock), d, (e) => events.push(e));

    expect(result).toEqual({ applied: 0, tampered: 0, failed: 1 });
    expect(mock.applied.map((r) => r.version)).toEqual([1]);
    expect(events.map((e) => e.kind)).toEqual(["failed"]);
  });

  test("squash preflight fails partial replacement history before applying old files", async () => {
    const d = newDir();
    const one = "SELECT 1 -- one";
    const two = "SELECT 2 -- two";
    writeMigration(d, 1, "one", one);
    writeMigration(d, 2, "two", two);
    const metadata = {
      format: 1,
      replaces: [
        { version: 1, name: "one", upHash: hash(one) },
        { version: 2, name: "two", upHash: hash(two) },
      ],
    };
    writeMigration(d, 3, "baseline", `-- sqlx-js-squash: ${JSON.stringify(metadata)}\nCREATE TABLE users (id int);\n`);

    const mock = new MockClient();
    mock.applied.push({ version: 1, name: "one", hash: hash(one) });
    const events: ApplyOutcome[] = [];
    const result = await applyPending(asClient(mock), d, (e) => events.push(e));

    expect(result).toEqual({ applied: 0, tampered: 0, failed: 1 });
    expect(mock.applied.map((r) => r.version)).toEqual([1]);
    expect(mock.calls).not.toContain("BEGIN");
    expect(events.map((e) => e.kind)).toEqual(["failed"]);
  });

  test("squash preflight rejects changed replacement files before replaying them", async () => {
    const d = newDir();
    const original = "SELECT 1 -- original";
    const changed = "SELECT 1 -- changed";
    writeMigration(d, 1, "one", original);
    const metadata = {
      format: 1,
      replaces: [{ version: 1, name: "one", upHash: hash(original) }],
    };
    writeMigration(d, 2, "baseline", `-- sqlx-js-squash: ${JSON.stringify(metadata)}\nCREATE TABLE users (id int);\n`);
    writeMigration(d, 1, "one", changed);

    const mock = new MockClient();
    const events: ApplyOutcome[] = [];
    const result = await applyPending(asClient(mock), d, (e) => events.push(e));

    expect(result).toEqual({ applied: 0, tampered: 1, failed: 0 });
    expect(mock.applied).toHaveLength(0);
    expect(mock.calls).not.toContain("BEGIN");
    expect(events.map((e) => e.kind)).toEqual(["tampered"]);
    const event = events[0];
    if (event?.kind !== "tampered") throw new Error("unreachable");
    expect(event.applied).toBe(hash(original));
    expect(event.current).toBe(hash(changed));
  });

  test("repeated squash supersedes nested replacement history transitively", async () => {
    const d = newDir();
    const one = "SELECT 1 -- one";
    const two = "SELECT 2 -- two";
    const addName = "ALTER TABLE users ADD COLUMN name text";
    const firstMetadata = {
      format: 1,
      replaces: [
        { version: 1, name: "one", upHash: hash(one) },
        { version: 2, name: "two", upHash: hash(two) },
      ],
    };
    const firstBaseline = `-- sqlx-js-squash: ${JSON.stringify(firstMetadata)}\nCREATE TABLE users (id int);\n`;
    const secondMetadata = {
      format: 1,
      replaces: [
        { version: 3, name: "baseline", upHash: hash(firstBaseline) },
        { version: 4, name: "add_name", upHash: hash(addName) },
      ],
    };
    const secondBaseline = `-- sqlx-js-squash: ${JSON.stringify(secondMetadata)}\nCREATE TABLE users (id int, name text);\n`;
    writeMigration(d, 1, "one", one);
    writeMigration(d, 2, "two", two);
    writeMigration(d, 3, "baseline", firstBaseline);
    writeMigration(d, 4, "add_name", addName);
    writeMigration(d, 5, "second_baseline", secondBaseline);
    const mock = new MockClient();
    mock.migrationTableExists = true;
    mock.applied.push({ version: 5, name: "second_baseline", hash: hash(secondBaseline) });
    const events: ApplyOutcome[] = [];

    const result = await applyPending(asClient(mock), d, (e) => events.push(e));

    expect(result).toEqual({ applied: 0, tampered: 0, failed: 0 });
    expect(events).toEqual([]);
    expect(mock.calls).not.toContain("BEGIN");
  });
});
