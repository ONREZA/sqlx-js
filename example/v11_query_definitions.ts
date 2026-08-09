import {
  defineQuery,
  type QueryParams,
  type QueryResult,
  type QueryRow,
  type SqlExecutor,
} from "@onreza/sqlx-js";
import { db } from "./database";
import type { SqlxJsGeneratedRegistry } from "./sqlx-js-env";

export const findUserByEmail = defineQuery.optional(
  "users.findByEmail",
  `SELECT id, name, email, role
   FROM users
   WHERE email = $email`,
);

export type FindUserByEmailParams = QueryParams<typeof findUserByEmail, SqlxJsGeneratedRegistry>;
export type FindUserByEmailRow = QueryRow<typeof findUserByEmail, SqlxJsGeneratedRegistry>;
export type FindUserByEmailResult = QueryResult<typeof findUserByEmail, SqlxJsGeneratedRegistry>;

export function findUser(
  executor: SqlExecutor<SqlxJsGeneratedRegistry>,
  params: FindUserByEmailParams,
) {
  return findUserByEmail.run(executor, params);
}

export function findUserInTransaction(email: string) {
  return db.sql.transaction((tx) => findUserByEmail.run(tx, { email }));
}
