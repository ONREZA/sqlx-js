# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Email [opensource@onreza.ru](mailto:opensource@onreza.ru) with the subject
`sqlx-js security report` and include:

- the affected version or commit;
- the security impact and required preconditions;
- a minimal reproduction or proof of concept;
- any known workaround;
- whether the report or fix has been shared elsewhere.

Remove production credentials, personal data, and unrelated private source
code. Maintainers will establish a private coordination channel for
validation, remediation, disclosure, and credit.

## Supported versions

sqlx-js is pre-1.0. Security fixes target the latest published release and the
current `main` branch. Older releases may require upgrading rather than a
backport. The final advisory will identify the fixed version and any required
migration or generated-artifact refresh.

## Scope

Security-sensitive areas include PostgreSQL authentication and TLS, SQL
parameter encoding, identifier allowlisting, role/profile boundaries, RLS
context isolation, pool lifecycle recovery, generated artifact integrity,
migrations, and the published package supply chain.

General bugs, feature requests, and questions can use the public issue tracker.
