import { createSqlClient } from "@onreza/sqlx-js";
import { Temporal } from "@js-temporal/polyfill";
import type { SqlxJsGeneratedRegistry as GeneratedRegistry } from "./sqlx-js-env";
import queryDescriptors from "./.sqlx-js/runtime-descriptors.json" with { type: "json" };

export async function createExampleDatabase(databaseUrl: string) {
  const database = createSqlClient<GeneratedRegistry<typeof Temporal>>(databaseUrl, {
    queryDescriptors,
    temporalApi: Temporal,
  });
  await database.ready({ timeoutMs: 5_000 });
  return database;
}
