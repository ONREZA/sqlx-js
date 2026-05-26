import { sql, close } from "@onreza/sqlx-js";

const admins = await sql.file("queries/get_users_by_role.sql", "admin", 5);
console.log(`admins (${admins.length}):`);
for (const a of admins) {
  console.log(`  ${a.id} ${a.name} <${a.email}>`);
}

const inserted = await sql(
  `INSERT INTO users (name, email, role) VALUES ($1, $2, $3) RETURNING id AS "id!"`,
  "FileQueryUser",
  `file-${Date.now()}@example.com`,
  "admin",
);
const newId: bigint = inserted[0]!.id;

const countRow = await sql.file("queries/count_posts.sql", newId);
console.log("posts of new user:", countRow[0]!.n);

await close();
