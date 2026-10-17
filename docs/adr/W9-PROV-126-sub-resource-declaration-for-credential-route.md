# W9-PROV-126 — The new rotation route's sub-resource classification is declared, not written into `permissions.ts`

Status: accepted
Date: 2026-09-11
Decided by: W9-PROV-126 (implementer)
Scope: `apps/web/server/rbac/declarations/W9-PROV-126.ts` (new),
`apps/web/server/rbac/declared-sub-resources.ts` (two-line addition)

## Context

`authorisation-matrix.test.ts` fails closed on any route whose `<sub>` segment
`permissions.ts`'s `SUB_RESOURCES` does not classify (ADR-0015): the new
`POST /api/model-connections/:id/credential` route introduces `credential` as a sub-resource of
`model-connections`, and an unclassified sub-resource is refused for every role, which turned red
both the `self-test · build · typecheck · lint · test+db · ownership · licences` job and
`Critical-package coverage floors` once the route was declared in
`tests/route-declarations/W9-PROV-126.ts`.

`apps/web/server/rbac/permissions.ts` is this wave's shared file, assigned to **W9-AUTH-118** for
W9.2 (per the Wave 9 plan's "Shared files, assigned per wave" table) — not to this task, and
editing it would be exactly the four-tracks-editing-one-file collision
[ADR-0038](0038-the-composition-root-and-the-shared-manifest-belong-to-the-integration-level.md)
and [ADR-0040](0040-sub-resource-classification-is-partitioned-by-the-task-that-ships-the-routes.md)
already exist to prevent.

ADR-0040 built exactly the mechanism this situation calls for:
`apps/web/server/rbac/declarations/<TASK-ID>.ts` lets a task classify its own route's `<sub>`
segment under a resource `permissions.ts` already classifies, without touching that file — the same
shape `tests/route-declarations/<TASK-ID>.ts` gives the route inventory. `W4-CP-08.ts` already uses
it for this exact resource (`test` under `model-connections`).

## Decision

**Add `apps/web/server/rbac/declarations/W9-PROV-126.ts`, classifying `credential` under
`model-connections`** — the same relationship `W4-CP-08.ts` already established for `test` under
the same resource: a write-only operation on one saved provider connection, not a resource of its
own, so it inherits `model-connections`'s existing §21 grants rather than being granted anything
new.

**Add the two lines `declared-sub-resources.ts`'s own header says are required of any new
declaration file**: the import and its spread into `DECLARED_SUB_RESOURCES`. This file is not named
in the wave's shared-files table at all — unlike `permissions.ts`, it carries no §21 policy of its
own, only the mechanical union of declarations, and its own module doc states plainly that "somebody
added a declaration file and did not import it here" is the exact failure mode it exists to close.
Leaving it unedited would leave the new declaration file dead code and the route still refused.

Both files are declared here as touched outside this task's `Owns:` globs, with this reason, per
`docs/adr/0018-the-declared-owns-line-is-the-ownership-boundary.md`'s precedent. Neither intersects
a sibling's Wave 9 work: `apps/web/server/rbac/declarations/W9-PROV-126.ts` is a new file no other
task can write to by construction (`declarationOwner`'s naming rule ties a declaration file to its
own task id), and the two-line addition to `declared-sub-resources.ts` adds text rather than
changing any line a sibling wrote — W9-AUTH-118 has not opened a PR as of this writing
(`gh pr list` finds none for issue #118), so there is nothing of its to collide with.

## Alternatives considered

- **Edit `permissions.ts` directly.** Rejected outright: it is explicitly assigned to W9-AUTH-118
  this wave, and this is precisely the collision ADR-0040 exists to make unnecessary.
- **Give `credential` its own top-level resource instead of classifying it under
  `model-connections`.** Rejected: `RESOURCES` in `permissions.ts` is itself §21's table and adding
  a new entry has the same ownership problem as editing `SUB_RESOURCES`, for no behavioural gain —
  §21 gives no separate grant to "who may rotate a provider credential" distinct from "who may
  manage the connection it belongs to".
- **Leave the route undeclared in `tests/route-declarations/W9-PROV-126.ts`.** Rejected: the route
  would then be undetected by the route inventory and unaccounted for by the authorisation matrix
  entirely, which is a worse and more silent gap than a correctly declared sub-resource.

## Consequences

- `decide()`'s behaviour for `POST /api/model-connections/:id/credential` is exactly
  `model-connections`'s existing per-role grants — no new capability was introduced, only a name for
  an existing one.
- If W9-AUTH-118's work on `permissions.ts` ever needs to reconcile the partitioned declarations back
  into the base table, this is one more line among the five already there, in the same shape.
