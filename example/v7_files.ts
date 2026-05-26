import { sql } from "@onreza/sqlx-js";

export async function topAdmins() {
  const rows = await sql.file("queries/get_users_by_role.sql", "admin", 5);
  for (const r of rows) {
    const id: bigint = r.id;
    const name: string = r.name;
    const email: string = r.email;
    void id; void name; void email;
  }
  return rows;
}

export async function postsCount(userId: bigint) {
  const r = await sql.file("queries/count_posts.sql", userId);
  const n: bigint = r[0]!.n;
  return n;
}
