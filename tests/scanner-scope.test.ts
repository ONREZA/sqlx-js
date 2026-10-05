import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanFile } from "../src/scan/scanner";

function scan(body: string, profiles: string[] = [], contextual: string[] = [], files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "sqlx-scope-"));
  const path = join(root, "queries.ts");
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(root, name), contents);
  writeFileSync(path,
    'import { defineQuery, sql, createSqlClient } from "@onreza/sqlx-js";\n'
    + 'import * as database from "@onreza/sqlx-js";\n'
    + body,
  );
  try {
    return scanFile(path, root, undefined, profiles, contextual);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const shadows = [
  '{ const f = () => defineQuery("SELECT hidden"); const defineQuery = q => q; f(); }',
  '{ defineQuery("SELECT hidden"); function defineQuery(q) { return q; } }',
  'function f() { const g = () => defineQuery("SELECT hidden"); if (true) { var defineQuery = q => q; } g(); }',
  'function f() { if (true) { var defineQuery = q => q; } defineQuery("SELECT hidden"); }',
  'for (const defineQuery of [q => q]) { defineQuery("SELECT hidden"); }',
  'for (let defineQuery = q => q; false;) { defineQuery("SELECT hidden"); }',
  'switch (1) { case 1: const defineQuery = q => q; defineQuery("SELECT hidden"); }',
  'switch (1) { case 1: const f = () => defineQuery("SELECT hidden"); break; case 2: const defineQuery = q => q; f(); }',
  '{ class defineQuery { static one(q) { return q; } static run() { return defineQuery.one("SELECT hidden"); } } }',
  'const c = class defineQuery { static one(q) { return q; } static run() { return defineQuery.one("SELECT hidden"); } };',
  'function f() { const g = () => database.defineQuery("SELECT hidden"); const database = { defineQuery: q => q }; g(); }',
  'function f() { const g = () => sql("SELECT hidden"); const { sql } = { sql: q => q }; g(); }',
  'try {} catch ({ defineQuery }) { defineQuery("SELECT hidden"); }',
];

test.each(shadows)("lexical binding shadows do not become SQL queries: %s", (body) => {
  expect(scan(body + '\ndefineQuery("SELECT visible");').map(({ query }) => query))
    .toEqual(["SELECT visible"]);
});

test.each([
  'function run() { db.sql("SELECT visible"); } const db = createSqlClient({}, { execution: "adaptive" });',
  'function run() { owned("SELECT visible"); } const owned = sql.with({});',
  'switch (1) { case 1: const db = createSqlClient({}, { execution: "adaptive" }); db.sql("SELECT visible"); }',
  'switch (1) { case 1: const owned = sql.with({}); owned("SELECT visible"); }',
])("late and case-local query ownership resolves statically: %s", (body) => {
  expect(scan(body)).toMatchObject([{ query: "SELECT visible", execution: "adaptive" }]);
});

test("late clients retain profiles through sql.with and transaction savepoints", () => {
  const sites = scan(`
    function run() { db.sql.transaction(async tx => {
      function ownedRun() { owned("SELECT one"); }
      const owned = tx.with({});
      await tx.savepoint(async nested => { await nested.one("SELECT two"); });
    }); }
    const db = createSqlClient({}, { execution: "adaptive", profile: profiles.api });
  `, ["api"], ["api"]);
  expect(sites).toMatchObject([
    { query: "SELECT one", profiles: ["api"], execution: "adaptive" },
    { query: "SELECT two", profiles: ["api"], execution: "adaptive", cardinality: "one" },
  ]);
  expect(() => scan(`
    function run() { owned("SELECT root"); }
    const owned = db.sql.with({});
    const db = createSqlClient({}, { execution: "adaptive", profile: profiles.api });
  `, ["api"], ["api"])).toThrow(/requires transaction settings/);
});

test.each([
  ['sql.transaction(async (tx, defineQuery = q => q) => { defineQuery("SELECT hidden"); tx("SELECT visible"); });', ["SELECT visible"]],
  ['sql.transaction(async function defineQuery(tx) { if (false) defineQuery("SELECT hidden"); tx("SELECT visible"); });', ["SELECT visible"]],
  ['sql.transaction(async tx => { const f = () => tx("SELECT closure"); { const tx = q => q; tx("SELECT hidden"); } tx("SELECT visible"); });', ["SELECT closure", "SELECT visible"]],
])("transaction callback retains ordinary function shadows: %s", (body, queries) => {
  expect(scan(body as string).map(({ query }) => query)).toEqual(queries);
});

test("transaction callback defaults and option expressions are scanned", () => {
  expect(scan(`
    sql.transaction({ settings: { key: sql("SELECT options") } },
      async (tx = sql("SELECT defaults")) => { tx("SELECT body"); });
  `).map(({ query }) => query)).toEqual(["SELECT options", "SELECT defaults", "SELECT body"]);
});

test.each([
  'function run() { db.sql("SELECT visible"); } let db = createSqlClient({}, { execution: "adaptive" });',
  'function run() { owned("SELECT visible"); } let owned = sql.with({});',
])("late mutable ownership still fails prepare: %s", (body) => {
  expect(() => scan(body)).toThrow(/must use const/);
});

test("ordinary function defaults resolve outside body var scope", () => {
  expect(scan('function run(arg = sql("SELECT defaults")) { if (true) { var sql = q => q; } sql("SELECT hidden"); }')
    .map(({ query }) => query)).toEqual(["SELECT defaults"]);
});

test("static blocks own var bindings without shadowing the surrounding class", () => {
  expect(scan(`class Example {
    static { var sql = q => q; sql("SELECT hidden"); }
    static run() { sql("SELECT visible"); }
  }`).map(({ query }) => query)).toEqual(["SELECT visible"]);
});

test("factory wrappers preserve literal-only definition and namespace recognition", () => {
  expect(scan(`
    (defineQuery)("SELECT one");
    (database.defineQuery as typeof defineQuery).one("SELECT two");
    (database).defineQuery("SELECT three");
  `).map(({ query }) => query)).toEqual(["SELECT one", "SELECT two", "SELECT three"]);
  expect(scan('(defineQuery.for("api")).optional("SELECT four");', ["api"]))
    .toMatchObject([{ query: "SELECT four", profiles: ["api"], cardinality: "optional" }]);
  expect(() => scan('(defineQuery)(`SELECT ${value}`);')).toThrow(/template interpolation/);
});


test("local-hop imported clients yield to late local clients with their own profile", () => {
  const sites = scan(`
    import { db } from "./client";
    function outerRun() { db.sql("SELECT outer"); }
    {
      function innerRun() { db.sql("SELECT inner"); owned("SELECT options"); }
      const owned = db.sql.with({});
      const db = createSqlClient({}, { execution: "adaptive", profile: profiles.inner });
    }
    db.sql("SELECT restored");
  `, ["outer", "inner"], [], {
    "client.ts": `import { createSqlClient } from "@onreza/sqlx-js";
      export const db = createSqlClient({}, { execution: "adaptive", profile: profiles.outer });`,
  });
  expect(sites.map(({ query, profiles }) => ({ query, profiles }))).toEqual([
    { query: "SELECT outer", profiles: ["outer"] },
    { query: "SELECT inner", profiles: ["inner"] },
    { query: "SELECT options", profiles: ["inner"] },
    { query: "SELECT restored", profiles: ["outer"] },
  ]);
});

test("cyclic constant ownership remains unrecognized without recursion", () => {
  expect(scan(`
    const first = second.with({});
    const second = first.with({});
    first("SELECT hidden");
    sql("SELECT visible");
  `).map(({ query }) => query)).toEqual(["SELECT visible"]);
});

test.each([
  'let unused = createSqlClient({}, { execution: "adaptive" });',
  'let unused = sql.with({});',
  'if (true) { var unused = createSqlClient({}, { execution: "adaptive" }); }',
])("unused mutable ownership still fails prepare: %s", (body) => {
  expect(() => scan(body)).toThrow(/must use const/);
});

test.each([
  ['const unused = createSqlClient({}, { profile: profiles.unknown });', /unknown profile/],
  ['const unused = createSqlClient({}, { profile: dynamic });', /profile must be/],
])("unused client profile still validates: %s", (body, message) => {
  expect(() => scan(body as string)).toThrow(message as RegExp);
});

test("nested var initializer resolves in its own lexical scope", () => {
  expect(scan(`function run() {
    { const createSqlClient = () => ({ sql: query => query });
      var db = createSqlClient(); }
    db.sql("SELECT hidden");
  }`).map(({ query }) => query)).toEqual([]);
  expect(() => scan(`function run() {
    function earlier() { db.sql("SELECT hidden"); }
    if (true) { var db = createSqlClient({}, { execution: "adaptive" }); }
  }`)).toThrow(/must use const/);
});

test("a var redeclaration retains the transaction callback parameter", () => {
  expect(scan('sql.transaction(async tx => { var tx; tx("SELECT visible"); });')
    .map(({ query }) => query)).toEqual(["SELECT visible"]);
});

test("type declarations do not shadow value imports", () => {
  expect(scan(`function run() {
    type sql = string;
    interface defineQuery { value: string; }
    sql("SELECT first");
    defineQuery("SELECT second");
  }`).map(({ query }) => query)).toEqual(["SELECT first", "SELECT second"]);
});

test("class self bindings include extends expressions and static var remains local", () => {
  expect(scan(`
    { class defineQuery extends defineQuery.one("SELECT hidden") {} }
    class Example {
      static { const factory = () => sql("SELECT hidden"); var sql = q => q; }
      static run() { sql("SELECT visible"); }
    }
  `).map(({ query }) => query)).toEqual(["SELECT visible"]);
});

test.each([
  "(database).createSqlClient",
  "(database as typeof database).createSqlClient",
  "((database).createSqlClient as typeof createSqlClient)",
])("transparent namespace client factories retain static ownership: %s", (factory) => {
  expect(scan(`const db = ${factory}({}, { execution: "adaptive", profile: profiles.api });
    db.sql("SELECT visible");`, ["api"]))
    .toMatchObject([{ query: "SELECT visible", profiles: ["api"], execution: "adaptive" }]);
  expect(scan('import { db } from "./client"; db.sql("SELECT imported");', ["api"], [], {
    "client.ts": `import * as database from "@onreza/sqlx-js";
      export const db = ${factory}({}, { execution: "adaptive", profile: profiles.api });`,
  })).toMatchObject([{ query: "SELECT imported", profiles: ["api"], execution: "adaptive" }]);
});

test.each([
  ['import type { createSqlClient as makeClient } from "@onreza/sqlx-js";', "makeClient"],
  ['import { type createSqlClient as makeClient, sql } from "@onreza/sqlx-js";', "makeClient"],
  ['import type * as namespace from "@onreza/sqlx-js";', "namespace.createSqlClient"],
])("type-only local factory imports do not invent client query ownership: %s", (imports, factory) => {
  expect(scan('import { db } from "./client"; db.sql("SELECT hidden"); sql("SELECT visible");', [], [], {
    "client.ts": imports + `\nexport const db = ${factory}({});`,
  }).map(({ query }) => query)).toEqual(["SELECT visible"]);
});
