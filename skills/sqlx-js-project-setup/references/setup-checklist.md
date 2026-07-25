# Setup checklist

## Requirements

- PostgreSQL 16 or newer.
- Node.js 24+, Bun 1.3+, or Deno 2.9+.
- TypeScript 5.4 through 6.x for scanning commands.
- ESM project configuration.

## Install

```bash
npm install @onreza/sqlx-js
npm install --save-dev "typescript@>=5.4 <7"
```

Use Bun equivalents where appropriate.

## Provider selection

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
6. Inspect and commit generated artifacts.

## Root alignment

Keep config, `--root`, TypeScript file discovery, migration/schema paths,
generated declaration path, enum output, and runtime `fileRoot` aligned.
