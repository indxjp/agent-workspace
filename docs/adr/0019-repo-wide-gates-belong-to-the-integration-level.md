# ADR-0019 — A gate that asserts over the whole repository cannot be owned by a task that owns one glob

Status: accepted
Date: 2026-09-03
Decided by: orchestrator, from the W1a integration's finding 1
Scope: whole programme — every repository-wide invariant test

## Context

Wave 1a's five tracks each passed alone and each was CI-green at its own tip. Merged, seven tests
failed. No file was claimed twice; §2.3 disjointness held exactly as designed. The integration agent
diagnosed it correctly and refused to patch it:

| Gate | Owner | Fails on files owned by |
| --- | --- | --- |
| `tests/route-inventory.test.ts` | W1-CP-05 | W1-CP-04's `api/runs/**`, `api/agents/[id]/runs` |
| `apps/web/server/runs/routes.test.ts` | W1-CP-04 | W1-CP-05's `api/agents/route.ts`, `[id]/route.ts` |
| `tests/no-sdk-import.test.ts` | W1-RN-01 | W1-CP-04's acceptance scripts, W1-CP-05's test file |

Every one of these gates is **correct**. Each asserts a closed world — *these are all the routes*,
*nothing else imports the SDK* — and each fails closed, exactly as [ADR-0015](0015-gates-decide-on-positive-assertions.md)
requires. That is why they broke: a closed-world assertion is only true of the *whole* tree, and each
was written by an author who could see, and own, one glob of it.

A sixth defect has the same shape. `tests/route-inventory.test.ts` plants
`api/agents/inventory-probe-*/route.jsx` mid-test while `tests/auth.test.ts` walks `apps/web/app/api`
to build its probe matrix — same Vitest project, parallel workers. Proved deterministically in both
directions; the second direction is a *spurious failure* currently masked by the seven above and
unmasked the moment they are fixed.

So this is not three authors being careless. It is a category error in the task decomposition: the
plan assigned repository-wide invariants to task-scoped owners.

## Decision

**A test that asserts a property of the whole repository is owned at the integration level, not by a
feature task.**

1. Repository-wide invariant gates — the §34 route inventory, the §42 no-SDK-import rule, the §9.1
   spec-inventory checks, the §41 and A.12 matrices when they arrive — belong to a dedicated
   **invariants task** in each wave's integration stack, above every feature branch. There it can see
   the tree it is asserting over.
2. A feature task may still write tests over **its own** files. What it may not do is assert
   completeness over files it cannot see.
3. When a feature task needs an invariant extended (a new route, a new permitted importer), it
   **declares that in its PR body**, and the invariants task consumes those declarations. The
   declaration is the interface between the two.
4. Any test that plants or removes files under a shared tree must isolate itself — a unique
   directory per run, or `describe.sequential` — because a sibling test may be walking that tree in
   a parallel worker. This is not optional even inside one owner's files.

## Alternatives considered

- **Route each failure back to its owner** (the integration agent's own recommendation, and correct
  under plan §8.7 as things stood). Rejected as the *general* answer: it fixes seven symptoms and
  leaves the category error, so Wave 2 — which adds far more routes, tables and permitted importers
  than Wave 1 — reproduces it at larger scale. The seven are still fixed; they are fixed *in the
  right place*.
- **Make each gate ignore files outside its owner's globs.** Rejected outright: a closed-world gate
  that only checks part of the world is the fail-open pattern ADR-0015 exists to stop. The
  route-inventory gate's entire purpose is catching the route nobody declared.
- **Run the gates only in the integration job, not per-PR.** Rejected: a feature PR would go green
  and break the union, which is precisely the failure being fixed, only later and with more branches
  stacked on it.

## Consequences

- Feature-task PRs no longer prove the repository-wide invariants; only the integration branch does.
  A task can be green and still break the union. That is now *stated* rather than assumed, and it is
  what the integration branch is for — but it means a wave is not verified until it is integrated.
- The invariants task becomes a serialisation point at the top of every wave. It is small, and it is
  cheaper than the restack that routing these fixes downward would cost.
- Plan §6's task cards assign `tests/route-inventory.test.ts` to W1-CP-05 and `tests/no-sdk-import.test.ts`
  to W1-RN-01. Under [ADR-0018](0018-the-declared-owns-line-is-the-ownership-boundary.md) the
  declared line governs, so those files move without a plan amendment; the wave manifest records it.
- The seven failures and the Vitest race are fixed **above** the feature branches, so no branch below
  the integration is rewritten and nothing is restacked. That is a side benefit of putting them where
  they belong, not the reason for doing it.
