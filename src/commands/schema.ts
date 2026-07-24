import { introspectDatabase, readSchemaSnapshot, schemaSnapshotEqual, schemaSnapshotExists, writeSchemaManifest, writeSchemaSnapshot } from "../schema-snapshot";

export type SchemaCommandOptions = {
  databaseUrl: string;
  snapshotPath: string;
  manifestPath: string;
  writeManifest: boolean;
};

export async function runSchemaDump(opts: SchemaCommandOptions): Promise<void> {
  const snapshot = await introspectDatabase(opts.databaseUrl);
  writeSchemaSnapshot(opts.snapshotPath, snapshot);
  if (opts.writeManifest) writeSchemaManifest(opts.manifestPath, snapshot);
  console.log(`snapshot: wrote ${opts.snapshotPath}`);
  if (opts.writeManifest) console.log(`snapshot: wrote ${opts.manifestPath}`);
}

export async function runSchemaCheck(opts: SchemaCommandOptions): Promise<void> {
  if (!schemaSnapshotExists(opts.snapshotPath)) {
    console.error(`snapshot: missing snapshot ${opts.snapshotPath}`);
    console.error("snapshot: run `sqlx-js snapshot dump` against a live database");
    process.exit(1);
  }
  const expected = readSchemaSnapshot(opts.snapshotPath);
  const actual = await introspectDatabase(opts.databaseUrl);
  if (!schemaSnapshotEqual(expected, actual)) {
    console.error(`snapshot: snapshot is stale: ${opts.snapshotPath}`);
    console.error("snapshot: run `sqlx-js snapshot dump` and commit the updated snapshot");
    process.exit(1);
  }
  console.log(`snapshot: ok — ${actual.relations.length} relation(s), ${actual.types.length} type(s), ${actual.functions.length} function(s)`);
}
