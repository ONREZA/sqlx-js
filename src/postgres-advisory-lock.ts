import {
  createPostgresSession,
  type PostgresOptions,
  type PostgresSession,
  type PostgresSessionOptions,
} from "./postgres-runtime";

const MIN_INT32 = -2_147_483_648;
const MAX_INT32 = 2_147_483_647;
const MAX_TIMEOUT_MS = 2_147_483_647;

const ACQUIRE_SQL = `SELECT
  pg_catalog.pg_backend_pid() AS backend_pid,
  pg_catalog.pg_try_advisory_lock(
    $1::pg_catalog.int4,
    $2::pg_catalog.int4
  ) AS acquired`;
const CHECK_SQL = "SELECT pg_catalog.pg_backend_pid() AS backend_pid";
const RELEASE_SQL = `SELECT
  pg_catalog.pg_backend_pid() AS backend_pid,
  pg_catalog.pg_advisory_unlock(
    $1::pg_catalog.int4,
    $2::pg_catalog.int4
  ) AS released`;

export interface PostgresAdvisoryLockKey {
  readonly namespace: number;
  readonly resource: number;
}

export type PostgresAdvisoryLockOptions = Omit<PostgresSessionOptions, "types"> & {
  readonly operationTimeoutMs?: number;
};

export class PostgresAdvisoryLockLostError extends Error {
  readonly key: PostgresAdvisoryLockKey;

  constructor(key: PostgresAdvisoryLockKey, options?: ErrorOptions) {
    super(
      `sqlx-js: PostgreSQL advisory lock (${key.namespace}, ${key.resource}) was lost`,
      options,
    );
    this.name = "PostgresAdvisoryLockLostError";
    this.key = key;
  }
}

export interface PostgresAdvisoryLockSession extends AsyncDisposable {
  readonly key: PostgresAdvisoryLockKey;
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

type AcquireRow = {
  backend_pid: number;
  acquired: boolean;
};

type CheckRow = {
  backend_pid: number;
};

type ReleaseRow = {
  backend_pid: number;
  released: boolean;
};

type ValidatedLockOptions = {
  readonly operationTimeoutMs?: number;
  readonly sessionOptions: PostgresSessionOptions;
};

function validateLockKeyPart(value: number, name: string): void {
  if (!Number.isInteger(value) || value < MIN_INT32 || value > MAX_INT32) {
    throw new TypeError(`sqlx-js: advisory lock ${name} must be a signed 32-bit integer`);
  }
}

function validateLockKey(key: PostgresAdvisoryLockKey): PostgresAdvisoryLockKey {
  if (!key || typeof key !== "object" || Array.isArray(key)) {
    throw new TypeError("sqlx-js: advisory lock key must be an object");
  }
  validateLockKeyPart(key.namespace, "namespace");
  validateLockKeyPart(key.resource, "resource");
  return Object.freeze({ namespace: key.namespace, resource: key.resource });
}

function validateLockOptions(options: PostgresAdvisoryLockOptions): ValidatedLockOptions {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("sqlx-js: advisory lock options must be an object");
  }
  const poolOptions = options as PostgresOptions;
  for (const name of ["max", "idleTimeoutMs", "maxLifetimeMs"] as const) {
    if (poolOptions[name] !== undefined) {
      throw new TypeError(`sqlx-js: advisory lock sessions own ${name}; do not configure it`);
    }
  }
  if (poolOptions.types !== undefined) {
    throw new TypeError("sqlx-js: advisory lock sessions use fixed control-query codecs");
  }
  const { operationTimeoutMs, ...sessionOptions } = options;
  if (
    operationTimeoutMs !== undefined
    && (
      !Number.isSafeInteger(operationTimeoutMs)
      || operationTimeoutMs < 1
      || operationTimeoutMs > MAX_TIMEOUT_MS
    )
  ) {
    throw new TypeError(
      `sqlx-js: advisory lock operationTimeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}, `
        + `got ${String(operationTimeoutMs)}`,
    );
  }
  return { operationTimeoutMs, sessionOptions };
}

async function runControlQuery<Row extends Record<string, unknown>>(
  client: PostgresSession,
  sql: string,
  params: unknown[],
  operation: string,
  timeoutMs: number | undefined,
): Promise<Row[]> {
  const query = client.unsafe<Row>(sql, params);
  if (timeoutMs === undefined) return await query;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      query,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void client.end().catch(() => {});
          reject(new Error(
            `sqlx-js: PostgreSQL advisory lock ${operation} timed out after ${timeoutMs}ms`,
          ));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class HeldPostgresAdvisoryLock implements PostgresAdvisoryLockSession {
  readonly key: PostgresAdvisoryLockKey;
  readonly #client: PostgresSession;
  readonly #backendPid: number;
  readonly #operationTimeoutMs: number | undefined;
  #state: "held" | "releasing" | "released" | "lost" = "held";
  #closePromise?: Promise<void>;
  #releasePromise?: Promise<void>;

  constructor(
    client: PostgresSession,
    key: PostgresAdvisoryLockKey,
    backendPid: number,
    operationTimeoutMs: number | undefined,
  ) {
    this.#client = client;
    this.key = key;
    this.#backendPid = backendPid;
    this.#operationTimeoutMs = operationTimeoutMs;
  }

  async assertHeld(): Promise<void> {
    if (this.#state === "lost") throw new PostgresAdvisoryLockLostError(this.key);
    if (this.#state !== "held") {
      throw new Error(
        `sqlx-js: PostgreSQL advisory lock (${this.key.namespace}, ${this.key.resource}) was released`,
      );
    }
    try {
      const [row] = await runControlQuery<CheckRow>(
        this.#client,
        CHECK_SQL,
        [],
        "health check",
        this.#operationTimeoutMs,
      );
      if (!row || row.backend_pid !== this.#backendPid) {
        await this.#lose();
        throw new PostgresAdvisoryLockLostError(this.key);
      }
    } catch (error) {
      if (error instanceof PostgresAdvisoryLockLostError) throw error;
      await this.#lose();
      throw new PostgresAdvisoryLockLostError(this.key, { cause: error });
    }
  }

  release(): Promise<void> {
    if (this.#releasePromise) return this.#releasePromise;
    if (this.#state === "released") return Promise.resolve();
    if (this.#state === "lost") return this.#close();
    this.#state = "releasing";
    return this.#releasePromise = this.#release();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.release();
  }

  async #release(): Promise<void> {
    let released = false;
    try {
      const [row] = await runControlQuery<ReleaseRow>(
        this.#client,
        RELEASE_SQL,
        [this.key.namespace, this.key.resource],
        "release",
        this.#operationTimeoutMs,
      );
      if (
        !row ||
        row.backend_pid !== this.#backendPid ||
        !row.released
      ) {
        throw new PostgresAdvisoryLockLostError(this.key);
      }
      released = true;
    } catch (error) {
      this.#state = "lost";
      if (error instanceof PostgresAdvisoryLockLostError) throw error;
      throw new PostgresAdvisoryLockLostError(this.key, { cause: error });
    } finally {
      if (released) this.#state = "released";
      await this.#close();
    }
  }

  async #lose(): Promise<void> {
    if (this.#state === "released" || this.#state === "lost") return;
    this.#state = "lost";
    await this.#close().catch(() => {});
  }

  #close(): Promise<void> {
    return this.#closePromise ??= this.#client.end();
  }
}

export async function tryAcquirePostgresAdvisoryLock(
  databaseUrl: string | undefined,
  keyInput: PostgresAdvisoryLockKey,
  options: PostgresAdvisoryLockOptions = {},
): Promise<PostgresAdvisoryLockSession | null> {
  const key = validateLockKey(keyInput);
  const { operationTimeoutMs, sessionOptions } = validateLockOptions(options);
  const client = await createPostgresSession(databaseUrl, sessionOptions);
  try {
    const [row] = await runControlQuery<AcquireRow>(
      client,
      ACQUIRE_SQL,
      [key.namespace, key.resource],
      "acquisition",
      operationTimeoutMs,
    );
    if (!row) throw new Error("sqlx-js: PostgreSQL advisory lock query returned no row");
    if (!row.acquired) {
      await client.end();
      return null;
    }
    return new HeldPostgresAdvisoryLock(client, key, row.backend_pid, operationTimeoutMs);
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
}
