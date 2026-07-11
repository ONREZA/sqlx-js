import { createSqlClient } from "@onreza/sqlx-js";
import type { SqlxJsGeneratedRegistry } from "./sqlx-js-env";

export function createExampleDatabase(databaseUrl: string) {
  return createSqlClient<SqlxJsGeneratedRegistry>(databaseUrl);
}
