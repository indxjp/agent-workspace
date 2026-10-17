# ADR-W9-MODEL-130-workspace-default-has-no-write-api-in-this-wave — the workspace-layer model default is shown, not editable, and the gap is declared (G-9)

Status: accepted
Date: 2026-09-12
Decided by: W9-MODEL-130
Scope: `apps/web/app/(shell)/admin/settings/**`, `apps/web/components/models/workspace-default-card.tsx`

## Context

The card's Minimum implementation places a workspace-default model control "on the existing
`apps/web/app/(shell)/admin/settings` screen — not a new workspace settings screen." Building it
requires a way to read and write `workspaces.defaultModelConnectionId`/`defaultModel` over HTTP.
Neither exists, and every file that could carry one is outside this task's reach:

- **`apps/web/app/api/workspaces/**` does not exist.** It is `W9-WS-119`'s own `Owns` glob, a
  *later*, not-yet-started wave (9.5).
- **`apps/web/app/api/models/**`/`apps/web/server/models/**`** could carry a narrow addition the
  same way this task's `GET /api/model-connections` addition does (see this task's other
  out-of-globs ADR) — but `openDatabaseRoot`'s `getWorkspaceModelDefault`/`setWorkspaceModelDefault`
  (the only functions that read or write these two columns) are reachable from nowhere an HTTP
  route can import without a *new* runtime accessor, and the only place that accessor could be
  registered is `apps/web/instrumentation-node.ts`.
- **`apps/web/instrumentation-node.ts` is this wave's exclusively-assigned shared file for a
  same-wave sibling.** The wave plan's "Shared files, assigned per wave" table names exactly one
  owner per wave for this file, and for W9.4 that owner is `W9-PROJ-125` — a task running in
  parallel with this one, not a sequential predecessor. Touching it would be exactly the
  same-wave-sibling collision the execution protocol forbids outright, not a "declare and confirm no
  intersection" situation: the intersection is the file itself.

So, unlike the project layer (`apps/web/components/projects/model.ts`'s own header, and
`docs/adr/W9-MODEL-130-project-default-write-awaits-sibling-patch-support.md`), there is no
optimistic body this task can send anywhere — no route exists to send it to, and none can be added
without touching a file a concurrent sibling exclusively owns.

## Decision

Ship `WorkspaceModelDefaultCard` on the existing `admin/settings` screen — visible, in the location
the card names, using the same section shape (`AgentModelSection`, `ProjectModelField`) every other
layer uses — but read-only: it states plainly that this deployment has no route to change the
workspace default yet, rather than rendering a `<select>`/`<input>` a click would silently not
persist. This is the same idiom this application already applies to every other capability that is
not wired up (`models-screen.tsx`'s "No providers are configured yet",
`AgentModelSection`'s `catalogState.kind === 'failed'` message, `server/runs/environment.ts`'s own
503 for an unconfigured run API) — ADR-0015: an unavailable capability says so, in place of a
control that looks like it does something and does not.

## Declared gap

**G-9.** The workspace-wide model default cannot be set from this UI in this wave. It remains
whatever `workspaces.defaultModelConnectionId`/`defaultModel` were left as (`null`/`null` for every
workspace this programme has created so far, since nothing has ever written them) — a run resolves
against it correctly the moment it *is* set by any means, because
`apps/web/instrumentation-node.ts`'s `resolveModelForRun` call already reads it
(`W9-MODEL-129`'s work); only the write path is missing. Closing this gap needs one of: `W9-WS-119`
extending its own workspace-settings PATCH to include the pair (its card's Minimum implementation
already says "update name and allowed settings"), or a later task adding the narrow
`apps/web/server/models/**` route this ADR describes as theoretically possible, once it is not
racing a same-wave sibling for `instrumentation-node.ts`.

## Alternatives considered

- **Touch `apps/web/instrumentation-node.ts` anyway, declaring the extra glob.** Rejected outright:
  the execution protocol's ownership rule is unconditional for a same-wave sibling's file, not a
  balancing test — "never touch another task's files" — and the wave plan's Shared-files table
  exists specifically to make that determination mechanical rather than a judgement call.
- **Fabricate a plausible future route URL and have the card `fetch` it, showing the resulting
  404/503 as the "unavailable" state.** Rejected: it invites a false "ready-made" read of a request
  going to a URL no other task has committed to, is more code than the honest static message,
  and a genuinely unconfigured 503-style subsystem (the pattern reused here) is materially
  different from a URL that will 404 forever until an unrelated task chooses its own shape.
- **Wait for `#120`'s dedicated workspace settings screen and add nothing here.** Rejected by the
  card's own words: it explicitly does not want this task to wait for `#120`, and a value is still
  worth stating even when it cannot yet be changed from here.

## Consequences

- A verifier reading only the Acceptance Criteria ("Add workspace default... controls at their
  appropriate screens") without this record could mistake the read-only card for an incomplete
  implementation; this ADR and the PR's own "Declared gaps" section are the two places that state
  it is a boundary, not an oversight.
- `W9-WS-119`, when it lands, can extend its own workspace PATCH with these two fields with no
  client change needed beyond replacing this card's body — the display shape (`ModelSelector`,
  `describeInheritance`) is already built and already reused at every other layer.
