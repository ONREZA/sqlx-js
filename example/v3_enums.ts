import { sql } from "@onreza/sqlx-js";
import { DbEnums, UserRole, type DbEnumName, type DbEnumValue } from "./db-enums";

const usersWithRole = await sql(`SELECT id, name, role FROM users WHERE id = $1`, 1n);

const adminCheck = await sql(`SELECT id FROM users WHERE role = $1`, UserRole.admin);

const viewer: DbEnumValue<"public.user_role"> = DbEnums["public.user_role"].viewer;
const dynamicEnumValue: DbEnumValue<DbEnumName> = viewer;

const postsTyped = await sql(
  `SELECT p.id, p.title, p.status, p.tags, p.history, u.role AS author_role FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = $1`,
  1n,
);

const insertWithRole = await sql(
  `INSERT INTO users (name, email, role) VALUES ($1, $2, $3) RETURNING id AS "id!", role AS "role!"`,
  "Bob",
  `bob-${Date.now()}@example.com`,
  UserRole.editor,
);

console.log(usersWithRole, adminCheck, dynamicEnumValue, postsTyped, insertWithRole);
