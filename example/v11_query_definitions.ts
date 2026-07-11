import {
  defineQuery,
  sql,
  type QueryParams,
  type QueryResult,
  type QueryRow,
  type SqlExecutor,
} from "@onreza/sqlx-js";

export const findUserByEmail = defineQuery.optional(
  "users.findByEmail",
  `SELECT id, name, email, role
   FROM users
   WHERE email = $email`,
);

export type FindUserByEmailParams = QueryParams<typeof findUserByEmail>;
export type FindUserByEmailRow = QueryRow<typeof findUserByEmail>;
export type FindUserByEmailResult = QueryResult<typeof findUserByEmail>;

export function findUser(executor: SqlExecutor, params: FindUserByEmailParams) {
  return findUserByEmail.run(executor, params);
}

export function findUserInTransaction(email: string) {
  return sql.transaction((tx) => findUserByEmail.run(tx, { email }));
}
