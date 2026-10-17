# ADR-0040 — Sub-resource classification is partitioned by the task that ships the routes, the way the route inventory already is

Status: accepted
Date: 2026-09-05
Decided by: W2-INT-01, closing the sub-wave 2b-1 union failure
Scope: `apps/web/server/rbac/permissions.ts`, `apps/web/server/rbac/declared-sub-resources.ts`,
`apps/web/server/rbac/declarations/**`; the shape of every future track that ships a route under
`/api/<resource>/:id/<sub>`

## Context

Sub-wave 2b-1 ran four backend tracks in parallel with pairwise-disjoint `Owns` globs. Every one of
them was green alone. On the union, `apps/web/server/rbac/authorisation-matrix.test.ts` failed with
64 undecided cells. Derived, not estimated (ADR-0016):

```text
$ npx vitest run apps/web/server/rbac/authorisation-matrix.test.ts
 × decides every cell — a route §21’s split cannot classify fails, it is not skipped
     expected [ …(64) ] to deeply equal []
 × gives Owner every declared route — §21: "Everything."
     expected [ …(16) ] to deeply equal []
 × would have caught an unclassified resource among the real declarations
     expected [ …(64) ] to deeply equal []
```

The 64 is `4 routes × 4 roles × 4 ownership answers`, and the four routes were W2-CP-07's:

```text
GET    /api/sessions/:claudeSessionId/transcript
POST   /api/sessions/:claudeSessionId/transcript
DELETE /api/sessions/:claudeSessionId/transcript
GET    /api/sessions/:claudeSessionId/subkeys
```

`permissions.ts`'s `SUB_RESOURCES` classified `messages` under `sessions` and nothing else, so
`decide()` returned `refuse` for every cell of all four — which is exactly what
[ADR-0015](0015-gates-decide-on-positive-assertions.md) and
[ADR-0031](0031-a-static-gate-cannot-be-complete-so-undecidable-must-mean-refused.md) require of an authorisation question nobody
has answered. **The gate was working.** W2-CP-06's own header says why that `else` exists: round 1
of its verification looked up only the resource segment, and a planted
`GET /api/agents/:id/secrets` was allowed to all four roles including Viewer.

Each track was green alone precisely because neither could see the other: W2-CP-06's matrix reads
the route declarations that exist when it runs, and W2-CP-07's four routes did not exist on
W2-CP-06's base. This is [ADR-0019](0019-repo-wide-gates-belong-to-the-integration-level.md)'s case
in its purest form — a repository-wide gate whose inputs come from every track at once.

The obvious fix is one line in `permissions.ts`. It is also the wrong one, and for the reason
[ADR-0038](0038-the-composition-root-and-the-shared-manifest-belong-to-the-integration-level.md)
was written a day earlier, one layer up: `permissions.ts` is inside W2-CP-06's `Owns` glob, and a
file four parallel tracks must each edit to ship their own routes is the file ADR-0038 calls a
defective dispatch. W2-CP-07 could not have added the line; nor could W2-CP-03 or W2-CP-02 have
added theirs, had their routes needed one.

## Decision

**A task that ships a route under `/api/<resource>/:id/<sub>` whose `<sub>` spec §34 does not print
declares that sub segment itself, in `apps/web/server/rbac/declarations/<TASK-ID>.ts`, citing the
reading of §21 that puts it inside its parent — and `permissions.ts` composes the union.**

This is [ADR-0025](0025-the-route-inventory-is-partitioned-by-owner.md) applied one layer up. That
record split a hand-maintained `EXPECTED_ROUTES` array into one file per owning task for exactly
this reason: six parallel tracks each declaring their own routes, and a gate that enumerated its
own inputs by hand would be red on every branch with no branch able to turn it green. The same
argument holds for the classification of those routes.

Concretely:

1. `permissions.ts` keeps `SPEC_34_SUB_RESOURCES` — the sub segments **spec §34 itself prints**,
   read out of the specification by W2-CP-06 — and stays W2-CP-06's file and W2-CP-06's reading
   of §21.
2. `apps/web/server/rbac/declarations/<TASK-ID>.ts` holds one task's declarations, as data:
   `{ owner, resource, sub, because }`. The `owner` must equal the file's own name stem.
3. `apps/web/server/rbac/declared-sub-resources.ts` composes the union through **written-out static
   imports**, because `decide()` runs inside a Next.js server bundle and a directory read at run
   time is not available to it — and because `tests/no-sdk-import.test.ts` refuses a module
   reference whose argument is not a string literal.
4. `apps/web/server/rbac/declared-sub-resources.test.ts` closes the one failure mode a written-out
   import list has: it derives the file set from
   `git ls-files -- apps/web/server/rbac/declarations`, reads each file's entries as text through
   `tests/inventory-support.ts` — the same reader the route inventory uses — and fails if the union
   the module composed is not exactly that set. **An unimported declaration file is a hard failure
   naming it, never a quietly smaller union.**

### What a declaration may not do

A declaration says *"this sub segment is part of its parent resource"* and nothing else. It cannot
add a resource, cannot change a grant, and cannot make anything skip:

- **The grants stay the parent's.** They come from `POLICY`, which is §21's split and stays
  W2-CP-06's. The most a wrong declaration can do is attach a route to the wrong parent — a
  reviewable claim, written in one place, with the sentence of §21 beside it.
- **An unclassified *resource* still fails.** Adding one means writing four roles' grants over it,
  which is a reading of §21, and it belongs with §21's table. There is no file under
  `declarations/` a task could put it in, and `decide()` goes on refusing it.
- **A duplicate throws.** Two tasks classifying the same `(resource, sub)` pair — or a task
  restating one §34 already prints — is refused at composition rather than de-duplicated. Two
  tasks having made the same decision separately is the state the partition exists to make
  impossible, and silently merging them would keep the program running and lose the fact. The
  condition is static, so it cannot fire in production without having fired in `pnpm build` and
  `pnpm test` on the same commit first.

## Consequences

- W2-CP-07's four routes are decided, by W2-CP-07's own reading of §21 written in W2-CP-07's own
  file, and `permissions.ts`'s §21 judgements are untouched. The diff to W2-CP-06's file is the
  rename of one constant, one call, and a header paragraph.
- A future track adding routes under an already-classified resource cannot redden a sibling's
  authorisation gate, which is the property sub-wave 2b-1 did not have.
- `apps/web/server/rbac/declarations/<TASK-ID>.ts` is now a file a track owns by construction —
  disjoint from its siblings the way `docs/adr/<TASK-ID>-*.md` and
  `tests/route-declarations/<TASK-ID>.ts` already are — and the Wave 2 plan says so beside
  those two.
- The classification the four routes received is recorded where the routes are:
  `apps/web/server/rbac/declarations/W2-CP-07.ts` quotes §21's Viewer *"view their own sessions"*
  and Builder *"share own … sessions"* clauses and §20's `SessionStore`, and applies
  `permissions.ts`'s own reading of `runs: ['events']` — *"they are the contents of the run, so
  reading them is reading the run."*
- What the gate cannot decide, stated rather than implied (ADR-0031): it cannot check that a
  declaration's `because` is a **true** reading of §21. No mechanical test can. What it enforces is
  that a classification never arrives without one, so a reviewer always has a sentence to disagree
  with.

## Alternatives rejected

**Add the two entries to `permissions.ts` and move on.** It closes this instance and leaves the
mechanism that produced it: the next track that ships a sub-resource is blocked on a file it does
not own, and the integrator edits `permissions.ts` again. ADR-0038 rejected exactly this shape for
`instrumentation.ts` on the same day.

**Let each track edit `permissions.ts` and resolve at merge.** Four tracks editing one table is
ADR-0038's "four tracks editing one composition root in a different costume". `SUB_RESOURCES` is a
single JSON-shaped object literal; four concurrent additions to it conflict textually and are
merged by whoever is least likely to notice a dropped one.

**Make an unclassified sub-resource inherit its parent's grants.** This is what round 1 of
W2-CP-06's own verification did, and the verifier broke it in one commit: `GET
/api/agents/:id/secrets` was allowed to every role including Viewer, while `/api/secrets` denies it
to everyone but the Owner. It is the exact fail-open ADR-0015 exists to refuse.

**Read the declarations directory at run time instead of importing it.** Not available: `decide()`
runs in a bundled Next.js server, and `tests/no-sdk-import.test.ts` reports any module reference it
cannot resolve to a string literal as a hard failure — the objection
`tests/inventory-support.ts`'s header records at length. The written-out import list plus a gate
that proves it complete is the shape that survives both.

## Related

- [ADR-0025](0025-the-route-inventory-is-partitioned-by-owner.md) — the same move, one layer down;
  this record is that argument applied to the classification rather than to the inventory.
- [ADR-0038](0038-the-composition-root-and-the-shared-manifest-belong-to-the-integration-level.md)
  — a file every sibling must edit belongs to the level above; here the answer is to make it a file
  they need not edit at all.
- [ADR-0019](0019-repo-wide-gates-belong-to-the-integration-level.md) — why the gate on the
  partition is W2-INT-01's and not W2-CP-06's.
- [ADR-0015](0015-gates-decide-on-positive-assertions.md),
  [ADR-0031](0031-a-static-gate-cannot-be-complete-so-undecidable-must-mean-refused.md) — the refusal this record is careful to
  preserve.
- [ADR-0027](0027-a-partition-that-lists-its-members-has-not-been-partitioned.md) — the double derivation the completeness gate
  uses, and why the wider pathspec matters.
