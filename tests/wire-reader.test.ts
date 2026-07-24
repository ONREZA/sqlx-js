import { describe, expect, test } from "bun:test";
import { assertSupportedPostgresVersion, MessageReader, postgresMajorVersion } from "../src/pg/wire";

const enc = new TextEncoder();

function buildMessage(tag: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + 4 + payload.length);
  out[0] = tag.charCodeAt(0);
  const len = payload.length + 4;
  out[1] = (len >>> 24) & 0xff;
  out[2] = (len >>> 16) & 0xff;
  out[3] = (len >>> 8) & 0xff;
  out[4] = len & 0xff;
  out.set(payload, 5);
  return out;
}

function cstr(s: string): Uint8Array {
  const bytes = enc.encode(s);
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function writeI16(n: number): Uint8Array {
  return new Uint8Array([(n >>> 8) & 0xff, n & 0xff]);
}
function writeI32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}
function writeI32Signed(n: number): Uint8Array {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setInt32(0, n, false);
  return new Uint8Array(buf);
}

function readyForQuery(): Uint8Array {
  return buildMessage("Z", new Uint8Array([0x49]));
}

function rowDesc(name: string): Uint8Array {
  const enc = new TextEncoder().encode(name);
  const payload = new Uint8Array(2 + enc.length + 1 + 4 + 2 + 4 + 2 + 4 + 2);
  payload[0] = 0; payload[1] = 1; // 1 field
  payload.set(enc, 2);
  // remaining fields: tableOid(4) attno(2) typeOid(4) size(2) modifier(4) format(2) → all zero
  return buildMessage("T", payload);
}

describe("MessageReader", () => {
  test("parses a complete message in a single chunk", () => {
    const r = new MessageReader();
    const out = r.push(readyForQuery());
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("Z");
  });

  test("buffers partial header bytes until len is known", () => {
    const r = new MessageReader();
    const msg = readyForQuery();
    expect(r.push(msg.subarray(0, 3))).toHaveLength(0);
    expect(r.push(msg.subarray(3))).toHaveLength(1);
  });

  test("buffers across many tiny chunks", () => {
    const r = new MessageReader();
    const msg = rowDesc("hello");
    let collected: any[] = [];
    for (let i = 0; i < msg.length; i++) {
      collected = collected.concat(r.push(msg.subarray(i, i + 1)));
    }
    expect(collected).toHaveLength(1);
    expect(collected[0].type).toBe("T");
    expect(collected[0].fields[0].name).toBe("hello");
  });

  test("parses multiple messages from a single chunk", () => {
    const r = new MessageReader();
    const combined = new Uint8Array(rowDesc("x").length + readyForQuery().length);
    const t = rowDesc("x");
    const z = readyForQuery();
    combined.set(t, 0);
    combined.set(z, t.length);
    const out = r.push(combined);
    expect(out).toHaveLength(2);
    expect(out[0]!.type).toBe("T");
    expect(out[1]!.type).toBe("Z");
  });

  test("emits messages incrementally as chunks arrive", () => {
    const r = new MessageReader();
    const t = rowDesc("col");
    const z = readyForQuery();
    const part1 = r.push(t);
    expect(part1).toHaveLength(1);
    const part2 = r.push(z);
    expect(part2).toHaveLength(1);
  });

  test("handles a large RowDescription split across chunks", () => {
    const r = new MessageReader();
    const names = ["alpha_column", "beta_column", "gamma_column", "delta_column", "epsilon_column"];
    const fieldBuffers: number[] = [];
    fieldBuffers.push(0, names.length);
    for (const n of names) {
      const bytes = enc.encode(n);
      for (const b of bytes) fieldBuffers.push(b);
      fieldBuffers.push(0);
      for (let i = 0; i < 18; i++) fieldBuffers.push(0);
    }
    const msg = buildMessage("T", new Uint8Array(fieldBuffers));
    let collected: any[] = [];
    const stride = 7;
    for (let i = 0; i < msg.length; i += stride) {
      collected = collected.concat(r.push(msg.subarray(i, Math.min(i + stride, msg.length))));
    }
    expect(collected).toHaveLength(1);
    expect(collected[0].fields).toHaveLength(5);
    expect(collected[0].fields[0].name).toBe("alpha_column");
    expect(collected[0].fields[4].name).toBe("epsilon_column");
  });
});

test("postgresMajorVersion reads stable and prerelease server versions", () => {
  expect(postgresMajorVersion("16.4")).toBe(16);
  expect(postgresMajorVersion("17beta2")).toBe(17);
  expect(postgresMajorVersion("unknown")).toBeNull();
  expect(assertSupportedPostgresVersion("18.1")).toBe(18);
  expect(() => assertSupportedPostgresVersion("15.14")).toThrow(
    "sqlx-js requires PostgreSQL 16 or newer; server reports 15.14",
  );
});

describe("MessageReader: extended message types", () => {
  test("parses ErrorResponse fields", () => {
    const payload = concat([
      new Uint8Array([0x53]), cstr("ERROR"),
      new Uint8Array([0x43]), cstr("23505"),
      new Uint8Array([0x4d]), cstr("duplicate key"),
      new Uint8Array([0x48]), cstr("use INSERT ... ON CONFLICT"),
      new Uint8Array([0]),
    ]);
    const r = new MessageReader();
    const out = r.push(buildMessage("E", payload));
    expect(out).toHaveLength(1);
    const m = out[0]!;
    expect(m.type).toBe("E");
    if (m.type !== "E") throw new Error("unreachable");
    expect(m.fields.S).toBe("ERROR");
    expect(m.fields.C).toBe("23505");
    expect(m.fields.M).toBe("duplicate key");
    expect(m.fields.H).toBe("use INSERT ... ON CONFLICT");
  });

  test("parses NoticeResponse (same structure, tag N)", () => {
    const payload = concat([
      new Uint8Array([0x53]), cstr("WARNING"),
      new Uint8Array([0x4d]), cstr("something"),
      new Uint8Array([0]),
    ]);
    const out = new MessageReader().push(buildMessage("N", payload));
    const m = out[0]!;
    expect(m.type).toBe("N");
    if (m.type !== "N") throw new Error("unreachable");
    expect(m.fields.S).toBe("WARNING");
  });

  test("parses DataRow with NULL column (length -1)", () => {
    const payload = concat([
      writeI16(3),
      writeI32(1), new Uint8Array([0x61]),
      writeI32Signed(-1),
      writeI32(2), new Uint8Array([0x62, 0x63]),
    ]);
    const out = new MessageReader().push(buildMessage("D", payload));
    const m = out[0]!;
    expect(m.type).toBe("D");
    if (m.type !== "D") throw new Error("unreachable");
    expect(m.columns).toHaveLength(3);
    expect(m.columns[0]).toEqual(new Uint8Array([0x61]));
    expect(m.columns[1]).toBeNull();
    expect(m.columns[2]).toEqual(new Uint8Array([0x62, 0x63]));
  });

  test("parses BackendKeyData (pid + secret)", () => {
    const payload = concat([writeI32(12345), writeI32(0xdeadbeef)]);
    const out = new MessageReader().push(buildMessage("K", payload));
    const m = out[0]!;
    expect(m.type).toBe("K");
    if (m.type !== "K") throw new Error("unreachable");
    expect(m.pid).toBe(12345);
    expect(m.secret | 0).toBe(0xdeadbeef | 0);
  });

  test("parses ParameterDescription with N>1", () => {
    const payload = concat([writeI16(3), writeI32(23), writeI32(25), writeI32(16)]);
    const out = new MessageReader().push(buildMessage("t", payload));
    const m = out[0]!;
    expect(m.type).toBe("t");
    if (m.type !== "t") throw new Error("unreachable");
    expect(m.oids).toEqual([23, 25, 16]);
  });

  test("preserves unsigned OIDs and signed variable-width type sizes", () => {
    const parameterPayload = concat([writeI16(1), writeI32(0xf0000001)]);
    const parameter = new MessageReader().push(buildMessage("t", parameterPayload))[0]!;
    expect(parameter).toEqual({ type: "t", oids: [0xf0000001] });

    const rowPayload = concat([
      writeI16(1),
      cstr("value"),
      writeI32(0xf0000001),
      writeI16(7),
      writeI32(0xe0000002),
      writeI16(-1),
      writeI32(-1),
      writeI16(0),
    ]);
    const row = new MessageReader().push(buildMessage("T", rowPayload))[0]!;
    expect(row.type).toBe("T");
    if (row.type !== "T") throw new Error("unreachable");
    expect(row.fields[0]).toEqual({
      name: "value",
      tableOid: 0xf0000001,
      columnAttr: 7,
      typeOid: 0xe0000002,
      typeSize: -1,
      typeModifier: -1,
      format: 0,
    });
  });

  test("parses ParameterStatus key/value", () => {
    const payload = concat([cstr("server_version"), cstr("17.2")]);
    const out = new MessageReader().push(buildMessage("S", payload));
    const m = out[0]!;
    expect(m.type).toBe("S");
    if (m.type !== "S") throw new Error("unreachable");
    expect(m.name).toBe("server_version");
    expect(m.value).toBe("17.2");
  });

  test("two large DataRows fragmented across randomized chunks", () => {
    const big = (start: number) => {
      const bytes = new Uint8Array(500);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (start + i) & 0xff;
      return bytes;
    };
    const row = (payload: Uint8Array) =>
      concat([writeI16(1), writeI32(payload.length), payload]);
    const m1 = buildMessage("D", row(big(0)));
    const m2 = buildMessage("D", row(big(100)));
    const z = readyForQuery();
    const stream = concat([m1, m2, z]);
    const r = new MessageReader();
    const collected: any[] = [];
    let off = 0;
    let seed = 1;
    while (off < stream.length) {
      seed = (seed * 1103515245 + 12345) | 0;
      const stride = 1 + (Math.abs(seed) % 73);
      const next = Math.min(off + stride, stream.length);
      collected.push(...r.push(stream.subarray(off, next)));
      off = next;
    }
    expect(collected.map((c) => c.type)).toEqual(["D", "D", "Z"]);
    expect(collected[0].columns[0]).toEqual(big(0));
    expect(collected[1].columns[0]).toEqual(big(100));
  });
});
