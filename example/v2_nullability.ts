import { db } from "./database";

const basic = await db.sql(`SELECT id, name, email, age, bio FROM users WHERE id = $1`, 1n);

const counted = await db.sql(`SELECT COUNT(*) AS n FROM users`);

const leftJoin = await db.sql(
  `SELECT u.id AS user_id, u.name, p.title, p.published FROM users u LEFT JOIN posts p ON p.user_id = u.id WHERE u.id = $1`,
  1n,
);

const coalesced = await db.sql(
  `SELECT id, COALESCE(bio, 'no bio') AS bio_or_default, COALESCE(age, 0) AS age_or_zero FROM users WHERE id = $1`,
  1n,
);

const literal = await db.sql(`SELECT 1 AS one, 'literal'::text AS msg, now() AS ts FROM users LIMIT 1`);

const caseExpr = await db.sql(
  `SELECT id, CASE WHEN age >= 18 THEN 'adult' ELSE 'minor' END AS bucket FROM users WHERE id = $1`,
  1n,
);

const fullOuter = await db.sql(
  `SELECT u.id AS uid, p.id AS pid FROM users u FULL OUTER JOIN posts p ON p.user_id = u.id WHERE u.id = $1 OR p.id = $1`,
  1n,
);

console.log(basic, counted, leftJoin, coalesced, literal, caseExpr, fullOuter);
