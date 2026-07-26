import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { applyPending } from "../src/commands/migrate";
import { decodeText, parseDatabaseUrl, PgClient } from "../src/pg/wire";

const tmp = mkdtempSync(join(tmpdir(), "sqlx-js-migration-store-"));
const configuredDbUrl = process.env.SQLX_JS_TEST_DATABASE_URL?.trim() || undefined;
const image = process.env.SQLX_JS_PG_IMAGE ?? "pgvector/pgvector:pg17";

function dockerAvailable(): boolean {
  return spawnSync("docker", ["info"], { encoding: "utf8" }).status === 0;
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function schemaName(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function migrationDir(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "0001_init.up.sql"), "SELECT 1");
  return dir;
}

const haveDatabase = Boolean(configuredDbUrl) || dockerAvailable();

if (!haveDatabase) {
  test.skip("migration store integration requires SQLX_JS_TEST_DATABASE_URL or Docker", () => {});
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
} else {
  let container: StartedPostgreSqlContainer | undefined;
  let dbUrl = configuredDbUrl ?? "";

  beforeAll(async () => {
    if (!configuredDbUrl) {
      container = await new PostgreSqlContainer(image)
        .withDatabase("sqlx_js_migration_store")
        .withUsername("postgres")
        .withPassword("postgres")
        .start();
      dbUrl = `postgres://postgres:postgres@${container.getHost()}:${container.getMappedPort(5432)}/sqlx_js_migration_store`;
    }
  });

  afterAll(async () => {
    rmSync(tmp, { recursive: true, force: true });
    if (container) await container.stop();
  });

  test("does not execute a later-schema migration history view", async () => {
    const currentSchema = schemaName("migration_current");
    const laterSchema = schemaName("migration_attacker");
    const client = new PgClient(parseDatabaseUrl(dbUrl));
    await client.connect();
    try {
      await client.simpleQuery(`
        CREATE SCHEMA ${quoteIdent(currentSchema)};
        CREATE SCHEMA ${quoteIdent(laterSchema)};
        CREATE FUNCTION ${quoteIdent(laterSchema)}.migration_probe() RETURNS bigint
        LANGUAGE plpgsql
        AS $fn$
        BEGIN
          EXECUTE 'CREATE TABLE ${quoteIdent(currentSchema)}.executed_by_view(value text)';
          RETURN 1;
        END
        $fn$;
        CREATE VIEW ${quoteIdent(laterSchema)}._sqlx_js_migrations AS
        SELECT ${quoteIdent(laterSchema)}.migration_probe() AS version,
               'forged'::text AS name,
               repeat('0', 64)::text AS up_hash;
        SET search_path = ${quoteIdent(currentSchema)}, ${quoteIdent(laterSchema)};
      `);

      await expect(applyPending(client, migrationDir("malicious-view"))).rejects.toThrow(
        `outside current schema ${quoteIdent(currentSchema)}`,
      );

      const result = await client.simpleQuery(`
        SELECT to_regclass('${currentSchema}.executed_by_view'), to_regclass('${currentSchema}._sqlx_js_migrations')
      `);
      expect(decodeText(result.rows[0]?.[0] ?? null)).toBeNull();
      expect(decodeText(result.rows[0]?.[1] ?? null)).toBeNull();
    } finally {
      await client.simpleQuery("RESET search_path");
      await client.simpleQuery(`DROP SCHEMA IF EXISTS ${quoteIdent(currentSchema)} CASCADE`);
      await client.simpleQuery(`DROP SCHEMA IF EXISTS ${quoteIdent(laterSchema)} CASCADE`);
      await client.end();
    }
  });

  test("does not replace a legitimate history table from a later schema", async () => {
    const currentSchema = schemaName("migration_current");
    const previousSchema = schemaName("migration_previous");
    const client = new PgClient(parseDatabaseUrl(dbUrl));
    await client.connect();
    try {
      await client.simpleQuery(`
        CREATE SCHEMA ${quoteIdent(currentSchema)};
        CREATE SCHEMA ${quoteIdent(previousSchema)};
        CREATE TABLE ${quoteIdent(previousSchema)}._sqlx_js_migrations (
          version bigint PRIMARY KEY,
          name text NOT NULL,
          up_hash text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO ${quoteIdent(previousSchema)}._sqlx_js_migrations(version, name, up_hash)
        VALUES (1, 'already_applied', repeat('a', 64));
        SET search_path = ${quoteIdent(currentSchema)}, ${quoteIdent(previousSchema)};
      `);

      await expect(applyPending(client, migrationDir("existing-history"))).rejects.toThrow(
        `outside current schema ${quoteIdent(currentSchema)}`,
      );

      const result = await client.simpleQuery(`
        SELECT to_regclass('${currentSchema}._sqlx_js_migrations'),
               (SELECT count(*)::text FROM ${quoteIdent(previousSchema)}._sqlx_js_migrations)
      `);
      expect(decodeText(result.rows[0]?.[0] ?? null)).toBeNull();
      expect(decodeText(result.rows[0]?.[1] ?? null)).toBe("1");
    } finally {
      await client.simpleQuery("RESET search_path");
      await client.simpleQuery(`DROP SCHEMA IF EXISTS ${quoteIdent(currentSchema)} CASCADE`);
      await client.simpleQuery(`DROP SCHEMA IF EXISTS ${quoteIdent(previousSchema)} CASCADE`);
      await client.end();
    }
  });
}
