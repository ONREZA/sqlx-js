# sqlx-js Extended JSON protocol

Status: implemented protocol version 1. This document is the compatibility
contract for PostgreSQL `json`/`jsonb` values, exported text processing, and
generated artifacts.

## Decision

sqlx-js owns a versioned Extended JSON protocol for every PostgreSQL
`json` and `jsonb` parameter and result. The public boundary is a branded,
immutable `SqlxJson<T>` document. Applications enter it explicitly through
`sql.json(...)`; once inside that boundary, supported extension values such as
`bigint` and Temporal objects encode and decode automatically.

This is a wire and persistence contract, not an ORM contract. sqlx-js owns
lossless scalar representation, protocol validation, PostgreSQL transport, and
generated parameter/result types. Applications continue to own domain schemas,
runtime business validation, object-to-model mapping, migrations, and SQL
operators.

The target breaking contract is:

- generated `json` and `jsonb` parameters require `SqlxJson<T>`;
- `sql.json(value)` validates, snapshots, brands, and returns that document;
- generated `json` and `jsonb` results return `SqlxJson<T>`;
- the PostgreSQL codecs and exported text parser/stringifier use the same
  protocol implementation;
- there is no option that silently returns an ordinary mutable JavaScript
  object from the database.

The explicit document boundary prevents an arbitrary application object from
changing persistence meaning merely because a nested value later becomes a
`bigint` or Temporal object. Automatic extension handling begins only after the
application has chosen the sqlx-js JSON protocol.

## API

`sql.json(...)` is the document constructor. The package also exports the
document and exact-number classes:

```ts
import {
  JsonNumber,
  SqlxJson,
  sql,
} from "@onreza/sqlx-js";

const payload = sql.json({
  eventId: 9_007_199_254_740_993n,
  occurredAt: Temporal.Instant.from("2026-08-04T10:15:30.123456789Z"),
  amount: JsonNumber.from("12345678901234567890.125"),
});

// payload: SqlxJson<{
//   eventId: bigint;
//   occurredAt: Temporal.Instant;
//   amount: JsonNumber;
// }>
await sql.execute(
  "INSERT INTO events (payload) VALUES ($1::jsonb)",
  payload,
);
```

The corresponding result remains branded:

```ts
const row = await sql.one("SELECT payload FROM events WHERE id = $1", id);

// row.payload: SqlxJson<EventPayload>
const event = row.payload.value;
// event.eventId: bigint
// event.occurredAt: Temporal.Instant
```

`SqlxJson.parse(text, { temporalApi })` returns a branded generic protocol tree,
using `globalThis.Temporal` when the explicit provider is omitted, and
`SqlxJson.stringify(document)` accepts only a branded document. A generic
`parse<T>(text)` overload must not claim domain validation from a type argument.
An application that needs `T` from untrusted text must validate the decoded
value at its own boundary.

`jsonbTypes` remains an application-owned compile-time assertion. A mapped
column would generate `SqlxJson<UserSettings>`, not `UserSettings` directly.
The protocol validates its own tags and values but does not validate the
application's `UserSettings` schema.

## Value model

Version 1 should preserve ordinary JSON shapes wherever possible and add exact
extension values.

| Application value | Protocol value after decoding | PostgreSQL JSONB behavior |
| --- | --- | --- |
| `null`, boolean, string | Same primitive | Native JSONB scalar |
| finite safe-integer `number` | `number` | Native JSONB number |
| finite fractional `number` | `number` with JavaScript IEEE-754 semantics | Native JSONB number |
| `bigint` | `bigint` through a versioned extension tag | Tagged JSONB object |
| `JsonNumber` | Native token; decoded as `JsonNumber` when JavaScript `number` is unsafe | Native JSONB number |
| supported Temporal object | Same Temporal class through a versioned extension tag | Tagged JSONB object |
| plain object or dense array | Deeply immutable protocol tree | Native shape except reserved-tag escaping |

`JsonNumber` represents an exact JSON number token rather than a JavaScript
`number`. It is the explicit choice for quantities that must remain native
JSONB numerics for comparison, arithmetic, containment, or numeric indexes.
Construction validates JSON number grammar, normalizes exponent notation to a
decimal representation, and enforces PostgreSQL `jsonb`'s 131072 integer-digit
and 16383 fractional-digit limits. Trailing fractional zeroes remain
significant in canonical text. PostgreSQL still owns any narrower server-side
acceptance caused by a deployed version or expression context.

The native JSON token carries no marker that distinguishes an explicit
`JsonNumber` input from an ordinary number written by another producer. On
read, unsafe integers, overflow, and underflow materialize as `JsonNumber`;
ordinary fractions and safe integers follow JavaScript `number` semantics.
This preserves native JSONB operators and indexes without pretending that a
write-side wrapper can be recovered when the wire representation is identical.

A `bigint` uses a tag and round-trips back to `bigint`. The decoder must not
guess that an untagged large JSON integer is a `bigint`: existing databases and
external producers did not declare that semantic type. An untagged numeric
token that cannot be represented under the safe JavaScript-number policy
decodes as `JsonNumber`.

JavaScript `Date` remains permanently rejected, including when nested inside an
Extended JSON document. Automatic `Date` conversion would reintroduce the
ambiguous local-time/instant boundary removed from PostgreSQL query I/O.

The Temporal target includes the standard types whose canonical strings can be
restored without guessing:

- `Temporal.Instant`;
- `Temporal.PlainDate`, `PlainTime`, and `PlainDateTime`;
- `Temporal.PlainYearMonth` and `PlainMonthDay`;
- `Temporal.ZonedDateTime`;
- `Temporal.Duration`.

Each type needs provider-backed conformance vectors before it ships. The first
implementation slice may expose only the four types already required by the
PostgreSQL temporal boundary, but it must reject unsupported Temporal objects
rather than stringify them as ordinary data.

`undefined`, functions, symbols, accessors, sparse arrays, cycles, class
instances, custom `toJSON`, `Map`, `Set`, binary views, non-finite numbers, and
unsupported Temporal objects fail closed. JSON `null` remains distinct from SQL
`NULL`: `sql.json(null)` is a non-null protocol document whose value is JSON
`null`, while a bare nullable query parameter represents SQL `NULL`.

## Version 1 wire representation

Version 1 keeps ordinary object paths unchanged and uses sparse tagged nodes.
Object keys are ordered by JavaScript UTF-16 code units in canonical output, so
the control object is emitted as `{"type": ..., "v": 1}`:

```json
{
  "$sqlx": { "type": "bigint", "v": 1 },
  "value": "9007199254740993"
}
```

```json
{
  "$sqlx": { "type": "temporal.Instant", "v": 1 },
  "value": "2026-08-04T10:15:30.123456789Z"
}
```

An application object with an own `$sqlx` key cannot be left ambiguous. The
encoder can escape it as an explicit object node:

```json
{
  "$sqlx": { "type": "object", "v": 1 },
  "value": {
    "$sqlx": "application-owned value",
    "other": true
  }
}
```

The decoder treats every unescaped `$sqlx` control key as protocol-owned.
Unknown versions, unknown types, extra control fields, malformed payloads, and
legacy objects that collide with the reserved namespace fail closed. A rollout
therefore needs a collision audit before writes are enabled.

A versioned root envelope was rejected because it would change every JSONB
path, containment expression, partial index, and external reader even for
documents that use only vanilla JSON. The `$sqlx` namespace, sparse tags, and
`object` escape above are frozen for protocol version 1.

## Canonical and safe processing

The protocol parser cannot delegate number materialization to `JSON.parse`,
because precision may already be lost before sqlx-js can inspect the value. The
database decoder, exported parser, document constructor, and stringifier must
share one exact tokenizer and one conformance suite.

Version 1 defines:

- deterministic object-key ordering for text output without Unicode key
  normalization;
- canonical string escaping and extension payload spelling;
- rejection of duplicate object keys before PostgreSQL `jsonb` can collapse
  them;
- exact handling of exponent notation, very large numeric tokens, and negative
  zero;
- maximum 16 MiB UTF-8 document text, depth 128, 100000 nodes, 8 MiB UTF-8
  strings/keys, 131072 decimal digits in a tagged `bigint`, and numeric tokens
  bounded by the PostgreSQL-compatible decimal limits above;
- safe own-property construction so `__proto__`, `prototype`, and
  `constructor` remain data rather than mutation paths;
- deep immutability or an equivalent eager snapshot so a validated document
  cannot be mutated before dispatch.

Canonical text is useful for fixtures, signatures, and non-PostgreSQL transport.
It does not promise byte preservation through `jsonb`: PostgreSQL may normalize
whitespace, key order, duplicate keys, and numeric rendering. The protocol
guarantee for `jsonb` is semantic round-trip of supported values.

## JSONB queries and indexes

Extension tags preserve application values but change their database shape.
For example, a tagged `bigint` is an object, not a JSONB number, and a tagged
`Temporal.Instant` is an object, not a JSONB string. Existing operators such as
`>`, `@>`, JSONPath predicates, expression indexes, and generated columns will
observe that stored representation.

sqlx-js must not rewrite application SQL or install hidden database functions
to disguise this difference. Applications choose the representation per value:

- use `bigint` or Temporal for exact protocol round-trip;
- use `JsonNumber` when PostgreSQL must see an exact native JSON number;
- use an ordinary string when PostgreSQL must query a temporal value as a
  string;
- prefer a typed PostgreSQL column when the value participates materially in
  filtering, ordering, joins, constraints, or indexing.

Documentation and diagnostics should make this choice visible. A future SQL
helper package may be considered separately, but it cannot be implicit in the
core query runtime.

## Artifacts and compatibility

The generated registry, cache manifest, and runtime descriptor must bind the
Extended JSON protocol version. Prepare and runtime must fail when they disagree
instead of interpreting persisted values under different rules. Protocol
changes that alter tags, number classification, escaping, or Temporal
restoration require a new protocol version and an upgrade guide.

Existing untagged vanilla JSON remains readable. It is decoded into a branded
document using ordinary primitives plus `JsonNumber` where a numeric token is
not safe as a JavaScript `number`. New extension values introduce tags only at
their own nodes, so existing object paths remain stable unless they collide
with the reserved namespace.

Deployment must be reader-first:

1. audit stored documents and SQL expressions for reserved-key collisions and
   extension-sensitive JSONB paths;
2. deploy readers that understand the new protocol while writers still emit
   vanilla values;
3. regenerate and deploy the new generated contracts;
4. enable writers that may persist extension tags;
5. treat rollback to an old reader as unsafe after the first tagged write
   unless data has been converted back.

The library should provide a read-only audit/inventory command before it offers
any data rewrite. Database migrations and backfills remain application-owned.

## Frozen version 1 decisions

- `SqlxJson<T>.value` is the eagerly snapshotted, deeply frozen tree; it is not
  a mutable copy.
- Negative zero is canonicalized to `0`. Object keys are sorted without Unicode
  normalization, and duplicate decoded keys are rejected.
- All eight reconstructable Temporal types listed above are supported. Input
  values must round-trip through their own provider constructor; database and
  text decoding use the client/global provider.
- Resource limits are fixed protocol constants. Making them configurable would
  let two version-1 readers disagree about whether the same persisted document
  is valid.
- `sqlx-js json audit` scans selectable ordinary/materialized user relation
  columns in a read-only transaction. It recursively follows arrays, domains,
  and composite fields so every runtime-decoded `json`/`jsonb` leaf is in the
  inventory. It reports each leaf path, `$sqlx` collisions at any depth,
  duplicate object keys preserved by `json`, dependent indexes, constraints,
  generated columns and views, plus source queries using JSON operators or
  `json_*`/`jsonb_*` functions. Missing column privileges, active row-level
  security for the audit role, or scan errors make the audit incomplete and
  non-zero.
- External producers may continue writing untagged JSON. Readers brand it and
  materialize unsafe native numeric tokens as `JsonNumber`; only sqlx-js writers
  require `SqlxJson` input.

None of these decisions requires runtime SQL parsing, row-schema validation, or
model generation. Keeping those boundaries explicit is what lets Extended JSON
improve correctness without turning sqlx-js into an ORM.
