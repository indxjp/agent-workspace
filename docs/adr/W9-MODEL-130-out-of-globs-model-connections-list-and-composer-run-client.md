# ADR-W9-MODEL-130-out-of-globs-model-connections-list-and-composer-run-client — every file this task touched outside its `Owns` line, and why each is genuinely unavoidable

Status: accepted
Date: 2026-09-12
Decided by: W9-MODEL-130
Scope: `apps/web/app/api/model-connections/route.ts`, `apps/web/server/models/{handlers,routes.test}.ts`, `apps/web/components/run/live{.ts,.test.ts}`, `tests/route-declarations/W9-MODEL-130.ts`

## Context

This task's `Owns globs` are `apps/web/components/{agents,composer,models,projects}/**`,
`apps/web/app/(shell)/admin/settings/**` and `apps/web/app/api/agents/*/runs/**`. Building the
card's Minimum implementation — one reusable `(connectionId, providerModelId)` selector, reused at
every layer — needed two things neither line covers.

### 1. No route lists model connections by name, and `#129`'s own doc comment already promised one

`#130`'s reusable selector needs a connection's **name** next to every model it offers
("`claude-sonnet-4-5` under *Prod Anthropic*"), and `#129`'s discovery rows
(`GET /api/models`) carry only a `connectionId` — never a name. The obvious source,
`GET /api/model-connections`, does not exist: only `POST /api/model-connections` and the four
`:id`-scoped routes do. This is not an oversight this task introduces; it is one `#129` already
named and left undone. `apps/web/server/models/handlers.ts`'s `listDiscoveredModels` doc comment,
committed by `W9-MODEL-129`, reads verbatim: *"`GET /api/model-connections` is the connection view
now."* That commit's own diff shows why: it deleted the pre-`#129` `listModels` function
(`{ status: 200, body: { models: await store.list() } }`, exactly the connections list) and
repointed `GET /api/models` at discovery instead, without ever adding the replacement route the
comment describes.

That gap is not cosmetic. `apps/web/components/models/models-screen.tsx` (`#128`'s Models
management screen, squarely inside this task's own `Owns` glob) still fetches `GET /api/models`
expecting the pre-`#129` connections shape (`{id, name, provider, hasCredential, ready}`) and
parses it with `readModelConnections`, which requires `id`/`name`/`provider ∈ PROVIDER_CHOICES`
on every entry. Discovery rows have none of those keys — `connectionId`/`providerModelId`/
`displayName`/`capabilities` instead — so `readModelConnections` throws on the first row the
moment any ready connection has a discoverable model. The Models screen is live-broken on `main`
today for exactly that case; `apps/web/components/models/model.test.ts`'s only coverage of it
constructs the response by hand rather than exercising the real route, so nothing caught it.

`apps/web/app/api/model-connections/**` and `apps/web/server/models/**` are `W9-MODEL-129`'s own
`Owns` glob for Wave 9.3 — a *sequential* predecessor of this task's Wave 9.4, not a concurrent
sibling (`docs/adr/W9-PLAN-waves-branch-from-main-not-from-each-other.md`), the same relationship
`W9-AUTH-117`'s own out-of-globs ADR describes for its own touch of `apps/web/server/runs/api.ts`.

### 2. The composer's run-override client sends a body the server has refused since `#129` landed

`apps/web/components/run/live.ts`'s `startAgentRun` (no Wave 9 task's glob; last touched by
Wave 1) posts `{ prompt, sessionId, modelConnectionId }` — a bare connection id, no `model`.
`apps/web/server/runs/api.ts`'s `parseStartRunBody` (already `#129`'s, not this task's) has
required `modelConnectionId` and `model` together or neither since that task landed: `(connectionId
=== null) !== (model === null)` is a `400`. So the composer's per-run override has answered `400`
for any non-null selection since `W9-MODEL-129` merged into `main` — before this task ever started.
`#130`'s own Acceptance Criteria ("Per-run override does not silently mutate agent/project/
workspace defaults", the verifier's attack 2) cannot be met by a client that cannot start an
overridden run at all.

## Decision

**`apps/web/app/api/model-connections/route.ts`** — add `GET`, calling a new, additive
**`listModelConnections`** in `apps/web/server/models/handlers.ts`: `#129`'s own deleted function,
unchanged, under the name its own comment already used. No existing export in either file is
edited. **`apps/web/server/models/routes.test.ts`** gets one new case proving the route (list,
readiness, provider — and that no key leaks the stored API key), rather than shipping an untested
route.

**`apps/web/components/run/live.ts`** — `startAgentRun`'s third parameter becomes
`{ connectionId, model } | null` and the request body becomes
`{ prompt, sessionId, modelConnectionId, model }`, matching `parseStartRunBody` exactly.
**`apps/web/components/run/live.test.ts`**'s existing cases are updated to the new parameter and
body shape; none is deleted or loosened.

**`tests/route-declarations/W9-MODEL-130.ts`** — a new, single-task declaration file
(`ADR-0025`'s partition: "a declaration file speaks for exactly one task"), naming
`GET /api/model-connections` under this task's own id, with the mandate spec §13 already gives
model management.

Confirmed against this wave's siblings: `W9-RUNS-134` (`packages/gateway/**`,
`packages/core/src/db/{schema,repositories}/runs*.ts`, `apps/web/server/runs/launcher*.ts`) and
`W9-PROJ-125` (`packages/core/src/db/repositories/{projects,project-files,project-mcp-servers}.ts`,
`apps/web/server/{compose,projects}/**`, `apps/web/instrumentation-node.ts`,
`apps/web/app/api/projects/**`) name none of the six files above.

## Alternatives considered

- **Have the composer send `modelConnectionId` alone and accept the `400`.** Rejected: it is the
  literal regression the card's verifier attack 2 tests, and the card's own Acceptance Criteria
  require the run override to work.
- **Widen `Owns globs` to claim `apps/web/server/models/**` or `apps/web/components/run/**`
  outright.** Rejected, same reasoning `W9-AUTH-117`'s ADR gives: it would claim a whole directory
  neither this task's Minimum implementation nor any sibling's needs, for one function and one
  parameter's shape.
- **Build a second, `#130`-local connections-listing endpoint** (e.g.
  `GET /api/model-connections/names`) instead of the one `#129`'s own comment names. Rejected: it
  would leave two "list connections" routes with different shapes, and `models-screen.tsx`'s real
  bug would still be unfixed.

## Consequences

- This task's PR declares all six files under "Files touched outside Owns", each with the reason
  above.
- `W9-WS-119` (Wave 9.5, sequential) and any later task adding `apps/web/app/api/model-connections/**`
  work inherit a `route.ts` that already exports `GET`; nothing in this task's addition assumes
  anything that task's own Minimum implementation depends on.
- `apps/web/components/models/models-screen.tsx` now fetches `GET /api/model-connections` instead
  of `GET /api/models` — an in-glob fix, recorded here because it is the direct consequence of
  closing the gap `#129`'s comment named.
