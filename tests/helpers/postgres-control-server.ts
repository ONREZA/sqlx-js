import { createServer, type Socket } from "node:net";

export interface ControlReply {
  parameterOids: number[];
  flag: "acquired" | "held" | "released";
  rows: (string | null)[][] | Promise<(string | null)[][]>;
  onExecute?: () => void;
}

function integer(value: number, bytes: 2 | 4 = 4): Buffer {
  const result = Buffer.alloc(bytes);
  if (bytes === 2) result.writeInt16BE(value);
  else result.writeInt32BE(value);
  return result;
}

function frame(type: string, body = Buffer.alloc(0)): Buffer {
  return Buffer.concat([Buffer.from(type), integer(body.length + 4), body]);
}

function fields(flag: string): Buffer {
  return frame("T", Buffer.concat([
    integer(2, 2),
    ...[["backend_pid", 23, 4], [flag, 16, 1]].map(([name, oid, size]) => Buffer.concat([
      Buffer.from(`${name}\0`), integer(0), integer(0, 2),
      integer(Number(oid)), integer(Number(size), 2), integer(-1), integer(0, 2),
    ])),
  ]));
}

export async function controlServer(replies: ControlReply[]) {
  const sockets = new Set<Socket>();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  let connections = 0;
  let executions = 0;
  let serverError: unknown;
  const server = createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      resolveClosed();
    });
    socket.on("error", () => {});
    let startup = true;
    let buffer = Buffer.alloc(0);
    let queue = Promise.resolve();
    let reply: ControlReply | undefined;
    const receive = async (type: string) => {
      if (type === "P") {
        reply = replies[executions];
        if (!reply) throw new Error("unexpected control query");
        socket.write(frame("1"));
      } else if (type === "D") {
        if (!reply) throw new Error("describe without parse");
        socket.write(Buffer.concat([
          frame("t", Buffer.concat([
            integer(reply.parameterOids.length, 2), ...reply.parameterOids.map((oid) => integer(oid)),
          ])),
          fields(reply.flag),
        ]));
      } else if (type === "B") {
        socket.write(frame("2"));
      } else if (type === "E") {
        if (!reply) throw new Error("execute without parse");
        executions++;
        reply.onExecute?.();
        const rows = await reply.rows;
        if (socket.destroyed) return;
        socket.write(Buffer.concat([
          ...rows.map((row) => frame("D", Buffer.concat([
            integer(row.length, 2),
            ...row.map((value) => value === null ? integer(-1) : Buffer.concat([
              integer(Buffer.byteLength(value)), Buffer.from(value),
            ])),
          ]))),
          frame("C", Buffer.from(`SELECT ${rows.length}\0`)),
        ]));
      } else if (type === "S") {
        socket.write(frame("Z", Buffer.from("I")));
      } else if (type === "X") {
        socket.end();
      } else if (type !== "H") {
        throw new Error(`unexpected frontend message ${type}`);
      }
    };
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (startup) {
        if (buffer.length < 4 || buffer.length < buffer.readInt32BE(0)) return;
        buffer = buffer.subarray(buffer.readInt32BE(0));
        startup = false;
        socket.write(Buffer.concat([
          frame("R", integer(0)),
          ...[["server_version", "17.0"], ["TimeZone", "UTC"], ["DateStyle", "ISO, MDY"]]
            .map(([name, value]) => frame("S", Buffer.from(`${name}\0${value}\0`))),
          frame("K", Buffer.concat([integer(123), integer(456)])),
          frame("Z", Buffer.from("I")),
        ]));
      }
      while (buffer.length >= 5) {
        const length = 1 + buffer.readInt32BE(1);
        if (buffer.length < length) return;
        const type = String.fromCharCode(buffer[0]!);
        buffer = buffer.subarray(length);
        queue = queue.then(() => receive(type)).catch((error: unknown) => {
          serverError ??= error;
          socket.destroy();
        });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a TCP server");
  return {
    url: `postgresql://x:x@127.0.0.1:${address.port}/x?sslmode=disable`,
    closed,
    get connections() { return connections; },
    get executions() { return executions; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (serverError) throw serverError;
    },
  };
}

export async function within<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 2_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
