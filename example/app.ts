import { sql, close } from "@onreza/sqlx-js";

async function main() {
  const insert = await sql(
    `INSERT INTO users (name, email, age) VALUES ($1, $2, $3) RETURNING id AS "id!", created_at AS "created_at!"`,
    "Alice",
    `alice-${Date.now()}@example.com`,
    30,
  );
  const newId = insert[0]!.id;
  console.log("inserted user id:", newId, "created_at:", insert[0]!.created_at);

  const found = await sql(
    `SELECT id AS "id!", name AS "name!", email AS "email!", age, bio FROM users WHERE id = $1`,
    newId,
  );
  if (found.length > 0) {
    const u = found[0]!;
    const ageDesc: string = u.age === null ? "unknown" : `${u.age} years`;
    const bioDesc: string = u.bio === null ? "no bio" : u.bio;
    console.log(`found ${u.name} (${u.email}), age: ${ageDesc}, bio: ${bioDesc}`);
  }

  const counts = await sql(
    `SELECT COUNT(*) AS "n!" FROM users WHERE age >= $1`,
    18,
  );
  console.log("adult users:", counts[0]!.n);

  await close();
}

await main();
