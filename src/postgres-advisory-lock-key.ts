export interface PostgresAdvisoryLockInt4Key {
  readonly namespace: number;
  readonly resource: number;
}

export type PostgresAdvisoryLockKey = PostgresAdvisoryLockInt4Key | bigint;

export interface PostgresAdvisoryLockControl {
  readonly key: PostgresAdvisoryLockKey;
  readonly acquireSql: string;
  readonly releaseSql: string;
  readonly params: unknown[];
  readonly identity: [classid: string, objid: string, objsubid: number];
}

const PAIR_ARGUMENTS = "$1::pg_catalog.int4, $2::pg_catalog.int4";
const BIGINT_ARGUMENT = "$1::pg_catalog.int8";

function acquireSql(args: string): string {
  return `SELECT pg_catalog.pg_backend_pid() AS backend_pid,
    pg_catalog.pg_try_advisory_lock(${args}) AS acquired`;
}

function releaseSql(args: string): string {
  return `SELECT pg_catalog.pg_backend_pid() AS backend_pid,
    pg_catalog.pg_advisory_unlock(${args}) AS released`;
}

const PAIR_ACQUIRE_SQL = acquireSql(PAIR_ARGUMENTS);
const PAIR_RELEASE_SQL = releaseSql(PAIR_ARGUMENTS);
const BIGINT_ACQUIRE_SQL = acquireSql(BIGINT_ARGUMENT);
const BIGINT_RELEASE_SQL = releaseSql(BIGINT_ARGUMENT);

export const CHECK_ADVISORY_LOCK_SQL = `SELECT
  pg_catalog.pg_backend_pid() AS backend_pid,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks
    WHERE locktype = 'advisory'
      AND pid = pg_catalog.pg_backend_pid()
      AND database = (
        SELECT oid FROM pg_catalog.pg_database
        WHERE datname = pg_catalog.current_database()
      )
      AND mode = 'ExclusiveLock'
      AND granted
      AND classid = $1::pg_catalog.oid
      AND objid = $2::pg_catalog.oid
      AND objsubid = $3::pg_catalog.int4
  ) AS held`;

function validateInt4(value: number, name: string): void {
  if (!Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) {
    throw new TypeError(`sqlx-js: advisory lock ${name} must be a signed 32-bit integer`);
  }
}

export function advisoryLockControl(key: PostgresAdvisoryLockKey): PostgresAdvisoryLockControl {
  if (typeof key === "bigint") {
    if (key < -9_223_372_036_854_775_808n || key > 9_223_372_036_854_775_807n) {
      throw new TypeError("sqlx-js: advisory lock bigint key must be a signed 64-bit integer");
    }
    const bits = BigInt.asUintN(64, key);
    return {
      key,
      acquireSql: BIGINT_ACQUIRE_SQL,
      releaseSql: BIGINT_RELEASE_SQL,
      params: [key],
      identity: [(bits >> 32n).toString(), BigInt.asUintN(32, bits).toString(), 1],
    };
  }
  if (!key || typeof key !== "object" || Array.isArray(key)) {
    throw new TypeError("sqlx-js: advisory lock key must be an object with namespace and resource, or a bigint");
  }
  const { namespace, resource } = key;
  validateInt4(namespace, "namespace");
  validateInt4(resource, "resource");
  return {
    key: Object.freeze({ namespace, resource }),
    acquireSql: PAIR_ACQUIRE_SQL,
    releaseSql: PAIR_RELEASE_SQL,
    params: [namespace, resource],
    identity: [
      BigInt.asUintN(32, BigInt(namespace)).toString(),
      BigInt.asUintN(32, BigInt(resource)).toString(),
      2,
    ],
  };
}

export function formatAdvisoryLockKey(key: PostgresAdvisoryLockKey): string {
  return typeof key === "bigint" ? `(bigint ${key})` : `(${key.namespace}, ${key.resource})`;
}
