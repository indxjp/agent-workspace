# ADR-W9-WS-119-2 — API-key callers are refused on every `/api/workspaces` route

Status: accepted
Date: 2026-09-12
Decided by: W9-WS-119, repair round 1 (verification round 1, finding 1); alternative 3 amended in
repair rounds 2 and 3 (verification round 2, finding 4; round 3, findings 1 and 4)
Scope: `apps/web/server/workspaces/access.ts`, `apps/web/app/api/workspaces/route.ts`,
`apps/web/app/api/workspaces/[id]/route.ts`

## Context

Verification round 1 found that every `/api/workspaces` route resolved the caller's identity with
`apps/web/server/rbac/ownership.ts`'s `resolveActorUserId`/`resolveActorUserIdForWorkspace`. That
function's documented purpose (issue #117) is `created_by` STAMPING: `resolveMemberUserId(...) ??
oldestOwnerUserId(memberships)`, where the fallback exists only to give a row an API key creates
the same attribution a pre-existing row's backfill gets — never to authorise a request.

`identify()` builds a `Principal` for an API key from an `api_keys` row (`principal.via ===
'api-key'`). Such a principal's `actor` is the key's name, which matches no email in the directory,
so `resolveMemberUserId` always returns `null` for it and the fallback always fires:
`oldestOwnerUserId` of the key's OWN workspace's memberships. Every `/api/workspaces` route then
queried as if the request had been made by that other, real person — across every workspace THAT
PERSON belongs to, not only the key's own:

- `GET /api/workspaces` (list) answered with the oldest Owner's full membership list, including
  workspaces the key has nothing to do with.
- `POST /api/workspaces` (create) created a workspace with that Owner, not the key, as the sole
  Owner.
- `GET`/`PATCH /api/workspaces/:id` used `getForMember(id, oldestOwnerUserId)`, so a Viewer API key
  scoped to workspace A could read and archive/rename ANY workspace that A's oldest Owner belongs
  to, including tenants that key never touched.

Measured against a real PostgreSQL 17 through `register()`: a workspace-A Viewer key listed a
foreign tenant "Delta" it had never seen, archived and renamed workspace A itself (an action only
an Owner may take, spec: "An Owner can rename/update/archive; unauthorized users cannot"), and
renamed/archived Delta too (spec: "Cross-workspace enumeration is prevented"). Both acceptance
criteria failed for exactly the caller type — an API key — issue #119's own ADR
(`W9-WS-119-workspace-resource-authorisation-and-lifecycle.md`) never considered.

## Decision

Every one of the four `/api/workspaces` routes refuses `principal.via === 'api-key'` outright, with
a `403 api_key_not_permitted`, before `resolveActorUserId`/`resolveActorUserIdForWorkspace` is ever
called:

- `apps/web/server/workspaces/access.ts` exports `apiKeyRefusal(principal)`, called first (after
  the `isUuid` format check, which needs no identity) inside both `memberOwnershipResolver` (used
  by `GET /api/workspaces/:id`) and `ownerOwnershipResolver` (used by `PATCH /api/workspaces/:id`).
  Because `authorise()` returns a resolver's `refuse` outcome directly, without calling `decide()`
  or the route's own callback, this also protects `GET /api/workspaces/:id`'s second,
  direct call to `resolveActorUserId` — that code is simply never reached for an API-key caller.
- `apps/web/app/api/workspaces/route.ts`'s `withIdentity` (shared by `GET` and `POST`) calls the
  same `apiKeyRefusal` immediately after `requireResourceAccess` allows, before
  `resolveActorUserIdForWorkspace` runs.

This is the least-privilege reading of §21/§27: an API key is scoped to ONE workspace with a FIXED
role and represents no person, so it has no "current memberships" for `GET /api/workspaces` to
list, no identity to stamp as an Owner for `POST /api/workspaces` to create with, and no basis to
answer "is this caller an Owner of workspace X" that does not borrow a real person's identity. A
`GET /api/workspaces/:id` for the key's own workspace, answering with the key's own role, was
considered and rejected (see Alternatives) — refusal is uniform across all four routes.

## Alternatives considered

- **Let a bearer key read (never write) its own workspace via `GET /api/workspaces/:id`, answering
  with the key's own `role` instead of a membership's.** Rejected for this round: it requires a
  second, key-shaped branch through `getWorkspace`/the ownership resolvers that issue #119's schema
  and handlers were not built to carry (a `WorkspaceMembershipView`'s `role` column is a
  `memberships.role`, and a key's role lives in `api_keys`, not in that table) — introducing it
  would be new surface, not a bug fix, and issue #119 never asked for API keys to read workspace
  metadata. If a future task wants this, it is a new, explicit branch, not a resurrection of the
  `created_by` fallback.
- **Give `resolveActorUserId` an API-key-aware caller that resolves to the key's OWN workspace only,
  narrowing rather than refusing.** Rejected: `/api/workspaces` is inherently cross-workspace
  (`GET/PATCH /api/workspaces/:id` can legitimately name a workspace that is not
  `principal.workspaceId`, per the original ADR's decision 1) — a "narrowed" identity would still
  need a positive answer to "does this key's workspace itself have this role", which is exactly
  `apiKeyRefusal`'s uniform "no" made needlessly stateful.
- **Reuse `resolveActorUserId` but ignore its fallback for these routes specifically (treat
  `resolveMemberUserId(...) === null` as "no identity", full stop).** Rejected in round 1 _as a
  replacement for_ `apiKeyRefusal`, on the reasoning that `resolveMemberUserId` is `null` for an
  API-key `actor` by construction (it matches no email), so a check written in terms of it would be
  restating "is this an API key" indirectly instead of asking `principal.via` directly. **Amended
  in repair round 2 (verification round 2, finding 4) and completed in round 3 (finding 1):** that
  reasoning was wrong about the outcome being identical. An API key is not the only caller for
  which `resolveMemberUserId` is `null`: a SESSION caller whose own membership is removed between
  `identify()` and a route's `listMemberships()` read is `null` too, and `apiKeyRefusal` does
  nothing for them, so with the fallback still in place that request was answered as the
  workspace's oldest Owner. The shipped code therefore does BOTH: `apiKeyRefusal` refuses the
  caller kind that can never have a membership (uniform `403`, before any lookup), and every
  identity resolution under `/api/workspaces` — `resolveMembershipView` in `access.ts`,
  `withIdentity` in `apps/web/app/api/workspaces/route.ts`, and `GET /api/workspaces/:id`'s own
  second read in `apps/web/app/api/workspaces/[id]/route.ts` — goes through
  `apps/web/server/rbac/ownership.ts`'s `resolveSessionActorUserId` /
  `resolveSessionActorUserIdForWorkspace`, which is exactly this alternative's form: the same
  lookup with the fallback removed, `null` meaning "refuse" (a `404 workspace_not_found` on the
  item routes, a `500 authorisation_undecidable` on the collection routes). The "strictly more
  code" cost is real and accepted: two exported resolvers instead of one, and a second read on the
  item `GET` that must refuse on its own rather than trust the resolver's. What it buys is that no
  route ever authorises a request as a person other than the one whose session was verified.
  `apps/web/server/workspaces/access.test.ts` (the resolvers) and
  `apps/web/server/workspaces/vanished-membership.test.ts` (all four routes, membership dropped
  between the reads of one request) are the tests that go red if any site regresses to the
  fallback.

## Consequences

- No API key can list, create, read or administer a `/api/workspaces` resource. A deployment that
  wants a key to manage workspaces must mint the requester a session instead.
- `apps/web/server/workspaces/api-key-refusal.test.ts` proves the four-role × four-route matrix for
  bearer-key principals, plus the foreign-tenant/random-UUID identical-response check with a bearer
  key, so a regression that reintroduces the fallback as an identity source fails a named test.
- The fallback is closed for session callers too, not only refused for keys — see the amended
  third alternative above. `GET /api/workspaces/:id`'s second, direct identity resolution (named
  in the Decision as merely "never reached for an API-key caller") is on the session-only resolver
  since repair round 3; the API-key protection described there is unchanged.
