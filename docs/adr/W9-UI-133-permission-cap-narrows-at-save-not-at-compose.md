# W9-UI-133 — An agent's own `writeFiles` permission narrows a `'read-write'` grant when the assignment is *saved*, not when a run is *composed*

Status: superseded by [W9-UI-133-permission-cap-narrows-at-read-and-write](W9-UI-133-permission-cap-narrows-at-read-and-write.md)
Date: 2026-09-12
Decided by: W9-UI-133 (implementing agent)
Scope: `packages/core/src/db/repositories/agent-resources.ts`'s `replace` and, as of verification
round 1, `read`/`get` too; explicitly **not** `apps/web/server/compose/resource-loader.ts` (outside
this task's Owns globs)

## Context

Issue #133's acceptance criterion "Permission caps and server validation errors are understandable"
and the card's own verifier attack #1 both name the same scenario: an agent is granted `'read-write'`
on a folder while the agent's own `writeFiles` tool permission is off. The card's Owns line for the
route directory says the inclusion is "only because the permission-cap validation may need a
server-side check added there" — a hint, not a mandate, and it does not say whether the ceiling
should reject the grant, narrow it silently, or leave it alone and only warn.

Two existing precedents point the same direction but do not by themselves answer *where* to put the
check:

- `docs/adr/W9-PROJ-125-project-resources-narrow-never-widen.md` establishes "narrow, never widen" as
  this codebase's rule for a project's contribution to a run: a project's file association is capped
  by the agent's `readFiles` permission, and a project's connector association by
  `unrestrictedNetwork`. That precedent is a **refusal** (`loadProjectFileGrants` throws), because a
  project is a *different* actor's contribution and the honest answer to "this project wants to hand
  the agent files the agent cannot read" is to refuse the run, not to quietly redefine what the
  project asked for.
- `apps/web/server/compose/run-request.ts`'s `toolPolicyFor` already denies the SDK's `Write`,
  `Edit`, and `NotebookEdit` tools outright whenever `writeFiles` is `false`, regardless of any file's
  own access mode. So a `'read-write'` grant on a `writeFiles: false` agent is already inert at every
  run today — no write happens — before this task changes anything. What is not honest yet is the
  *record*: `GET /api/agents/:id/resources` and the composed `RunRequest.resources.files` array both
  still say `'read-write'`, which reads as a grant that would take effect the moment `writeFiles` is
  turned on, silently, with no further action from whoever set the grant.

`apps/web/server/compose/resource-loader.ts` — the one place that would need to change to narrow a
grant strictly at *compose* time, leaving the persisted value alone — is outside this task's Owns
globs (`apps/web/components/agents/**`, `apps/web/contracts/agents*.ts`,
`apps/web/app/api/agents/*/resources/**`, `packages/core/src/db/repositories/agent-resources*.ts`).

## Decision

**An agent's own grant is different from a project's: it is the same actor's own choice, on the same
row this request is already editing, so it is narrowed to `'read'`, not refused — and it is narrowed
at the one place both writers of an assignment already call through:
`AgentResourceRepository.replace` in `packages/core/src/db/repositories/agent-resources.ts`.**

`replace` now reads the agent's `permissions` in the same query that already proves the agent exists
in this workspace (previously a bare existence probe; now `select({ permissions: agents.permissions
})` instead of `select({ id: agents.id })`, same predicate, same query count). If `writeFiles` is
`false`, every `'read-write'` file grant in the request is rewritten to `'read'` before the existing
unknown-file/unknown-skill/unknown-connector validation and the transactional write run — so the
row that lands in `agent_files`, the row `GET` reads back, and the row `resource-loader.ts` later
composes a run from are all the same, honest, narrowed value. **Narrowed, not refused**: `writeFiles`
lives on the very agent being edited, so a caller who turns it back on later does not have to
re-discover and re-grant every file it had already marked read-write — the grant's *intent* survives
in the UI's own draft (`AgentDetailScreen` resyncs its editable draft to what the server actually
persisted after a successful save, so the person editing sees the narrowed value immediately, not an
optimistic echo of what they asked for), even though the *persisted* value only ever expresses what
the agent could actually exercise at the moment it was saved.

Putting the check in the repository rather than in `PUT /api/agents/:id/resources`'s route handler
matters for more than tidiness: `POST /api/agents` (`apps/web/app/api/agents/route.ts`, outside this
task's Owns globs) accepts an `assignments` body in the same request that creates the agent and calls
the identical `AgentResourceRepository.replace`. A check written into the `PUT` route alone would
leave that creation path unfixed — the same root cause, unaddressed at a second site (ADR-0048). By
reading the ceiling inside `replace` itself, both writers share one check without either route
needing to fetch the agent's own permissions a second time.

The UI warns about the same ceiling *before* saving: `apps/web/components/agents/resource-editor.tsx`'s
`FileAssignments` shows an inline note next to any row where `access === 'read-write'` while the
agent's own `writeFiles` is off, naming exactly what will happen ("will be saved and enforced as
read-only"). It is advisory, not blocking — the request that follows tells the truth regardless of
whether the warning was read.

## Alternatives considered

- **Refuse the `PUT`/`POST` outright when a `'read-write'` grant exceeds `writeFiles`**, the same
  shape `loadProjectFileGrants` uses. Rejected: unlike a project's contribution, this is the agent's
  own definition and its own resource list in the same edit — refusing would force an artificial
  ordering (turn on `writeFiles` first, only then be allowed to grant read-write, in two separate
  saves) for no security benefit, since the grant is already inert at run time either way.
- **Leave the persisted value alone and narrow only inside `resource-loader.ts` at compose time**,
  which would also make a future permission change retroactively "restore" every affected grant with
  no further action. Rejected for this task specifically: that file is outside this card's Owns
  globs, so implementing it here would touch a file the task is not permitted to edit. This is the
  residual, declared gap below, not a decision this task is making on the merits alone.
- **Do nothing — rely on `toolPolicyFor`'s existing global deny of `Write`/`Edit`/`NotebookEdit`.**
  Rejected: it is sufficient for the *security* property (no write can actually happen) but leaves
  the *record* dishonest — `GET`'s own response, and the value an operator reading the composed
  `RunRequest` would see, both still claim `'read-write'` for something no run can exercise.

## Consequences

- `AgentResourceRepository.replace` now performs the same lookup as before (agent exists in this
  workspace) but selects `permissions` instead of a bare `id`; no additional round trip.
- A grant made while `writeFiles` was off and never re-saved after `writeFiles` is turned back on
  stays `'read'` until the assignment is written again — narrowing is a property of *the request
  that persisted it*, not a live constraint re-evaluated on every read. `GET` and a composed run
  agree with each other, always; they do not necessarily agree with what today's `writeFiles` value
  alone would imply if the grant predates the toggle.
- **Declared gap**: `apps/web/server/compose/resource-loader.ts` applies no permission ceiling of its
  own to an agent's own file grants (it already applies one to a *project's* file/connector
  associations, per W9-PROJ-125). For every grant saved through this task's code path, that gap is
  invisible — the ceiling already narrowed the stored value, so there is nothing left for
  `resource-loader.ts` to get wrong. It would only be reachable by a row written through some other
  path this task did not touch (there is none known today) or a future writer of `agent_files` that
  bypasses `AgentResourceRepository.replace` entirely.

## Verification round 1: the declared gap was reachable today, through this task's own shipped flow

The "Consequences" section above claimed the compose-time gap "would only be reachable by a row
written through some other path this task did not touch (there is none known today) or a future
writer of `agent_files` that bypasses `AgentResourceRepository.replace` entirely." That claim was
wrong, and it undersold the risk: the gap was reachable **today**, with no bypass of `replace`
required, through the exact two-request partial-save sequence this same task ships and this ADR's
own "Consequences" already half-describes —

1. Grant a file `'read-write'` while the agent's `writeFiles` permission is on (a normal `PUT`,
   narrowed correctly by `replace`, matching this ADR's Decision).
2. A *later*, independent `PATCH /api/agents/:id` turns `writeFiles` off — on its own, with no
   resources `PUT` in the same request. `AgentDetailScreen.save()` (`apps/web/components/agents/
   agent-detail.tsx`) sends exactly this pair of requests, and by design the second request is not
   required to succeed for the first to be considered saved.
3. No third request ever re-narrows the row — nothing requires one. It was never `replace()`d again,
   so `replace`'s narrowing never runs on it, and it sits in `agent_files` reading `'read-write'`
   against an agent whose `writeFiles` is now `false`.
4. `createAgentRunResourceLoader` (`apps/web/server/compose/resource-loader.ts`) composes a run by
   calling `AgentResourceRepository.get`, which — before this round's fix — returned the row
   verbatim. The composed run carried `'read-write'`, and `apps/runner`'s `materializeFiles` mounts
   a `'read-write'` grant writable on disk; `applyFileGrantPolicy`'s Bash-deny is conditioned on at
   least one grant already reading `'read'`, so a workspace with `runCommands: true` and no other
   file grant could still write through the Bash tool despite the operator having turned `writeFiles`
   off.

Step 2 needs no bypass of `replace`, no direct database access, and no path this task did not
already build — it is the ordinary shape of using the two-request save this ADR itself designed.
"There is none known today" was simply not checked against the feature this same ADR ships.

**Correction to the Decision, not a reversal of it**: narrowing at `replace`-time (write) is still
correct and still the only place a *new* grant can be validated against the unknown-file/
unknown-skill/unknown-connector checks. What was missing is that `AgentResourceRepository.get` — the
method both `GET /api/agents/:id/resources` and `createAgentRunResourceLoader` call, and the only
reader of `agent_files` in the run-compose path — now re-derives the same ceiling from the agent's
*current* `permissions` on every read, not just when a row happens to get rewritten. This lives
inside `packages/core/src/db/repositories/agent-resources.ts`, squarely inside this task's Owns
globs — the "Alternatives considered" entry above rejected narrowing at compose time because
`resource-loader.ts` itself is out of Owns, and never considered narrowing at the repository's own
read path instead, which needs no file outside Owns. See that file's `read` function for the fix and
`packages/core/src/db/repositories/agent-resources.test.ts` ("reads a 'read-write' row back as
'read' once the agent's writeFiles permission is turned off after the row was written, with no
further replace()") and `apps/web/app/api/agents/[id]/resources/compose-write-ceiling.test.ts` (the
same scenario driven through the real, unmodified `createAgentRunResourceLoader`) for the proof.

The declared gap in "Consequences" above is retracted: with narrowing applied on every read as well
as on write, there is no longer a path — partial-save or otherwise — through which a stale
`'read-write'` row reaches a composed run or a `GET` response.

## Related

- [W9-PROJ-125-project-resources-narrow-never-widen](W9-PROJ-125-project-resources-narrow-never-widen.md)
- ADR-0048 (fix a root cause at every site it reaches — the reason the check lives in the repository,
  not the route)
