import { sql } from "@onreza/sqlx-js";

const result = await sql.execute(
  `UPDATE users SET name = $1 WHERE id = $2`,
  "Updated Name",
  1n,
);

const rowCount: number = result.rowCount;
const command: string = result.command;

console.log({ rowCount, command });
