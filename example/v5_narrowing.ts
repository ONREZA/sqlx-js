import { sql } from "@onreza/sqlx-js";

const explicit = await sql(
  `SELECT id, bio FROM users WHERE bio IS NOT NULL AND id = $1`,
  1n,
);

const eqNarrow = await sql(
  `SELECT id, age FROM users WHERE age = $1`,
  25,
);

const inNarrow = await sql(
  `SELECT id, age FROM users WHERE age IN (18, 21, 25)`,
);

const compoundAnd = await sql(
  `SELECT id, bio, age FROM users WHERE bio IS NOT NULL AND age > $1`,
  18,
);

const orNoNarrow = await sql(
  `SELECT id, bio FROM users WHERE bio IS NOT NULL OR id = $1`,
  1n,
);

const joinQualified = await sql(
  `SELECT u.id, p.title, p.body FROM users u LEFT JOIN posts p ON p.user_id = u.id WHERE p.body IS NOT NULL AND u.id = $1`,
  1n,
);

const expressionWrap = await sql(
  `SELECT id, COALESCE(bio, 'none') AS bio_or_default, length(bio) AS bio_len FROM users WHERE bio IS NOT NULL AND id = $1`,
  1n,
);

console.log(explicit, eqNarrow, inNarrow, compoundAnd, orNoNarrow, joinQualified, expressionWrap);
