import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSchemaSnapshot,
  renderSchemaManifest,
  schemaSnapshotEqual,
  stableSchemaJson,
  type SchemaSnapshot,
} from "../src/schema-snapshot";

const snapshot: SchemaSnapshot = {
  version: 3,
  schemas: ["public"],
  relations: [{
    schema: "public",
    name: "posts",
    kind: "table",
    columns: [
      { name: "id", ordinal: 1, type: "bigint", typeOid: 20, nullable: false, writable: false, identity: "always" },
      { name: "user_id", ordinal: 2, type: "bigint", typeOid: 20, nullable: false, writable: true },
      { name: "rating", ordinal: 3, type: "integer", typeOid: 23, nullable: true, writable: true, default: "0" },
    ],
    constraints: [
      { name: "posts_pkey", kind: "primary_key", columns: ["id"], definition: "PRIMARY KEY (id)" },
      {
        name: "posts_user_id_fkey",
        kind: "foreign_key",
        columns: ["user_id"],
        definition: "FOREIGN KEY (user_id) REFERENCES users(id)",
        references: { schema: "public", table: "users", columns: ["id"], onUpdate: "no action", onDelete: "cascade" },
      },
      { name: "posts_rating_check", kind: "check", columns: [], definition: "CHECK (rating >= 0)", expression: "rating >= 0" },
    ],
    indexes: [
      { name: "posts_user_id_idx", unique: false, primary: false, method: "btree", columns: ["user_id"], definition: "CREATE INDEX posts_user_id_idx ON posts USING btree (user_id)" },
    ],
  }],
  types: [
    { kind: "enum", schema: "public", name: "role", values: ["admin", "viewer"] },
  ],
  functions: [
    {
      schema: "public",
      name: "normalize_email",
      kind: "function",
      identityArguments: "value text",
      arguments: "value text",
      returnType: "text",
      returnsSet: false,
      volatility: "immutable",
      strict: true,
      securityDefiner: false,
      leakproof: false,
      parallelSafety: "safe",
      owner: "app_owner",
      ownerSuperuser: false,
      publicExecute: true,
      settings: ["search_path=app, pg_temp", "TimeZone=UTC"],
      searchPath: "app, pg_temp",
      extensionOwned: false,
      language: "sql",
    },
  ],
};

test("stableSchemaJson is deterministic and newline terminated", () => {
  const text = stableSchemaJson(snapshot);
  expect(text).toEndWith("\n");
  expect(text).toBe(stableSchemaJson(JSON.parse(text) as SchemaSnapshot));
});

test("schema snapshot equality ignores cluster-local OIDs but preserves identifiers and physical order", () => {
  const other = structuredClone(snapshot);
  other.relations[0]!.columns[0]!.typeOid = 50_000;
  expect(schemaSnapshotEqual(snapshot, other)).toBe(true);
  other.relations[0]!.columns[0]!.name = "forbidden_secret";
  expect(schemaSnapshotEqual(snapshot, other)).toBe(false);

  const physical = structuredClone(snapshot);
  physical.types.push({
    kind: "composite",
    schema: "public",
    name: "address",
    fields: [{ name: "zip", type: "integer" }, { name: "street", type: "text" }],
  });
  const reordered = structuredClone(physical);
  const reorderedComposite = reordered.types[1];
  if (reorderedComposite?.kind !== "composite") throw new Error("expected composite snapshot fixture");
  reorderedComposite.fields.reverse();
  expect(schemaSnapshotEqual(physical, reordered)).toBe(false);
});

test("renderSchemaManifest includes constraints, indexes, types, and functions", () => {
  const text = renderSchemaManifest(snapshot);
  expect(text).toContain("### public.posts (table)");
  expect(text).toContain("posts_user_id_fkey: foreign_key [user_id] -> public.users(id)");
  expect(text).toContain("posts_rating_check: check");
  expect(text).toContain("posts_user_id_idx: btree [user_id]");
  expect(text).toContain("enum public.role");
  expect(text).toContain("public.normalize_email(value text) -> text");
  expect(text).toContain('function, language sql, immutable, strict, parallel safe, owner app_owner, public execute, settings ["search_path=app, pg_temp","TimeZone=UTC"]');
});

test("readSchemaSnapshot rejects incomplete function metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlx-js-schema-snapshot-"));
  const path = join(root, "schema.json");
  try {
    const malformed = structuredClone(snapshot) as unknown as {
      functions: Array<Record<string, unknown>>;
    };
    delete malformed.functions[0]!.language;
    writeFileSync(path, JSON.stringify(malformed));
    expect(() => readSchemaSnapshot(path)).toThrow(/schema snapshot is malformed/);

    const inconsistent = structuredClone(snapshot);
    inconsistent.functions[0]!.searchPath = "public";
    writeFileSync(path, JSON.stringify(inconsistent));
    expect(() => readSchemaSnapshot(path)).toThrow(/schema snapshot is malformed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
