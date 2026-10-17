# W9-SEC-149 — Every write on `/api/model-connections*` reaches `decide()`, called directly rather than through `rbac/http.ts`'s `authorise()`

Status: accepted
Date: 2026-09-12
Decided by: W9-SEC-149 (implementer)
Scope: `apps/web/server/composition/services.ts`, `apps/web/server/models/runtime.ts`,
`apps/web/server/models/http.ts`, `apps/web/app/api/model-connections/**`,
`apps/web/server/models/routes.test.ts`

## Context

Issue #149: every route under `/api/model-connections*` answered by workspace membership alone.
`installModelsApi`'s `resolveActor` (`apps/web/server/composition/services.ts`) read a membership
row that already carried a `role`, then built a `ModelsActorResolution` that discarded it —
`workspaceId`, `userId` and `userLabel` survived the trip, `role` did not. Every route downstream
of `withModelsRuntime` (`apps/web/server/models/http.ts`) then had exactly one question available
to it — "is there a membership at all?" — for both a `GET` and a `DELETE`, on a resource spec §21
grants only Owner and Admin `MANAGE` over. A Builder or a Viewer with a valid session and workspace
membership could `PATCH`, `DELETE`, rotate credentials on, or test-connect any connection in the
workspace.

`apps/web/server/rbac/decide.ts` already answers exactly this question — `(role, method, path,
ownership) → allow | deny | refuse` — against the same `model-connections` grants (`MANAGE` for
Owner/Admin, the `none` fallback for Builder/Viewer) and the sub-resource declarations
`W4-CP-08.ts` (`test`) and `W9-PROV-126.ts` (`credential`) already registered. Nothing about §21's
policy needed to change; what was missing was a call site.

`apps/web/server/rbac/http.ts`'s `authorise()` is the existing call site every other RBAC-gated
route (agents, files, memberships, …) uses, and it was the first thing considered here. It does
three things before it reaches `decide()`: verifies its own session cookie
(`currentRbacRuntime().identify(request)`), builds a `Principal`, and builds a `WorkspaceDirectory`
for ownership resolvers that need to read a row. The models subsystem already has its own,
independent actor resolution — `resolveWorkspace` + `identifyActor`, wired at the composition root
in `apps/web/server/composition/register.ts` (not this task's file) — built for a different
reason (issue #126's credential-rotation audit trail predates this wave's RBAC table) and it
already does the one relevant thing `authorise()` would redo: read the session cookie and resolve
the caller's membership, role included. Routing model-connections writes through `authorise()`
instead would mean either (a) wiring `configureRbacRuntime` into the models composition path too,
duplicating the session-verification `resolveWorkspace`/`identifyActor` already perform, or (b)
editing `apps/web/server/rbac/http.ts` or `apps/web/server/rbac/runtime.ts` to accept an
already-resolved principal — both under `apps/web/server/rbac/**`, which this wave's card is
explicit that W9-SEC-149 does not touch (W9-WS-119 owns that directory this wave).

## Decision

**Carry the role through, and call `decide()` directly from `apps/web/server/models/http.ts`,
importing it read-only.**

1. `ModelsActorResolution`'s `workspace` variant (`apps/web/server/models/runtime.ts`) gains a
   required `role: Role` field (`Role` imported, read-only, from `../rbac/roles`). Required, not
   optional — an actor resolution that could omit it would let a future call site fall back to no
   role at all, and `decide()` treats an unparseable role as `refuse`, never as the
   least-privileged one (ADR-0031). `installModelsApi`'s `resolveActor`
   (`apps/web/server/composition/services.ts`) now copies `actor.role` onto the resolution as the
   field following `userLabel` — separated from it by a two-line comment citing this issue, not
   discarded.

2. `apps/web/server/models/http.ts`'s `withModelsRuntime` gains a third, **optional** parameter,
   `write?: { readonly ownership: Ownership }` (`Ownership` imported, read-only, from
   `../rbac/decide`). The gate itself is keyed on `request.method`, not on whether a caller passed
   `write`: `GET`/`HEAD` skip it (declared gap G-12, below); every other method calls `decide({
   role: actor.role, method: request.method, path: new URL(request.url).pathname, ownership:
   write?.ownership ?? 'unknown' })` after the existing `unauthenticated`/`forbidden` checks and
   before invoking `run` — `deny` maps to `403 forbidden` with `decide()`'s own `because`, `refuse`
   maps to `500 authorisation_undecidable`, and only `allow` reaches the handler. This is exactly
   `authorise()`'s own mapping, so a caller of either cannot tell which one decided. Keying on the
   method rather than on the argument's presence means a write route added later that forgot to
   pass `write` would still reach `decide()` — with the honest "row not read yet" `'unknown'`
   ownership — rather than the gate being skipped outright; round 1 verification (finding 5) named
   the presence-keyed shape as a fail-open-by-omission risk and this is the fix.

3. The five write routes pass `write` explicitly; the three reads (`GET /api/model-connections`,
   `GET /api/model-connections/:id`, `GET /api/models`) do not and are `GET`, so both the argument
   and the method agree they are unaffected — see "Deliberately not built" below and the plan's
   declared gap G-12.

   | Route | `ownership` |
   | --- | --- |
   | `POST /api/model-connections` | `'not-applicable'` (collection, no single row) |
   | `PATCH /api/model-connections/:id` | `'unknown'` |
   | `DELETE /api/model-connections/:id` | `'unknown'` |
   | `POST /api/model-connections/:id/credential` | `'unknown'` |
   | `POST /api/model-connections/:id/test` | `'unknown'` |

   `'unknown'` rather than `'own'`/`'other'` because no ownership resolver is built: the grants in
   play for this resource are `any` (Owner/Admin) and `none` (Builder/Viewer), neither of which
   reads `ownership` at all (`applyGrant` in `decide.ts`), so building a resolver that reads the row
   before deciding would add a database round trip no branch of the decision consults.

`write` is the third **positional** parameter, added after the existing `run` callback rather than
inserted before it, specifically so that `apps/web/app/api/models/route.ts` — `GET /api/models`,
outside this task's `Owns` globs — keeps compiling and behaving identically with its existing
two-argument call, unedited.

## Concealment (issue #117)

No new response shape was introduced for an id that does not exist, belongs to another workspace,
or is refused outright:

- A **denied** role (`decide()` → `deny`) never reaches the store. The `403` body is built entirely
  from the role, method and path — never the row — so a Builder or Viewer gets byte-identical `403`
  bodies for a real id, a foreign id, and a random UUID alike.
- An **allowed** role (`decide()` → `allow`) reaches the same workspace-scoped store every route
  already used before this change. The store is bound to `actor.workspaceId`
  (`runtime.models.forWorkspace(actor.workspaceId)`), so an Owner of workspace B naming workspace
  A's connection id already got the same `404 model_connection_not_found` a nonexistent id gets —
  this task changed nothing about that path and re-asserts it in
  `apps/web/server/models/routes.test.ts` rather than only relying on it having been true before.

## Rejected alternatives

- **Route through `rbac/http.ts`'s `authorise()`.** Rejected per the Context section above: it
  would mean wiring a second, redundant session-verification path into the models composition, or
  editing files under `apps/web/server/rbac/**`, which this task does not own this wave.
- **Make `write` a required parameter (or insert it before `run`).** Rejected: `GET
  /api/models` (`apps/web/app/api/models/route.ts`) calls `withModelsRuntime` and is outside this
  task's `Owns` globs. A required third parameter, or one inserted earlier in the argument list,
  would force an edit to that file to keep it compiling — an out-of-glob edit for a route this
  issue's acceptance criteria explicitly leave membership-scoped. Keying the gate on
  `request.method` instead (decision 2) gets the same fail-closed-by-default property without
  touching that file's call site or its signature.
- **Move `GET /api/model-connections`, `GET /api/model-connections/:id` and `GET /api/models` onto
  `decide()` too, for a uniformly-gated resource.** Rejected and declared as gap G-12: `#130`'s
  `ModelSelector` (`apps/web/components/models/model-selector.tsx`) reads both lists for every role
  that can compose a run, and `permissions.ts` grants Builder and Viewer no read of
  `model-connections`/`models`. Gating reads now would remove model selection from every Builder and
  Viewer — a regression `#149`'s own acceptance criterion ("can still read the list if the role
  model says it may") does not ask for. Reconciling the read grants is a `permissions.ts` decision,
  and that file is W9-WS-119's this wave.
- **Give model-connections its own parallel RBAC integration (a `models/rbac.ts` wrapping
  `Principal`/`WorkspaceDirectory` the way `apps/web/server/resources/authorise.ts` wraps
  `authorise()` for other resources).** Rejected: it would still need either a `Principal` this
  subsystem does not otherwise use, or a duplicate one built from the existing actor resolution —
  more layering than one `decide()` call at one call site needs, for a table this task does not
  change the shape of.

## Consequences

- Every actor resolution constructed anywhere in the program for `ModelsActorResolution` — the
  composition root and `apps/web/server/models/routes.test.ts`'s test fixtures — must supply a
  role. This is a compile-time obligation, not a runtime one: `role` was already available at every
  existing call site (`WorkspaceMembership.role`), and the only edits this required were the ones
  this task's `Owns` glob covers.
- `decide()`'s `refuse` branch is unreachable in production traffic through these five routes today
  — the role is always one `parseRole` accepts (a `WorkspaceMembership` row) and the path is always
  one `parsePath`/`parseSub` already classify (`credential` and `test` are both declared). It is
  implemented and mapped to `500 authorisation_undecidable` anyway, matching `authorise()`'s own
  shape, so a future change to either side of that boundary fails loudly instead of by coincidence.
- Reads on this resource remain membership-scoped, not role-scoped, until W9-WS-119's
  `permissions.ts` work reconciles Builder/Viewer's read grant with `#130`'s model selector (gap
  G-12).

## Repair round 1 (verify:W9-SEC-149)

Round 1 verification returned PASS with five minor findings; the orchestrator chose to repair
rather than merge because three of them (3, 4, 5) described a fail-open-by-omission *shape*, not a
live hole (ADR-0015 principle 4). All five are fixed:

- **Finding 1** — decision 1's "on the line directly under `userLabel`" was literally two comment
  lines off (the role sits on the line following the comment, not `userLabel`'s own next line).
  Reworded above to say what is actually there.
- **Finding 2** — the PR body typed test/clone counts into prose instead of pasting command
  output; rewritten in the PR body directly, nothing to change here.
- **Finding 3** — `installModelsApi`'s role-carrying line (services.ts) had no test that fails if
  it is hard-coded to `'owner'`; `routes.test.ts` gained a composition-root test that calls the
  real `installModelsApi` with a `'viewer'`/`'builder'` membership and asserts the refusal.
- **Finding 4** — the `refuse → 500` branch of the write gate had no test; `routes.test.ts` gained
  a test sending a role `decide()` cannot classify and asserting `500 authorisation_undecidable`.
- **Finding 5** — the gate was keyed on whether `write` was passed, which fails open for a
  hypothetical future write route that forgets the argument. Decision 2 above now keys it on
  `request.method` instead, closing that shape without touching any file outside this task's
  `Owns` globs.
