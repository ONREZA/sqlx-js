import {
  defineQuery,
  type QueryParams,
  type QueryRow,
  type SqlExecutor,
} from "@onreza/sqlx-js";

/*
 * This demonstrates the sqlx-js boundary: one literal, prepared call to a
 * database-owned filtered read API. Production function design may instead
 * require different indexes, pagination, security, or a materialized view and
 * refresh strategy. The ! aliases mirror non-null guarantees implemented by
 * the function because RETURNS TABLE does not expose NOT NULL metadata.
 * Choose those PostgreSQL details for the workload:
 * https://www.postgresql.org/docs/current/queries-table-expressions.html#QUERIES-TABLEFUNCTIONS
 * https://www.postgresql.org/docs/current/sql-explain.html
 * https://www.postgresql.org/docs/current/rules-materializedviews.html
 * https://www.postgresql.org/docs/current/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY
 */
export const listFilteredUsers = defineQuery(
  "users.listFiltered",
  `SELECT
     id AS "id!",
     name AS "name!",
     email AS "email!",
     role AS "role!",
     created_at AS "createdAt!"
   FROM public.list_users(
     COALESCE($role, NULL::public.user_role),
     COALESCE($search, NULL::text),
     COALESCE($afterId, NULL::bigint),
     $limit
   )`,
);

export type ListFilteredUsersParams = QueryParams<typeof listFilteredUsers>;
export type ListFilteredUsersRow = QueryRow<typeof listFilteredUsers>;

export function listUsers(executor: SqlExecutor, params: ListFilteredUsersParams) {
  return listFilteredUsers.run(executor, params);
}
