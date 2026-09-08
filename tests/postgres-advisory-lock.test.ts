import { afterEach, describe, expect, test } from "bun:test";
import { Temporal } from "temporal-polyfill";
import {
  PostgresAdvisoryLockLostError,
  tryAcquirePostgresAdvisoryLock,
  type PostgresAdvisoryLockKey,
} from "../src/index";

import { controlServer, within } from "./helpers/postgres-control-server";

let server: Awaited<ReturnType<typeof controlServer>> | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("PostgreSQL advisory lock input", () => {
  const url = "postgresql://postgres:postgres@127.0.0.1:1/postgres";

  test("rejects keys outside the signed 32-bit pair contract", async () => {
    await expect(tryAcquirePostgresAdvisoryLock(url, {
      namespace: 2_147_483_648,
      resource: 0,
    })).rejects.toThrow("namespace must be a signed 32-bit integer");
    await expect(tryAcquirePostgresAdvisoryLock(url, {
      namespace: 0,
      resource: 1.5,
    })).rejects.toThrow("resource must be a signed 32-bit integer");
  });

  test("rejects bigint keys outside signed int64 before connecting", async () => {
    for (const key of [-9_223_372_036_854_775_809n, 9_223_372_036_854_775_808n]) {
      await expect(tryAcquirePostgresAdvisoryLock(url, key))
        .rejects.toThrow("bigint key must be a signed 64-bit integer");
    }
  });

  test("rejects numeric and string substitutes for bigint before connecting", async () => {
    for (const key of [300003, "300003", Object(300003n)]) {
      await expect(tryAcquirePostgresAdvisoryLock(url, key as never)).rejects.toBeInstanceOf(TypeError);
    }
  });

  test("rejects non-object keys before connecting", async () => {
    await expect(tryAcquirePostgresAdvisoryLock(url, null as never))
      .rejects.toThrow("key must be an object");
    await expect(tryAcquirePostgresAdvisoryLock(url, [] as never))
      .rejects.toThrow("key must be an object");
  });

  test("keeps connection retirement under the lock session", async () => {
    const key = { namespace: 7, resource: 9 };
    for (const [name, value] of [
      ["max", 1],
      ["idleTimeoutMs", 1_000],
      ["maxLifetimeMs", 1_000],
    ] as const) {
      await expect(tryAcquirePostgresAdvisoryLock(url, key, { [name]: value } as never))
        .rejects.toThrow(`sessions own ${name}`);
    }
  });

  test("keeps control-query codecs under the lock session", async () => {
    const key = { namespace: 7, resource: 9 };
    await expect(tryAcquirePostgresAdvisoryLock(url, key, {
      types: {},
    } as never)).rejects.toThrow("sessions use fixed control-query codecs");
  });

  test("rejects invalid operation deadlines before connecting", async () => {
    const key = { namespace: 7, resource: 9 };
    for (const operationTimeoutMs of [0, 1.5, 2_147_483_648]) {
      await expect(tryAcquirePostgresAdvisoryLock(url, key, { operationTimeoutMs }))
        .rejects.toThrow("operationTimeoutMs must be an integer from 1 to 2147483647");
    }
  });

  test("rejects non-object options before connecting", async () => {
    await expect(tryAcquirePostgresAdvisoryLock(url, { namespace: 7, resource: 9 }, null as never))
      .rejects.toThrow("options must be an object");
  });

  test("exposes a stable lock-loss error", () => {
    const cause = new Error("connection closed");
    const error = new PostgresAdvisoryLockLostError({ namespace: 7, resource: 9 }, { cause });
    expect(error.name).toBe("PostgresAdvisoryLockLostError");
    expect(error.key).toEqual({ namespace: 7, resource: 9 });
    expect(error.cause).toBe(cause);
  });

  test("preserves a bigint key and its exact value in lock-loss errors", () => {
    const key = -9_223_372_036_854_775_808n;
    const cause = new Error("connection closed");
    const error = new PostgresAdvisoryLockLostError(key, { cause });
    expect(error.key).toBe(key);
    expect(error.message).toContain("(bigint -9223372036854775808)");
    expect(error.cause).toBe(cause);
  });

  test.each<PostgresAdvisoryLockKey>([{ namespace: 7, resource: 9 }, 300003n])(
    "destroys a session when acquisition exceeds its deadline for %p", async (key) => {
      let querySeen!: () => void;
      const dispatched = new Promise<void>((resolve) => { querySeen = resolve; });
      server = await controlServer([{
        flag: "acquired",
        parameterOids: typeof key === "bigint" ? [20] : [23, 23],
        rows: new Promise(() => {}),
        onExecute: querySeen,
      }]);
      const acquisition = tryAcquirePostgresAdvisoryLock(
        server.url,
        key,
        { temporalApi: Temporal, connectTimeoutMs: 1_000, operationTimeoutMs: 500 },
      );
      const outcome = acquisition.then(() => null, (error: unknown) => error);
      await within(dispatched, "advisory lock query was not dispatched");
      expect(await outcome).toMatchObject({ message: "sqlx-js: PostgreSQL advisory lock acquisition timed out after 500ms" });
      await within(server.closed, "timed-out advisory lock socket remained open");
    },
  );
});
