import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Socket, connect as netConnect } from "node:net";
import { TLSSocket, connect as tlsConnect } from "node:tls";

const textEncoder = new TextEncoder();

export const MIN_POSTGRES_MAJOR_VERSION = 16;

export function postgresMajorVersion(version: string): number | null {
  const match = /^(\d+)/.exec(version);
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) ? major : null;
}

export function assertSupportedPostgresVersion(version: string | undefined): number {
  const major = version ? postgresMajorVersion(version) : null;
  if (major !== null && major >= MIN_POSTGRES_MAJOR_VERSION) return major;
  throw new Error(
    `sqlx-js requires PostgreSQL ${MIN_POSTGRES_MAJOR_VERSION} or newer; server reports ${version ?? "unknown"}`,
  );
}

export const SSL_MODES = ["disable", "prefer", "require", "verify-ca", "verify-full"] as const;
export type SslMode = (typeof SSL_MODES)[number];

export type ConnConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  sslmode?: SslMode;
  applicationName?: string;
  startupOptions?: string;
  connectTimeoutMs?: number;
  statementTimeoutMs?: number;
  sslRootCert?: string;
  sslCert?: string;
  sslKey?: string;
  startupParameters?: Readonly<Record<string, string>>;
  onNotice?: (notice: PgNotice) => void | Promise<void>;
};

export type PgNotice = {
  message: string;
  severity?: string;
  code?: string;
  detail?: string;
  hint?: string;
};

export function parseDatabaseUrl(url: string): ConnConfig {
  const u = new URL(url);
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
    throw new Error(`unsupported scheme: ${u.protocol}`);
  }
  const params = u.searchParams;
  const hostname = decodeURIComponent(u.hostname);
  const sslmodeRaw = params.get("sslmode") ?? undefined;
  if (sslmodeRaw !== undefined && !(SSL_MODES as readonly string[]).includes(sslmodeRaw)) {
    throw new Error(`unsupported sslmode: ${sslmodeRaw}`);
  }
  const cfg: ConnConfig = {
    host: hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname || "localhost",
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username || "postgres"),
    password: decodeURIComponent(u.password || ""),
    database: decodeURIComponent(u.pathname.replace(/^\//, "")) || decodeURIComponent(u.username || "postgres"),
  };
  if (sslmodeRaw !== undefined) cfg.sslmode = sslmodeRaw as SslMode;
  const appName = params.get("application_name");
  if (appName) cfg.applicationName = appName;
  const startupOptions = params.get("options");
  if (startupOptions) cfg.startupOptions = startupOptions;
  const role = params.get("role");
  if (role) cfg.startupParameters = { role };
  const ct = params.get("connect_timeout");
  if (ct) {
    const n = Number(ct);
    if (Number.isFinite(n) && n > 0) cfg.connectTimeoutMs = n * 1000;
  }
  const st = params.get("statement_timeout");
  if (st) {
    const n = Number(st);
    if (Number.isFinite(n) && n >= 0) cfg.statementTimeoutMs = n;
  }
  const sslRootCert = params.get("sslrootcert");
  if (sslRootCert) cfg.sslRootCert = sslRootCert;
  const sslCert = params.get("sslcert");
  if (sslCert) cfg.sslCert = sslCert;
  const sslKey = params.get("sslkey");
  if (sslKey) cfg.sslKey = sslKey;
  return cfg;
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

export type PgRowResult = {
  rows: (Uint8Array | null)[][];
  fields: FieldDescription[];
  tag: string;
};

export type PlanValidation = "planned" | "parse-only";

export class MessageReader {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private offset = 0;

  push(chunk: Uint8Array): ServerMessage[] {
    this.chunks.push(chunk);
    this.size += chunk.length;
    return this.drain();
  }

  private buffered(): Uint8Array {
    if (this.chunks.length === 1) return this.chunks[0]!;
    const out = new Uint8Array(this.size);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    this.chunks = [out];
    return out;
  }

  private drain(): ServerMessage[] {
    const out: ServerMessage[] = [];
    while (true) {
      const available = this.size - this.offset;
      if (available < 5) break;
      const view = this.buffered();
      const len = readInt32(view, this.offset + 1);
      const total = 1 + len;
      if (available < total) break;
      const tag = String.fromCharCode(view[this.offset]!);
      const payload = view.subarray(this.offset + 5, this.offset + total);
      out.push(parseMessage(tag, copyOf(payload)));
      this.offset += total;
    }
    if (this.offset > 0) {
      const view = this.buffered();
      const tail = view.subarray(this.offset);
      this.chunks = tail.length > 0 ? [copyOf(tail)] : [];
      this.size = tail.length;
      this.offset = 0;
    }
    return out;
  }
}

function copyOf(view: Uint8Array): Uint8Array {
  const out = new Uint8Array(view.length);
  out.set(view);
  return out;
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
      for (let i = 0; i < n; i++) oids.push(readUInt32(payload, 2 + i * 4));
      return { type: "t", oids };
    }
    case "T": {
      const n = readInt16(payload, 0);
      let off = 2;
      const fields: FieldDescription[] = [];
      for (let i = 0; i < n; i++) {
        const [name, next] = readCString(payload, off);
        off = next;
        const tableOid = readUInt32(payload, off); off += 4;
        const columnAttr = readInt16(payload, off); off += 2;
        const typeOid = readUInt32(payload, off); off += 4;
        const typeSize = readSignedInt16(payload, off); off += 2;
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
  return (b[o]! << 8) | b[o + 1]!;
}
function readSignedInt16(b: Uint8Array, o: number): number {
  const value = readInt16(b, o);
  return value > 0x7fff ? value - 0x1_0000 : value;
}
function readInt32(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) | 0;
}
function readUInt32(b: Uint8Array, o: number): number {
  return readInt32(b, o) >>> 0;
}
function readCString(b: Uint8Array, off: number): [string, number] {
  let end = off;
  while (end < b.length && b[end] !== 0) end++;
  const s = new TextDecoder("utf-8").decode(b.subarray(off, end));
  return [s, end + 1];
}

function writeInt32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = (n >>> 24) & 0xff;
  b[1] = (n >>> 16) & 0xff;
  b[2] = (n >>> 8) & 0xff;
  b[3] = n & 0xff;
  return b;
}
function writeInt16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  b[0] = (n >>> 8) & 0xff;
  b[1] = n & 0xff;
  return b;
}
function cstr(s: string): Uint8Array {
  const enc = textEncoder.encode(s);
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

function isTlsRequired(mode: SslMode): boolean {
  return mode === "require" || mode === "verify-ca" || mode === "verify-full";
}

type AnySocket = Socket | TLSSocket;

function readCertFile(kind: string, path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (e) {
    throw new Error(`sqlx-js: cannot read ${kind} at ${path}: ${(e as Error).message}`);
  }
}

async function openPlainSocket(
  host: string,
  port: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const sock = netConnect({ host, port });
    let settled = false;
    const finish = (result: { socket: Socket } | { error: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      sock.removeListener("connect", onConnect);
      sock.removeListener("error", onError);
      if ("error" in result) reject(result.error);
      else resolve(result.socket);
    };
    const timer = setTimeout(() => {
      sock.destroy();
      finish({ error: new Error(`sqlx-js: TCP connect timeout to ${host}:${port} after ${timeoutMs}ms`) });
    }, timeoutMs);
    const onConnect = () => {
      sock.setNoDelay(true);
      finish({ socket: sock });
    };
    const onError = (error: Error) => finish({ error });
    const onAbort = () => {
      sock.destroy();
      finish({
        error: signal?.reason instanceof Error
          ? signal.reason
          : new Error("sqlx-js: PostgreSQL connection aborted"),
      });
    };
    sock.once("connect", onConnect);
    sock.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function performSslHandshake(
  sock: Socket,
  cfg: ConnConfig,
  mode: SslMode,
  signal: AbortSignal,
): Promise<{ sock: AnySocket; tls: boolean }> {
  const reply: number = await new Promise<number>((resolve, reject) => {
    let settled = false;
    const finish = (result: { reply: number } | { error: Error }) => {
      if (settled) return;
      settled = true;
      sock.removeListener("data", onData);
      sock.removeListener("error", onError);
      sock.removeListener("close", onClose);
      signal.removeEventListener("abort", onAbort);
      if ("error" in result) reject(result.error);
      else resolve(result.reply);
    };
    const onData = (chunk: Buffer) => {
      if (chunk.length === 0) {
        finish({ error: new Error("ssl: empty handshake reply") });
        return;
      }
      if (chunk.length > 1) {
        sock.unshift(chunk.subarray(1));
      }
      finish({ reply: chunk[0]! });
    };
    const onError = (error: Error) => finish({ error });
    const onClose = () => {
      finish({ error: new Error("sqlx-js: connection closed during SSL negotiation") });
    };
    const onAbort = () => {
      sock.destroy();
      finish({
        error: signal.reason instanceof Error
          ? signal.reason
          : new Error("sqlx-js: PostgreSQL connection aborted"),
      });
    };
    sock.once("data", onData);
    sock.once("error", onError);
    sock.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    sock.write(frame(null, writeInt32(80877103)));
  });
  if (reply === "S".charCodeAt(0)) {
    const tlsSock = await new Promise<TLSSocket>((resolve, reject) => {
      const t = tlsConnect({
        socket: sock,
        servername: cfg.host,
        rejectUnauthorized: mode === "verify-full" || mode === "verify-ca",
        checkServerIdentity: mode === "verify-full" ? undefined : () => undefined,
        ...(cfg.sslRootCert ? { ca: readCertFile("sslrootcert", cfg.sslRootCert) } : {}),
        ...(cfg.sslCert ? { cert: readCertFile("sslcert", cfg.sslCert) } : {}),
        ...(cfg.sslKey ? { key: readCertFile("sslkey", cfg.sslKey) } : {}),
      });
      let settled = false;
      const finish = (result: { socket: TLSSocket } | { error: Error }) => {
        if (settled) return;
        settled = true;
        t.removeListener("secureConnect", onSecureConnect);
        t.removeListener("error", onError);
        t.removeListener("close", onClose);
        signal.removeEventListener("abort", onAbort);
        if ("error" in result) reject(result.error);
        else resolve(result.socket);
      };
      const onSecureConnect = () => finish({ socket: t });
      const onError = (error: Error) => {
        sock.destroy();
        finish({ error });
      };
      const onClose = () => {
        finish({ error: new Error("sqlx-js: connection closed during TLS handshake") });
      };
      const onAbort = () => {
        t.destroy();
        finish({
          error: signal.reason instanceof Error
            ? signal.reason
            : new Error("sqlx-js: PostgreSQL connection aborted"),
        });
      };
      t.once("secureConnect", onSecureConnect);
      t.once("error", onError);
      t.once("close", onClose);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    return { sock: tlsSock, tls: true };
  }
  if (reply === "N".charCodeAt(0)) {
    if (isTlsRequired(mode)) {
      sock.destroy();
      throw new Error(`sqlx-js: server rejected SSL but sslmode=${mode} requires it`);
    }
    return { sock, tls: false };
  }
  sock.destroy();
  throw new Error(`sqlx-js: unexpected SSL handshake reply byte 0x${reply.toString(16)}`);
}

// PgClient is NOT concurrent-safe: every describe/simpleQuery/execParamsText expects
// to consume the entire stream of messages up to the next ReadyForQuery before
// the next call begins. Issue calls strictly sequentially per instance.
type Waiter = { resolve: (msg: ServerMessage) => void; reject: (err: Error) => void };

export class PgClient {
  private sock!: AnySocket;
  private reader = new MessageReader();
  private queue: ServerMessage[] = [];
  private waiters: Waiter[] = [];
  private closed = false;
  private closeReason: Error | null = null;
  private tlsEnabled = false;
  private serverVersionText: string | undefined;
  private planSequence = 0;
  private backendPid: number | undefined;
  private backendSecret: number | undefined;
  private readyStatus: string | undefined;
  private rejectConnect: ((error: Error) => void) | undefined;
  private connectAbort: AbortController | undefined;

  constructor(private cfg: ConnConfig) {}

  get usingTls(): boolean { return this.tlsEnabled; }
  get isClosed(): boolean { return this.closed; }
  get transactionStatus(): string | undefined { return this.readyStatus; }

  ref(): void {
    this.sock?.ref();
  }

  unref(): void {
    this.sock?.unref();
  }

  async connect(): Promise<void> {
    const timeoutMs = this.cfg.connectTimeoutMs ?? 15000;
    const connectAbort = new AbortController();
    this.connectAbort = connectAbort;
    let aborted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        aborted = true;
        const err = new Error(`sqlx-js: connect timeout to ${this.cfg.host}:${this.cfg.port} after ${timeoutMs}ms (includes TLS + authentication)`);
        this.closed = true;
        this.closeReason ??= err;
        connectAbort.abort(err);
        this.destroySocket();
        reject(err);
      }, timeoutMs);
    });
    let rejectInterrupted!: (error: Error) => void;
    const interrupted = new Promise<never>((_, reject) => {
      rejectInterrupted = reject;
    });
    this.rejectConnect = rejectInterrupted;
    try {
      await Promise.race([
        this.connectInner(timeoutMs, () => aborted || this.closed, connectAbort.signal),
        deadline,
        interrupted,
      ]);
    } catch (error) {
      this.destroy(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      if (this.rejectConnect === rejectInterrupted) this.rejectConnect = undefined;
      if (this.connectAbort === connectAbort) this.connectAbort = undefined;
      if (timer) clearTimeout(timer);
    }
  }

  private destroySocket(): void {
    try { (this.sock as AnySocket | undefined)?.destroy(); } catch { /* ignore */ }
  }

  // Cooperative cancellation: a socket can finish connecting after the deadline
  // has already rejected. Re-check `aborted` at each await boundary so a late
  // connection is torn down instead of leaking.
  private async connectInner(
    timeoutMs: number,
    aborted: () => boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const mode: SslMode = this.cfg.sslmode ?? "prefer";
    const plain = await openPlainSocket(this.cfg.host, this.cfg.port, timeoutMs, signal);
    this.sock = plain;
    if (aborted()) return this.abortConnect();
    let socket: AnySocket = plain;
    if (mode !== "disable") {
      const result = await performSslHandshake(plain, this.cfg, mode, signal);
      socket = result.sock;
      this.tlsEnabled = result.tls;
    }
    this.sock = socket;
    if (aborted()) return this.abortConnect();
    this.attachHandlers();

    await this.startup();
    await this.authenticate();
    await this.awaitReady();
    try {
      assertSupportedPostgresVersion(this.serverVersionText);
    } catch (error) {
      this.destroySocket();
      throw error;
    }
  }

  private abortConnect(): never {
    this.destroySocket();
    throw this.closeReason ?? new Error("sqlx-js: connect aborted");
  }

  private attachHandlers(): void {
    const onData = (chunk: Buffer) => {
      for (const m of this.reader.push(chunk)) this.deliver(m);
    };
    const onClose = () => {
      this.closed = true;
      if (!this.closeReason) this.closeReason = new Error("connection closed");
      this.flushWaiters();
    };
    const onError = (err: Error) => {
      this.closed = true;
      if (!this.closeReason) this.closeReason = err;
      this.flushWaiters();
    };
    this.sock.on("data", onData);
    this.sock.on("close", onClose);
    this.sock.on("error", onError);
  }

  private deliver(msg: ServerMessage) {
    if (msg.type === "Z") this.readyStatus = msg.status;
    if (msg.type === "other" && msg.tag === "A") return;
    if (msg.type === "N") {
      try {
        const pending = this.cfg.onNotice?.({
          message: msg.fields.M ?? "PostgreSQL notice",
          severity: msg.fields.S,
          code: msg.fields.C,
          detail: msg.fields.D,
          hint: msg.fields.H,
        });
        if (pending) void pending.catch(() => {});
      } catch {}
      return;
    }
    const w = this.waiters.shift();
    if (w) w.resolve(msg);
    else this.queue.push(msg);
  }

  private flushWaiters() {
    const reason = this.closeReason ?? new Error("connection closed");
    const err = new ConnectionLostError(reason);
    while (this.waiters.length) {
      const w = this.waiters.shift()!;
      w.reject(err);
    }
  }

  private next(): Promise<ServerMessage> {
    if (this.queue.length) return this.supportedMessage(Promise.resolve(this.queue.shift()!));
    if (this.closed) {
      const reason = this.closeReason ?? new Error("connection closed");
      return Promise.reject(new ConnectionLostError(reason));
    }
    return this.supportedMessage(
      new Promise((resolve, reject) => this.waiters.push({ resolve, reject })),
    );
  }

  private async supportedMessage(message: Promise<ServerMessage>): Promise<ServerMessage> {
    const value = await message;
    if (
      value.type === "other"
      && (value.tag === "G" || value.tag === "H" || value.tag === "W")
    ) {
      const error = new Error("sqlx-js: PostgreSQL COPY streaming protocol is not supported");
      this.destroy(error);
      throw error;
    }
    return value;
  }

  private write(buf: Uint8Array) {
    this.sock.write(buf);
  }

  private async startup(): Promise<void> {
    const pairs: Uint8Array[] = [
      cstr("user"), cstr(this.cfg.user),
      cstr("database"), cstr(this.cfg.database),
      cstr("client_encoding"), cstr("UTF8"),
    ];
    if (this.cfg.applicationName) {
      pairs.push(cstr("application_name"), cstr(this.cfg.applicationName));
    }
    if (this.cfg.startupOptions) {
      pairs.push(cstr("options"), cstr(this.cfg.startupOptions));
    }
    if (this.cfg.statementTimeoutMs !== undefined) {
      pairs.push(cstr("statement_timeout"), cstr(String(this.cfg.statementTimeoutMs)));
    }
    for (const [name, value] of Object.entries(this.cfg.startupParameters ?? {})) {
      pairs.push(cstr(name), cstr(value));
    }
    pairs.push(new Uint8Array([0]));
    const body = concat([writeInt32(196608), concat(pairs)]);
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
      textEncoder.encode(clientFirst),
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

    const clientFinalNoProof = `c=biws,r=${combinedNonce}`;
    const authMessage = `${clientFirstBare},${serverFirst},${clientFinalNoProof}`;
    const { clientProofB64, serverSignatureB64 } = computeScramProof(this.cfg.password, salt, iterations, authMessage);
    const clientFinal = `${clientFinalNoProof},p=${clientProofB64}`;

    this.write(frame("p", textEncoder.encode(clientFinal)));

    const m2 = await this.next();
    if (m2.type !== "R" || m2.code !== 12) throw new Error(`SCRAM: expected R/12, got ${stringifyMessage(m2)}`);
    const serverFinal = new TextDecoder().decode(m2.payload);
    const sfKv = parseScramKv(serverFinal);
    if (sfKv.e) throw new Error(`SCRAM server error: ${sfKv.e}`);
    if (sfKv.v !== serverSignatureB64) throw new Error("SCRAM: server signature mismatch");
  }

  private async awaitReady(): Promise<void> {
    while (true) {
      const m = await this.next();
      if (m.type === "Z") return;
      if (m.type === "S" && m.name === "server_version") this.serverVersionText = m.value;
      if (m.type === "K") {
        this.backendPid = m.pid;
        this.backendSecret = m.secret;
      }
      if (m.type === "E") throw pgError(m.fields);
    }
  }

  async cancel(): Promise<void> {
    if (this.backendPid === undefined || this.backendSecret === undefined || this.closed) return;
    const timeoutMs = this.cfg.connectTimeoutMs ?? 15000;
    const socket = await openPlainSocket(this.cfg.host, this.cfg.port, timeoutMs);
    const request = frame(null, concat([
      writeInt32(80877102),
      writeInt32(this.backendPid),
      writeInt32(this.backendSecret),
    ]));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`sqlx-js: cancel timeout to ${this.cfg.host}:${this.cfg.port} after ${timeoutMs}ms`));
      }, timeoutMs);
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.end(request);
    });
  }

  destroy(reason = new Error("connection destroyed")): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason ??= reason;
    this.connectAbort?.abort(this.closeReason);
    this.rejectConnect?.(this.closeReason);
    this.destroySocket();
    this.flushWaiters();
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
      if (m.type === "E") { if (!err) err = pgError(m.fields); continue; }
    }
    if (err) throw err;
    if (!sawRowDesc && !sawNoData) throw new Error("describe: neither RowDescription nor NoData");
    return { paramOids, fields };
  }

  async plan(sql: string, paramCount: number): Promise<PlanValidation> {
    // Binding placeholder values lets PostgreSQL build a value-dependent custom
    // plan. SQL PREPARE preserves inferred types while force_generic_plan keeps
    // correctness validation independent of those values.
    const statement = `sqlx_js_plan_${++this.planSequence}`;
    const prefix = `PREPARE ${statement} AS `;
    let inTransaction = false;
    let prepared = false;
    let planError: unknown;
    try {
      await this.simpleQuery("BEGIN");
      inTransaction = true;
      await this.simpleQuery("SET LOCAL plan_cache_mode = force_generic_plan");
      try {
        await this.simpleQuery(prefix + sql);
        prepared = true;
      } catch (error) {
        if (!(error instanceof PgError) || error.position === undefined) throw error;
        const position = Math.max(1, error.position - prefix.length);
        throw new PgError({ ...error.fields, P: String(position) }, { cause: error });
      }
      const params = Array.from({ length: paramCount }, () => "NULL").join(", ");
      const execute = paramCount === 0 ? statement : `${statement}(${params})`;
      await this.simpleQuery(`EXPLAIN (FORMAT JSON) EXECUTE ${execute}`);
    } catch (error) {
      planError = error;
    }
    if (inTransaction) {
      const cleanup = !prepared
        ? "ROLLBACK"
        : planError === undefined
          ? `DEALLOCATE ${statement}; ROLLBACK`
          : `ROLLBACK; DEALLOCATE ${statement}`;
      try {
        await this.simpleQueryAll(cleanup);
      } catch (error) {
        if (planError === undefined) throw error;
      }
    }
    if (!prepared && planError instanceof PgError && planError.code === "42601") return "parse-only";
    if (planError !== undefined) throw planError;
    return "planned";
  }

  async execParamsText(
    sql: string,
    params: (string | null)[],
  ): Promise<PgRowResult> {
    const stmtName = "";
    const parseBody = concat([cstr(stmtName), cstr(sql), writeInt16(0)]);
    this.write(frame("P", parseBody));
    return await this.execDescribedParamsText(params);
  }

  async execDescribedParamsText(params: (string | null)[]): Promise<PgRowResult> {
    const stmtName = "";
    const portal = "";
    const bindParts: Uint8Array[] = [
      cstr(portal),
      cstr(stmtName),
      writeInt16(0),
      writeInt16(params.length),
    ];
    for (const p of params) {
      if (p === null) {
        bindParts.push(writeInt32(-1));
      } else {
        const bytes = textEncoder.encode(p);
        bindParts.push(writeInt32(bytes.length));
        bindParts.push(bytes);
      }
    }
    bindParts.push(writeInt16(0));
    this.write(frame("B", concat(bindParts)));

    const describeBody = concat([new Uint8Array([0x50]), cstr(portal)]);
    this.write(frame("D", describeBody));

    const executeBody = concat([cstr(portal), writeInt32(0)]);
    this.write(frame("E", executeBody));

    this.write(frame("S", new Uint8Array(0)));

    const rows: (Uint8Array | null)[][] = [];
    let fields: FieldDescription[] = [];
    let tag = "";
    let err: PgError | null = null;
    while (true) {
      const m = await this.next();
      if (m.type === "1" || m.type === "2") continue;
      if (m.type === "T") { fields = m.fields; continue; }
      if (m.type === "n") continue;
      if (m.type === "D") { rows.push(m.columns); continue; }
      if (m.type === "C") { tag = m.tag; continue; }
      if (m.type === "Z") break;
      if (m.type === "E") { if (!err) err = pgError(m.fields); continue; }
    }
    if (err) throw err;
    return { rows, fields, tag };
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
      else if (m.type === "E") { if (!err) err = pgError(m.fields); }
    }
    if (err) throw err;
    return { rows: allRows, fields: lastFields, tags };
  }

  async simpleQuery(sql: string): Promise<PgRowResult> {
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
      else if (m.type === "E") { if (!err) err = pgError(m.fields); }
    }
    if (err) throw err;
    return { rows, fields, tag };
  }

  async end(): Promise<void> {
    try { this.write(frame("X", new Uint8Array(0))); } catch {}
    try { this.sock.end(); } catch {}
  }
}

export function computeScramProof(
  password: string,
  salt: Uint8Array,
  iterations: number,
  authMessage: string,
): { saltedPassword: Buffer; clientProofB64: string; serverSignatureB64: string } {
  const saltedPassword = pbkdf2Sync(password, Buffer.from(salt), iterations, 32, "sha256");
  const clientKey = createHmac("sha256", saltedPassword).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const clientSignature = createHmac("sha256", storedKey).update(authMessage).digest();
  const clientProof = Buffer.alloc(clientKey.length);
  for (let i = 0; i < clientKey.length; i++) clientProof[i] = clientKey[i]! ^ clientSignature[i]!;
  const serverKey = createHmac("sha256", saltedPassword).update("Server Key").digest();
  const serverSignature = createHmac("sha256", serverKey).update(authMessage).digest();
  return {
    saltedPassword,
    clientProofB64: clientProof.toString("base64"),
    serverSignatureB64: serverSignature.toString("base64"),
  };
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
  constructor(public fields: Record<string, string>, options?: { cause?: unknown }) {
    super(fields.M ?? "postgres error", options);
    this.name = "PgError";
    // Bun attaches own `line`/`column` properties to every Error instance, which
    // would shadow the prototype getters below. Drop them so `.column` resolves
    // to the PG column name, not the engine's source position.
    delete (this as unknown as Record<string, unknown>).line;
    delete (this as unknown as Record<string, unknown>).column;
  }
  get code(): string | undefined { return this.fields.C; }
  get position(): number | undefined { return this.fields.P ? Number(this.fields.P) : undefined; }
  get hint(): string | undefined { return this.fields.H; }
  get detail(): string | undefined { return this.fields.D; }
  get severity(): string | undefined { return this.fields.S; }
  get schema(): string | undefined { return this.fields.s; }
  get table(): string | undefined { return this.fields.t; }
  get column(): string | undefined { return this.fields.c; }
  get constraint(): string | undefined { return this.fields.n; }
}

export class ConnectionLostError extends Error {
  constructor(public readonly cause: Error) {
    super(`sqlx-js: connection lost: ${cause.message}`);
    this.name = "ConnectionLostError";
  }
}

function pgError(fields: Record<string, string>): PgError {
  return new PgError(fields);
}

export function decodeText(b: Uint8Array | null): string | null {
  return b === null ? null : new TextDecoder().decode(b);
}
