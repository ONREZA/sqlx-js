import { sql } from "@onreza/sqlx-js";

export const findProbe = (id: bigint) =>
  sql("SELECT id, name FROM pgschema_probe WHERE id = $1", id);
