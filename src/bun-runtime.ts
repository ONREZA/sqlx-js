import { SQL } from "bun";
import { createSqlRuntime, type RuntimeClient } from "./runtime";

export type BunClient = SQL;

class BunRuntimeClient implements RuntimeClient {
  constructor(public readonly client: BunClient) {}

  async query(query: string, params: unknown[]): Promise<unknown[]> {
    return await this.client.unsafe(query, params) as unknown[];
  }

  async transaction<R>(fn: (client: RuntimeClient) => Promise<R>): Promise<R> {
    return await this.client.begin(async (tx) => {
      return await fn(new BunRuntimeClient(tx));
    }) as R;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

let defaultClient: BunRuntimeClient | null = null;

function createDefaultClient(): BunRuntimeClient {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("sqlx-js: DATABASE_URL is not set");
  return new BunRuntimeClient(new SQL({ url, bigint: true }));
}

function getRuntimeClient(): BunRuntimeClient {
  defaultClient ??= createDefaultClient();
  return defaultClient;
}

export function getClient(): BunClient {
  return getRuntimeClient().client;
}

export function setClient(client: BunClient): void {
  defaultClient = new BunRuntimeClient(client);
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
