# ADR-W9-FILES-131 — A case-only rename is refused unconditionally, on every backend

Status: accepted
Date: 2026-09-11
Decided by: W9-FILES-131 agent
Scope: `apps/web/server/files/handlers.ts`'s `moveSubtree`

## Context

The task card's Rejections list names "case-only renames on case-insensitive stores" as something
this task must refuse. Which stores are case-insensitive is not something `key-safety.ts` or
`object-store.ts` can answer generically (`key-safety.ts`'s own header: "It equally cannot decide
which distinct strings a particular backend's namespace treats as the same name"). A move this
task composes is copy-then-delete: for a case-only rename (`Docs` → `docs`) on a backend whose
underlying namespace folds case (the local-filesystem backend on the default Windows/macOS
configuration this repository already documents as a carried gap in `local-fs-store.ts`), the
"copy" step's destination and the "delete" step's source can resolve to the *same* underlying
file, so deleting the source after copying to the destination can delete the very bytes just
written.

## Decision

`moveSubtree` refuses a rename where the source and destination path are equal case-insensitively
but not equal case-sensitively, with `409 name_conflict`, **unconditionally** — the same refusal on
every backend, regardless of whether that particular backend actually folds case. This is a
conservative, uniform rule rather than a backend-specific probe, for the reason `key-safety.ts`
already gives: nothing in this module can safely determine a given deployment's actual case
sensitivity, and a rule that is only sometimes applied is a rule a verifier will find the gap in.

## Alternatives considered

- **Detect case-folding at runtime** (write a probe file, check whether a case-varied read finds
  it) and only refuse where folding is detected. Rejected: this needs a live filesystem probe on
  every rename, and case-folding a `copyObject` for the S3 backend (which never folds case) would
  then behave differently from the local-filesystem backend for the identical caller-visible
  request, which contradicts the contract suite's own claim that every backend produces the same
  observable result.
- **Allow case-only renames and route them through a copy-then-delete with the copy verified before
  the delete.** Rejected as needless complexity for a case the Simplicity Mandate does not ask this
  task to support at all — the card lists it as a rejection, not a feature to implement correctly.

## Consequences

A caller cannot rename `Notes.txt` to `notes.txt` (or a folder `Docs` to `docs`) through this API,
on any backend, even where the backend in question would have handled it safely (S3). This is
strictly conservative — it never allows an unsafe rename — and is the same trade-off `moveSubtree`
already documents for retry resumability: correctness first, generality only where it costs
nothing to prove.
