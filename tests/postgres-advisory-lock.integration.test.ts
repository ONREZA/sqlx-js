import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Temporal } from "temporal-polyfill";
import { connect, createServer, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import {
  createClient,
  PostgresAdvisoryLockLostError,
  tryAcquirePostgresAdvisoryLock,
  type PostgresAdvisoryLockKey,
  type PostgresAdvisoryLockSession,
} from "../src/index";
import { advisoryLockControl, CHECK_ADVISORY_LOCK_SQL } from "../src/postgres-advisory-lock-key";
import { createPostgresSession } from "../src/postgres-runtime";
import { within } from "./helpers/postgres-control-server";

const IMAGE = process.env.SQLX_JS_PG_IMAGE ?? "pgvector/pgvector:pg17";
const CONFIGURED_DATABASE_URL = process.env.SQLX_JS_TEST_DATABASE_URL?.trim() || undefined;
const KEYS: PostgresAdvisoryLockKey[] = [
  { namespace: 1_728_194_883, resource: 3 },
  { namespace: -2_147_483_648, resource: 2_147_483_647 },
  300003n,
  0n,
  -300003n,
  -1n,
  9_007_199_254_740_993n,
  -9_223_372_036_854_775_808n,
  9_223_372_036_854_775_807n,
];

function legacyLock(key: PostgresAdvisoryLockKey) {
  return typeof key === "bigint"
    ? { args: "$1::bigint", params: [key] }
    : { args: "$1::int4, $2::int4", params: [key.namespace, key.resource] };
}

// PostgreSQL's two-int4 keyspace uses signed halves of the same 64 bits.
function correspondingPair(key: bigint) {
  return {
    namespace: Number(BigInt.asIntN(32, key >> 32n)),
    resource: Number(BigInt.asIntN(32, key)),
  };
}

describe("PostgreSQL advisory lock session", () => {
  let container: StartedPostgreSqlContainer | undefined;
  let databaseUrl = CONFIGURED_DATABASE_URL ?? "";
  const options = { temporalApi: Temporal, operationTimeoutMs: 5_000 };

  beforeAll(async () => {
    if (databaseUrl) return;
    container = await new PostgreSqlContainer(IMAGE).start();
    databaseUrl = container.getConnectionUri();
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  async function terminateLockBackend(key: PostgresAdvisoryLockKey): Promise<void> {
    const client = createClient(databaseUrl, { temporalApi: Temporal });
    try {
      const identity = typeof key === "bigint"
        ? `classid::int8 = (($1::int8 >> 32) & 4294967295)
           AND objid::int8 = ($1::int8 & 4294967295) AND objsubid = 1`
        : `classid = $1::int4::oid AND objid = $2::int4::oid AND objsubid = 2`;
      const rows = await client.unsafe<{ pid: number }>(
        `SELECT pid FROM pg_catalog.pg_locks
         WHERE locktype = 'advisory' AND granted AND mode = 'ExclusiveLock'
           AND database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
           AND ${identity}`,
        legacyLock(key).params,
      );
      expect(rows).toHaveLength(1);
      await client.unsafe("SELECT pg_catalog.pg_terminate_backend($1::int4)", [rows[0]!.pid]);
    } finally {
      await client.end();
    }
  }

  describe.each(KEYS)("key %p", (key) => {
    test("blocks legacy callers, preserves its key, and releases without stacking", async () => {
      const legacy = await createPostgresSession(databaseUrl, options);
      const { args, params } = legacyLock(key);
      const active = await tryAcquirePostgresAdvisoryLock(databaseUrl, key, options);
      try {
        expect(active).not.toBeNull();
        expect(active!.key).toEqual(key);
        await active!.assertHeld();
        await active!.assertHeld();
        expect(await tryAcquirePostgresAdvisoryLock(databaseUrl, key, options)).toBeNull();
        expect((await legacy.unsafe(`SELECT pg_try_advisory_lock(${args}) AS acquired`, params))[0])
          .toEqual({ acquired: false });
        await active!.release();
        await active!.release();
        await expect(active!.assertHeld()).rejects.toThrow("was released");
        expect((await legacy.unsafe(`SELECT pg_try_advisory_lock(${args}) AS acquired`, params))[0])
          .toEqual({ acquired: true });
        expect(await tryAcquirePostgresAdvisoryLock(databaseUrl, key, options)).toBeNull();
        expect((await legacy.unsafe(`SELECT pg_advisory_unlock(${args}) AS released`, params))[0])
          .toEqual({ released: true });
        const successor = await tryAcquirePostgresAdvisoryLock(databaseUrl, key, options);
        expect(successor).not.toBeNull();
        await successor![Symbol.asyncDispose]();
      } finally {
        await active?.release();
        await legacy.end();
      }
    });

    test("becomes permanently lost after termination without reconnecting", async () => {
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
      try {
        expect(active).not.toBeNull();
        await terminateLockBackend(key);
        await expect(active!.assertHeld()).rejects.toBeInstanceOf(PostgresAdvisoryLockLostError);
        await expect(active!.assertHeld()).rejects.toMatchObject({ key });
        const successor = await tryAcquirePostgresAdvisoryLock(databaseUrl, key, options);
        try {
          expect(successor).not.toBeNull();
          await expect(active!.assertHeld()).rejects.toBeInstanceOf(PostgresAdvisoryLockLostError);
          await active!.release();
          await expect(active!.assertHeld()).rejects.toBeInstanceOf(PostgresAdvisoryLockLostError);
          await successor!.assertHeld();
          if (password !== "") expect(passwordCalls).toBe(1);
        } finally {
          await successor?.release();
        }
      } finally {
        await active?.release();
      }
    });

    test("release fails closed after loss and concurrent calls share the result", async () => {
      const active = await tryAcquirePostgresAdvisoryLock(databaseUrl, key, options);
      expect(active).not.toBeNull();
      try {
        await terminateLockBackend(key);
        const firstRelease = active!.release();
        expect(active!.release()).toBe(firstRelease);
        await expect(firstRelease).rejects.toBeInstanceOf(PostgresAdvisoryLockLostError);
        const successor = await tryAcquirePostgresAdvisoryLock(databaseUrl, key, options);
        expect(successor).not.toBeNull();
        await successor!.release();
      } finally {
        await active?.release().catch(() => {});
      }
    });
  });

  test.each(KEYS.filter((key): key is bigint => typeof key === "bigint"))(
    "keeps the corresponding int4 pair independent from bigint %p", async (key) => {
      const pair = correspondingPair(key);
      const active = await tryAcquirePostgresAdvisoryLock(databaseUrl, key, options);
      const other = await tryAcquirePostgresAdvisoryLock(databaseUrl, pair, options);
      try {
        expect(active).not.toBeNull();
        expect(other).not.toBeNull();
        await active!.assertHeld();
        await other!.assertHeld();
        await active!.release();
        await other!.assertHeld();
        expect(await tryAcquirePostgresAdvisoryLock(databaseUrl, pair, options)).toBeNull();
      } finally {
        await active?.release();
        await other?.release();
      }
    },
  );

  test("accepts an unmodified PostgreSQL hashtextextended result", async () => {
    const legacy = await createPostgresSession(databaseUrl, options);
    try {
      const [row] = await legacy.unsafe<{ key: bigint }>(
        "SELECT pg_catalog.hashtextextended($1::text, $2::bigint) AS key",
        ["sqlx-js-issue-103", -17n],
      );
      expect(typeof row!.key).toBe("bigint");
      const active = await tryAcquirePostgresAdvisoryLock(databaseUrl, row!.key, options);
      try {
        expect(active).not.toBeNull();
        await active!.assertHeld();
        expect((await legacy.unsafe(
          "SELECT pg_try_advisory_lock(hashtextextended($1::text, $2::bigint)) AS acquired",
          ["sqlx-js-issue-103", -17n],
        ))[0]).toEqual({ acquired: false });
      } finally {
        await active?.release();
      }
    } finally {
      await legacy.end();
    }
  });

  test.each<PostgresAdvisoryLockKey>([-1n, { namespace: -1, resource: -1 }])(
    "checks backend ownership, exclusive mode, and keyspace for %p", async (key) => {
      const client = await createPostgresSession(databaseUrl, options);
      const peer = await createPostgresSession(databaseUrl, options);
      const wrongKey = typeof key === "bigint" ? correspondingPair(key) : -1n;
      const correct = legacyLock(key);
      const wrong = legacyLock(wrongKey);
      const { identity } = advisoryLockControl(key);
      const held = async () => (await client.unsafe<{ held: boolean }>(CHECK_ADVISORY_LOCK_SQL, identity))[0]!.held;
      try {
        expect(await held()).toBe(false);
        await client.unsafe(`SELECT pg_advisory_lock(${wrong.args})`, wrong.params);
        expect(await held()).toBe(false);
        await peer.unsafe(`SELECT pg_advisory_lock(${correct.args})`, correct.params);
        expect(await held()).toBe(false);
        await peer.unsafe(`SELECT pg_advisory_unlock(${correct.args})`, correct.params);
        await client.unsafe(`SELECT pg_advisory_lock_shared(${correct.args})`, correct.params);
        expect(await held()).toBe(false);
        await client.unsafe(`SELECT pg_advisory_unlock_shared(${correct.args})`, correct.params);
        await client.unsafe(`SELECT pg_advisory_lock(${correct.args})`, correct.params);
        expect(await held()).toBe(true);
        await client.unsafe(`SELECT pg_advisory_unlock(${correct.args})`, correct.params);
        expect(await held()).toBe(false);
      } finally {
        await client.end();
        await peer.end();
      }
    },
  );

  describe.each<PostgresAdvisoryLockKey>([300003n, { namespace: 0, resource: 300003 }])(
    "stalled control queries for %p", (key) => {
      test.each(["health check", "release"])("fails permanently closed on %s timeout", async (operation) => {
        const target = new URL(databaseUrl);
        const upstreamPort = Number(target.port) || 5432;
        const upstreamHost = target.hostname;
        const sockets = new Set<Socket>();
        let forward = true;
        let connections = 0;
        let confirmClosed!: () => void;
        const closed = new Promise<void>((resolve) => { confirmClosed = resolve; });
        const proxy = createServer((socket) => {
          connections++;
          const upstream = connect(upstreamPort, upstreamHost);
          sockets.add(socket);
          sockets.add(upstream);
          socket.on("data", (data) => { if (forward) upstream.write(data); });
          upstream.on("data", (data) => socket.write(data));
          socket.on("error", () => upstream.destroy());
          upstream.on("error", () => socket.destroy());
          socket.on("close", () => {
            upstream.destroy();
            confirmClosed();
          });
          upstream.on("close", () => socket.destroy());
        });
        await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
        const address = proxy.address();
        if (!address || typeof address === "string") throw new Error("expected a TCP proxy");
        target.hostname = "127.0.0.1";
        target.port = String(address.port);
        let active: PostgresAdvisoryLockSession | null = null;
        try {
          active = await tryAcquirePostgresAdvisoryLock(target.toString(), key, {
            ...options, operationTimeoutMs: 500,
          });
          expect(active).not.toBeNull();
          forward = false;
          const pending = operation === "release" ? active!.release() : active!.assertHeld();
          if (operation === "release") expect(active!.release()).toBe(pending);
          await expect(pending).rejects.toBeInstanceOf(PostgresAdvisoryLockLostError);
          await expect(pending).rejects.toMatchObject({
            key, cause: { message: `sqlx-js: PostgreSQL advisory lock ${operation} timed out after 500ms` },
          });
          await within(closed, "timed-out capability did not close its session");
          await expect(active!.assertHeld()).rejects.toBeInstanceOf(PostgresAdvisoryLockLostError);
          expect(connections).toBe(1);
          const successor = await tryAcquirePostgresAdvisoryLock(databaseUrl, key, options);
          try {
            expect(successor).not.toBeNull();
            await successor!.assertHeld();
          } finally {
            await successor?.release();
          }
        } finally {
          await active?.release().catch(() => {});
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((resolve) => proxy.close(() => resolve()));
        }
      });
    },
  );

  test.each<PostgresAdvisoryLockKey>([300003n, { namespace: 0, resource: 300003 }])(
    "invalidates in-flight health checks as soon as release starts for %p", async (key) => {
      const active = await tryAcquirePostgresAdvisoryLock(databaseUrl, key, options);
      try {
        expect(active).not.toBeNull();
        const checking = active!.assertHeld();
        const releasing = active!.release();
        const rejected = expect(checking).rejects.toThrow("was released");
        expect(active!.release()).toBe(releasing);
        await Promise.all([rejected, releasing]);
        await expect(active!.assertHeld()).rejects.toThrow("was released");
      } finally {
        await active?.release();
      }
    },
  );

  test.each<PostgresAdvisoryLockKey>([-1n, { namespace: -1, resource: -1 }])(
    "checks and releases ownership under an ordinary PostgreSQL role for %p", async (key) => {
      const role = `sqlx_lock_${randomUUID().replaceAll("-", "")}`;
      const admin = createClient(databaseUrl, { temporalApi: Temporal });
      try {
        await admin.unsafe(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER`);
        try {
          const active = await tryAcquirePostgresAdvisoryLock(databaseUrl, key, { ...options, role });
          try {
            expect(active).not.toBeNull();
            await active!.assertHeld();
            expect(await tryAcquirePostgresAdvisoryLock(databaseUrl, key, options)).toBeNull();
          } finally {
            await active?.release();
          }
        } finally {
          await admin.unsafe(`DROP ROLE "${role}"`);
        }
      } finally {
        await admin.end();
      }
    },
  );

  test("reads session options once before validating fixed codecs", async () => {
    const key = 300003n;
    const active = await tryAcquirePostgresAdvisoryLock(databaseUrl, key, options);
    let contender: PostgresAdvisoryLockSession | null = null;
    let reads = 0;
    try {
      expect(active).not.toBeNull();
      const dynamicOptions = Object.defineProperty({ ...options }, "types", {
        enumerable: true,
        get: () => ++reads === 1 ? undefined : {
          bool: { to: 16, from: 16, parse: () => true, serialize: String },
        },
      });
      contender = await tryAcquirePostgresAdvisoryLock(databaseUrl, key, dynamicOptions);
      expect(contender).toBeNull();
      expect(reads).toBe(1);
      await active!.assertHeld();
    } finally {
      await contender?.release().catch(() => {});
      await active?.release();
    }
  });

  test("snapshots pair keys so application mutation cannot change ownership or release", async () => {
    const key = { namespace: 1728194883, resource: 9 };
    const active = await tryAcquirePostgresAdvisoryLock(databaseUrl, key, options);
    try {
      expect(active).not.toBeNull();
      key.resource = 10;
      expect(active!.key.resource).toBe(9);
      expect(Object.isFrozen(active!.key)).toBe(true);
      expect(Reflect.set(active!, "key", { namespace: 0, resource: 0 })).toBe(false);
      expect(active!.key.resource).toBe(9);
      await active!.assertHeld();
    } finally {
      await active?.release();
    }
  });
});
