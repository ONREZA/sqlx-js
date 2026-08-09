import { createSqlClient } from "@onreza/sqlx-js";
import { Temporal } from "@js-temporal/polyfill";
import type { SqlxJsGeneratedRegistry } from "./sqlx-js-env";
import queryDescriptors from "./.sqlx-js/runtime-descriptors.json" with { type: "json" };

export const db = createSqlClient<SqlxJsGeneratedRegistry>(undefined, {
  queryDescriptors,
  temporalApi: Temporal,
});
