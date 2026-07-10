import { sql } from "@onreza/sqlx-js";

export async function listUsersWithPostStats(limit: number, offset: number) {
  return await sql(
    `SELECT
       u.id AS user_id,
       u.email AS user_email,
       u.role AS user_role,
       COUNT(p.id) AS post_count,
       MAX(p.id) AS latest_post_id
     FROM users u
     LEFT JOIN posts p ON p.user_id = u.id
     GROUP BY u.id, u.email, u.role
     ORDER BY u.id DESC
     LIMIT $1::int OFFSET $2::int`,
    limit,
    offset,
  );
}

export async function upsertUserByEmail(name: string, email: string) {
  return await sql.one(
    `INSERT INTO users (name, email)
     VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
     RETURNING id AS user_id, name AS user_name, email AS user_email, role AS user_role`,
    name,
    email,
  );
}

export async function findUsers(name: string | null, limit: number) {
  return await sql(
    `SELECT id AS user_id, name AS user_name, email AS user_email
     FROM users
     WHERE ($1::text IS NULL OR name ILIKE '%' || $1 || '%')
     ORDER BY id
     LIMIT $2::int`,
    name,
    limit,
  );
}

export async function publishNextDraft() {
  return await sql.optional(
    `UPDATE posts
     SET status = 'published', published = true
     WHERE id = (
       SELECT id
       FROM posts
       WHERE status = 'draft'
       ORDER BY id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id AS post_id, user_id, status, published`,
  );
}

export async function deleteArchivedPosts(userId: bigint) {
  return await sql(
    `DELETE FROM posts
     WHERE user_id = $1 AND status = 'archived'
     RETURNING id AS post_id, user_id, status`,
    userId,
  );
}
