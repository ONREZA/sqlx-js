import { sql } from "@onreza/sqlx-js";

const u = await sql(`SELECT id, name, settings FROM users WHERE id = $1`, 1n);
if (u.length > 0) {
  const theme = u[0]!.settings.value.theme;
  console.log("user theme:", theme);
}

const p = await sql(
  `SELECT id, title, meta, attachments FROM posts WHERE id = $1`,
  1n,
);

if (p.length > 0) {
  const tags = p[0]!.meta?.value.tags ?? [];
  const firstUrl = p[0]!.attachments[0]?.value.url;
  console.log("tags:", tags, "url:", firstUrl);
}
