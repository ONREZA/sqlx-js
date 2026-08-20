# Provider workflows

## Built-in migrations

```bash
sqlx-js migrate add <name>
sqlx-js dev --strict-inference
sqlx-js verify --strict-inference
sqlx-js migrate run --dry-run
sqlx-js migrate run
```

Use `migrate info` and `migrate check` for history/file inspection. Review
`revert --dry-run` before reverting. Use `squash` only with a disposable shadow
database and verify adoption on already-migrated targets. Archive operations
own only recognized migration history.

## Declarative pgschema

```bash
sqlx-js pgschema install
# commit pgschema.lock.json
sqlx-js dev --strict-inference
sqlx-js verify --strict-inference
sqlx-js pgschema plan -- --output-json plan.json
sqlx-js pgschema apply -- --plan plan.json --auto-approve
```

Use `pgschema install --frozen` in CI and refresh the compatible patch only with
`pgschema update --patch`. `pgschema exec -- <args>` is a direct diagnostic
escape hatch and does not own deployment connection or schema safeguards.
Review the saved plan as the deployment artifact. Do not use `dev` or `verify`
as a substitute for `plan` and `apply`.

## Shadow selection

- Default automatic shadows require `CREATEDB`.
- Use `--shadow-admin-url` when database creation needs separate credentials.
- Use `--shadow-url` only for a pre-created disposable database.
- Never point a shadow option at production or a database containing data that
  must be retained.

## Closure checks

- Proposed schema builds from a clean shadow.
- `verify --strict-inference` is read-only and passes.
- Generated artifacts match the proposed schema.
- Target plan is reviewed separately.
- Target application completes.
- Migration history or declared schema state matches the intended revision.
