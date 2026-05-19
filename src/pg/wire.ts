import { connect, type Socket } from "bun";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

export type ConnConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

export function parseDatabaseUrl(url: string): ConnConfig {
  const u = new URL(url);
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
    throw new Error(`unsupported scheme: ${u.protocol}`);
  }
  return {
    host: u.hostname || "localhost",
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username || "postgres"),
    password: decodeURIComponent(u.password || ""),
    database: u.pathname.replace(/^\//, "") || u.username || "postgres",
  };
}

export type ServerMessage =
  | { type: "R"; code: number; payload: Uint8Array }
  | { type: "S"; name: string; value: string }
  | { type: "K"; pid: number; secret: number }
  | { type: "Z"; status: string }
  | { type: "1" }
  | { type: "2" }
  | { type: "3" }
  | { type: "n" }
  | { type: "t"; oids: number[] }
  | { type: "T"; fields: FieldDescription[] }
  | { type: "E"; fields: Record<string, string> }
  | { type: "N"; fields: Record<string, string> }
  | { type: "C"; tag: string }
  | { type: "D"; columns: (Uint8Array | null)[] }
  | { type: "other"; tag: string; payload: Uint8Array };

export type FieldDescription = {
  name: string;
  tableOid: number;
  columnAttr: number;
  typeOid: number;
  typeSize: number;
  typeModifier: number;
  format: number;
};

class MessageReader {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): ServerMessage[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;

    const out: ServerMessage[] = [];
    while (this.buf.length >= 5) {
      const len = readInt32(this.buf, 1);
      const total = 1 + len;
      if (this.buf.length < total) break;
      const tag = String.fromCharCode(this.buf[0]!);
      const payload = this.buf.subarray(5, total);
      out.push(parseMessage(tag, payload));
      this.buf = this.buf.subarray(total);
    }
    return out;
  }
}

function parseMessage(tag: string, payload: Uint8Array): ServerMessage {
  switch (tag) {
    case "R": {
      const code = readInt32(payload, 0);
      return { type: "R", code, payload: payload.subarray(4) };
    }
    case "S": {
      const [name, rest] = readCString(payload, 0);
      const [value] = readCString(payload, rest);
      return { type: "S", name, value };
    }
    case "K":
      return { type: "K", pid: readInt32(payload, 0), secret: readInt32(payload, 4) };
    case "Z":
      return { type: "Z", status: String.fromCharCode(payload[0]!) };
    case "1":
      return { type: "1" };
    case "2":
      return { type: "2" };
    case "3":
      return { type: "3" };
    case "n":
      return { type: "n" };
    case "t": {
      const n = readInt16(payload, 0);
      const oids: number[] = [];
      for (let i = 0; i < n; i++) oids.push(readInt32(payload, 2 + i * 4));
      return { type: "t", oids };
    }
    case "T": {
      const n = readInt16(payload, 0);
      let off = 2;
      const fields: FieldDescription[] = [];
      for (let i = 0; i < n; i++) {
        const [name, next] = readCString(payload, off);
        off = next;
        const tableOid = readInt32(payload, off); off += 4;
        const columnAttr = readInt16(payload, off); off += 2;
        const typeOid = readInt32(payload, off); off += 4;
        const typeSize = readInt16(payload, off); off += 2;
        const typeModifier = readInt32(payload, off); off += 4;
        const format = readInt16(payload, off); off += 2;
        fields.push({ name, tableOid, columnAttr, typeOid, typeSize, typeModifier, format });
      }
      return { type: "T", fields };
    }
    case "E":
    case "N": {
      const fields: Record<string, string> = {};
      let off = 0;
      while (off < payload.length && payload[off] !== 0) {
        const code = String.fromCharCode(payload[off]!);
        off += 1;
        const [val, next] = readCString(payload, off);
        fields[code] = val;
        off = next;
      }
      return { type: tag as "E" | "N", fields };
    }
    case "C": {
      const [tagStr] = readCString(payload, 0);
      return { type: "C", tag: tagStr };
    }
    case "D": {
      const n = readInt16(payload, 0);
      let off = 2;
      const cols: (Uint8Array | null)[] = [];
      for (let i = 0; i < n; i++) {
        const len = readInt32(payload, off);
        off += 4;
        if (len === -1) cols.push(null);
        else { cols.push(payload.subarray(off, off + len)); off += len; }
      }
      return { type: "D", columns: cols };
    }
    default:
      return { type: "other", tag, payload };
  }
}

function readInt16(b: Uint8Array, o: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getInt16(o, false);
}
function readInt32(b: Uint8Array, o: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getInt32(o, false);
}
function readCString(b: Uint8Array, off: number): [string, number] {
  let end = off;
  while (end < b.length && b[end] !== 0) end++;
  const s = new TextDecoder("utf-8").decode(b.subarray(off, end));
  return [s, end + 1];
}

function writeInt32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n, false);
  return b;
}
function writeInt16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setInt16(0, n, false);
  return b;
}
function cstr(s: string): Uint8Array {
  const enc = new TextEncoder().encode(s);
  const out = new Uint8Array(enc.length + 1);
  out.set(enc);
  return out;
}
function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function frame(tag: string | null, body: Uint8Array): Uint8Array {
  const lenBytes = writeInt32(body.length + 4);
  if (tag === null) return concat([lenBytes, body]);
  const tb = new Uint8Array(1);
  tb[0] = tag.charCodeAt(0);
  return concat([tb, lenBytes, body]);
}

export class PgClient {
  private sock!: Socket;
  private reader = new MessageReader();
  private queue: ServerMessage[] = [];
  private waiters: ((msg: ServerMessage) => void)[] = [];
  private closed = false;
  private closeReason: Error | null = null;

  constructor(private cfg: ConnConfig) {}

  async connect(): Promise<void> {
    this.sock = await connect({
      hostname: this.cfg.host,
      port: this.cfg.port,
      socket: {
        data: (_s, chunk) => {
          for (const m of this.reader.push(chunk)) this.deliver(m);
        },
        close: () => {
          this.closed = true;
          this.closeReason = new Error("connection closed");
          this.flushWaiters();
        },
        error: (_s, err) => {
          this.closed = true;
          this.closeReason = err;
          this.flushWaiters();
        },
      },
    });

    await this.startup();
    await this.authenticate();
    await this.awaitReady();
  }

  private deliver(msg: ServerMessage) {
    const w = this.waiters.shift();
    if (w) w(msg);
    else this.queue.push(msg);
  }

  private flushWaiters() {
    while (this.waiters.length) {
      const w = this.waiters.shift()!;
      w({ type: "E", fields: { M: this.closeReason?.message ?? "closed" } });
    }
  }

  private next(): Promise<ServerMessage> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    if (this.closed) return Promise.reject(this.closeReason);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private write(buf: Uint8Array) {
    this.sock.write(buf);
  }

  private async startup(): Promise<void> {
    const params = concat([
      cstr("user"), cstr(this.cfg.user),
      cstr("database"), cstr(this.cfg.database),
      cstr("client_encoding"), cstr("UTF8"),
      new Uint8Array([0]),
    ]);
    const body = concat([writeInt32(196608), params]);
    this.write(frame(null, body));
  }

  private async authenticate(): Promise<void> {
    while (true) {
      const m = await this.next();
      if (m.type !== "R") throw new Error(`expected R, got ${m.type}: ${stringifyMessage(m)}`);
      if (m.code === 0) return;
      if (m.code === 3) {
        const body = cstr(this.cfg.password);
        this.write(frame("p", body));
        continue;
      }
      if (m.code === 5) {
        const salt = m.payload.subarray(0, 4);
        const md5 = (data: Uint8Array | string) =>
          createHash("md5").update(typeof data === "string" ? Buffer.from(data) : data).digest("hex");
        const inner = md5(this.cfg.password + this.cfg.user);
        const combined = Buffer.concat([Buffer.from(inner, "utf8"), Buffer.from(salt)]);
        const outer = "md5" + md5(combined);
        this.write(frame("p", cstr(outer)));
        continue;
      }
      if (m.code === 10) {
        await this.scramAuth(m.payload);
        continue;
      }
      throw new Error(`unsupported auth code ${m.code}`);
    }
  }

  private async scramAuth(initialPayload: Uint8Array): Promise<void> {
    const mechs: string[] = [];
    let off = 0;
    while (off < initialPayload.length) {
      const [name, next] = readCString(initialPayload, off);
      if (!name) break;
      mechs.push(name);
      off = next;
    }
    if (!mechs.includes("SCRAM-SHA-256")) {
      throw new Error(`server offered ${mechs.join(",")}; no SCRAM-SHA-256`);
    }
    const clientNonce = randomBytes(18).toString("base64");
    const clientFirstBare = `n=,r=${clientNonce}`;
    const clientFirst = `n,,${clientFirstBare}`;
    const initialBody = concat([
      cstr("SCRAM-SHA-256"),
      writeInt32(clientFirst.length),
      new TextEncoder().encode(clientFirst),
    ]);
    this.write(frame("p", initialBody));

    const m1 = await this.next();
    if (m1.type !== "R" || m1.code !== 11) throw new Error(`SCRAM: expected R/11, got ${stringifyMessage(m1)}`);
    const serverFirst = new TextDecoder().decode(m1.payload);
    const sf = parseScramKv(serverFirst);
    const combinedNonce = scramField(sf, "r");
    if (!combinedNonce.startsWith(clientNonce)) throw new Error("SCRAM: server nonce mismatch");
    const salt = Buffer.from(scramField(sf, "s"), "base64");
    const iterations = parseInt(scramField(sf, "i"), 10);

    const saltedPassword = pbkdf2Sync(this.cfg.password, salt, iterations, 32, "sha256");
    const clientKey = createHmac("sha256", saltedPassword).update("Client Key").digest();
    const storedKey = createHash("sha256").update(clientKey).digest();

    const clientFinalNoProof = `c=biws,r=${combinedNonce}`;
    const authMessage = `${clientFirstBare},${serverFirst},${clientFinalNoProof}`;
    const clientSignature = createHmac("sha256", storedKey).update(authMessage).digest();
    const clientProof = Buffer.alloc(clientKey.length);
    for (let i = 0; i < clientKey.length; i++) clientProof[i] = clientKey[i]! ^ clientSignature[i]!;
    const clientFinal = `${clientFinalNoProof},p=${clientProof.toString("base64")}`;

    this.write(frame("p", new TextEncoder().encode(clientFinal)));

    const m2 = await this.next();
    if (m2.type !== "R" || m2.code !== 12) throw new Error(`SCRAM: expected R/12, got ${stringifyMessage(m2)}`);
    const serverFinal = new TextDecoder().decode(m2.payload);
    const sfKv = parseScramKv(serverFinal);
    if (sfKv.e) throw new Error(`SCRAM server error: ${sfKv.e}`);
    const serverKey = createHmac("sha256", saltedPassword).update("Server Key").digest();
    const expected = createHmac("sha256", serverKey).update(authMessage).digest().toString("base64");
    if (sfKv.v !== expected) throw new Error("SCRAM: server signature mismatch");
  }

  private async awaitReady(): Promise<void> {
    while (true) {
      const m = await this.next();
      if (m.type === "Z") return;
      if (m.type === "E") throw pgError(m.fields);
    }
  }

  async describe(sql: string): Promise<{ paramOids: number[]; fields: FieldDescription[] }> {
    const stmtName = "";
    const parseBody = concat([
      cstr(stmtName),
      cstr(sql),
      writeInt16(0),
    ]);
    this.write(frame("P", parseBody));
    const describeBody = concat([
      new Uint8Array([0x53]),
      cstr(stmtName),
    ]);
    this.write(frame("D", describeBody));
    this.write(frame("S", new Uint8Array(0)));

    let paramOids: number[] = [];
    let fields: FieldDescription[] = [];
    let sawNoData = false;
    let sawRowDesc = false;
    let err: PgError | null = null;
    while (true) {
      const m = await this.next();
      if (m.type === "1") continue;
      if (m.type === "t") { paramOids = m.oids; continue; }
      if (m.type === "T") { fields = m.fields; sawRowDesc = true; continue; }
      if (m.type === "n") { sawNoData = true; continue; }
      if (m.type === "Z") break;
      if (m.type === "E") { err = pgError(m.fields); continue; }
    }
    if (err) throw err;
    if (!sawRowDesc && !sawNoData) throw new Error("describe: neither RowDescription nor NoData");
    return { paramOids, fields };
  }

  async simpleQueryAll(sql: string): Promise<{ rows: (Uint8Array | null)[][]; fields: FieldDescription[]; tags: string[] }> {
    this.write(frame("Q", cstr(sql)));
    const allRows: (Uint8Array | null)[][] = [];
    let lastFields: FieldDescription[] = [];
    const tags: string[] = [];
    let err: PgError | null = null;
    while (true) {
      const m = await this.next();
      if (m.type === "T") lastFields = m.fields;
      else if (m.type === "D") allRows.push(m.columns);
      else if (m.type === "C") tags.push(m.tag);
      else if (m.type === "Z") break;
      else if (m.type === "E") err = pgError(m.fields);
    }
    if (err) throw err;
    return { rows: allRows, fields: lastFields, tags };
  }

  async simpleQuery(sql: string): Promise<{ rows: (Uint8Array | null)[][]; fields: FieldDescription[]; tag: string }> {
    this.write(frame("Q", cstr(sql)));
    const rows: (Uint8Array | null)[][] = [];
    let fields: FieldDescription[] = [];
    let tag = "";
    let err: PgError | null = null;
    while (true) {
      const m = await this.next();
      if (m.type === "T") fields = m.fields;
      else if (m.type === "D") rows.push(m.columns);
      else if (m.type === "C") tag = m.tag;
      else if (m.type === "Z") break;
      else if (m.type === "E") err = pgError(m.fields);
    }
    if (err) throw err;
    return { rows, fields, tag };
  }

  async end(): Promise<void> {
    try { this.write(frame("X", new Uint8Array(0))); } catch {}
    this.sock.end();
  }
}

function parseScramKv(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

function scramField(kv: Record<string, string>, key: string): string {
  const v = kv[key];
  if (v === undefined) throw new Error(`SCRAM: missing field "${key}"`);
  return v;
}

function stringifyMessage(m: ServerMessage): string {
  return JSON.stringify(m, (_k, v) => v instanceof Uint8Array ? `<${v.length}B>` : v);
}

export class PgError extends Error {
  constructor(public fields: Record<string, string>) {
    super(fields.M ?? "postgres error");
  }
  get code(): string | undefined { return this.fields.C; }
  get position(): number | undefined { return this.fields.P ? Number(this.fields.P) : undefined; }
  get hint(): string | undefined { return this.fields.H; }
}

function pgError(fields: Record<string, string>): PgError {
  return new PgError(fields);
}

export function decodeText(b: Uint8Array | null): string | null {
  return b === null ? null : new TextDecoder().decode(b);
}
