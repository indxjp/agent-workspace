# ADR-W9-FILES-131 — `apps/web/server/skills/store.ts` needed a two-line, non-semantic change

Status: accepted
Date: 2026-09-11
Decided by: W9-FILES-131 agent
Scope: `apps/web/server/skills/store.ts` (declared as an extra file on this task's PR `Owns` line,
with this record as the reason)

## Context

This task's card requires adding `listPrefix` and `copyObject` to the shared `ObjectStore`
contract in `packages/core/src/storage/object-store.ts` (in this task's Owns globs), implemented
by every backend. `apps/web/server/files/store.ts` (also in this task's Owns globs) and
`apps/web/server/skills/store.ts` (outside them — `apps/web/server/skills/**` belongs to no
Wave 9.2 task) are two structurally identical wrapper modules, each memoising a scope lookup and
forwarding every `ObjectStore` method to the real backend. Widening the interface's required
member set broke both at typecheck: neither forwarded the two new methods, since neither existed
when they were written.

The Wave 9 plan's W9.2 disjointness section lists `apps/web/server/{auth,rbac}` for
`W9-AUTH-118` and `apps/web/server/models` for `W9-PROV-126` under `apps/web/server/`; `skills` is
named by neither. No Wave 9.2 sibling declares it, so touching it does not collide with either
sibling's declared globs.

## Decision

`apps/web/server/skills/store.ts` is added to this task's PR `Owns` line, with this ADR as the
written reason, and its `forWorkspace` wrapper gets the same two forwarding lines
`apps/web/server/files/store.ts` gets: `listPrefix` and `copyObject`, each a direct pass-through to
the resolved backend `ObjectStore`, matching every other method already there. Nothing about
skills' own behaviour, routes, or tests changes; the file's only defect was that it stopped
type-checking against an interface this task necessarily widened.

## Alternatives considered

- **Leave `ObjectStore`'s new methods optional instead of required**, so a wrapper omitting them
  still satisfies the type. Rejected: the real backends (local filesystem, S3, memory) all
  implement both unconditionally — that is the task's own acceptance criterion — and
  `moveSubtree`/`deleteSubtree` call them unconditionally too. Making the *type* optional to avoid
  touching one unrelated file would weaken the guarantee for every caller that legitimately needs
  it, in exchange for skipping a two-line, purely mechanical edit.
- **Do not fix `skills/store.ts` and let its typecheck fail.** Rejected outright: `pnpm -w
  typecheck` is a required gate, and leaving a broken build to avoid an ownership question is not
  an option the wave protocol offers.

## Consequences

A future reader of `apps/web/server/skills/store.ts`'s git blame will see a W9-FILES-131 commit
touching a file its Owns glob otherwise excludes. This record, and the PR's own `## Ownership`
section, are the explanation. No sibling task in Wave 9.2 declares this file, so no ownership
conflict exists; a later task that does claim `apps/web/server/skills/**` inherits two already
-correct forwarding lines and nothing else to reconcile.
