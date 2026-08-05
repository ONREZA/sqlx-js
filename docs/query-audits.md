# Query reuse and similarity audits

`sqlx-js queries audit` and `sqlx-js queries similarities` provide
database-free evidence for reviewing repeated SQL. Both commands are read-only,
advisory, and independent from `prepare`: findings never invalidate generated
artifacts, fail an ordinary prepare, rewrite SQL, or apply a refactor.

## Exact query reuse

Run the exact audit after source scanning:

```bash
sqlx-js queries audit
sqlx-js queries audit --json
```

The audit treats two or more source sites with the same stable query fingerprint
as a possible duplicate, not proof that they represent one domain operation.
For each candidate it reports:

- definition-only, execution-only, or mixed origin;
- names, cardinalities, connection profiles, and source locations;
- nullable-parameter, result-assertion, expected-validation, and local Temporal
  contracts;
- contract fields that differ between occurrences;
- source-text variants that normalize to the same fingerprint.

It separately reports a named `defineQuery` identity attached to multiple query
fingerprints. Such a name collision can merge unrelated operations in query
observers even when neither SQL text is duplicated.

Findings have a zero exit status. Configuration and source-scan failures retain
the standard `queries` error behavior and exit with status 2.

### Reviewed intentional duplication

An intentional exact duplicate can be acknowledged in `sqlx-js.config.*`:

```ts
import { defineConfig } from "@onreza/sqlx-js";

export default defineConfig({
  queryAudit: {
    exactDuplicates: {
      ignore: [
        {
          queryId: "0123456789abcdef",
          occurrences: 3,
          reason: "Separate billing workflows retain distinct query names",
        },
      ],
    },
  },
});
```

The query ID and exact occurrence count fence the reviewed source set. Adding
or removing an occurrence makes the entry stale and surfaces the candidate for
review again. An ignore for a removed query or a query that is no longer
duplicated is also stale.

JSON output keeps ignored candidates, their current source sites, and the
review reason. It also emits every stale ignore. An acknowledged candidate is
therefore distinguishable from a candidate that is absent from the project.
The ignore acknowledges only the duplicate-source signal. A cardinality,
profile, assertion, validation, or Temporal contract divergence still sets the
candidate and report `reviewRequired` fields.

## AST similarity

The experimental similarity command ranks shared PostgreSQL AST fragments:

```bash
sqlx-js queries similarities
sqlx-js queries similarities --json --limit 100 --min-nodes 12
```

Application queries are grouped by their stable fingerprint before comparison,
so exact source reuse does not multiply similarity results. Candidate fragments
must occur in at least two distinct queries or functions. Nested fragments that
cover the same unit set are collapsed into one ranked family while retaining
their related fragment count and node types.

The score is structural size multiplied by the logarithm of the number of
participating units. It is a review-order heuristic, not a probability or an
automatic refactoring decision.

Normalization deliberately:

- ignores source locations and literal values;
- alpha-renames parameter positions while preserving whether two references use
  the same parameter or distinct parameters;
- preserves literal kinds, identifiers, operators, types, and statement shape;
- maps an unqualified SQL-function parameter reference to the same placeholder
  shape as an application query parameter;
- does not alpha-rename relation, column, CTE, or alias identifiers.

This boundary finds copied predicates, joins, CTEs, and policy expressions while
avoiding a broad "looks vaguely similar" rewrite engine. Results can indicate a
shared invariant, intentional lifecycle symmetry, or accidental drift. They do
not imply that the SQL should be combined.

### SQL function sources

When `schema.provider` is `"pgschema"`, the command reads the configured
`schema.file` (default `schema.sql`) as its SQL function source. A project whose
DDL lifecycle is owned by another orchestrator can point at its reviewed source:

```bash
sqlx-js queries similarities --functions pgschema/functions
```

`--functions` accepts one root-relative SQL file or a directory recursively
containing `.sql` files and overrides the configured schema file. This is an
analysis input only; sqlx-js does not make it a second schema authority.

Only bodies declared with `LANGUAGE sql` are analyzed. `plpgsql` and other
languages are counted in coverage and skipped until a reliable language parser
can preserve their procedural semantics. SQL-standard `RETURN` and
`BEGIN ATOMIC` bodies are analyzed directly from PostgreSQL's AST. Procedures
remain separately counted and skipped because this command's unit contract is
queries and functions. DDL and body parse failures remain in the report as
skipped coverage rather than being converted into guessed ASTs.

The JSON report uses `formatVersion: 1`, marks the feature as `experimental` and
`advisory`, records normalization and coverage, and returns deterministic
candidate ordering. `complete` is false when a DDL/body parse failure or an
unsupported SQL-function body leaves coverage partial, even though the advisory
command itself completed successfully. `--limit` defaults to 50 and
`--min-nodes` defaults to 12.

[Back to documentation index](./README.md)
