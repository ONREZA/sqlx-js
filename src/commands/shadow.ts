import { randomBytes } from "node:crypto";
import { decodeText, parseDatabaseUrl, PgClient } from "../pg/wire";

export type ShadowDatabaseOptions = {
  databaseUrl: string;
  shadowUrl?: string;
  shadowAdminUrl?: string;
};

type ShadowDatabaseHandle = {
  databaseUrl: string;
  cleanup: () => Promise<void>;
};

function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

function databaseUrlWithDatabase(databaseUrl: string, database: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceDatabaseUrl(databaseUrl: string): string {
  return databaseUrlWithDatabase(databaseUrl, "postgres");
}

function generatedShadowDatabaseName(): string {
  return `sqlx_js_shadow_${process.pid}_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

async function listUserSchemas(c: PgClient): Promise<string[]> {
  const r = await c.simpleQuery(`
    SELECT nspname
    FROM pg_namespace
    WHERE nspname <> 'information_schema'
      AND nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
    ORDER BY nspname
  `);
  return r.rows.map((row) => decodeText(row[0]!)!).filter((schema) => schema.length > 0);
}

export async function isolateShadowDatabase(c: PgClient): Promise<void> {
  for (const schema of await listUserSchemas(c)) {
    await c.simpleQuery(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
  }
  await c.simpleQuery("CREATE SCHEMA IF NOT EXISTS public");
  await c.simpleQuery("RESET ALL");
}

async function useExplicitShadowDatabase(databaseUrl: string): Promise<ShadowDatabaseHandle> {
  const c = new PgClient(parseDatabaseUrl(databaseUrl));
  await c.connect();
  try {
    await isolateShadowDatabase(c);
  } finally {
    await c.end();
  }
  return { databaseUrl, cleanup: async () => {} };
}

async function createDisposableShadowDatabase(
  databaseUrl: string,
  shadowAdminUrl?: string,
  log: (msg: string) => void = console.log,
): Promise<ShadowDatabaseHandle> {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to create an automatic shadow database (or pass --shadow-url)");
  }
  const name = generatedShadowDatabaseName();
  const adminUrl = shadowAdminUrl ?? maintenanceDatabaseUrl(databaseUrl);
  const shadowUrl = databaseUrlWithDatabase(databaseUrl, name);
  const owner = parseDatabaseUrl(databaseUrl).user;
  const admin = new PgClient(parseDatabaseUrl(adminUrl));
  await admin.connect();
  try {
    await admin.simpleQuery(`CREATE DATABASE ${quoteIdent(name)} OWNER ${quoteIdent(owner)}`);
  } catch (err) {
    throw new Error(
      `sqlx-js: failed to create shadow database ${name}: ${(err as Error).message}. ` +
      "Grant CREATEDB, pass --shadow-admin-url, or pass --shadow-url.",
    );
  } finally {
    await admin.end();
  }
  log(`shadow: created ${name}`);
  let dropped = false;
  return {
    databaseUrl: shadowUrl,
    cleanup: async () => {
      if (dropped) return;
      dropped = true;
      const dropAdmin = new PgClient(parseDatabaseUrl(adminUrl));
      await dropAdmin.connect();
      try {
        await dropAdmin.simpleQuery(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
        log(`shadow: dropped ${name}`);
      } finally {
        await dropAdmin.end();
      }
    },
  };
}

async function withShadowHandle<T>(
  handle: ShadowDatabaseHandle,
  fn: (databaseUrl: string) => Promise<T>,
): Promise<T> {
  let fnError: unknown;
  try {
    return await fn(handle.databaseUrl);
  } catch (err) {
    fnError = err;
    throw err;
  } finally {
    try {
      await handle.cleanup();
    } catch (cleanupErr) {
      if (fnError) console.warn(`shadow: cleanup failed after command error: ${(cleanupErr as Error).message}`);
      else throw cleanupErr;
    }
  }
}

export async function withWorkflowShadowDatabase<T>(
  opts: ShadowDatabaseOptions,
  fn: (databaseUrl: string) => Promise<T>,
): Promise<T> {
  const handle = opts.shadowUrl
    ? await useExplicitShadowDatabase(opts.shadowUrl)
    : await createDisposableShadowDatabase(opts.databaseUrl, opts.shadowAdminUrl);
  return withShadowHandle(handle, fn);
}

export async function withDryRunShadowDatabase<T>(
  opts: ShadowDatabaseOptions,
  fn: (databaseUrl: string) => Promise<T>,
  log?: (msg: string) => void,
): Promise<T> {
  if (opts.shadowUrl) return fn(opts.shadowUrl);
  const handle = await createDisposableShadowDatabase(opts.databaseUrl, opts.shadowAdminUrl, log);
  return withShadowHandle(handle, fn);
}
