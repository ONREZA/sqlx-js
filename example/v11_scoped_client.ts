import { createSqlClient } from "@onreza/sqlx-js";
import type { SqlxJsGeneratedRegistry } from "./sqlx-js-env";
import queryDescriptors from "./.sqlx-js/runtime-descriptors.json" with { type: "json" };

export function createExampleDatabase(databaseUrl: string) {
  return createSqlClient<SqlxJsGeneratedRegistry>(databaseUrl, { queryDescriptors });
}
