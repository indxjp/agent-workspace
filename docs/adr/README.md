# Architecture Decision Records

Every decision taken during execution that is **not** already determined by
`docs/spec.md` or the development plan is recorded here. This directory is the
decision log for the whole programme.

## Index

The index is **generated on demand and not committed**:

```sh
pnpm --silent adr:index                  # the table on stdout: id, title, date, scope, status
pnpm --silent adr:index > adr-index.md   # as a file to browse
```

`scripts/docs/adr-index.mjs` lists `docs/adr/*.md` and emits the count and the rows **together**,
so the two cannot disagree by construction — [W0-DOC-01](W0-DOC-01-mechanical-count-derivation.md)'s
rule. It used to be a committed table in this file; every ADR pull request then changed its count
and appended a row at the same place, so any two ADR pull requests in flight conflicted on it.
[ADR-0150](0150-the-adr-index-is-generated-on-demand-not-committed.md) records why it is no longer
committed. **Adding an ADR touches only the new record.**

The index is sorted by filename, which is the order `ls` gives. It is **not** a chronology —
see "Naming" below for why, and read each record's `Date` field for ordering.

Two things the listing shows that a reader would otherwise guess at:

- **`0013` is not in this directory.** The sequence runs `0012`, then `0014`. ADR-0013 is a
  Wave 1 record and is not part of Wave 0's decision log; the gap is deliberate, not a lost file.
- **Five rows share the id `W0-INF-01`.** Task ids are not unique per record — one task may
  take several decisions, and the filename slug is what distinguishes them. The `Id` column is
  the owning task, not a key. The five carry headings numbered `0001`–`0005` from the series
  [ADR-0012](0012-reconciling-two-adr-series.md) renamed them out of; that record renames
  without rewriting, so the old numbers survive inside the files. Read the filename, not the
  heading — the headings collide with unrelated programme records of the same number.

## Why this exists

Execution is autonomous: agents do not stop to ask. Plan §3.5 previously routed an
unresolved question to a blocking Owner decision (§11). That route is closed by
[ADR-0004](0004-autonomous-execution.md). An agent that hits a decision now **takes it,
records it here with its reasoning and its alternatives, and continues**. The ADR is the
audit trail that replaces the conversation that did not happen.

An ADR is therefore not paperwork. It is the only place a reader can find out _why_ the
code looks the way it does, when the spec did not say.

## Naming, and why it is not the usual `NNNN-`

Standard ADR practice numbers records globally (`0001-`, `0002-`, …). That convention
cannot survive this programme's parallelism: plan §2.3 buys concurrency with disjoint file
ownership, and a globally-allocated number is a shared resource — two agents in the same
wave would race for `0007-`.

So records fall into two classes:

| Class           | Filename              | Written by                                                                    |
| --------------- | --------------------- | ----------------------------------------------------------------------------- |
| Programme-level | `NNNN-<slug>.md`      | The orchestrator only, serially. Never by a wave agent.                       |
| Task-level      | `<TASK-ID>-<slug>.md` | The one agent that owns that task, e.g. `W1-RN-01-sdk-event-normalisation.md` |

A task id is unique to exactly one agent, so `docs/adr/W1-RN-01-*.md` is automatically
inside that agent's `Owns:` globs and cannot collide with a sibling's. Adding a record changes
no other file: the index is generated on demand (see "Index" above).

## When an agent MUST write an ADR

- The spec or plan is silent, ambiguous, or self-contradictory and a reading had to be chosen.
- A dependency, library, or wire format was selected where more than one would have worked.
- A capability could not be verified and something had to be declared unverified instead.
- A plan rule was deviated from — including a deviation the Owner authorised.
- A gate, check, or test was scoped, narrowed, or deferred.

## When an agent must NOT write an ADR

- The spec states it. Transcribe it; an ADR restating the spec is noise (plan §39).
- It is a detail local to one file that no future reader would ask "why?" about.

## Template

```markdown
# ADR-<id> — <title>

Status: accepted | superseded by ADR-<id> | reversed
Date: <YYYY-MM-DD>
Decided by: <orchestrator | task id + agent role>
Scope: <what this binds — one wave, one package, the whole programme>

## Context

<The forces. What was actually observed — quote the spec line, the verifier finding, the
probe output. Facts, not narrative.>

## Decision

<What was decided, in the imperative. One paragraph.>

## Alternatives considered

<Each with the reason it lost. An ADR with no rejected alternative is usually a decision
that did not need recording.>

## Consequences

<What this costs, what it forecloses, and what must change if it is reversed. Be honest
about the downside — that is the half a future reader needs.>
```
