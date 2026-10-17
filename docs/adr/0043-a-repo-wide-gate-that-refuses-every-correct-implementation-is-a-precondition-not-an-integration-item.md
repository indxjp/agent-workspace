# ADR-0043 — A repo-wide gate that refuses every correct implementation is a precondition, not an integration item

**Status:** accepted
**Date:** 2026-09-06
**Scope:** programme
**Context:** both sub-wave 2b-2 tracks blocked on one assertion neither could reach

## Context

`tests/route-inventory.test.ts` carried this, introduced as *"a positive assertion that the parse
worked"*:

```ts
expect(routes.size).toBeGreaterThanOrEqual(EXPECTED_ROUTES.length);
```

It compares **§34's fixed printed surface** against **the accumulating union of every task's declared
routes**. `ADR-0026` makes that comparison structurally false: §34's route list is introduced with
*"Examples:"*, and a route §34 does not print ships legally provided it carries a machine-checked
`mandate` naming the spec section that requires it. So the declared surface is *permitted* to exceed
§34's — and the first sub-wave in which two tracks each landed mandated routes is the one where it
did.

Both 2b-2 verifiers reproduced it independently, and both derived the numbers rather than repeating
them: `expected 31 to be greater than or equal to 34` for W2-CP-04's branch, `expected 31 to be
greater than or equal to 35` for W2-CP-05's. W2-CP-05's verifier counted the declarations itself —
`3+5+3+5+5+9+5 = 35`, of which 30 predate the branch — and drew the conclusion that decides this
record: **with §34 printing 31, that branch could have shipped at most one route without tripping the
assertion, so no route surface satisfying its own acceptance criteria could pass.**

The file is outside every 2b-2 task's `Owns` globs, which is
[ADR-0019](0019-repo-wide-gates-belong-to-the-integration-level.md) working as intended. But
ADR-0019 sends it to the integration level, and the integration level runs *after* the tracks are
green — and the tracks cannot become green. That is a deadlock, and it is a different animal from the
union failures ADR-0019 was written for.

## Decision

**A repo-wide gate that refuses every correct implementation of a task already in flight is a
precondition of the sub-wave, and the orchestrator owns it. It is fixed on `main` before the repair
round, not at integration.**

The distinguishing test is not *"is this file repo-wide?"* — it is:

> Can any implementation meeting the task's stated acceptance criteria pass this gate?

If yes, a red gate is the task's problem and ADR-0019 applies unchanged: the union is where it gets
resolved. If no, the gate is refusing the plan rather than the code, and no amount of work inside the
`Owns` globs can clear it.

`tests/no-route-answers-503.test.ts` is the contrasting case in the same sub-wave and stays with the
integrator: it is red because the 2b-2 routes answer `503` until `W2-INT-02` installs their runtimes,
which is the correct intermediate state under
[ADR-0038](0038-the-composition-root-and-the-shared-manifest-belong-to-the-integration-level.md).
That gate clears at integration by construction. This ADR extends `W2-INT-02`'s `Owns` cell to name
it, so the file has an owner rather than being discovered again.

## The replacement assertion

The bound is deleted, not weakened. What replaces it is an assertion about the thing the comment
claimed to be about — **the parser** — decided by a **second and looser reading of the same text**:

`unparsedRequestLines()` re-reads §34's fenced blocks with a recognizer that accepts any
three-to-seven-letter word followed by a token, and asserts that every line it finds was turned into
a route by `parseSpecRoutes()`, which accepts exactly seven method tokens. A `TRACE`, a lowercase
`get`, or a method the spec gains later is caught by one reading and dropped by the other, and the
disagreement is the finding. The two readings agree exactly over §34 as it stands, so an empty result
is the parser reading every request line the section prints rather than the recognizer failing to
look.

Watched failing before being trusted, per [ADR-0029](0029-a-narrowing-is-a-defect-only-when-a-counter-example-exists.md)
— `TRACE  /api/agents/:id/echo` inserted into §34's fenced block, `docs/spec.md` restored after:

```
 FAIL  |tests| route-inventory.test.ts > … > reads spec §34 and finds the routes it prints
AssertionError: lines in §34's fenced blocks that look like request lines and yielded no route:
  expected [ 'TRACE  /api/agents/:id/echo' ] to deeply equal []
```

Every other assertion in that file — `mandateFaults`, the shape rule, the
landed/declared/served equality, the derived declaration-file inventory — was green on both branches
and is untouched.

## Consequences

* Both 2b-2 tracks can now reach green, and their repair rounds are about their own findings rather
  than about a gate they cannot open.
* The gate now fails on a parser regression, which is what its comment always said it did, and no
  longer fails on the repository legitimately growing.
* **The general risk this closes is a gate that encodes an invariant a later ADR repealed.** ADR-0026
  made §34 a shape rule; this assertion still read it as a closed world, and nothing connected the
  two. A gate contradicting a live ADR is a defect in the gate, and finding it took two independent
  verifiers on two branches reproducing the same arithmetic.
* The cost is that the orchestrator now writes product code in a narrow case. That is bounded by the
  test above: only when no correct implementation could pass, and only for a file no task in flight
  can reach.
