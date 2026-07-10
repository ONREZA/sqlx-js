import { sql } from "@onreza/sqlx-js";

const insertResult = await sql(
  `INSERT INTO users (name, email, settings) VALUES ($1, $2, $3) RETURNING id AS "id!"`,
  "Dave",
  `dave-${Date.now()}@example.com`,
  sql.json({ theme: "dark", lang: "en" }),
);

const updated = await sql(
  `UPDATE users SET settings = $1 WHERE id = $2 RETURNING id AS "id!", settings`,
  sql.json({ theme: "light", lang: "en", notifications: { email: true, push: false } }),
  insertResult[0]!.id,
);

const found = await sql(
  `SELECT id, settings FROM users WHERE settings = $1 LIMIT 1`,
  sql.json({ theme: "light", lang: "en" } as SqlxJsJson.UserSettings),
);

console.log(insertResult, updated, found);
