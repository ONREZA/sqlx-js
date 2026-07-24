import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { ConnectionLostError, PgClient } from "../src/pg/wire";

let server: Server | null = null;
afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
});

function startSrv(onSocket: (s: import("node:net").Socket) => void): Promise<number> {
  return new Promise((resolve) => {
    server = createServer(onSocket);
    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address();
      if (addr && typeof addr === "object") resolve(addr.port);
    });
  });
}

function errorResponse(message: string): Buffer {
  const body = Buffer.from(`SERROR\0C28P01\0M${message}\0\0`);
  const frame = Buffer.alloc(5 + body.length);
  frame[0] = "E".charCodeAt(0);
  frame.writeInt32BE(body.length + 4, 1);
  body.copy(frame, 5);
  return frame;
}

describe("ConnectionLostError", () => {
  test("class shape: name, message, cause", () => {
    const cause = new Error("ECONNRESET");
    const err = new ConnectionLostError(cause);
    expect(err.name).toBe("ConnectionLostError");
    expect(err.message).toContain("connection lost");
    expect(err.message).toContain("ECONNRESET");
    expect(err.cause).toBe(cause);
    expect(err instanceof Error).toBe(true);
  });

  test("connect() rejects with ConnectionLostError if server drops mid-handshake", async () => {
    const port = await startSrv((s) => {
      s.once("data", () => s.destroy());
    });
    const client = new PgClient({
      host: "127.0.0.1",
      port,
      user: "x",
      password: "x",
      database: "x",
      sslmode: "disable",
      connectTimeoutMs: 1000,
    });
    await expect(client.connect()).rejects.toBeInstanceOf(ConnectionLostError);
  });

  test("a clean handshake rejection does not retry in a loop", async () => {
    let attempts = 0;
    const port = await startSrv((socket) => {
      attempts++;
      socket.once("data", () => socket.end());
    });
    const client = new PgClient({
      host: "127.0.0.1",
      port,
      user: "x",
      password: "x",
      database: "x",
      sslmode: "disable",
      connectTimeoutMs: 1000,
    });
    await expect(client.connect()).rejects.toBeInstanceOf(ConnectionLostError);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(attempts).toBe(1);
  });

  test("an authentication failure closes the rejected startup socket", async () => {
    let closed!: () => void;
    const socketClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const port = await startSrv((socket) => {
      let startup = false;
      socket.on("close", closed);
      socket.on("data", () => {
        if (!startup) {
          startup = true;
          socket.write("N");
          return;
        }
        socket.write(errorResponse("bad password"));
      });
    });
    const client = new PgClient({
      host: "127.0.0.1",
      port,
      user: "x",
      password: "x",
      database: "x",
      connectTimeoutMs: 1000,
    });
    await expect(client.connect()).rejects.toThrow();
    await Promise.race([
      socketClosed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("rejected startup socket remained open")), 500)
      ),
    ]);
  });
});
