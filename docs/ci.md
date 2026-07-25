# CI and deployment checks

Build a database-aware CI gate while keeping generated artifacts reproducible and deployment checks explicit.

The shortest production gate is provider-aware:

```bash
sqlx-js ci
```

For both providers, `ci` runs provider-aware `verify --strict-inference`
against a disposable shadow database and then the database-free
`prepare --check --strict-inference`. It validates the proposed schema source,
not target deployment drift, and never writes generated artifacts or changes
the target database. `--json` returns a versioned per-step report.

Commit the generated `sqlx-js-env.d.ts`, `.sqlx-js/` cache directory, and configured enum catalog output to your repo. In CI:

```yaml
- run: bun install
- run: sqlx-js pgschema install # only when schema.provider is "pgschema"
- run: sqlx-js ci
- run: sqlx-js doctor --json
- run: tsc --noEmit
- run: bun test --timeout 120000
- run: bun run build
```

Keep target-specific deployment checks explicit:

```bash
sqlx-js migrate run --dry-run --json               # built-in migrations
sqlx-js pgschema plan -- --output-json plan.json   # pgschema
sqlx-js snapshot check                             # when a snapshot is committed
```

`verify` needs credentials that can create a temporary database or an explicit
`--shadow-admin-url` / `--shadow-url`. `prepare --check` remains the fast
database-free consistency check. `prepare --verify` remains available for the
narrower advanced case of comparing query artifacts against a specifically
supplied live database.

The managed pgschema binary is installed under `node_modules/.cache/sqlx-js/pgschema/`, not `.sqlx-js/`, so it is not part of the committed offline cache.

Generated declarations, enum modules, and cache files should be excluded from formatters and linters. TypeScript artifacts remain included in `tsconfig.json` for type checking, but rules such as Biome's empty-interface or confusing-void checks are not meaningful for generated contracts.

[Documentation index](./README.md)
