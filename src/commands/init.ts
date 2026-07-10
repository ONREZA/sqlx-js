import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const CONFIG_TEMPLATE = `import { defineConfig } from "@onreza/sqlx-js";

export default defineConfig({
  // Map jsonb columns/params to TypeScript types declared in a .d.ts, e.g.
  //   "users.settings": "SqlxJsJson.UserSettings",
  jsonbTypes: {},
  // Map PostgreSQL type names to TypeScript types, e.g.
  //   geometry: "GeoJSON.Geometry",
  customTypes: {},
});
`;

const PGSCHEMA_CONFIG_TEMPLATE = `import { defineConfig } from "@onreza/sqlx-js";

export default defineConfig({
  schema: {
    provider: "pgschema",
    file: "schema.sql",
    schemas: ["public"],
  },
  jsonbTypes: {},
  customTypes: {},
});
`;

const ENV_TEMPLATE = `# Connection string used by sqlx-js prepare/migrate and the runtime.
DATABASE_URL=postgres://user:password@localhost:5432/your_db
# Managed Postgres with TLS:
# DATABASE_URL=postgres://user:password@db.example.com:5432/your_db?sslmode=verify-full
`;

const PGSCHEMA_TEMPLATE = `-- Desired PostgreSQL schema managed by pgschema.
-- Edit this file, then run:
--   sqlx-js db plan -- --output-json plan.json
--   sqlx-js db apply -- --auto-approve
`;

export type InitOptions = {
  root: string;
  schemaProvider?: "builtin" | "pgschema";
  log?: (msg: string) => void;
};

export function runInit(opts: InitOptions): void {
  const log = opts.log ?? console.log;
  const created: string[] = [];
  const skipped: string[] = [];

  const ensureFile = (rel: string, content: string) => {
    const full = join(opts.root, rel);
    if (existsSync(full)) {
      skipped.push(rel);
      return;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    created.push(rel);
  };

  const ensureDir = (rel: string) => {
    const full = join(opts.root, rel);
    if (existsSync(full)) {
      skipped.push(`${rel}/`);
      return;
    }
    mkdirSync(full, { recursive: true });
    created.push(`${rel}/`);
  };

  const schemaProvider = opts.schemaProvider ?? "builtin";
  ensureFile("sqlx-js.config.ts", schemaProvider === "pgschema" ? PGSCHEMA_CONFIG_TEMPLATE : CONFIG_TEMPLATE);
  if (schemaProvider === "pgschema") ensureFile("schema.sql", PGSCHEMA_TEMPLATE);
  else ensureDir("migrations");
  ensureFile(".env.example", ENV_TEMPLATE);

  for (const f of created) log(`created ${f}`);
  for (const f of skipped) log(`exists  ${f} (left unchanged)`);

  log("");
  log("Next steps:");
  log("  1. Set DATABASE_URL (see .env.example).");
  if (schemaProvider === "pgschema") {
    log("  2. Install managed pgschema:  sqlx-js db install");
    log("  3. Verify it:  sqlx-js db check");
    log("  4. Edit schema.sql, then review:  sqlx-js db plan");
    log("  5. After applying schema changes, run:  sqlx-js prepare");
  } else {
    log("  2. Add a migration:  sqlx-js migrate add init");
    log("  3. Make sure tsconfig.json \"include\" covers sqlx-js-env.d.ts.");
    log("  4. Develop locally:  sqlx-js migrate dev");
  }
}
