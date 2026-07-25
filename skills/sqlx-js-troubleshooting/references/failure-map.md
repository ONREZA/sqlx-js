# Failure map

| Symptom / phase | Owning skill |
| --- | --- |
| Install, init, first query, tsconfig | `sqlx-js-project-setup` |
| Unknown command or flag | `sqlx-js-cli` |
| Migration, pgschema, shadow build | `sqlx-js-schema-workflows` |
| CI or committed artifact drift | `sqlx-js-ci` |
| Query call syntax or wrappers | `sqlx-js-query-api` |
| Missing query or wrong generated type | `sqlx-js-inference` |
| Role, profile, tenant setting, RLS | `sqlx-js-profiles-rls` |
| OID, enum, JSON, array, domain, codec | `sqlx-js-custom-types` |
| Connection loss, timeout, hang, transaction cleanup | `sqlx-js-runtime-reliability` |
| Benchmark, soak, chaos, TLS/auth evidence | `sqlx-js-runtime-evidence` |
| Cache revision or version migration | `sqlx-js-upgrades` |
| Tag, release workflow, npm publish | `sqlx-js-release` |

## Minimal evidence

- sqlx-js version or commit;
- Node/Bun/Deno and TypeScript versions;
- PostgreSQL major version and proxy mode;
- exact command or API call;
- config subset with secrets removed;
- SQLSTATE and server message when available;
- whether SQL was dispatched;
- generated artifact diff when relevant;
- smallest schema and query reproduction.
