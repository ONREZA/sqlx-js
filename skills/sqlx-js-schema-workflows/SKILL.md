---
name: sqlx-js-schema-workflows
description: Choose and operate sqlx-js schema ownership through built-in migrations or declarative pgschema, including shadow dev and verify, target planning, migration squash, revert review, and deployment gates. Use for schema changes, migration commands, pgschema, shadow databases, or questions about development versus deployment.
---

# sqlx-js schema workflows

Keep one DDL source of truth and distinguish shadow validation from target
deployment.

## Workflow

1. Inspect `sqlx-js.config.*` and existing schema files.
2. Identify exactly one provider:
   - built-in linear migrations;
   - declarative pgschema.
3. Confirm which database is the disposable shadow and which is the target.
4. Develop with `dev`; verify without writes with `verify`.
5. Review the provider-specific target plan.
6. Apply only with explicit deployment authorization.
7. Verify migration history or pgschema state after application.

Read [the provider workflows](references/workflows.md) before changing schema
files or running a target command.

## Safety rules

- Do not mix migrations and `schema.sql` as competing DDL authorities.
- `dev` and `verify` must use a disposable shadow database.
- Do not describe a successful shadow build as a target deployment.
- Inspect pending work before `migrate run`, `migrate revert`, or
  `pgschema apply`.
- Treat `migrate reset`, destructive pgschema plans, and shadow URL reuse as
  destructive operations requiring exact target resolution.
- Preserve migration hashes and squash adoption semantics.
- Keep RLS policy DDL in the schema provider, not in runtime helpers.

## Verification

Use provider-aware `sqlx-js ci` for the proposed schema and committed query
artifacts. Keep target drift and deployment checks explicit and separate.
