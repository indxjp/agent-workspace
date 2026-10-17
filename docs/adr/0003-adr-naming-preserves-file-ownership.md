# ADR-0003 — ADR filenames are task-scoped, not globally numbered

Status: accepted
Date: 2026-09-03
Decided by: orchestrator
Scope: whole programme

## Context

Standard ADR practice allocates a global sequence number per record. Plan §2.3 buys all of this
programme's concurrency with **disjoint file ownership**, checked mechanically before a wave
launches. A globally-allocated number is a shared resource: two agents in the same parallel level
would both reach for the next integer, making `docs/adr/` exactly the shared file §2.3 names as
"the classic offender" alongside `package.json`.

## Decision

Two classes of record, distinguished by filename:

- `docs/adr/NNNN-<slug>.md` — programme-level. Written **only** by the orchestrator, serially.
- `docs/adr/<TASK-ID>-<slug>.md` — task-level, e.g. `W1-RN-01-sdk-event-normalisation.md`.

A task id belongs to exactly one agent, so `docs/adr/<TASK-ID>-*` sits inside that agent's `Owns:`
globs by construction. Every task card gains that glob implicitly. `docs/adr/README.md` is owned by
the wave integrator alone.

## Alternatives considered

- **Global numbers with a reservation step.** Rejected: it serialises the one thing the plan
  parallelises, to buy a filename convention.
- **One ADR file per wave, appended to.** Rejected: concurrent appends to one file is the same
  collision plus merge conflicts, and it makes an individual decision unlinkable.
- **ADRs outside the repository.** Rejected: a decision log that does not travel with the code it
  explains stops being read.

## Consequences

- `ls docs/adr/` does not read as a chronology. The README index and each record's Date field carry
  the ordering instead.
- Task-level ADRs inherit their task's fate. A decision that outlives its task must be promoted to a
  programme-level record by the orchestrator at wave close, or it is silently lost.
