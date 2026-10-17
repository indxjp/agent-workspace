# W1-INT-02 — Two route files gain a runtime declaration, because the alternative was to weaken the rule

Status: accepted
Date: 2026-09-03
Decided by: W1-INT-02 (Wave 1 invariants)
Scope: `apps/web/app/api/agents/route.ts`, `apps/web/app/api/agents/[id]/route.ts`; the route-runtime
invariant in `tests/route-inventory.test.ts`

## Context

`apps/web/server/runs/routes.test.ts`, W1-CP-04's file, carried this over **every** route under
`apps/web/app/api`:

```ts
it('runs every route on the Node runtime and never prerenders one', () => {
  for (const route of routes) {
    expect(source, route.path).toContain("export const runtime = 'nodejs'");
    expect(source, route.path).toContain("export const dynamic = 'force-dynamic'");
  }
});
```

On the Wave 1a union it failed, on `apps/web/app/api/agents/[id]/route.ts` — one of W1-CP-05's two
agent route files, neither of which declares either export. [ADR-0019](0019-repo-wide-gates-belong-to-the-integration-level.md)
moves the assertion to `tests/route-inventory.test.ts`, where the whole tree is visible. That relocates
the gate; it does not answer the failure, because the failure is real. Two of the five route handlers
this repository ships do not say what runtime they run on.

W1a's manifest recommended narrowing the assertion to W1-CP-04's subtree. ADR-0019 rejects that as the
general answer, and it is the wrong answer here specifically: an invariant that skips the two files
that violate it is not an invariant.

## Decision

**The two agent route files gain `export const dynamic = 'force-dynamic'` and
`export const runtime = 'nodejs'`, and the invariant keeps its full reach.**

The declarations are correct on their own merits, not only because a gate wants them. Every handler
in both files goes through `withWorkspaceStore`, which calls the injected runtime's
`resolveWorkspace(request)` and answers `401`, `403` or a workspace-scoped store depending on what
that request carries. A response that is a function of the request must not be prerendered, and
`force-dynamic` states that rather than leaving it to be inferred. `'edge'` is deprecated
and cannot hold a long-lived stream (R-13), and a route file that says nothing is a route file whose
runtime is whatever a later default makes it.

`apps/web/app/api/agents/route.ts` and `apps/web/app/api/agents/[id]/route.ts` are declared in
W1-INT-02's `Owns` line with this reason, under
[ADR-0018](0018-the-declared-owns-line-is-the-ownership-boundary.md). Their author W1-CP-05 is frozen
several branches below and its PR is open against a base this branch sits above, so there is no
sibling this claim can collide with — the §2.3 disjointness condition holds. This is the same move
ADR-0019 already makes for `tests/route-inventory.test.ts` and `tests/no-sdk-import.test.ts`: the
repair lands **above** the feature branches so that nothing below is rewritten and nothing is
restacked.

## Alternatives considered

- **Narrow the assertion to the routes that satisfy it**, whether by subtree or by listing the two
  files as exceptions. Rejected: that is the fail-open shape, and it would leave two shipped routes
  with no declared runtime while a green gate says every route has one — an artefact asserting a
  behaviour that is not so, which is the defect class this programme keeps finding.
- **Report it as a declared gap and leave the gate red.** Rejected: W1-INT-02's acceptance criterion
  is a suite with zero failures, and more to the point a known-red gate is a gate people learn to
  read past. The change is four lines and its correctness does not depend on the gate.
- **Route the repair back to W1-CP-05.** This is what plan §8.7 would have said, and ADR-0019 is
  precisely the ruling that it is the wrong general answer: it would restack five branches to add two
  declarations that are correct wherever they land.

## Consequences

- **W1-CP-05's two route files differ from the tip of `aw/w1-06-agent-crud`.** Anyone comparing them
  will find these four lines and this record; the commit message and the PR's Ownership section both
  name the file and the reason.
- **The invariant is now asserted over every route handler in the tracked tree**, from a file that can
  see all of them, and it passes — which is a stronger statement than it has ever been able to make,
  since on W1-CP-04's own branch it ranged over three files and on the union it ranged over five and
  failed.
- **A new route file must declare both exports or fail `pnpm test`.** That is a small tax on adding a
  route, paid by a rule that is now uniform.
