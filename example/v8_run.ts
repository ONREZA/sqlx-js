import { sql, close } from "@onreza/sqlx-js";
import { createUserWithFirstPost } from "./v8_transactions";

const { userId, postId } = await createUserWithFirstPost(
  "TxAlice",
  `tx-${Date.now()}@example.com`,
  "Hello via tx",
);
console.log("transaction created user", userId, "post", postId);

const sameUser = await sql(
  `SELECT id AS "id!", name AS "name!" FROM users WHERE id = $1`,
  userId,
);
console.log("re-read inside same session:", sameUser[0]);

const before = await sql(`SELECT COUNT(*) AS "n!" FROM users`);
try {
  await sql.transaction(async (tx) => {
    await tx(
      `INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id AS "id!"`,
      "should-rollback",
      `rb-${Date.now()}@example.com`,
    );
    throw new Error("boom");
  });
} catch {
}
const after = await sql(`SELECT COUNT(*) AS "n!" FROM users`);
console.log(`count before=${before[0]!.n}, after=${after[0]!.n} (should be equal)`);

await close();
