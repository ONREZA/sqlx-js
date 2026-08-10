import { Temporal } from "@js-temporal/polyfill";
import { createSqlClient } from "@onreza/sqlx-js";
import type { SqlxJsGeneratedRegistry as GeneratedRegistry } from "./sqlx-js-env";
import queryDescriptors from "./.sqlx-js/runtime-descriptors.json" with { type: "json" };

const db = createSqlClient<GeneratedRegistry<typeof Temporal>>(undefined, {
  queryDescriptors,
  temporalApi: Temporal,
});

export const findProbe = (id: bigint) =>
  db.sql("SELECT id, name FROM pgschema_probe WHERE id = $1", id);
