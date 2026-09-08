import { afterEach, describe, expect, test } from "bun:test";
import { Temporal } from "temporal-polyfill";
import {
  PostgresAdvisoryLockLostError,
  tryAcquirePostgresAdvisoryLock,
  type PostgresAdvisoryLockKey,
} from "../src/index";
import { controlServer, within, type ControlReply } from "./helpers/postgres-control-server";

let server: Awaited<ReturnType<typeof controlServer>> | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const options = { temporalApi: Temporal, operationTimeoutMs: 1_000 };

describe.each<PostgresAdvisoryLockKey>([300003n, { namespace: 0, resource: 300003 }])(
  "advisory capability state for %p", (key) => {
    const parameterOids = typeof key === "bigint" ? [20] : [23, 23];
    const acquired: ControlReply = { parameterOids, flag: "acquired", rows: [["123", "t"]] };

    test.each([false, true])("closes a rejected or empty acquisition, empty=%p", async (empty) => {
      server = await controlServer([{ ...acquired, rows: empty ? [] : [["123", "f"]] }]);
      const acquiring = tryAcquirePostgresAdvisoryLock(server.url, key, options);
      if (empty) await expect(acquiring).rejects.toThrow("query returned no row");
      else expect(await acquiring).toBeNull();
      await within(server.closed, "acquisition did not close its session");
      expect(server.connections).toBe(1);
      expect(server.executions).toBe(1);
    });

    test("concurrent successful checks share the same owned session", async () => {
      const held: ControlReply = { parameterOids: [26, 26, 23], flag: "held", rows: [["123", "t"]] };
      server = await controlServer([
        acquired, held, held, held,
        { parameterOids, flag: "released", rows: [["123", "t"]] },
      ]);
      const active = await tryAcquirePostgresAdvisoryLock(server.url, key, options);
      await Promise.all([active!.assertHeld(), active!.assertHeld(), active!.assertHeld()]);
      await active!.release();
      await within(server.closed, "released session remained open");
      expect(server.connections).toBe(1);
      expect(server.executions).toBe(5);
    });

    test("release prevents a successful in-flight reply from confirming ownership", async () => {
      server = await controlServer([
        acquired,
        { parameterOids: [26, 26, 23], flag: "held", rows: [["123", "t"]] },
        { parameterOids, flag: "released", rows: [["123", "t"]] },
      ]);
      const active = await tryAcquirePostgresAdvisoryLock(server.url, key, options);
      const checking = active!.assertHeld();
      const releasing = active!.release();
      await expect(checking).rejects.toThrow("was released");
      await releasing;
      await within(server.closed, "released session remained open");
      await expect(active!.assertHeld()).rejects.toThrow("was released");
      expect(server.executions).toBe(3);
    });

    test.each(["check", "release"])("a timed-out check also terminates concurrent %s", async (following) => {
      server = await controlServer([
        acquired,
        { parameterOids: [26, 26, 23], flag: "held", rows: new Promise(() => {}) },
      ]);
      const active = await tryAcquirePostgresAdvisoryLock(server.url, key, {
        ...options, operationTimeoutMs: 500,
      });
      const checking = active!.assertHeld();
      const concurrent = following === "check" ? active!.assertHeld() : active!.release();
      const results = await Promise.allSettled([checking, concurrent]);
      for (const result of results) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") expect(result.reason).toBeInstanceOf(PostgresAdvisoryLockLostError);
      }
      await within(server.closed, "timed-out session remained open");
      await expect(active!.assertHeld()).rejects.toBeInstanceOf(PostgresAdvisoryLockLostError);
      if (following === "release") expect(active!.release()).toBe(concurrent);
      else await active!.release();
      expect(server.connections).toBe(1);
      expect(server.executions).toBe(2);
    });

    for (const flag of ["held", "released"] as const) {
      test.each([
        { name: "missing row", rows: [] },
        { name: "wrong backend", rows: [["124", "t"]] },
        { name: "negative answer", rows: [["123", "f"]] },
      ])(`permanently loses the capability on ${flag}: $name`, async ({ rows }) => {
        server = await controlServer([
          acquired,
          { parameterOids: flag === "held" ? [26, 26, 23] : parameterOids, flag, rows },
        ]);
        const active = await tryAcquirePostgresAdvisoryLock(server.url, key, options);
        expect(active).not.toBeNull();
        const failing = flag === "held" ? active!.assertHeld() : active!.release();
        await expect(failing).rejects.toBeInstanceOf(PostgresAdvisoryLockLostError);
        await expect(failing).rejects.toMatchObject({ key });
        await within(server.closed, "lost capability did not close its session");
        await expect(active!.assertHeld()).rejects.toBeInstanceOf(PostgresAdvisoryLockLostError);
        if (flag === "released") expect(active!.release()).toBe(failing);
        else await active!.release();
        expect(server.connections).toBe(1);
        expect(server.executions).toBe(2);
      });
    }
  },
);
