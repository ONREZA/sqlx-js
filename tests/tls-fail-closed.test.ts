import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectionLostError, PgClient, PgError } from "../src/pg/wire";

const SSL_REQUEST = Buffer.from("0000000804d2162f", "hex");
const STARTUP_PROTOCOL = 196_608;

let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function listen(onSocket: (socket: Socket) => void): Promise<number> {
  server = createServer(onSocket);
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP server address");
  return address.port;
}

function client(port: number, sslmode: "prefer" | "require" | "verify-ca" | "verify-full", timeout = 1_000) {
  return new PgClient({
    host: "127.0.0.1",
    port,
    user: "test",
    password: "test",
    database: "test",
    sslmode,
    connectTimeoutMs: timeout,
  });
}

function errorResponse(code: string, message: string): Buffer {
  const body = Buffer.from(`SERROR\0C${code}\0M${message}\0\0`);
  const frame = Buffer.alloc(5 + body.length);
  frame[0] = "E".charCodeAt(0);
  frame.writeInt32BE(body.length + 4, 1);
  body.copy(frame, 5);
  return frame;
}

async function within<T>(promise: Promise<T>, message: string): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(message)), 500);
    }),
  ]);
}

describe("TLS fail-closed negotiation", () => {
  test("required modes stop after an exact SSLRequest when PostgreSQL replies N", async () => {
    const captures: Buffer[][] = [];
    const closed: Array<Promise<void>> = [];
    const port = await listen((socket) => {
      const chunks: Buffer[] = [];
      captures.push(chunks);
      closed.push(new Promise<void>((resolve) => socket.once("close", resolve)));
      let replied = false;
      socket.on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
        if (!replied && Buffer.concat(chunks).length >= SSL_REQUEST.length) {
          replied = true;
          socket.write("N");
        }
      });
    });

    for (const mode of ["require", "verify-ca", "verify-full"] as const) {
      await expect(client(port, mode).connect()).rejects.toThrow(
        `sslmode=${mode} requires it`,
      );
    }
    await Promise.all(closed.map((connection) =>
      within(connection, "required TLS socket remained open")
    ));
    expect(captures).toHaveLength(3);
    for (const chunks of captures) {
      expect(Buffer.concat(chunks)).toEqual(SSL_REQUEST);
    }
  });

  test("a malformed SSL reply closes without PostgreSQL startup", async () => {
    const chunks: Buffer[] = [];
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const port = await listen((socket) => {
      socket.once("close", resolveClosed);
      socket.on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
        if (Buffer.concat(chunks).length === SSL_REQUEST.length) socket.write("X");
      });
    });

    await expect(client(port, "require").connect()).rejects.toThrow(
      "unexpected SSL handshake reply byte 0x58",
    );
    await within(closed, "malformed-reply socket remained open");
    expect(Buffer.concat(chunks)).toEqual(SSL_REQUEST);
  });

  test("a stalled SSL reply reaches the connect deadline without startup", async () => {
    const chunks: Buffer[] = [];
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const port = await listen((socket) => {
      socket.once("end", resolveClosed);
      socket.once("close", resolveClosed);
      socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    });

    await expect(client(port, "require", 250).connect()).rejects.toThrow(
      "TCP + TLS + authentication",
    );
    await within(closed, "stalled TLS socket remained open");
    expect(Buffer.concat(chunks)).toEqual(SSL_REQUEST);
  });

  test("a close before the SSL reply sends no startup bytes", async () => {
    const chunks: Buffer[] = [];
    const port = await listen((socket) => {
      socket.on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
        socket.destroy();
      });
    });

    await expect(client(port, "require").connect()).rejects.toThrow(
      "connection closed during SSL negotiation",
    );
    expect(Buffer.concat(chunks)).toEqual(SSL_REQUEST);
  });

  test("a close during TLS receives a ClientHello but no PostgreSQL startup", async () => {
    const negotiation: Buffer[] = [];
    const encrypted: Buffer[] = [];
    const port = await listen((socket) => {
      let accepted = false;
      socket.on("data", (chunk) => {
        if (!accepted) {
          negotiation.push(Buffer.from(chunk));
          if (Buffer.concat(negotiation).length >= SSL_REQUEST.length) {
            accepted = true;
            socket.write("S");
          }
          return;
        }
        encrypted.push(Buffer.from(chunk));
        socket.destroy();
      });
    });

    await expect(client(port, "require").connect()).rejects.toThrow();
    expect(Buffer.concat(negotiation)).toEqual(SSL_REQUEST);
    expect(encrypted.length).toBeGreaterThan(0);
    expect(encrypted[0]![0]).toBe(0x16);
  });

  test("a socket reset while TLS files are loading rejects the connection", async () => {
    const root = mkdtempSync(join(tmpdir(), "sqlx-js-tls-files-"));
    const rootCert = join(root, "root.crt");
    writeFileSync(rootCert, Buffer.alloc(4 * 1024 * 1024, 0x20));
    try {
      const port = await listen((socket) => {
        socket.once("data", () => {
          socket.write("S", () => socket.resetAndDestroy());
        });
      });
      const connection = new PgClient({
        host: "127.0.0.1",
        port,
        user: "test",
        password: "test",
        database: "test",
        sslmode: "require",
        sslRootCert: rootCert,
        connectTimeoutMs: 1_000,
      }).connect();

      await expect(connection).rejects.toBeInstanceOf(ConnectionLostError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a stalled TLS handshake reaches the connect deadline without startup", async () => {
    const negotiation: Buffer[] = [];
    const encrypted: Buffer[] = [];
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const port = await listen((socket) => {
      socket.once("close", resolveClosed);
      let accepted = false;
      socket.on("data", (chunk) => {
        if (!accepted) {
          negotiation.push(Buffer.from(chunk));
          if (Buffer.concat(negotiation).length >= SSL_REQUEST.length) {
            accepted = true;
            socket.write("S");
          }
          return;
        }
        encrypted.push(Buffer.from(chunk));
      });
    });

    await expect(client(port, "require", 100).connect()).rejects.toThrow(
      "TCP + TLS + authentication",
    );
    await within(closed, "stalled TLS-handshake socket remained open");
    expect(Buffer.concat(negotiation)).toEqual(SSL_REQUEST);
    expect(encrypted.length).toBeGreaterThan(0);
    expect(encrypted[0]![0]).toBe(0x16);
  });

  test("prefer alone may continue with a PostgreSQL startup after N", async () => {
    const negotiation: Buffer[] = [];
    const startup: Buffer[] = [];
    const port = await listen((socket) => {
      let rejectedTls = false;
      let replied = false;
      socket.on("data", (chunk) => {
        if (!rejectedTls) {
          negotiation.push(Buffer.from(chunk));
          if (Buffer.concat(negotiation).length >= SSL_REQUEST.length) {
            rejectedTls = true;
            socket.write("N");
          }
          return;
        }
        startup.push(Buffer.from(chunk));
        if (!replied && Buffer.concat(startup).length >= 8) {
          replied = true;
          socket.write(errorResponse("57P03", "database unavailable"));
        }
      });
    });

    const connection = client(port, "prefer").connect();
    await expect(connection).rejects.toBeInstanceOf(PgError);
    await expect(connection).rejects.toMatchObject({ code: "57P03" });
    expect(Buffer.concat(negotiation)).toEqual(SSL_REQUEST);
    expect(Buffer.concat(startup).readInt32BE(4)).toBe(STARTUP_PROTOCOL);
  });
});
