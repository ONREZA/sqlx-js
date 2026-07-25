# Upgrade compatibility checklist

## Inspect

- `package.json` version and engine constraints.
- `CHANGELOG.md`.
- `docs/upgrades/README.md` and every guide in the version range.
- Cache, generator, function catalog, enum catalog, and snapshot revisions.
- Managed versus raw runtime option changes.
- Generated registry and custom codec requirements.

## Regenerate

Use live `prepare` after schema-dependent revision changes. Use
`prepare --offline` only for outputs whose committed cache remains compatible.
Review the complete diff rather than accepting generated churn blindly.

## Verify

```bash
sqlx-js prepare --check --strict-inference
sqlx-js prepare --verify --strict-inference
bunx tsc --noEmit
bunx tsc -p example
bun test tests --timeout 120000
bun run test:runtime-boundary
```

Add package smokes when runtime exports, options, codecs, or engine support
change.

## Rollback

- Retain the prior package and generated artifact set together.
- Do not run a new runtime against an unreviewed old registry.
- Record schema changes that cannot be reversed by a package downgrade.
- Distinguish package rollback from database rollback.
