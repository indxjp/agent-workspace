# ADR-W9-AUTH-117-ownership-resolver-and-404-before-decide — reading the row before `decide()`, without breaking every other caller of `authorise()`

Status: accepted
Date: 2026-09-11
Decided by: W9-AUTH-117
Scope: `apps/web/server/rbac/http.ts`, `apps/web/server/resources/{authorise,item-ownership}.ts`, `apps/web/server/agents/http.ts`, item routes under `apps/web/app/api/{agents,files,skills}/**`

## Context

The card: *"Item handlers load the row within the caller's workspace first, return an
indistinguishable `404` when it is absent or in another tenant, and only then call `decide()` with
`own`, `other` or `permitted`."* But `apps/web/server/rbac/http.ts`'s `authorise(request, ownership,
run)` calls `decide()` **before** invoking `run` — the handler that would read the row runs only
*after* a verdict is already reached, and the `ownership` argument is a plain value fixed at the
call site, not something a handler can compute from a row it has not been allowed to read yet.

`authorise` is called by five other things this task does not own (`shares`, `sharing-policies`,
`projects`), all passing a plain `Ownership` literal. Changing its signature to always demand a
resolver would be a breaking change to every one of them, for a facility only four resources need.

## Decision

`authorise`'s `ownership` parameter becomes a union: a plain `Ownership`, unchanged, or a new
`OwnershipResolver` — `(principal, directory) => Promise<OwnershipOutcome>`, where
`OwnershipOutcome` is `{ kind: 'ownership'; ownership: Ownership }` or
`{ kind: 'refuse'; result: ApiResult }`. `typeof ownership === 'function'` tells the two apart
unambiguously (an `Ownership` is always a string literal). Inside `authorise`, the resolver runs
**after** `identify()` establishes the caller and **before** `decide()` is called at all: a
`'refuse'` outcome returns its `result` directly, bypassing `decide()` entirely, which is what
makes the 404 indistinguishable rather than a `403` that would assert a rule was measured against
a row that does not exist in this tenant.

`requireResourceAccess` (the wrapper `shares`/`projects`/etc. already call) is widened the same
way — additively, so every existing call site with a plain literal is untouched. A new module,
`apps/web/server/resources/item-ownership.ts`, exports `resolverForRow(load, notFound)`: given a
row loader already scoped to the caller's workspace (the stores this task's four resources hand
out are workspace-bound by construction) and the route's own 404 builder, it returns exactly the
resolver `authorise` now accepts, comparing the loaded row's `created_by` against
`resolveActorUserId`'s answer for the verified caller.

Agents' `withAuthorisedWorkspaceStore` needed one more shape: its `ownership` parameter can now
also be `(store) => OwnershipResolver` — a factory, told apart from a plain `Ownership` the same
way (`typeof … === 'function'`) — because agents resolves its workspace-scoped store *before*
`authorise` runs (`withWorkspaceStore`'s existing order), so the row-loading resolver needs that
store closed over it rather than reached fresh.

## Alternatives considered

- **Run `decide()` twice**: once cheaply with `'unknown'` to gate broad refusals, then again after
  loading the row. Rejected: `decide()`'s own header states it is never called for a caller's
  benefit and never throws; calling it twice per request for four resources buys nothing a single
  correctly-ordered call does not, and risks the two calls disagreeing if the row changes between
  them (a race this task would then have to reason about for no benefit).
- **Give every existing `authorise` caller a resolver too**, for symmetry. Rejected: none of
  `shares`, `sharing-policies` or `projects` are in this task's `Owns` globs, and none of their
  existing tests were written against a resolver-shaped second argument — forcing the change would
  be an undeclared touch to files this task does not own, for a capability their own tasks did not
  ask for.
- **A resource-specific `getRow`-then-`decide` helper per route**, duplicated four times. Rejected
  in favour of `resolverForRow` because the comparison itself (`actorUserId === row.createdBy`) is
  identical for every one of agents/files/skills, and duplicating it four times is exactly the kind
  of divergence a shared helper exists to prevent.

## Consequences

- `agentNotFound`, and the files/skills routes' own 404 builders, had to become the resolver's
  `notFound` argument rather than something only the post-`decide()` handler produces — a small,
  mechanical export change (`export function agentNotFound()`), not a behavioural one: the same
  body and status code are returned, just from one call site earlier when ownership cannot be
  established at all.
- Files' `GET`/`DELETE`/`PATCH /api/files/:id` now read the path segment (`readIdParam` +
  `requireFilePath`) **before** calling `requireResourceAccess`, reversed from their previous
  order. This is a minor, deliberate behavioural change: a malformed id now answers its `400`
  before authentication runs, rather than after — decoding a caller-supplied id string discloses
  nothing about workspace data, and the alternative (auth-first) has no way to hand the decoded
  path to a resolver that must exist *before* `authorise` is called. `apps/web/app/api/agents/[id]/
  route.ts` already reads its id before calling `withAuthorisedWorkspaceStore`, for the same
  structural reason; this makes files consistent with it.
- `resolverForRow`'s `load` must be given an already-validated key (agents: `isUuid(id)` guards the
  `store.get` call) — a resolver that handed a non-UUID string to a `uuid` column would reach
  PostgreSQL as an invalid literal and throw instead of answering "not found," which this task
  guards explicitly rather than leaving to the database driver's own error shape.
