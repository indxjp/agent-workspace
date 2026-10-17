# ADR-W9-FILES-131 — The subtree operation cap is a fixed, declared constant, not a config knob

Status: accepted
Date: 2026-09-11
Decided by: W9-FILES-131 agent
Scope: `apps/web/server/files/handlers.ts`'s `moveSubtree`/`deleteSubtree`

## Context

The task card's "Deliberately not built" list states: "No large-tree streaming or pagination of
the operation itself; boundedness is asserted by a test with a fixed large tree, and a hard cap
refuses beyond it rather than running unbounded." Neither the card nor issue #131 names a number.
The Simplicity Mandate rules out a configuration surface (an env var, a workspace setting, a
per-call override) for a value nothing in the spec asks to be tunable.

## Decision

`MAX_SUBTREE_OBJECTS = 500`, exported as a constant from `apps/web/server/files/handlers.ts`, used
identically by `moveSubtree` and `deleteSubtree`. A subtree whose `listPrefix` count exceeds it is
refused with `413 subtree_too_large` before any copy or delete is attempted — refused, not
partially applied. The number is chosen for two reasons stated plainly: it is small enough that a
boundedness test can build a tree past it (501 objects) inside a normal test timeout, and it is
comfortably above what a hand-built folder in this product's files feature is expected to hold at
this stage (spec §16 illustrates a handful of files per folder, not thousands).

## Alternatives considered

- **A per-workspace or per-request configurable cap.** Rejected: nothing in the issue or the card
  asks for this to be tunable, and a knob nobody asked for is exactly what the Simplicity Mandate
  rules out.
- **No cap, only a timeout.** Rejected: a slow-but-eventually-successful unbounded loop is still
  the "unbounded operation" the card explicitly disallows; a request that takes an unpredictable
  amount of time and holds partial state throughout is worse than one that fails fast and named.

## Consequences

A legitimate folder with more than 500 files or nested descendants cannot be moved or recursively
deleted through this API in one request; the caller must reduce the subtree's size first (moving a
sub-folder at a time). This is stated as a real limitation, not hidden: it is the same trade the
card's own "Deliberately not built" section already accepts. Raising the cap later, if needed, is
a one-line change with no shape implications for the rest of the design.
