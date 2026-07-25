import { createSqlClient } from "@onreza/sqlx-js";
import type { SqlxJsGeneratedRegistry } from "./sqlx-js-env";
import queryDescriptors from "./.sqlx-js/runtime-descriptors.json" with { type: "json" };

export async function createExampleDatabase(databaseUrl: string) {
  const database = createSqlClient<SqlxJsGeneratedRegistry>(databaseUrl, { queryDescriptors });
  await database.ready({ timeoutMs: 5_000 });
  return database;
}
