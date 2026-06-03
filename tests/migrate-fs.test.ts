import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  checkMigrationFiles,
  createSquashMigration,
  dumpSchema,
  listMigrationArchives,
  migrateAdd,
  restoreMigrationArchive,
  sanitizePgDumpSchema,
} from "../src/commands/migrate";

const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sqlx-js-mig-"));
  dirs.push(d);
  return d;
}

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex");
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

describe("checkMigrationFiles", () => {
  test("passes a valid migration directory without DATABASE_URL", () => {
    const d = newDir();
    writeFileSync(join(d, "0001_create_users.up.sql"), "CREATE TABLE users (id int);\n");
    writeFileSync(join(d, "0001_create_users.down.sql"), "DROP TABLE users;\n");

    const report = checkMigrationFiles(d);

    expect(report).toEqual({ ok: true, migrations: 1, archives: 0, issues: [] });
  });

  test("reports duplicate versions and orphan down migrations", () => {
    const d = newDir();
    writeFileSync(join(d, "0001_create_users.up.sql"), "CREATE TABLE users (id int);\n");
    writeFileSync(join(d, "0001_create_posts.up.sql"), "CREATE TABLE posts (id int);\n");
    writeFileSync(join(d, "0002_drop_posts.down.sql"), "DROP TABLE posts;\n");

    const report = checkMigrationFiles(d);

    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.code)).toEqual(["duplicate-version", "orphan-down"]);
  });

  test("requires down migration stem to match the up migration exactly", () => {
    const d = newDir();
    writeFileSync(join(d, "0001_create.up.sql"), "CREATE TABLE users (id int);\n");
    writeFileSync(join(d, "1_create.down.sql"), "DROP TABLE users;\n");

    const report = checkMigrationFiles(d);

    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.code)).toEqual(["orphan-down"]);
  });

  test("reports invalid squash metadata and tampered replacement files", () => {
    const d = newDir();
    const original = "CREATE TABLE users (id int);\n";
    const changed = "CREATE TABLE users (id bigint);\n";
    const metadata = {
      format: 1,
      replaces: [{ version: 1, name: "create_users", upHash: hash(original) }],
    };
    writeFileSync(join(d, "0001_create_users.up.sql"), changed);
    writeFileSync(join(d, "0002_baseline.up.sql"), `-- sqlx-js-squash: ${JSON.stringify(metadata)}\nCREATE TABLE users (id int);\n`);
    writeFileSync(join(d, "0003_bad_baseline.up.sql"), "-- sqlx-js-squash: nope\nSELECT 1;\n");

    const report = checkMigrationFiles(d);

    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.code)).toEqual(["invalid-squash-metadata", "tampered-squash-replacement"]);
  });
});

describe("createSquashMigration", () => {
  test("writes a baseline migration with replacement metadata", () => {
    const d = newDir();
    writeFileSync(join(d, "0001_create_users.up.sql"), "CREATE TABLE users (id int);\n");
    writeFileSync(join(d, "0001_create_users.down.sql"), "DROP TABLE users;\n");

    const result = createSquashMigration({
      migrationsDir: d,
      name: "baseline",
      schemaSql: "CREATE TABLE users (id int);\n",
    });

    expect(result.version).toBe(2);
    expect(result.replaced).toBe(1);
    const sql = readFileSync(join(d, "0002_baseline.up.sql"), "utf8");
    expect(sql).toContain("-- sqlx-js-squash:");
    expect(sql).toContain('"name":"create_users"');
    expect(sql).toContain("CREATE TABLE users");
    expect(existsSync(join(d, "0002_baseline.down.sql"))).toBe(false);
  });

  test("replace archives old up and down migrations after writing the baseline", () => {
    const d = newDir();
    writeFileSync(join(d, "0001_create_users.up.sql"), "CREATE TABLE users (id int);\n");
    writeFileSync(join(d, "0001_create_users.down.sql"), "DROP TABLE users;\n");
    writeFileSync(join(d, "0002_add_posts.up.sql"), "CREATE TABLE posts (id int);\n");

    const result = createSquashMigration({
      migrationsDir: d,
      name: "baseline",
      schemaSql: "CREATE TABLE users (id int);\nCREATE TABLE posts (id int);\n",
      replace: true,
    });

    expect(existsSync(join(d, "0003_baseline.up.sql"))).toBe(true);
    expect(existsSync(join(d, "0001_create_users.up.sql"))).toBe(false);
    expect(existsSync(join(d, "0002_add_posts.up.sql"))).toBe(false);
    expect(result.archiveDir).toBeDefined();
    const archived = readdirSync(result.archiveDir!).sort();
    expect(archived).toEqual(["0001_create_users.down.sql", "0001_create_users.up.sql", "0002_add_posts.up.sql"]);
  });

  test("lists and restores a squash archive without overwriting by default", () => {
    const d = newDir();
    writeFileSync(join(d, "0001_create_users.up.sql"), "CREATE TABLE users (id int);\n");
    writeFileSync(join(d, "0001_create_users.down.sql"), "DROP TABLE users;\n");
    writeFileSync(join(d, "0002_add_posts.up.sql"), "CREATE TABLE posts (id int);\n");

    createSquashMigration({
      migrationsDir: d,
      name: "baseline",
      schemaSql: "CREATE TABLE users (id int);\nCREATE TABLE posts (id int);\n",
      replace: true,
    });

    const archives = listMigrationArchives(d);
    expect(archives.map((a) => a.name)).toEqual(["0003_baseline"]);
    expect(archives[0]!.files).toEqual(["0001_create_users.down.sql", "0001_create_users.up.sql", "0002_add_posts.up.sql"]);

    writeFileSync(join(d, "0001_create_users.up.sql"), "-- local edit\n");
    expect(() => restoreMigrationArchive(d, "0003_baseline")).toThrow(/overwrite existing migration file/);
    expect(readFileSync(join(d, "0001_create_users.up.sql"), "utf8")).toBe("-- local edit\n");

    const restored = restoreMigrationArchive(d, "0003_baseline", { force: true });
    expect(restored.restored).toEqual(["0001_create_users.down.sql", "0001_create_users.up.sql", "0002_add_posts.up.sql"]);
    expect(readFileSync(join(d, "0001_create_users.up.sql"), "utf8")).toBe("CREATE TABLE users (id int);\n");
    expect(readFileSync(join(d, "0002_add_posts.up.sql"), "utf8")).toBe("CREATE TABLE posts (id int);\n");
  });

  test("repeated squash replaces only the effective migration history", () => {
    const d = newDir();
    const one = "CREATE TABLE users (id int);\n";
    const two = "CREATE INDEX users_idx ON users(id);\n";
    const threeMetadata = {
      format: 1,
      replaces: [
        { version: 1, name: "create_users", upHash: hash(one) },
        { version: 2, name: "add_index", upHash: hash(two) },
      ],
    };
    writeFileSync(join(d, "0001_create_users.up.sql"), one);
    writeFileSync(join(d, "0002_add_index.up.sql"), two);
    writeFileSync(join(d, "0003_baseline.up.sql"), `-- sqlx-js-squash: ${JSON.stringify(threeMetadata)}\nCREATE TABLE users (id int);\n`);
    writeFileSync(join(d, "0004_add_posts.up.sql"), "CREATE TABLE posts (id int);\n");

    const result = createSquashMigration({
      migrationsDir: d,
      name: "second_baseline",
      schemaSql: "CREATE TABLE users (id int);\nCREATE TABLE posts (id int);\n",
    });

    expect(result.replaced).toBe(2);
    const sql = readFileSync(join(d, "0005_second_baseline.up.sql"), "utf8");
    const metadata = JSON.parse(sql.split(/\r?\n/)[0]!.slice("-- sqlx-js-squash:".length).trim()) as {
      replaces: { version: number; name: string }[];
    };
    expect(metadata.replaces.map((r) => `${r.version}_${r.name}`)).toEqual(["3_baseline", "4_add_posts"]);
  });
});

describe("pg_dump baseline output", () => {
  test("removes psql meta commands but keeps dollar-quoted function bodies", () => {
    const sql = sanitizePgDumpSchema(
      "\\restrict abc\n" +
      "CREATE FUNCTION demo() RETURNS text\n" +
      "LANGUAGE plpgsql AS $$\n" +
      "BEGIN\n" +
      "  RETURN '\\\\not-a-psql-command';\n" +
      "\\kept_inside_body\n" +
      "END;\n" +
      "$$;\n" +
      "\\unrestrict abc\n",
    );

    expect(sql).not.toContain("\\restrict");
    expect(sql).not.toContain("\\unrestrict");
    expect(sql).toContain("\\kept_inside_body");
  });

  test("ignores dollar-quote markers inside strings and comments", () => {
    const sql = sanitizePgDumpSchema(
      "\\restrict abc\n" +
      "COMMENT ON TABLE demo IS '$$';\n" +
      "-- $$ in a line comment\n" +
      "/* $tag$ in a block comment\n" +
      "still a comment */\n" +
      "\\unrestrict abc\n",
    );

    expect(sql).toContain("COMMENT ON TABLE demo IS '$$';");
    expect(sql).toContain("-- $$ in a line comment");
    expect(sql).toContain("still a comment */");
    expect(sql).not.toContain("\\restrict");
    expect(sql).not.toContain("\\unrestrict");
  });

  test("keeps backslash lines inside multiline string literals", () => {
    const sql = sanitizePgDumpSchema(
      "\\restrict abc\n" +
      "COMMENT ON TABLE demo IS 'line one\n" +
      "\\not_a_psql_command\n" +
      "$$ still string';\n" +
      "\\unrestrict abc\n",
    );

    expect(sql).toContain("\\not_a_psql_command");
    expect(sql).toContain("$$ still string';");
    expect(sql).not.toContain("\\restrict");
    expect(sql).not.toContain("\\unrestrict");
  });

  test("runs pg_dump without putting URL credentials in argv", () => {
    const d = newDir();
    const script = join(d, "fake-pg-dump");
    const captureArgs = join(d, "args.txt");
    const capturePassword = join(d, "password.txt");
    const captureDatabase = join(d, "database.txt");
    writeFileSync(script,
      "#!/usr/bin/env bash\n" +
      "set -euo pipefail\n" +
      "out=''\n" +
      "for arg in \"$@\"; do case \"$arg\" in --file=*) out=\"${arg#--file=}\" ;; esac; done\n" +
      "printf '%s\\n' \"$*\" > \"$CAPTURE_ARGS\"\n" +
      "printf '%s\\n' \"${PGPASSWORD-}\" > \"$CAPTURE_PASSWORD\"\n" +
      "printf '%s\\n' \"${PGDATABASE-}\" > \"$CAPTURE_DATABASE\"\n" +
      "printf '\\\\restrict abc\\nCREATE TABLE dump_users (id int);\\n\\\\unrestrict abc\\n' > \"$out\"\n",
    );
    chmodSync(script, 0o755);

    const oldArgs = process.env.CAPTURE_ARGS;
    const oldPassword = process.env.CAPTURE_PASSWORD;
    const oldDatabase = process.env.CAPTURE_DATABASE;
    process.env.CAPTURE_ARGS = captureArgs;
    process.env.CAPTURE_PASSWORD = capturePassword;
    process.env.CAPTURE_DATABASE = captureDatabase;
    try {
      const sql = dumpSchema("postgres://dump_user:s3cr3t@localhost:5432/dump_db?sslmode=require", script);
      expect(sql).toBe("CREATE TABLE dump_users (id int);\n");
      expect(readFileSync(captureArgs, "utf8")).not.toContain("s3cr3t");
      expect(readFileSync(capturePassword, "utf8").trim()).toBe("s3cr3t");
      expect(readFileSync(captureDatabase, "utf8").trim()).toBe("dump_db");
    } finally {
      if (oldArgs === undefined) delete process.env.CAPTURE_ARGS;
      else process.env.CAPTURE_ARGS = oldArgs;
      if (oldPassword === undefined) delete process.env.CAPTURE_PASSWORD;
      else process.env.CAPTURE_PASSWORD = oldPassword;
      if (oldDatabase === undefined) delete process.env.CAPTURE_DATABASE;
      else process.env.CAPTURE_DATABASE = oldDatabase;
    }
  });

  test("runs pg_dump with the same resolved connection defaults as the wire client", () => {
    const d = newDir();
    const script = join(d, "default-env-pg-dump");
    const captureEnv = join(d, "env.txt");
    writeFileSync(script,
      "#!/usr/bin/env bash\n" +
      "set -euo pipefail\n" +
      "out=''\n" +
      "for arg in \"$@\"; do case \"$arg\" in --file=*) out=\"${arg#--file=}\" ;; esac; done\n" +
      "printf 'host=%s\\nport=%s\\nuser=%s\\npassword=%s\\ndatabase=%s\\nsslmode=%s\\nservice=%s\\npassfile=%s\\n' " +
      "\"${PGHOST-}\" \"${PGPORT-}\" \"${PGUSER-}\" \"${PGPASSWORD-}\" \"${PGDATABASE-}\" \"${PGSSLMODE-}\" \"${PGSERVICE-}\" \"${PGPASSFILE-}\" > \"$CAPTURE_ENV\"\n" +
      "printf 'CREATE TABLE dump_users (id int);\\n' > \"$out\"\n",
    );
    chmodSync(script, 0o755);

    const saved = {
      CAPTURE_ENV: process.env.CAPTURE_ENV,
      PGHOST: process.env.PGHOST,
      PGPORT: process.env.PGPORT,
      PGUSER: process.env.PGUSER,
      PGPASSWORD: process.env.PGPASSWORD,
      PGDATABASE: process.env.PGDATABASE,
      PGSSLMODE: process.env.PGSSLMODE,
      PGSERVICE: process.env.PGSERVICE,
      PGPASSFILE: process.env.PGPASSFILE,
    };
    process.env.CAPTURE_ENV = captureEnv;
    process.env.PGHOST = "wrong-host";
    process.env.PGPORT = "6543";
    process.env.PGUSER = "wrong-user";
    process.env.PGPASSWORD = "wrong-password";
    process.env.PGDATABASE = "wrong-db";
    process.env.PGSSLMODE = "require";
    process.env.PGSERVICE = "wrong-service";
    process.env.PGPASSFILE = "/tmp/wrong-passfile";
    try {
      const sql = dumpSchema("postgres:///target_db", script);
      expect(sql).toBe("CREATE TABLE dump_users (id int);\n");
      expect(readFileSync(captureEnv, "utf8")).toBe(
        "host=localhost\n" +
        "port=5432\n" +
        "user=postgres\n" +
        "password=\n" +
        "database=target_db\n" +
        "sslmode=\n" +
        "service=\n" +
        "passfile=\n",
      );
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("reads large pg_dump output through a file instead of stdout buffering", () => {
    const d = newDir();
    const script = join(d, "large-pg-dump");
    writeFileSync(script,
      "#!/usr/bin/env bash\n" +
      "set -euo pipefail\n" +
      "out=''\n" +
      "for arg in \"$@\"; do case \"$arg\" in --file=*) out=\"${arg#--file=}\" ;; esac; done\n" +
      "dd if=/dev/zero bs=1048576 count=2 2>/dev/null | tr '\\0' '-' > \"$out\"\n" +
      "printf '\\nCREATE TABLE big_dump (id int);\\n' >> \"$out\"\n",
    );
    chmodSync(script, 0o755);

    const sql = dumpSchema("postgres://dump_user@localhost/dump_db", script);
    expect(sql.length).toBeGreaterThan(1024 * 1024);
    expect(sql).toContain("CREATE TABLE big_dump");
  });
});
