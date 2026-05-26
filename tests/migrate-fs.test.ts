import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateAdd } from "../src/commands/migrate";

const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sqlx-js-mig-"));
  dirs.push(d);
  return d;
}

describe("migrateAdd", () => {
  test("creates both .up.sql and .down.sql", () => {
    const d = newDir();
    migrateAdd({ databaseUrl: "", migrationsDir: d, name: "create_users" });
    expect(existsSync(join(d, "0001_create_users.up.sql"))).toBe(true);
    expect(existsSync(join(d, "0001_create_users.down.sql"))).toBe(true);
    expect(readFileSync(join(d, "0001_create_users.up.sql"), "utf8")).toContain("create_users");
    expect(readFileSync(join(d, "0001_create_users.down.sql"), "utf8")).toContain("revert");
  });

  test("normalises unsafe characters in the name", () => {
    const d = newDir();
    migrateAdd({ databaseUrl: "", migrationsDir: d, name: "Add Foo'Bar; DROP--" });
    const files = require("node:fs").readdirSync(d) as string[];
    const up = files.find((f) => f.endsWith(".up.sql"))!;
    expect(up).toMatch(/^0001_[A-Za-z0-9_-]+\.up\.sql$/);
    expect(up).not.toContain(" ");
    expect(up).not.toContain("'");
    expect(up).not.toContain(";");
  });

  test("rejects names that normalise to empty", () => {
    const d = newDir();
    expect(() => migrateAdd({ databaseUrl: "", migrationsDir: d, name: "...$$$" }))
      .toThrow(/invalid migration name/);
  });

  test("does not overwrite existing .down.sql", () => {
    const d = newDir();
    migrateAdd({ databaseUrl: "", migrationsDir: d, name: "foo" });
    writeFileSync(join(d, "0001_foo.down.sql"), "-- custom down\n");
    migrateAdd({ databaseUrl: "", migrationsDir: d, name: "bar" });
    expect(readFileSync(join(d, "0001_foo.down.sql"), "utf8")).toBe("-- custom down\n");
    expect(existsSync(join(d, "0002_bar.up.sql"))).toBe(true);
    expect(existsSync(join(d, "0002_bar.down.sql"))).toBe(true);
  });
});

describe("readMigrations name validation", () => {
  test("throws when an existing migration has unsafe characters in its name", () => {
    const d = newDir();
    writeFileSync(join(d, "0001_safe_name.up.sql"), "SELECT 1");
    writeFileSync(join(d, `0002_b'ad.up.sql`), "SELECT 2");
    expect(() => migrateAdd({ databaseUrl: "", migrationsDir: d, name: "ok" }))
      .toThrow(/unsafe migration filename/);
  });
});
