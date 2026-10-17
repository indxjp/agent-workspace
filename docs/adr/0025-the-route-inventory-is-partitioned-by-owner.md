# ADR-0025 — The route inventory's expected set is partitioned by owner, so six parallel tracks can each ship routes

Status: accepted
Date: 2026-09-04
Decided by: orchestrator
Scope: `tests/route-inventory.test.ts`, `tests/route-declarations/**`; extends ADR-0019

## Context

[ADR-0019](0019-repo-wide-gates-belong-to-the-integration-level.md) moved the route-inventory gate
to the integration level, because a closed-world assertion over the whole tree cannot be written by
an owner of one glob. That fixed Wave 1a, where the gate's *implementation* was the contested file.

Wave 2 contests its **data**. `EXPECTED_ROUTES` is a single array literal in a single file, and each
entry already names the task that owns it:

```ts
{ method: 'POST', path: '/api/agents', owner: 'W1-CP-05', landed: true },
```

Sub-wave 2b runs six tracks in parallel and five of them ship API routes — secrets, files, skills,
connectors, users and API keys. Under ADR-0019 as written, none of them may edit the gate, so either

* the routes land undeclared and every one of the six fails CI against a gate that is working
  correctly, or
* all six edit one array, which is a guaranteed conflict at the integration branch and a
  guaranteed union failure before it.

Neither is a defect in the gate. The gate is right. The **list is a shared mutable resource in a
wave designed around not having any** — the same shape as the ADR filename collision that
[ADR-0003](0003-adr-naming-preserves-file-ownership.md) solved by making the name task-scoped.

## Decision

1. **Split `EXPECTED_ROUTES` into one declaration file per owning task**, at
   `tests/route-declarations/<TASK-ID>.ts`, each exporting the routes that task ships. A task's
   declaration file falls inside its own `Owns` glob by construction, exactly as its ADRs do.
2. **The gate reads the union of the tracked declaration files** — enumerated with `git ls-files`,
   the tracked-tree rule this file already uses — and keeps all three of its assertions unchanged:
   the union equals the shipped surface, the union is a subset of spec §34, and nothing ships that
   §34 does not name. The gate is not weakened; only the list is repartitioned.
3. **Two positive assertions guard the partition itself**, because a partitioned list has two new
   ways to fail open and both must fail closed:
   * a declaration file that exports nothing readable is a **hard failure**, not an empty
     contribution — an unreadable declaration is not an absence of routes
     ([ADR-0015](0015-gates-decide-on-positive-assertions.md));
   * two files declaring the same `method`+`path` is a **hard failure** naming both owners, because
     duplicate ownership is the condition this split exists to make impossible, and a set union
     would silently swallow it.
4. **The split is done by `W2-INT-00` in sub-wave 2a**, before any 2b track exists, and it converts
   the existing W1-CP-04 and W1-CP-05 entries as its own proof. A partition scheme first exercised
   by the tasks it was built for has been tested by nobody.

## Alternatives considered

* **Let 2b tracks append to the array and resolve conflicts at integration.** Rejected: this is
  precisely the union failure ADR-0019 was written about, re-entered voluntarily.
* **Derive the expected set from the tracked tree.** That deletes the gate. Its entire value is that
  the two sets are produced independently and compared; deriving one from the other makes it
  tautological, and the undeclared `route.jsx` a verifier planted in Wave 1a would have passed.
* **Have the integrator declare all six tracks' routes.** Rejected: the integrator would be
  declaring a surface it did not build, and each track's CI would be red until the very last branch —
  so no track would ever be green on its own, which is the property the stack is for.

## Consequences

* One more file per route-shipping task, and a reader who wants the whole surface runs the gate
  rather than reading one array. The gate prints the union on failure, so the loss is small.
* `tests/route-inventory.test.ts` becomes an integration-owned file that no wave task edits again —
  the partition means it no longer needs to be edited to add a route.
* The screen-inventory test plan §9.1 requires for Wave 2's UI has the same shape and gets the same
  treatment: `tests/screen-declarations/<TASK-ID>.ts`, built by the same task.
