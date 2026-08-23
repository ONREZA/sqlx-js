# Roadmap

Unfinished work, ordered by ROI (0–10): how much demonstrated consumer pain
the completed item would close. Shipped features belong in the
[README](./README.md), not here.

| Feature | ROI | Completion boundary |
| --- | ---: | --- |
| Prisma migration assistant | 8 | Inventory Prisma Migrate history, TypedSQL/raw SQL, and Prisma Client call sites; import compatible SQL and classify the remaining CRUD, relation, and nested-write sites as assisted or manual. Do not promise an automatic ORM rewrite. |
| Optional `plpgsql_check` validation | 6 | Add an explicitly execution-enabled disposable-database gate for deferred PL/pgSQL statements and assignments. Normal `prepare` must remain non-executing, and projects without the extension must remain unaffected. |
| Planning datasets and query-plan inventory | 5 | Run an application-owned seed only against an explicit disposable planning database, then `ANALYZE` and persist normalized generic `EXPLAIN (FORMAT JSON)` metadata in an environment-scoped artifact. Bind it to PostgreSQL, schema, planner settings, and seed identities; keep it advisory by default. |
| Generated function call API | 4 | Generate a callable surface from canonical function identities only after default and named arguments, procedures, overload resolution, and returned-set contracts can be represented without ambiguity. |
| pgschema migration handoff | 4 | Produce a reviewable `schema.sql` baseline from a built-in-migration project and verify equivalent desired state before switching providers, without leaving two DDL authorities active. |
| Large-result and bulk I/O | 4 | Add typed cursor streaming and COPY with backpressure, cancellation, and explicit connection ownership once a concrete consumer supplies acceptance and performance cases. |
| Multidimensional array contracts | 3 | Preserve runtime dimensions in generated parameter and row contracts without treating PostgreSQL's declared array bounds as enforced shape. The existing one-dimensional public wrapper must not claim stronger guarantees. |
| Query-plan policy gates | 3 | On top of the plan inventory, allow opt-in blocking rules only for representative, identity-matched planning environments. Cost changes and sequential scans must never fail CI by default. |
| LISTEN / NOTIFY lifecycle | 2 | Add typed notification payloads only with a dedicated long-lived connection, reconnect, resubscription, cancellation, and shutdown contract. Sending a literal `NOTIFY` remains ordinary SQL. |
