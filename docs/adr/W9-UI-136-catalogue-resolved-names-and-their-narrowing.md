# ADR-W9-UI-136 — Names on the Runs screen come from catalogues this screen already reads, and one of them narrows by role

Status: accepted
Date: 2026-09-12
Decided by: W9-UI-136 (implementing agent)
Scope: `apps/web/components/run/history.ts`, `apps/web/components/run/history-screen.tsx`,
`apps/web/components/run/run-detail-panel.tsx`

## Context

`GET /api/runs` and `GET /api/runs/:id` (issue #135, `renderRun` in `apps/web/server/runs/api.ts`)
render `agentId`, `projectId`, `initiatingUserId` and `workspaceId` — never a name. Issue #136 asks
this screen to show agent, project, user and workspace, and its verifier attack asks for a
"deleted-resource state with working links to whatever still exists" when an agent and a project
have since been removed. Something has to turn an id into a name, or into "deleted", without a new
API and without a client-side role table (the task card's own words for the `user` filter, applied
here to the same principle).

Three existing, already-landed list endpoints answer this without a new route:

- `GET /api/agents` — `permissions.ts` grants every role `read: 'any'` on `agents`, so this list is
  the complete workspace roster for every caller.
- `GET /api/projects` — `apps/web/app/api/projects/route.ts`'s own `GET` handler filters its
  `visible` set to `project.createdBy === actor.userId` for every role but Owner and Admin. A
  Builder or Viewer's list is therefore _their own_ projects, not the workspace's.
- `GET /api/users` — the workspace's current members.
- `GET /api/workspaces` — the caller's own memberships, one of which is the run's `workspaceId`.

## Decision

1. **A run's id fields are resolved against these lists, fetched once per screen load and shared by
   the list and the detail panel** (`history-screen.tsx`'s `useCatalog`, `parseCatalog` in
   `history.ts`). Each catalogue is one of three states — `loading`, `unavailable` (the fetch
   failed or came back malformed), or `ready` with an id→label map — and `resolveResourceReference`
   turns a run's id plus one of those states into exactly one of `'absent'` (the run carries no id
   here), `'unknown'` (the catalogue itself could not be read), `'deleted'` (the catalogue was read
   and does not hold this id) or `'resolved'` (a name, and a link).

2. **`'unknown'` and `'deleted'` are kept apart on purpose.** Collapsing them would let this screen
   say "deleted" about a resource it simply failed to fetch a name for — asserting a fact from an
   absence, the shape ADR-0015 forbids. `'unknown'` renders the raw id in monospace with "(not
   available)"; only `'deleted'` renders the word "Deleted".

3. **For Builder and Viewer, a project id absent from `GET /api/projects` is `'deleted'`, and that
   is a declared narrowing, not a verified fact.** Those two roles' project catalogue is "projects I
   created", not "projects in this workspace" — so a project a Builder does not own but can still
   read through some other grant would render as deleted even though it exists. This task does not
   fix it: doing so would mean either widening `GET /api/projects`'s own visibility filter (a route
   this task does not own) or adding a second, id-by-id lookup path with its own authorisation
   question. Owner and Admin see every project, so the distinction is exact for them, which is the
   pair issue #135's own header already narrows the `runs` list to (`OWN_READS` for everyone but
   Owner) — the same two roles for whom this screen's project names are also exact.

4. **The active workspace is not re-fetched and re-shown as a page heading.** `apps/web/app/(shell)/
layout.tsx` already names it in the sidebar on every route, `GET /api/runs` never mixes more than
   one `workspaceId` into one response, and no API this wave ships lets a client ask "which of my
   memberships is the active one" (that is `#119`/`#120`'s surface). The detail panel still resolves
   and shows a run's own `workspaceId` against `GET /api/workspaces`, which is the concrete,
   per-run tenant-boundary fact issue #136 actually asks for, without inventing a heading this
   screen cannot honestly source.

5. **A durable, post-restart "deleted agent/project" attribution cannot be manufactured by this
   UI.** The current schema deletes an agent's sessions and therefore its runs through
   `sessions_agent_workspace_fk ... ON DELETE CASCADE`; deleting a project sets
   `sessions.project_id` to `NULL`; and a user referenced by a session is `ON DELETE RESTRICT`.
   Consequently the UI's `deleted` reference arm is correct for a stale catalogue observed while
   a page is open, and for a future API that preserves the id, but the current durable response
   cannot carry either a deleted agent id or a deleted project id after restart. W9-PROJ-124 is the
   planned backend task that preserves project history attribution. This task declares the current
   structural limit instead of labelling a `null` project id "deleted" without evidence.

## Alternatives considered

- **A new, purpose-built `GET /api/runs/:id/context` (or similar) that resolves every name
  server-side.** Rejected: it is a new endpoint for a task whose card lists no new API surface, and
  it would duplicate the authorisation `GET /api/agents`/`GET /api/projects`/`GET /api/users`
  already apply correctly.
- **Treat any id absent from a catalogue as `'unknown'`, never `'deleted'`.** Rejected: it would
  fail the verifier's own attack — an agent or project actually removed must render as removed, not
  as a permanent "not available" that looks identical to a transient fetch failure.
- **Widen `GET /api/projects`'s visibility for this screen's sake.** Out of this task's `Owns`
  globs (`apps/web/server/projects/**`), and a policy question (§21's project visibility) this task
  is not positioned to answer.

## Consequences

- A Builder or Viewer occasionally sees "Deleted project" for a project that still exists but that
  they do not own — declared in the PR's `## Declared gaps`, not silently absorbed.
- Adding `GET /api/agents/:id` semantics that already grant every role `any` read means agent-name
  resolution has no equivalent narrowing; only the project catalogue does.
- A future task that gives `GET /api/projects` a workspace-wide read for every role removes this
  narrowing with no change to `history.ts` — `resolveResourceReference` already reads whatever the
  catalogue contains.
- Until W9-PROJ-124 changes the durable project shape, a reloaded run whose former project was
  deleted renders "No project", because that is the only fact `GET /api/runs` answers. A deleted
  agent's run cannot be listed at all under the current cascade. Both are declared gaps rather than
  simulated UI states.
