# W2-DB-02 — A constraint violation arrives wrapped, so the classifier walks the cause chain

Status: accepted
Date: 2026-09-04
Decided by: W2-DB-02 (Persistence)
Scope: `packages/core/src/db/repositories/violations.ts` and its two callers

## Context

The repository layer turns three database rejections into named outcomes — `name-conflict`,
`unknown-model-connection`, `unknown-session` — by reading a rejection's SQLSTATE and its constraint
name. The first version read them off the thrown value:

```ts
const { code, constraint } = error as { code?: unknown; constraint?: unknown };
```

Both were `undefined`, nothing was classified, and every rejection was re-thrown. The conformance
suite caught it on its first run against a real PostgreSQL 17 — four assertions that expected a
named outcome received an exception instead:

```text
 FAIL  @agent-workspace/web server/agents/store.test.ts > the PostgreSQL agent store >
   over a real PostgreSQL, against the same suite > update >
   rejects a modelConnectionId the workspace does not have
Error: Failed query: update "agents" set "model_connection_id" = $1, "updated_at" = $2
  where ("agents"."workspace_id" = $3 and "agents"."id" = $4) returning …
Caused by: error: insert or update on table "agents" violates foreign key constraint
  "agents_model_connection_id_model_connections_id_fk"
Serialized Error: { length: 367, severity: 'ERROR', code: '23503',
  detail: 'Key (model_connection_id)=(44444444-4444-4444-8444-444444444444) is not present
  in table "model_connections".', …, constraint:
  'agents_model_connection_id_model_connections_id_fk', file: 'ri_triggers.c',
  routine: 'ri_ReportViolation' }

 Test Files  1 failed (1)
      Tests  4 failed | 41 passed (45)
```

The `code` and `constraint` are on the `pg` error, and Drizzle throws a `DrizzleQueryError`
carrying the SQL and the parameters, with the `pg` error under `cause`.

This was already known in this repository and written down: `packages/core/src/db/seed.test.ts`'s
`expectConstraintViolation` walks the `cause` chain and its doc comment says why — matching on the
message text instead *"would pass for ANY failure of the statement, including a typo in the test's
own SQL"*. That helper is in a test file, so nothing production reads it.

## Decision

One shared reader, `postgresViolations(error)`, in
`packages/core/src/db/repositories/violations.ts`. It walks the `cause` chain to a bounded depth
and **yields every link that carries both a string `code` and a string `constraint`**, outermost
first. The caller then decides which SQLSTATE-and-constraint pairs it recognises, at the point where
those constraint names are known.

The depth is bounded because a `cause` chain can be cyclic and an unbounded walk over a cycle turns
a failed insert into a hung request.

Yielding rather than returning "the first `pg` error" keeps the decision a positive assertion where
the names live: a caller for which nothing matched re-throws, because a rejection this layer cannot
name might be a dropped connection, and reporting that as a client error would be a gate deciding
on the absence of a negative ([ADR-0015](0015-gates-decide-on-positive-assertions.md)).

## Alternatives considered

* **Match on the error message text.** Rejected for the reason `seed.test.ts` already gives: the
  message is not a stable contract and a match on it passes for failures that have nothing to do
  with the constraint.
* **Read `error.cause` once, at a fixed depth.** Rejected: it encodes a wrapper depth that is
  Drizzle's to change, and the value it produces on a different depth is `undefined`, which
  classifies as "unknown" and fails silently in exactly the direction that hurts.
* **Catch nothing and check for a conflict with a `select` first.** Rejected: two statements where
  one will do, and it is a race — a concurrent insert between the check and the write returns
  "created" for a row that was rejected.

## Consequences

* `agents.ts` and `runs.ts` share one reader, so a third resource adding an outcome does not
  rediscover the wrapping.
* The four assertions that found this are permanent: they are part of the contract suite that runs
  against both implementations, so a future change to how Drizzle wraps errors fails a test rather
  than quietly turning every named outcome back into a 500.
