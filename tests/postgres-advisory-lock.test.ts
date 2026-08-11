import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { Temporal } from "temporal-polyfill";
import {
  PostgresAdvisoryLockLostError,
  tryAcquirePostgresAdvisoryLock,
} from "../src/index";

let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

function protocolMessage(type: string, body: Buffer): Buffer {
  const message = Buffer.alloc(5 + body.length);
  message[0] = type.charCodeAt(0);
  message.writeInt32BE(body.length + 4, 1);
  body.copy(message, 5);
  return message;
}

function int32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeInt32BE(value);
  return result;
}

function parameterStatus(name: string, value: string): Buffer {
  return protocolMessage("S", Buffer.from(`${name}\0${value}\0`));
}

async function stalledPostgresServer(): Promise<{
  readonly closed: Promise<void>;
  readonly port: number;
  readonly querySeen: Promise<void>;
}> {
  let resolveClosed!: () => void;
  let resolveQuerySeen!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const querySeen = new Promise<void>((resolve) => {
    resolveQuerySeen = resolve;
  });
  server = createServer((socket) => {
    let ready = false;
    socket.once("close", resolveClosed);
    socket.on("data", () => {
      if (ready) {
        resolveQuerySeen();
        return;
      }
      ready = true;
      socket.write(Buffer.concat([
        protocolMessage("R", int32(0)),
        parameterStatus("server_version", "17.0"),
        parameterStatus("TimeZone", "UTC"),
        parameterStatus("DateStyle", "ISO, MDY"),
        protocolMessage("K", Buffer.concat([int32(123), int32(456)])),
        protocolMessage("Z", Buffer.from("I")),
      ]));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP server address");
  return { closed, port: address.port, querySeen };
}

async function within<T>(promise: Promise<T>, message: string): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(message)), 2_000);
    }),
  ]);
}

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

  test("destroys a session when a control query exceeds its deadline", async () => {
    const stalled = await stalledPostgresServer();
    const acquisition = tryAcquirePostgresAdvisoryLock(
      `postgresql://x:x@127.0.0.1:${stalled.port}/x?sslmode=disable`,
      { namespace: 7, resource: 9 },
      { temporalApi: Temporal, connectTimeoutMs: 1_000, operationTimeoutMs: 500 },
    );
    const rejected = expect(acquisition).rejects.toThrow("acquisition timed out after 500ms");

    await within(stalled.querySeen, "advisory lock query was not dispatched");
    await rejected;
    await within(stalled.closed, "timed-out advisory lock socket remained open");
  });
});
