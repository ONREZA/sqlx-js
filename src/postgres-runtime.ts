import postgres from "postgres";
import { createSqlRuntime, encodeParam, encodePgArrayLiteral, parsePgArrayLiteral, type RuntimeClient } from "./runtime";
import { arrayElementOid, builtinArrayOids } from "./pg/oids";

export type PostgresClient = postgres.Sql<{ bigint: bigint }>;
export type PostgresOptions = postgres.Options<Record<string, postgres.PostgresType>>;
type PostgresQueryClient = PostgresClient | postgres.TransactionSql<{ bigint: bigint }>;

class PostgresRuntimeClient implements RuntimeClient {
  constructor(public readonly client: PostgresQueryClient) {}

  async query(query: string, params: unknown[]): Promise<unknown[]> {
    return await this.client.unsafe(query, params as never[], { prepare: true }) as unknown[];
  }

  transformParam(param: unknown): unknown {
    const elementOid = postgresNativeArrayElementOid(param);
    if (elementOid !== undefined) return this.client.array(param as never[], elementOid);
    return encodeParam(param);
  }

  async transaction<R>(fn: (client: RuntimeClient) => Promise<R>): Promise<R> {
    if (!("begin" in this.client)) throw new Error("sqlx-js.transaction: nested transactions are not supported");
    return await this.client.begin(async (tx) => {
      return await fn(new PostgresRuntimeClient(tx));
    }) as R;
  }

  async close(): Promise<void> {
    if ("end" in this.client) await this.client.end();
  }
}

let defaultClient: PostgresRuntimeClient | null = null;

const STRING_ARRAY_ELEMENT_OIDS = new Set([
  18,
  19,
  25,
  27,
  28,
  29,
  142,
  600,
  601,
  602,
  603,
  604,
  628,
  650,
  718,
  774,
  790,
  829,
  869,
  1042,
  1043,
  1083,
  1186,
  1266,
  1560,
  1562,
  1700,
  2950,
  2205,
  2206,
  3220,
  3614,
  3615,
  3904,
  3906,
  3908,
  3910,
  3912,
  3926,
  4451,
  4536,
]);

function parseSimpleArrayElement(oid: number): ((value: string) => unknown) | undefined {
  switch (oid) {
    case 16:
      return (value) => value === "t";
    case 20:
      return (value) => BigInt(value);
    case 21:
    case 23:
    case 26:
    case 700:
    case 701:
      return (value) => Number(value);
    default:
      return STRING_ARRAY_ELEMENT_OIDS.has(oid) ? (value) => value : undefined;
  }
}

function postgresNativeArrayElementOid(value: unknown): number | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  let oid: number | undefined;
  for (const item of value) {
    if (item === null) continue;
    const itemOid = item instanceof Uint8Array ? 17 : undefined;
    if (itemOid === undefined) return undefined;
    if (oid !== undefined && oid !== itemOid) return undefined;
    oid = itemOid;
  }
  return oid;
}

function postgresTypes(): Record<string, postgres.PostgresType> {
  const types: Record<string, postgres.PostgresType> = { bigint: postgres.BigInt };
  for (const oid of builtinArrayOids()) {
    const elementOid = arrayElementOid(oid);
    if (elementOid === undefined) continue;
    const parseElement = parseSimpleArrayElement(elementOid);
    if (!parseElement) continue;
    types[`array_${oid}`] = {
      to: oid,
      from: [oid],
      serialize: (value) => Array.isArray(value) ? encodePgArrayLiteral(value) : String(value),
      parse: (value) => parsePgArrayLiteral(value, parseElement),
    };
  }
  return types;
}

export function createClient(url = process.env.DATABASE_URL, options: PostgresOptions = {}): PostgresClient {
  if (!url) throw new Error("sqlx-js: DATABASE_URL is not set");
  return postgres(url, { ...options, types: { ...postgresTypes(), ...(options.types ?? {}) } }) as PostgresClient;
}

function createDefaultClient(): PostgresRuntimeClient {
  return new PostgresRuntimeClient(createClient());
}

function getRuntimeClient(): PostgresRuntimeClient {
  defaultClient ??= createDefaultClient();
  return defaultClient;
}

export function getClient(): PostgresClient {
  return getRuntimeClient().client as PostgresClient;
}

export function setClient(client: PostgresClient): void {
  defaultClient = new PostgresRuntimeClient(client);
}

export async function close(): Promise<void> {
  if (defaultClient) {
    await defaultClient.close();
    defaultClient = null;
  }
}

const runtime = createSqlRuntime(getRuntimeClient);

export const sql = runtime.sql;
export const unsafe = runtime.unsafe;
