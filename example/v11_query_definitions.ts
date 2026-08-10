import {
  defineQuery,
  type QueryParams,
  type QueryResult,
  type QueryRow,
  type SqlExecutor,
} from "@onreza/sqlx-js";
import { db } from "./database";
import type { SqlxJsRegistry } from "./database";

export const findUserByEmail = defineQuery.optional(
  "users.findByEmail",
  `SELECT id, name, email, role
   FROM users
   WHERE email = $email`,
);

export type FindUserByEmailParams = QueryParams<typeof findUserByEmail, SqlxJsRegistry>;
export type FindUserByEmailRow = QueryRow<typeof findUserByEmail, SqlxJsRegistry>;
export type FindUserByEmailResult = QueryResult<typeof findUserByEmail, SqlxJsRegistry>;

export function findUser(
  executor: SqlExecutor<SqlxJsRegistry>,
  params: FindUserByEmailParams,
) {
  return findUserByEmail.run(executor, params);
}

export function findUserInTransaction(email: string) {
  return db.sql.transaction((tx) => findUserByEmail.run(tx, { email }));
}
