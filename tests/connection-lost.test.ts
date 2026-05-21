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
});
