# CI gate map

## Core provider-aware gate

```bash
sqlx-js ci
sqlx-js doctor --json
tsc --noEmit
bun test tests --timeout 120000
bun run build
```

`sqlx-js ci` runs strict provider-aware shadow verification, which includes
generated-artifact comparison. It does not mutate the target database.

## Credentials

- Use credentials that can create a temporary database, or supply a dedicated
  shadow admin URL.
- Use `--shadow-url` only for a disposable database.
- Keep target deployment credentials out of PR verification when possible.

## Target deployment gates

Built-in migrations:

```bash
sqlx-js migrate run --dry-run --json
```

pgschema:

```bash
sqlx-js pgschema plan -- --output-json plan.json
```

Snapshots:

```bash
sqlx-js snapshot check
```

## Failure routing

- Scan or generated type mismatch: `sqlx-js-inference`.
- Cache/generator revision: `sqlx-js-upgrades`.
- Shadow or target DDL: `sqlx-js-schema-workflows`.
- Runtime/package smoke: `sqlx-js-runtime-reliability`.
- Release workflow: `sqlx-js-release`.
