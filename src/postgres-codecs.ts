import {
  encodePgArrayLiteral,
  encodePgArrayLiteralElements,
  parsePgArrayLiteral,
} from "./runtime";

export type RuntimeTypeCodec<T = unknown> = {
  parse(value: string): T;
  serialize(value: T): string;
};

export type RuntimeTypeCodecs = Readonly<Record<string, RuntimeTypeCodec>>;

type ParsedCodecOptions = {
  parsers?: Record<number, (value: string) => unknown>;
  serializers?: Record<number, (value: unknown) => unknown>;
  types?: Record<string, { to?: number; from?: number | number[] }>;
};

type ValuesQuery = PromiseLike<unknown[][]>;
type CodecClient = {
  options: ParsedCodecOptions;
  unsafe: (query: string, params?: unknown[]) => { values: () => ValuesQuery };
};

type TypeRow = {
  schema: string;
  name: string;
  oid: number;
  arrayOid: number;
  kind: string;
  baseOid: number;
  relationOid: number;
};

type CompositeField = {
  name?: string;
  typeOid: number;
};

const BUILTIN_CODECS: RuntimeTypeCodecs = {
  vector: { parse: parseVector, serialize: serializeVector },
  halfvec: { parse: parseVector, serialize: serializeVector },
  hstore: { parse: parseHstore, serialize: serializeHstore },
  sparsevec: { parse: String, serialize: String },
  citext: { parse: String, serialize: String },
  ltree: { parse: String, serialize: String },
  lquery: { parse: String, serialize: String },
  ltxtquery: { parse: String, serialize: String },
};

export function parseVector(value: string): number[] {
  if (!value.startsWith("[") || !value.endsWith("]")) {
    throw new Error(`sqlx-js: malformed vector value: ${value}`);
  }
  const body = value.slice(1, -1);
  if (body === "") return [];
  return body.split(",").map((part) => {
    const number = Number(part);
    if (Number.isNaN(number) && part !== "NaN") {
      throw new Error(`sqlx-js: malformed vector value: ${value}`);
    }
    return number;
  });
}

export function serializeVector(value: readonly number[]): string {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number")) {
    throw new Error("sqlx-js: vector value must be an array of numbers");
  }
  return `[${value.map(String).join(",")}]`;
}

function parseQuoted(value: string, start: number): { value: string; next: number } {
  let result = "";
  let index = start + 1;
  while (index < value.length) {
    const char = value[index++]!;
    if (char === '"') {
      if (value[index] === '"') {
        result += '"';
        index++;
        continue;
      }
      return { value: result, next: index };
    }
    if (char === "\\" && index < value.length) result += value[index++]!;
    else result += char;
  }
  throw new Error("sqlx-js: malformed quoted PostgreSQL value");
}

function quoteText(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function parseHstore(value: string): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  let index = 0;
  const skipSpace = () => {
    while (/\s/.test(value[index] ?? "")) index++;
  };
  const token = (untilArrow: boolean): string => {
    skipSpace();
    if (value[index] === '"') {
      const parsed = parseQuoted(value, index);
      index = parsed.next;
      return parsed.value;
    }
    const start = index;
    if (untilArrow) {
      while (index < value.length && value.slice(index, index + 2) !== "=>") index++;
    } else {
      while (index < value.length && value[index] !== ",") index++;
    }
    return value.slice(start, index).trim();
  };
  while (index < value.length) {
    const key = token(true);
    skipSpace();
    if (value.slice(index, index + 2) !== "=>") throw new Error("sqlx-js: malformed hstore value");
    index += 2;
    skipSpace();
    let item: string | null;
    if (value[index] === '"') {
      const parsed = parseQuoted(value, index);
      index = parsed.next;
      item = parsed.value;
    } else {
      const raw = token(false);
      item = raw === "NULL" ? null : raw;
    }
    Object.defineProperty(result, key, {
      value: item,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    skipSpace();
    if (index >= value.length) break;
    if (value[index] !== ",") throw new Error("sqlx-js: malformed hstore value");
    index++;
  }
  return result;
}

export function serializeHstore(value: Readonly<Record<string, string | null>>): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("sqlx-js: hstore value must be an object");
  }
  return Object.entries(value)
    .map(([key, item]) => {
      if (item !== null && typeof item !== "string") {
        throw new Error(`sqlx-js: hstore value for ${key} must be a string or null`);
      }
      return `${quoteText(key)}=>${item === null ? "NULL" : quoteText(item)}`;
    })
    .join(", ");
}

export function parseCompositeLiteral(value: string): (string | null)[] {
  if (!value.startsWith("(") || !value.endsWith(")")) {
    throw new Error(`sqlx-js: malformed composite value: ${value}`);
  }
  if (value === "()") return [];
  const result: (string | null)[] = [];
  let index = 1;
  while (index < value.length - 1) {
    if (value[index] === '"') {
      const parsed = parseQuoted(value, index);
      result.push(parsed.value);
      index = parsed.next;
    } else {
      const start = index;
      while (index < value.length - 1 && value[index] !== ",") index++;
      const raw = value.slice(start, index);
      result.push(raw === "" ? null : raw);
    }
    if (value[index] === ",") index++;
  }
  return result;
}

export function serializeCompositeLiteral(fields: readonly (string | null)[]): string {
  return `(${fields.map((field) => field === null ? "" : quoteText(field)).join(",")})`;
}

function numberValue(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`sqlx-js: invalid PostgreSQL type OID: ${value}`);
  return number;
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function configuredOids(options: ParsedCodecOptions): Set<number> {
  const result = new Set<number>();
  for (const type of Object.values(options.types ?? {})) {
    if (type.to !== undefined) result.add(type.to);
    const from = type.from === undefined ? [] : Array.isArray(type.from) ? type.from : [type.from];
    for (const oid of from) result.add(oid);
  }
  return result;
}

export class PostgresTypeRegistry {
  private pending: Promise<void> | undefined;
  private complete = false;
  private readonly client: CodecClient;

  constructor(
    client: unknown,
    private readonly codecs: RuntimeTypeCodecs = {},
  ) {
    this.client = client as CodecClient;
  }

  ready(): Promise<void> | undefined {
    if (this.complete) return undefined;
    if (
      !this.client.options.parsers
      || !this.client.options.serializers
    ) {
      this.complete = true;
      return undefined;
    }
    if (!this.pending) {
      this.pending = this.install().then(
        () => {
          this.complete = true;
          this.pending = undefined;
        },
        (error) => {
          this.pending = undefined;
          throw error;
        },
      );
    }
    return this.pending;
  }

  private codecFor(type: TypeRow): { codec: RuntimeTypeCodec; user: boolean } | undefined {
    const qualified = this.codecs[`${type.schema}.${type.name}`];
    if (qualified) return { codec: qualified, user: true };
    const bare = this.codecs[type.name];
    if (bare) return { codec: bare, user: true };
    const builtin = type.kind === "b" ? BUILTIN_CODECS[type.name] : undefined;
    return builtin ? { codec: builtin, user: false } : undefined;
  }

  private async install(): Promise<void> {
    const requestedNames = new Set([...Object.keys(BUILTIN_CODECS), ...Object.keys(this.codecs)]
      .map((name) => name.split(".").at(-1)!)
      .filter(Boolean));
    const requested = [...requestedNames].map(sqlLiteral).join(", ");
    const filter = requested ? `OR t.typname IN (${requested})` : "";
    const typeRows = await this.client.unsafe(`
      SELECT n.nspname, t.typname, t.oid::int8, t.typarray::int8,
             t.typtype::text, t.typbasetype::int8, t.typrelid::int8
      FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname <> 'pg_catalog'
        AND n.nspname <> 'information_schema'
        AND n.nspname NOT LIKE 'pg_toast%'
        AND n.nspname NOT LIKE 'pg_temp_%'
        AND (t.typtype IN ('e', 'd', 'c') ${filter})
      ORDER BY n.nspname, t.typname
    `, []).values();
    const types: TypeRow[] = typeRows.map((row) => ({
      schema: String(row[0]),
      name: String(row[1]),
      oid: numberValue(row[2]),
      arrayOid: numberValue(row[3]),
      kind: String(row[4]),
      baseOid: numberValue(row[5]),
      relationOid: numberValue(row[6]),
    }));
    const typesByOid = new Map(types.map((type) => [type.oid, type]));
    const arrayElements = new Map(types
      .filter((type) => type.arrayOid > 0)
      .map((type) => [type.arrayOid, type.oid]));

    for (const key of Object.keys(this.codecs)) {
      const matches = types.filter((type) => key.includes(".")
        ? `${type.schema}.${type.name}` === key
        : type.name === key);
      if (matches.length === 0) {
        throw new Error(`sqlx-js: runtime type codec ${key} does not match a PostgreSQL type`);
      }
      if (matches.some((type) => type.kind === "d")) {
        throw new Error(
          `sqlx-js: runtime type codec ${key} cannot override a PostgreSQL domain because result metadata exposes its base type`,
        );
      }
    }

    const relationOids = types.filter((type) => type.kind === "c" && type.relationOid > 0)
      .map((type) => type.relationOid);
    const fieldsByRelation = new Map<number, CompositeField[]>();
    if (relationOids.length > 0) {
      const fieldRows = await this.client.unsafe(`
        SELECT attrelid::int8, attname, atttypid::int8, attisdropped
        FROM pg_catalog.pg_attribute
        WHERE attrelid IN (${relationOids.join(", ")})
          AND attnum > 0
        ORDER BY attrelid, attnum
      `, []).values();
      for (const row of fieldRows) {
        const relationOid = numberValue(row[0]);
        const fields = fieldsByRelation.get(relationOid) ?? [];
        const dropped = row[3] === true;
        fields.push({
          ...(dropped ? {} : { name: String(row[1]) }),
          typeOid: dropped ? 0 : numberValue(row[2]),
        });
        fieldsByRelation.set(relationOid, fields);
      }
    }

    const options = this.client.options;
    const installedParsers = options.parsers!;
    const installedSerializers = options.serializers!;
    const explicit = configuredOids(options);
    const parsers = new Map<number, (value: string) => unknown>();
    const serializers = new Map<number, (value: unknown) => unknown>();
    const arrayShapedValue = (oid: number, seen = new Set<number>()): boolean => {
      if (oid === 114 || oid === 3802 || arrayElements.has(oid)) return true;
      if (seen.has(oid)) return false;
      seen.add(oid);
      const type = typesByOid.get(oid);
      if (!type) return false;
      const selected = this.codecFor(type);
      if (selected?.user) return true;
      if (type.kind === "b" && (type.name === "vector" || type.name === "halfvec")) return true;
      return type.kind === "d" && type.baseOid > 0
        ? arrayShapedValue(type.baseOid, seen)
        : false;
    };

    const parserFor = (oid: number): ((value: string) => unknown) => {
      const cached = parsers.get(oid);
      if (cached) return cached;
      const existing = installedParsers[oid];
      const type = typesByOid.get(oid);
      const arrayElement = arrayElements.get(oid);
      const selected = type ? this.codecFor(type) : undefined;
      if (existing && (arrayElement !== undefined
        ? explicit.has(oid)
        : !selected?.user || explicit.has(oid))) return existing;
      let implementation: (value: string) => unknown = (value) => value;
      const parser = (value: string) => implementation(value);
      parsers.set(oid, parser);
      if (arrayElement !== undefined) {
        implementation = (value) => parsePgArrayLiteral(value, parserFor(arrayElement));
      } else if (!type) implementation = existing ?? implementation;
      else if (selected) implementation = selected.codec.parse;
      else if (type.kind === "d" && type.baseOid > 0) implementation = parserFor(type.baseOid);
      else if (type.kind === "c") {
        const fields = fieldsByRelation.get(type.relationOid) ?? [];
        implementation = (value) => {
          const raw = parseCompositeLiteral(value);
          return Object.fromEntries(fields.flatMap((field, index) => {
            if (!field.name) return [];
            const item = raw[index] ?? null;
            return [[field.name, item === null ? null : parserFor(field.typeOid)(item)]];
          }));
        };
      }
      installedParsers[oid] = parser;
      return parser;
    };

    const serializerFor = (oid: number): ((value: unknown) => unknown) => {
      const cached = serializers.get(oid);
      if (cached) return cached;
      const existing = installedSerializers[oid];
      const type = typesByOid.get(oid);
      const arrayElement = arrayElements.get(oid);
      const selected = type ? this.codecFor(type) : undefined;
      if (existing && (arrayElement !== undefined
        ? explicit.has(oid)
        : !selected?.user || explicit.has(oid))) return existing;
      let implementation: (value: unknown) => unknown = (value) => String(value);
      const serializer = (value: unknown) => implementation(value);
      serializers.set(oid, serializer);
      if (arrayElement !== undefined) {
        implementation = (value) => {
          if (!Array.isArray(value)) throw new Error("sqlx-js: PostgreSQL array value must be an array");
          const encode = arrayShapedValue(arrayElement)
            ? encodePgArrayLiteralElements
            : encodePgArrayLiteral;
          return encode(value, (item) => String(serializerFor(arrayElement)(item)));
        };
      } else if (!type) implementation = existing ?? implementation;
      else if (selected) implementation = selected.codec.serialize as (value: unknown) => string;
      else if (type.kind === "d" && type.baseOid > 0) implementation = serializerFor(type.baseOid);
      else if (type.kind === "c") {
        const fields = fieldsByRelation.get(type.relationOid) ?? [];
        implementation = (value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error(`sqlx-js: PostgreSQL composite ${type.name} must be an object`);
          }
          const record = value as Record<string, unknown>;
          return serializeCompositeLiteral(fields.map((field) => {
            if (!field.name) return null;
            const item = record[field.name];
            if (item === undefined) {
              throw new Error(
                `sqlx-js: PostgreSQL composite ${type.name} field ${field.name} is undefined; pass null explicitly`,
              );
            }
            return item === null ? null : String(serializerFor(field.typeOid)(item));
          }));
        };
      }
      installedSerializers[oid] = serializer;
      return serializer;
    };

    for (const type of types) {
      if (!explicit.has(type.oid)) {
        installedParsers[type.oid] = parserFor(type.oid);
        installedSerializers[type.oid] = serializerFor(type.oid);
      }
      if (type.arrayOid > 0 && !explicit.has(type.arrayOid)) {
        const parseElement = parserFor(type.oid);
        const serializeElement = serializerFor(type.oid);
        installedParsers[type.arrayOid] = (value) => parsePgArrayLiteral(value, parseElement);
        installedSerializers[type.arrayOid] = (value) => {
          if (!Array.isArray(value)) throw new Error(`sqlx-js: PostgreSQL ${type.name}[] value must be an array`);
          const encode = arrayShapedValue(type.oid)
            ? encodePgArrayLiteralElements
            : encodePgArrayLiteral;
          return encode(value, (item) => String(serializeElement(item)));
        };
      }
    }
  }
}
