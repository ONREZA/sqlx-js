import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Temporal } from "temporal-polyfill";
import {
  createClient,
  PostgresAdvisoryLockLostError,
  tryAcquirePostgresAdvisoryLock,
} from "../src/index";

const IMAGE = process.env.SQLX_JS_PG_IMAGE ?? "pgvector/pgvector:pg17";
const CONFIGURED_DATABASE_URL = process.env.SQLX_JS_TEST_DATABASE_URL?.trim() || undefined;

describe("PostgreSQL advisory lock session", () => {
  let container: StartedPostgreSqlContainer | undefined;
  let databaseUrl = CONFIGURED_DATABASE_URL ?? "";

  beforeAll(async () => {
    if (databaseUrl) return;
    container = await new PostgreSqlContainer(IMAGE).start();
    databaseUrl = container.getConnectionUri();
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  async function terminateLockBackend(key: { namespace: number; resource: number }): Promise<void> {
    const client = createClient(databaseUrl, { temporalApi: Temporal });
    try {
      const rows = await client.unsafe<{ pid: number }>(
        `SELECT pid
         FROM pg_catalog.pg_locks
         WHERE locktype = 'advisory'
           AND granted
           AND classid = $1::pg_catalog.int4::pg_catalog.oid
           AND objid = $2::pg_catalog.int4::pg_catalog.oid
           AND objsubid = 2`,
        [key.namespace, key.resource],
      );
      expect(rows).toHaveLength(1);
      await client.unsafe(
        "SELECT pg_catalog.pg_terminate_backend($1::pg_catalog.int4)",
        [rows[0]!.pid],
      );
    } finally {
      await client.end();
    }
  }

  test("holds one session until release and permits standby takeover", async () => {
    const key = { namespace: 1_728_194_883, resource: 3 };
    const options = { temporalApi: Temporal };
    const active = await tryAcquirePostgresAdvisoryLock(databaseUrl, key, options);
    expect(active).not.toBeNull();
    await active!.assertHeld();

    expect(await tryAcquirePostgresAdvisoryLock(databaseUrl, key, options)).toBeNull();

    await active!.release();
    await active!.release();
    await expect(active!.assertHeld()).rejects.toThrow("was released");

    const successor = await tryAcquirePostgresAdvisoryLock(databaseUrl, key, options);
    expect(successor).not.toBeNull();
    await successor!.release();
  });

  test("accepts signed key boundaries and releases through async disposal", async () => {
    const key = { namespace: -2_147_483_648, resource: 2_147_483_647 };
    const options = { temporalApi: Temporal };
    const active = await tryAcquirePostgresAdvisoryLock(databaseUrl, key, options);
    expect(active).not.toBeNull();

    await active![Symbol.asyncDispose]();

    const successor = await tryAcquirePostgresAdvisoryLock(databaseUrl, key, options);
    expect(successor).not.toBeNull();
    await successor!.release();
  });

  test("detects backend termination without silently reacquiring", async () => {
    const key = { namespace: 1_728_194_883, resource: 4 };
    const options = { temporalApi: Temporal };
    const password = decodeURIComponent(new URL(databaseUrl).password);
    let passwordCalls = 0;
    const active = await tryAcquirePostgresAdvisoryLock(databaseUrl, key, {
      ...options,
      ...(password === "" ? {} : {
        password: () => {
          passwordCalls++;
          return password;
        },
      }),
    });
    expect(active).not.toBeNull();

    await terminateLockBackend(key);

    await expect(active!.assertHeld()).rejects.toBeInstanceOf(PostgresAdvisoryLockLostError);
    if (password !== "") expect(passwordCalls).toBe(1);
    await active!.release();

    const successor = await tryAcquirePostgresAdvisoryLock(databaseUrl, key, options);
    expect(successor).not.toBeNull();
    await successor!.release();
  });

  test("release fails closed after session loss and still permits takeover", async () => {
    const key = { namespace: 1_728_194_883, resource: 5 };
    const options = { temporalApi: Temporal };
    const active = await tryAcquirePostgresAdvisoryLock(databaseUrl, key, options);
    expect(active).not.toBeNull();

    await terminateLockBackend(key);

    const firstRelease = active!.release();
    expect(active!.release()).toBe(firstRelease);
    await expect(firstRelease).rejects.toBeInstanceOf(PostgresAdvisoryLockLostError);

    const successor = await tryAcquirePostgresAdvisoryLock(databaseUrl, key, options);
    expect(successor).not.toBeNull();
    await successor!.release();
  });
});
