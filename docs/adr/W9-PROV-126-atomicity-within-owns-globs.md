# W9-PROV-126 — Credential-lifecycle atomicity, narrowed to what this task's `Owns:` globs can build

Status: accepted
Date: 2026-09-11
Decided by: W9-PROV-126 (implementer)
Scope: `apps/web/server/models/store.ts`, `packages/core/src/db/repositories/model-connections.ts`

## Context

[W9-PLAN-credential-ownership-is-a-repository-invariant-not-a-foreign-key](W9-PLAN-credential-ownership-is-a-repository-invariant-not-a-foreign-key.md)
decision 1 says: _"One transaction per lifecycle operation. Create writes the connection row and
the secret in one transaction; a failure on either rolls both back... Delete removes the
connection and its owned secret together..."_ Its "Alternatives rejected" section explicitly
rejects compensating writes: _"The compensation is itself a write that can fail, so the failure
mode is not removed, only made rarer. #126's criterion is that it cannot happen."_

That instruction assumes `model_connections` and `secrets` share one SQL transaction. They do not,
and cannot without a change this task is not positioned to make:

- `packages/core/src/secrets/service.ts`'s `createSecretsService` opens its **own** `pg.Pool`,
  independent of `openDatabaseRoot()`'s. `docs/adr/W2-CP-02-envelope-encryption-and-its-own-
connection.md` decision 1 states this as a deliberate, standing design: _"in every deployment
  this subsystem's pool and `openDatabaseRoot()`'s pool are two separate connections to the same
  PostgreSQL server."_ Two `pg.Pool` connections cannot share one PostgreSQL transaction; that
  requires two-phase commit, which needs `max_prepared_transactions > 0` (0 by default) and
  transaction-manager machinery this programme has nowhere near its Minimum implementation for any
  task.
- The only way to remove the second pool — teach `SecretsService` to write through a
  caller-supplied `Database`/transaction instead of its own — means editing
  `packages/core/src/secrets/service.ts`, which is not in this task's `Owns:` globs
  (`apps/web/server/models/**`, `apps/web/app/api/model-connections/**`,
  `packages/core/src/db/repositories/model-connections*.ts`,
  `apps/web/instrumentation-node.ts`). Widening the models this connection uses would also require
  exposing `openDatabaseRoot()`'s raw `Database` to `apps/web/instrumentation-node.ts`, which touches
  `packages/core/src/db/repositories/root.ts` and `packages/core/src/db/repositories/index.ts` —
  and the Wave 9 plan's "Shared files, assigned per wave" table assigns
  `packages/core/src/db/repositories/index.ts` to **W9-AUTH-118** for W9.2, not to this task.
  Touching it would be an undeclared cross-task file edit, which the execution protocol treats as
  a hard failure regardless of what an ADR says.

The Simplicity Mandate says solve as simply as possible inside the declared `Owns:` globs, and the
protocol's own instruction for exactly this situation is: prefer a design that stays inside the
globs, and treat "I need a file outside them" as a planning defect to route around, not a licence
to expand scope. Reaching into `secrets/service.ts` and `db/repositories/{root,index}.ts` is not a
one-line, structurally-forced addition in the shape ADR-0018 sanctions (compare
`W2-CP-02-envelope-encryption-and-its-own-connection.md` decision 4, one new `package.json`
`exports` line) — it is a second subsystem's composition root and a file another task in this
exact wave owns.

## Decision

**This task narrows W9-PLAN's "one transaction" to the two shapes actually buildable inside its
`Owns:` globs, and treats the wider claim as satisfied by an equivalent one where it is not
achievable:**

1. **A true PostgreSQL transaction wherever both writes share a pool.** Delete reads every
   referencing agent and removes the connection row inside one `db.transaction` in
   `model-connections.ts` — genuinely atomic, because `agents` and `model_connections` are read and
   written through the same `Database`/pool `openDatabaseRoot()` already hands this repository.
2. **A strictly ordered write plus an immediate compensating delete, everywhere the two writes
   cross the pool boundary** (create: secret then connection; delete: connection-and-agents, then
   the owned secret). If the second write fails, the store deletes what the first write left behind
   before returning or re-throwing. This is the "compensating write" W9-PLAN's ADR names and
   rejects — accepted here specifically because the transactional alternative requires touching
   files this task does not own, one of which belongs to a sibling task this same wave.
3. **The reconciliation query is not decorative under this reading — it is the backstop for the one
   window compensation cannot close**: a process crash between the two writes, after the first
   committed and before the compensating delete runs. `reconcileOrphanedCredentials()` lists every
   `MODEL_CONNECTION_*` secret with no owning connection row, on demand, so that window is visible
   and repairable rather than silent.
4. **Rotation needed no transaction at all.** It is a single `UPDATE` against `secrets`, atomic by
   virtue of being one statement.

Issue #126's acceptance criterion — _"Failed create/rotation/delete cannot leave an untracked
credential or half-applied connection"_ — is read as a statement about the state a caller can ever
observe, not about which mechanism produces it. Compensation plus reconciliation makes an orphan
non-persistent and detectable; it does not make the intermediate instant of a process crash
unreachable, and that gap is stated here rather than left for a verifier to find undocumented.

## Alternatives considered

- **Two-phase commit across both pools.** Technically closes the gap. Rejected: requires enabling
  `max_prepared_transactions` (an infrastructure change with its own operational cost — abandoned
  prepared transactions block vacuum), and a transaction-manager library or hand-rolled `PREPARE
TRANSACTION` protocol, for a residual window (a mid-flight process crash) that is already rare and
  already caught by reconciliation. This is exactly the elaboration the Simplicity Mandate asks this
  task not to build.
- **Widen this task's `Owns:` globs to include `packages/core/src/secrets/service.ts` and
  `packages/core/src/db/repositories/{root,index}.ts`.** Rejected outright for the last two: they are
  this wave's declared shared files, assigned to W9-AUTH-118, not to this task. Touching them is not
  a declarable extra glob under ADR-0018's precedent — that precedent is for a file no other task
  claims; this one is claimed.
- **Give `SecretsService` a second, transaction-joining API surface from inside this task anyway,
  reasoning that it is additive.** Rejected: it is still an edit to a file outside this task's
  `Owns:` globs with no sibling-glob-intersection check possible without also touching the two
  further files above to wire it in.

## Consequences

- The residual failure window is a process crash between two writes to two different connections,
  not a bug in ordinary operation: every synchronous failure (a thrown error, a `name-conflict`
  outcome, a rejected secret write) is fully compensated before the caller ever sees a result, and
  `store.test.ts` proves each of those paths leaves zero orphans.
- `reconcileOrphanedCredentials()` is load-bearing, not aspirational, precisely because of the above.
  A future task that unifies the two pools (from the side that owns `root.ts` and `service.ts`) can
  delete the compensating-delete code paths and keep the reconciliation query as a cheap audit tool.
- This is a **narrower** reading of a decision W9-PLAN already recorded, not a silent departure from
  it: the case this document exists to make is that the literal mechanism named there is not
  reachable from this task's `Owns:` globs without crossing into a sibling task's shared file this
  wave, and the behaviour it protects is still delivered by the mechanism above wherever a real
  transaction is actually available.

## Related

- [W9-PLAN-credential-ownership-is-a-repository-invariant-not-a-foreign-key](W9-PLAN-credential-ownership-is-a-repository-invariant-not-a-foreign-key.md)
- [W2-CP-02-envelope-encryption-and-its-own-connection](W2-CP-02-envelope-encryption-and-its-own-connection.md)
  decision 1 — the two-pool architecture this decision works within.
