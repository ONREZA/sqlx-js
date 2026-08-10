# Setup checklist

## Requirements

- PostgreSQL 16 or newer.
- Node.js 24+, Bun 1.3+, or Deno 2.9+.
- TypeScript 6.x for scanning commands.
- ES2025 or newer runtime semantics.
- ESM project configuration.

## Install

```bash
npm install @onreza/sqlx-js temporal-polyfill
npm install --save-dev "typescript@>=6 <7"

# or
bun add @onreza/sqlx-js temporal-polyfill
bun add --dev "typescript@>=6 <7"
```

The default `sqlx-js init` scaffold imports the adaptive fallback. Omit
`temporal-polyfill` only when every target runtime exposes native Temporal, and
select the matching scaffold explicitly:

```bash
sqlx-js init --temporal-provider native
```

## Schema provider selection

- Existing ordered SQL migrations: select built-in migrations.
- Existing declarative `schema.sql` owned through pgschema: select pgschema.
- Existing external schema system: use the query-only prepare loop rather than
  creating a competing DDL owner.

## First contract

1. Configure `DATABASE_URL`.
2. Apply or build the development schema.
3. Add one literal `sql(...)` or `defineQuery`.
4. Run `sqlx-js dev --strict-inference` for provider-owned schema development,
   or live `prepare --strict-inference` for query-only setup.
5. Run TypeScript.
6. Run `sqlx-js doctor --fix` locally when generated-file attributes are
   missing.
7. Inspect and commit generated artifacts together with `.gitattributes`.

## Root alignment

Keep config, `--root`, TypeScript file discovery, migration/schema paths,
generated declaration path, enum output, and runtime `fileRoot` aligned.
