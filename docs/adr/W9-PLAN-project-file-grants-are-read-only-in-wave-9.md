# W9-PLAN — Project file grants are read-only in Wave 9, and can only narrow an agent's access

Status: accepted
Date: 2026-09-11
Decided by: W9-PLAN-00 (the Wave 9 planner)
Scope: `project_files` and `project_mcp_servers` as seen by W9-PROJ-125; the absence of a migration in
that task

## Context

Issue #125 has to make project associations effective at run time without turning a project into a
privilege-escalation path. Its Proposed Changes leave the access model open:

> Define access semantics explicitly (for example project grants with read/read-write modes capped by
> agent permissions); **extend `project_files` if the current binary association is insufficient.**

`packages/core/src/db/schema/project-files.ts` is today a pure join: `(workspace_id, project_id,
file_id)`, with tenant-paired composite foreign keys to both sides and no access column.
`agent_files` is where a read versus read-write mode lives, and the agent's own tool permissions are
the ceiling on any of it.

The other half of the issue — *"Starting a session in a project deterministically resolves and persists
its agent"* — reads as though it needs a column too. It does not: `packages/core/src/db/schema/sessions.ts`
already carries a non-null `agent_id` with a tenant-paired composite foreign key to
`agents(id, workspace_id)`. Resolving `defaultAgentId` at session start and writing it there is an
`INSERT` value, not a schema change.

W9-PROJ-125 sits in W9.4, whose single migration slot belongs to W9-RUNS-134
([W9-PLAN-one-migration-per-wave-sets-the-wave-count](W9-PLAN-one-migration-per-wave-sets-the-wave-count.md)).
So the question is not only "is a column simpler" but "does the criteria set require one".

## Decision

**`project_files` keeps its binary shape. A project file association is a read-only grant, and the
composed run's access is the association intersected with the agent's own permissions.
W9-PROJ-125 writes no migration.**

1. **Read-only.** A project association contributes read access to a file or folder and never write
   access. A project that needs an agent to write a file gives the agent that file directly, through
   `agent_files`, where the mode already exists.
2. **Narrowing only, never widening.** The resource loader unions the project's associations with the
   agent's assignments and then intersects the result with the agent's permission set. A file the
   agent's tool permissions do not reach is dropped and reported as a pre-launch error, not silently
   omitted — this is #125's criterion *"Project association cannot broaden agent-level tool
   permissions"*, implemented as an intersection rather than as a check that can be forgotten at one
   call site.
3. **Deterministic precedence, documented.** For the same file id, the agent's own assignment wins over
   the project's. For the same path reached two ways, the more restrictive mode wins. A duplicate folder
   grant resolves to one grant. These are stated in W9-PROJ-125's own ADR and covered by unit tests.
4. **Connectors.** `project_mcp_servers` likewise contributes a connector only where the agent is
   already authorised for that connector's credential; otherwise the launch fails with a named error.
   No credential is ever surfaced by virtue of a project association.
5. **The resolved agent is persisted into `sessions.agent_id`**, which exists, so later edits to the
   project's `defaultAgentId` cannot rewrite a session's or a run's attribution.

## Consequences

- W9-PROJ-125 needs no migration, which is what lets it share W9.4 with W9-RUNS-134 instead of
  occupying a slot of its own. Without this and
  [W9-PLAN-credential-ownership-is-a-repository-invariant-not-a-foreign-key](W9-PLAN-credential-ownership-is-a-repository-invariant-not-a-foreign-key.md),
  Wave 9 would need nine waves rather than seven.
- A project cannot express "everyone working in this project may edit these shared files". That is a
  genuine product limitation and it is stated as such on the card, not hidden. The workaround is an
  agent-level read-write assignment, which is where write access is already modelled.
- The intersection makes a project association strictly safe: no combination of project configuration
  and agent configuration can produce access the agent did not already have.
- When a read-write project grant is wanted later, the change is additive — an `access` column on
  `project_files` defaulting to `read` — and no existing row's meaning changes.

## Alternatives rejected

**Add `access` to `project_files` now.** One column, and it costs W9-PROJ-125 the wave's migration slot,
displacing W9-RUNS-134 into a wave of its own and pushing #135 and #136 one wave later each. #125's
acceptance criteria are satisfied without it; the criterion is *"Conflicting folder/file access has a
documented deterministic result"*, and "read-only, intersected with the agent, agent wins on
conflict" is a documented deterministic result.

**Union project and agent resources without the intersection.** This is the unsafe simplification #125
names explicitly — *"Simply unioning resources would be unsafe"* — and it is rejected for the reason the
issue gives.

**Treat project associations as read-write and cap them at the agent.** Indistinguishable from
read-only in every case where the agent has read-only access, and strictly more surprising in the cases
where it differs, because the project's stored intent would then depend on which agent runs.

## Related

- [W9-PLAN-one-migration-per-wave-sets-the-wave-count](W9-PLAN-one-migration-per-wave-sets-the-wave-count.md)
  — the constraint that makes the absence of a migration load-bearing.
- Issue #117 (W9-AUTH-117) — the ownership and grant semantics W9-PROJ-125 authorises against.
