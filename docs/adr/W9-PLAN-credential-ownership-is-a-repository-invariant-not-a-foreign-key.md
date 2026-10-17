# W9-PLAN — A model connection's credential is owned by a repository invariant, not by a foreign key

Status: accepted
Date: 2026-09-11
Decided by: W9-PLAN-00 (the Wave 9 planner)
Scope: `model_connections`, `secrets` and `packages/core/src/db/repositories/model-connections.ts` as
seen by W9-PROV-126; the absence of a migration in that task; the split of URL validation between
W9-PROV-126 and W9-PROV-127

## Context

Issue #126 diagnoses the model-connection credential lifecycle precisely: creation writes the secret
before the connection with no compensation, deletion removes the connection and leaves the secret, and
the relationship between the two is carried by the synthetic name `MODEL_CONNECTION_<UUID>` — *"A
naming convention is acting as an unenforced relationship."*

Its Proposed Changes then offer two ways to fix the relationship, in one sentence, as alternatives:

> Represent credential ownership explicitly (FK/purpose metadata **or a transactional repository
> invariant**), while keeping ciphertext only in the existing SecretsService.

The acceptance criteria constrain the *behaviour*, not the mechanism. They are: invalid configs rejected
before persistence with field-level errors; credentials never returned or logged; *"Failed
create/rotation/delete cannot leave an untracked credential or half-applied connection"*; rotation
without learning the old value; deletion handling references predictably and removing the owned secret;
existing connections migrated or reconciled; *"`hasCredential`/readiness accurately reflect persisted
state"*.

Every one of those is a statement about what a transaction does and what a read computes. None of them
names a column.

W9-PROV-126 sits in W9.2, whose single migration slot belongs to W9-AUTH-118
([W9-PLAN-one-migration-per-wave-sets-the-wave-count](W9-PLAN-one-migration-per-wave-sets-the-wave-count.md)).

## Decision

**W9-PROV-126 takes the transactional-repository-invariant branch. There is no foreign key from
`secrets` to `model_connections`, no `purpose` column, and no migration.**

1. **One transaction per lifecycle operation.** Create writes the connection row and the secret in one
   transaction; a failure on either rolls both back, so neither an untracked credential nor a
   half-applied connection can survive. Rotation replaces the secret inside a transaction that also
   touches the connection row, so a partial rotation is impossible. Delete removes the connection and
   its owned secret together, after reporting the referencing agents, projects and workspace defaults.
2. **Reconciliation instead of a constraint.** A repository query lists secrets named
   `MODEL_CONNECTION_%` with no corresponding connection row, and connections with no secret. This is
   #126's *"migration/reconciliation path for already orphaned or missing model-connection secrets"*,
   and it is what covers the rows that predate the invariant — a foreign key added today would have to
   be added `NOT VALID` and reconciled anyway.
3. **Readiness is derived, not stored.** `hasCredential` plus the provider's required-field set,
   computed on read. That is the only definition that *cannot* be stale, which is what the criterion
   *"accurately reflect persisted state"* asks for. Nothing is persisted, so nothing can disagree with
   the persisted state.
4. **Idempotence is asserted by test, not by a unique index.** Rotating with the same key twice, and
   deleting twice, are covered by tests that assert one secret and one no-op respectively.
5. **Validation ownership is split with W9-PROV-127.** W9-PROV-127 lands the egress policy in W9.1 and
   applies it to every server-side *fetch* — the probe and the gateway adapters. W9-PROV-126 applies
   the same module at *save* time inside `apps/web/server/models/contract.ts` in W9.2. This is #127's
   *"Coordinate validation ownership with #126"*, resolved by giving each task the files it must write:
   #127 owns `apps/web/server/models/probe*.ts`, #126 owns the rest of `apps/web/server/models/**`.

## Consequences

- W9-PROV-126 needs no migration, which is what lets W9.2's slot go to W9-AUTH-118 and keeps the
  identity chain on its shortest schedule. With this and
  [W9-PLAN-project-file-grants-are-read-only-in-wave-9](W9-PLAN-project-file-grants-are-read-only-in-wave-9.md),
  Wave 9 is seven waves; without them, nine.
- The relationship is enforced by application code, not by the database. That is genuinely weaker: a
  future writer who inserts a `MODEL_CONNECTION_*` secret outside the repository gets no error. The
  mitigations are the reconciliation query and the repository being the single write path, and the
  weakness is stated here rather than discovered later.
- No stored `lastValidatedAt` and no stored test result, which is the reason W9-PROV-128 shows a current
  derived status and the result of the test the user just ran rather than a history. That is the Wave 9
  plan's declared gap G-5, owned by both tasks.
- Adding a foreign key later is additive and does not change any row's meaning, because the invariant
  already guarantees the referential property the key would assert.

## Alternatives rejected

**Add a `model_connection_id` foreign key to `secrets`.** The strongest mechanism, and the one to reach
for the day `secrets` gains a second owner kind. Rejected for Wave 9 on two grounds: it costs W9.2's
migration slot for a property the transaction already guarantees, and `secrets` is a general table
whose other rows have no connection, so the column is nullable and the constraint therefore proves
nothing about the rows it does not cover.

**Add a `purpose` column to `secrets`.** Same cost, and it records a *category* rather than an owner, so
it does not make the relationship enforceable — it makes the naming convention slightly more legible.

**Compensating writes instead of a transaction — write the secret, then the connection, then delete the
secret on failure.** The compensation is itself a write that can fail, so the failure mode is not
removed, only made rarer. #126's criterion is that it *cannot* happen.

## Related

- [W9-PLAN-one-migration-per-wave-sets-the-wave-count](W9-PLAN-one-migration-per-wave-sets-the-wave-count.md)
  — why the absence of a migration is load-bearing.
- Issue #127 (W9-PROV-127) — the egress policy this task applies at save time.
- Issue #128 (W9-PROV-128) — the UX half, and the other owner of declared gap G-5.
