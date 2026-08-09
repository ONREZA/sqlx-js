import { db } from "./database";

const insertResult = await db.sql(
  `INSERT INTO users (name, email, settings) VALUES ($1, $2, $3) RETURNING id AS "id!"`,
  "Dave",
  `dave-${Date.now()}@example.com`,
  db.sql.json({ theme: "dark", lang: "en" }),
);

const updated = await db.sql(
  `UPDATE users SET settings = $1 WHERE id = $2 RETURNING id AS "id!", settings`,
  db.sql.json({ theme: "light", lang: "en", notifications: { email: true, push: false } }),
  insertResult[0]!.id,
);

const found = await db.sql(
  `SELECT id, settings FROM users WHERE settings = $1 LIMIT 1`,
  db.sql.json({ theme: "light", lang: "en" } as SqlxJsJson.UserSettings),
);

console.log(insertResult, updated, found);
