import { createSqlClient } from "@onreza/sqlx-js";
import { Temporal } from "@js-temporal/polyfill";
import type { SqlxJsGeneratedRegistry as GeneratedRegistry } from "./sqlx-js-env";
import queryDescriptors from "./.sqlx-js/runtime-descriptors.json" with { type: "json" };

export type SqlxJsRegistry = GeneratedRegistry<typeof Temporal>;

export const db = createSqlClient<SqlxJsRegistry>(undefined, {
  queryDescriptors,
  temporalApi: Temporal,
});
