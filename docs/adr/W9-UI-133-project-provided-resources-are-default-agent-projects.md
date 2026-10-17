# W9-UI-133 — "Project-provided" resources on the agent screen are the projects that name this agent as their default agent

Status: accepted
Date: 2026-09-12
Decided by: W9-UI-133 (implementing agent)
Scope: `apps/web/components/agents/model.ts`'s `projectProvidedGroups`;
`apps/web/components/agents/resource-editor.tsx`'s `ProjectProvidedResources`

## Context

The card's Minimum implementation requires: "Project-provided resources from W9-PROJ-125 are listed
in a separate, read-only group so they are never mistaken for direct assignments." Issue #125's own
association is `project_files`/`project_mcp_servers` rows keyed by **project**, not by agent — a
project contributes its resources to whichever agent a *session* under that project actually uses
(`docs/adr/W9-PROJ-125-project-resources-narrow-never-widen.md`), and a session's agent is chosen at
session-start time, not fixed in the schema. There is no `agent_projects` join table and no column
recording "this agent is used by these projects" as a durable fact.

The one durable link this deployment does record between a project and a specific agent is
`projects.default_agent_id` (`ProjectResource.defaultAgentId` — "runs of this project with no agent
picked use this one"). A project whose resources reached this agent only because a caller explicitly
picked this agent for one session, on a project that names a *different* default agent, leaves no
row anywhere that says so after the fact.

## Decision

**The agent detail screen's "project-provided" group lists every project the caller can see whose
`defaultAgentId` equals this agent's id, with that project's `fileIds`/`mcpServerIds` resolved to
names via the same file/connector catalogs the direct-assignment groups already fetch.** No new
route: `GET /api/projects` already returns every project's `fileIds`/`mcpServerIds` in one response,
scoped to what the caller is authorised to see server-side.

This is a narrower claim than "every project this agent's resources have ever composed into", and it
says so in its own doc comment (`model.ts`): a project whose association with this agent existed only
for one session, chosen explicitly rather than by default, has no persisted trace to read back and is
out of this card's Minimum implementation.

## Alternatives considered

- **List every project in the workspace regardless of `defaultAgentId`.** Rejected: it would show a
  project's resources on every agent in the workspace, which is not "these resources reach a run of
  *this* agent" — it is "these resources exist somewhere", which the card's "never be mistaken for
  direct assignments" line is explicitly trying to prevent from happening the other way around
  (project resources mistaken for direct ones); showing them on the wrong agent is the same category
  of mistake in reverse.
- **Do not show a project-provided group at all, and instead point to a "Projects" screen.**
  Rejected: it satisfies "never mistaken for direct assignments" only by omission, and does not meet
  the card's explicit requirement that they be "listed" here.

## Consequences

- A project that once used this agent for a single, explicitly-chosen session (not as its default)
  never appears in this group, on this agent's screen, for that reason alone. This is the same
  boundary `docs/adr/W9-PROJ-125-project-resources-narrow-never-widen.md`'s own "Consequences"
  section already accepts for the reverse direction (a project association is not retro-fitted with
  history it never recorded) — this task inherits it rather than building a new join table to close
  it, which no acceptance criterion of `#133` asks for.
- `GET /api/projects` filters to projects the caller can see (owner/admin, or their own); a Builder
  viewing an agent they created may not see every project that names this agent as its default if
  another member created that project. The group under-reports in that case rather than
  over-exposing another member's project — the safer direction for a read-only display.

## Related

- [W9-PROJ-125-project-resources-narrow-never-widen](W9-PROJ-125-project-resources-narrow-never-widen.md)
