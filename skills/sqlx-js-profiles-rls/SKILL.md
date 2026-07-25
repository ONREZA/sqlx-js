---
name: sqlx-js-profiles-rls
description: Configure, implement, or audit sqlx-js connection profiles, PostgreSQL startup roles, profile-scoped generated registries, required transaction settings, and RLS diagnostics. Use for multi-role applications, tenant context, SET ROLE behavior, RLS safety, profile inference, or changes that cross prepare and runtime role identity.
---

# sqlx-js profiles and RLS

Preserve the identity `query -> explicit profile -> PostgreSQL role` across
scan, prepare, generated contracts, runtime generations, and diagnostics.

## Workflow

1. Inspect exported `defineDatabaseProfiles(...)` config.
2. Identify the login role, effective profile role, and required transaction
   settings.
3. Trace the query site to one explicit profile.
4. Validate under that role in a session-preserving prepare connection.
5. Bind the generated profile registry at client construction.
6. For contextual profiles, require a transaction and all configured settings.
7. Test cross-tenant isolation, replacement generations, and RLS failure paths.

Read [the role and RLS boundaries](references/boundaries.md) before changing
profile behavior.

## Invariants

- Apply the effective role before Describe, generic planning, and catalog
  introspection.
- Send the same role on every runtime pool connection and replacement
  generation.
- Include the profile in cache and generated registry identity.
- Reject contextual profile queries outside the transaction boundary before
  dispatch.
- Apply transaction characteristics before parameterized transaction-local
  settings.
- Never install tenant or user context with session-level `SET` on a pooled
  connection.
- Keep RLS policy DDL in migrations or `schema.sql`.
- Describe profile checks as planning-time privilege validation, not proof of
  arbitrary RLS expressions or runtime side effects.
