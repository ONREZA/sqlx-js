# Runtime reliability contract

## Ownership layers

| Layer | Owns |
| --- | --- |
| `src/pg/driver.ts` connection | Wire state, one in-flight operation, protocol synchronization |
| Raw pool | Connection admission, FIFO queueing, reconnect for later work |
| `createClient` | Explicit raw pool access and caller-owned lifecycle |
| Managed generation | Deadlines, codec bootstrap, poison/replacement, observers |
| `createSqlClient` | Stable managed surface and bounded close |
| Transaction executor | Dedicated connection and callback-scoped validity |

## Outcome rules

- Failure before dispatch: report `not_sent`; retry is an application decision.
- Server result received: report the confirmed PostgreSQL result.
- Confirmed rollback: transaction outcome is `rolled_back`.
- Lost connection after dispatch or unconfirmed commit/rollback: outcome is
  `unknown`; never replay.

## Cancellation rules

- Before dispatch, prevent the user statement from being sent.
- After dispatch, issue PostgreSQL cancellation and wait only for bounded
  confirmation.
- If synchronization is uncertain, destroy the connection.
- A poisoned generation rejects collateral active operations and is replaced
  single-flight.

## Required regression dimensions

- connect and TLS/SCRAM failure classification;
- cancellation during bootstrap and parameter encoding;
- timeout after dispatch;
- concurrent collateral operations;
- transaction BEGIN/COMMIT/ROLLBACK uncertainty;
- close while active or replacement is pending;
- subsequent operation on a healthy replacement;
- no remaining unexpected PostgreSQL backends.
