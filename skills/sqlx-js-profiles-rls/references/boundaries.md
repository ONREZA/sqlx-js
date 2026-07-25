# Profiles and RLS boundaries

## Static profile identity

Profile names, roles, and setting keys are generated contract inputs. Keep them
identical in development, CI, shadow validation, and deployed runtime.

Direct client bindings can propagate a profile. Reusable definitions must use
an explicit `defineQuery.for(...)` allowlist. Do not infer profiles through
arbitrary factories, mutable aliases, or dependency injection.

## Session requirements

Prepare must use a direct or session-pooled connection because role selection,
Describe, planning, and catalog reads must stay on one backend. Transaction- or
statement-pooling proxies cannot preserve this contract.

The login role must be allowed to assume every configured effective role.
Cluster roles must exist for automatically created shadow databases.

## RLS context

- Use lower-case custom setting names such as `app.tenant_id`.
- Require every configured setting at the transaction boundary.
- Apply values with parameterized `set_config(..., true)`.
- In policies, prefer
  `NULLIF(current_setting('app.key', true), '')` before casts so reset context
  fails closed.

## Diagnostic limits

`doctor` can flag superuser, `BYPASSRLS`, table ownership without forced RLS,
and missing applicable permissive policies. It cannot prove arbitrary `USING`
or `WITH CHECK` expressions, triggers, dynamic SQL, sequence privileges, or
value-dependent effects.
