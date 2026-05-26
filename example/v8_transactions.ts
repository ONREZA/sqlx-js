import { sql } from "@onreza/sqlx-js";

export async function createUserWithFirstPost(name: string, email: string, title: string) {
  return await sql.transaction(async (tx) => {
    const inserted = await tx(
      `INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id AS "id!"`,
      name,
      email,
    );
    const userId: bigint = inserted[0]!.id;
    const posts = await tx(
      `INSERT INTO posts (user_id, title) VALUES ($1, $2) RETURNING id AS "id!"`,
      userId,
      title,
    );
    return { userId, postId: posts[0]!.id };
  });
}

export async function rollbackOnError() {
  try {
    await sql.transaction(async (tx) => {
      await tx(
        `INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id AS "id!"`,
        "rollback-test",
        `rollback-${Date.now()}@example.com`,
      );
      throw new Error("intentional rollback");
    });
  } catch {
  }
}
