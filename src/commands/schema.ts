import { introspectDatabase, readSchemaSnapshot, schemaSnapshotEqual, schemaSnapshotExists, writeSchemaManifest, writeSchemaSnapshot } from "../schema-snapshot";
import { PgClient, parseDatabaseUrl } from "../pg/wire";
import { acquireMigrateLock, applyPending, DEFAULT_MIGRATE_LOCK_KEY, releaseMigrateLock } from "../migration-core";

export type SchemaCommandOptions = {
  databaseUrl: string;
  snapshotPath: string;
  manifestPath: string;
  writeManifest: boolean;
  shadowUrl?: string;
  migrationsDir: string;
};

export type ShadowMigrationResult = {
  applied: number;
};

export async function applyShadowMigrations(
  databaseUrl: string,
  migrationsDir: string,
  log: (msg: string) => void = console.log,
): Promise<ShadowMigrationResult> {
  const client = new PgClient(parseDatabaseUrl(databaseUrl));
  await client.connect();
  let locked = false;
  let applied = 0;
  try {
    await acquireMigrateLock(client, DEFAULT_MIGRATE_LOCK_KEY);
    locked = true;
    const result = await applyPending(client, migrationsDir, (e) => {
      if (e.kind === "applied") {
        applied++;
        log(`shadow: applied ${String(e.version).padStart(4, "0")}_${e.name}`);
      } else if (e.kind === "adopted") {
        applied++;
        log(`shadow: adopted ${String(e.version).padStart(4, "0")}_${e.name} (${e.replaced} replaced)`);
      } else if (e.kind === "tampered") {
        throw new Error(
          `sqlx-js shadow: ${e.version}_${e.name} hash mismatch (applied ${e.applied.slice(0, 16)} vs current ${e.current.slice(0, 16)})`,
        );
      } else {
        throw new Error(`sqlx-js shadow: ${e.version}_${e.name} failed — ${e.error}`);
      }
    });
    if (applied === 0 && result.tampered === 0 && result.failed === 0) log("shadow: migrations up-to-date");
    return { applied };
  } finally {
    if (locked) {
      try {
        await releaseMigrateLock(client, DEFAULT_MIGRATE_LOCK_KEY);
      } catch (e) {
        log(`shadow: failed to release advisory lock: ${(e as Error).message}`);
      }
    }
    await client.end();
  }
}

function effectiveDatabaseUrl(opts: SchemaCommandOptions): string {
  return opts.shadowUrl ?? opts.databaseUrl;
}

async function prepareShadowIfNeeded(opts: SchemaCommandOptions): Promise<void> {
  if (opts.shadowUrl) await applyShadowMigrations(opts.shadowUrl, opts.migrationsDir);
}

export async function runSchemaDump(opts: SchemaCommandOptions): Promise<void> {
  await prepareShadowIfNeeded(opts);
  const snapshot = await introspectDatabase(effectiveDatabaseUrl(opts));
  writeSchemaSnapshot(opts.snapshotPath, snapshot);
  if (opts.writeManifest) writeSchemaManifest(opts.manifestPath, snapshot);
  console.log(`schema: wrote ${opts.snapshotPath}`);
  if (opts.writeManifest) console.log(`schema: wrote ${opts.manifestPath}`);
}

export async function runSchemaCheck(opts: SchemaCommandOptions): Promise<void> {
  if (!schemaSnapshotExists(opts.snapshotPath)) {
    console.error(`schema: missing snapshot ${opts.snapshotPath}`);
    console.error("schema: run `sqlx-js schema dump` against a live database");
    process.exit(1);
  }
  await prepareShadowIfNeeded(opts);
  const expected = readSchemaSnapshot(opts.snapshotPath);
  const actual = await introspectDatabase(effectiveDatabaseUrl(opts));
  if (!schemaSnapshotEqual(expected, actual)) {
    console.error(`schema: snapshot is stale: ${opts.snapshotPath}`);
    console.error("schema: run `sqlx-js schema dump` and commit the updated snapshot");
    process.exit(1);
  }
  console.log(`schema: ok — ${actual.relations.length} relation(s), ${actual.types.length} type(s), ${actual.functions.length} function(s)`);
}
