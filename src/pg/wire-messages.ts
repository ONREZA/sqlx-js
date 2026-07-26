const textDecoder = new TextDecoder();

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
  | { type: "D"; payload: Uint8Array }
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

export class MessageReader {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private offset = 0;

  push(
    chunk: Uint8Array,
    consumeDataRow?: (payload: Uint8Array) => void,
  ): ServerMessage[] {
    this.chunks.push(chunk);
    this.size += chunk.length;
    return this.drain(consumeDataRow);
  }

  private buffered(): Uint8Array {
    if (this.chunks.length === 1) return this.chunks[0]!;
    const out = new Uint8Array(this.size);
    let off = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, off);
      off += chunk.length;
    }
    this.chunks = [out];
    return out;
  }

  private drain(consumeDataRow?: (payload: Uint8Array) => void): ServerMessage[] {
    const out: ServerMessage[] = [];
    while (true) {
      const available = this.size - this.offset;
      if (available < 5) break;
      const view = this.buffered();
      const length = readInt32(view, this.offset + 1);
      const total = 1 + length;
      if (available < total) break;
      const tag = String.fromCharCode(view[this.offset]!);
      const payload = view.subarray(this.offset + 5, this.offset + total);
      if (tag === "D" && consumeDataRow) consumeDataRow(payload);
      else out.push(parseMessage(tag, payload));
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
      const count = readInt16(payload, 0);
      const oids: number[] = [];
      for (let index = 0; index < count; index++) {
        oids.push(readUInt32(payload, 2 + index * 4));
      }
      return { type: "t", oids };
    }
    case "T": {
      const count = readInt16(payload, 0);
      let offset = 2;
      const fields: FieldDescription[] = [];
      for (let index = 0; index < count; index++) {
        const [name, next] = readCString(payload, offset);
        offset = next;
        const tableOid = readUInt32(payload, offset); offset += 4;
        const columnAttr = readInt16(payload, offset); offset += 2;
        const typeOid = readUInt32(payload, offset); offset += 4;
        const typeSize = readSignedInt16(payload, offset); offset += 2;
        const typeModifier = readInt32(payload, offset); offset += 4;
        const format = readInt16(payload, offset); offset += 2;
        fields.push({ name, tableOid, columnAttr, typeOid, typeSize, typeModifier, format });
      }
      return { type: "T", fields };
    }
    case "E":
    case "N": {
      const fields: Record<string, string> = {};
      let offset = 0;
      while (offset < payload.length && payload[offset] !== 0) {
        const code = String.fromCharCode(payload[offset]!);
        offset += 1;
        const [value, next] = readCString(payload, offset);
        fields[code] = value;
        offset = next;
      }
      return { type: tag as "E" | "N", fields };
    }
    case "C": {
      const [commandTag] = readCString(payload, 0);
      return { type: "C", tag: commandTag };
    }
    case "D":
      return { type: "D", payload };
    default:
      return { type: "other", tag, payload };
  }
}

function readInt16(buffer: Uint8Array, offset: number): number {
  return (buffer[offset]! << 8) | buffer[offset + 1]!;
}

function readSignedInt16(buffer: Uint8Array, offset: number): number {
  const value = readInt16(buffer, offset);
  return value > 0x7fff ? value - 0x1_0000 : value;
}

function readInt32(buffer: Uint8Array, offset: number): number {
  return (
    (buffer[offset]! << 24)
    | (buffer[offset + 1]! << 16)
    | (buffer[offset + 2]! << 8)
    | buffer[offset + 3]!
  ) | 0;
}

function readUInt32(buffer: Uint8Array, offset: number): number {
  return readInt32(buffer, offset) >>> 0;
}

function readCString(buffer: Uint8Array, offset: number): [string, number] {
  let end = offset;
  while (end < buffer.length && buffer[end] !== 0) end++;
  return [textDecoder.decode(buffer.subarray(offset, end)), end + 1];
}
