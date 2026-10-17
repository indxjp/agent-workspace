# ADR-SDK-02-AGENT-POLICY-234 — A replaced agent policy is a nullable, narrowing jsonb column

Status: accepted
Date: 2026-09-22
Decided by: SDK-02-AGENT-POLICY-234 implementing agent
Scope: `packages/core/src/db/schema/agents.ts`, `packages/core/src/db/repositories/agents.ts`,
`apps/web/server/agents/**`, `apps/web/app/api/agents/[id]/policy/route.ts`,
`apps/web/server/compose/run-request.ts`, `packages/contracts/src/agents.ts`

## Context

Issue #234 (S-13) asks for `GET`/`PUT /api/agents/:id/policy`: an agent's tool, skill and limit
policy becomes a readable and replaceable wire resource. Before this unit the policy existed only
as a compile step — `apps/web/server/compose/run-request.ts`'s `agentConfigFor` derives `tools`
from the four `agents.permissions` booleans, `skills` from the agent's resource assignments, and
`limits` as a fixed `{ maxTurns: null, maxBudgetUsd: null }` — with no column, table or row
anywhere a `PUT` could write to.

Two decisions had to be made together, because the second is only safe if the first supports it:
where a replaced policy is stored, and what the compile step does with one once it exists. A
policy route sits directly in front of a production agent's tool surface; a design that let a
`PUT` widen an agent past the permission checkboxes an Owner or Builder already set through the
UI would turn "read and replace policy" into "escalate an agent's own blast radius," which is not
what issue #234 or spec §17 Step 4 asks for.

## Decision

**Storage.** `agents` gains one nullable `policy jsonb` column (migration `0021`). `NULL` means
"compile from `permissions` and the assigned resources" — today's behaviour for every row that
exists before this migration runs, and for every agent nobody has ever called `PUT` on afterward.
`GET` answers the stored policy when the column is set and the compiled one otherwise, so the
route is truthful on day one for every existing agent. The column is read through
`parseAgentPolicy` (`packages/core/src/db/schema/agents.ts`), the same `$type<T>()`-is-compile-time
-only pattern `parseAgentPermissions` already uses one column over, per R-15 §4.

**Narrowing at read time, not only at write time.** `apps/web/server/compose/run-request.ts`'s
`agentConfigFor` reads the stored policy when it is present, but `tools.deny` and `tools.autoApprove`
are *unioned* with the permission-derived denials and the assigned-connector approvals, never
replaced by the stored policy's own arrays. The stored `skills` is *intersected* with the agent's
current skill assignments at compose time — a stored `{ mode: 'all' }` compiles to "every skill
currently assigned", never the whole discoverable skill surface, and a stored allowlist loses any
name whose assignment has since been revoked. Only `tools.base`, `tools.permissionMode`,
`tools.allowDangerouslySkipPermissions` and `limits` come from the stored policy verbatim;
`applyFileGrantPolicy`'s read-only file denials still run last, over the union. A stored
policy can therefore restrict an agent past its permission checkboxes but can never re-grant a
tool those checkboxes, or a file grant, already denied — the ceiling is enforced every time a run
is composed, not only at the moment a `PUT` is accepted.

**The `PUT` route's own refusals.** A policy whose `skills.mode === 'allowlist'` names a skill the
agent has no resource assignment for is refused (`409 skill_not_assigned`): the policy route
governs which of the agent's already-assigned skills the model may see, not a second way to assign
one. A parseable `permissionMode: 'bypassPermissions'` is refused regardless of role
(`400 dangerous_permission_mode_refused`) — R-01 §10 makes it the one mode that additionally
requires `allowDangerouslySkipPermissions: true`, and nothing on the site offers it as an
authoring choice today.

## Alternatives considered

- **Project the policy onto the columns that already exist** (`permissions` plus the resource
  assignment tables). Rejected: a `PUT` would silently drop `permissionMode`, `limits`,
  `autoApprove` and `base` — a validated input the server discards, which ADR-0015 forbids and
  which would make the `GET` that follows a `PUT` a lie.
- **Accept only a policy equal to the compiled one.** Rejected: a `PUT` that can only re-send what
  it just read is not "replaceable," and fails the issue's own acceptance criteria.
- **A separate `agent_policies` table**, one optional row per agent. Rejected: a one-to-one table
  needs its own tenant-pairing constraints and cascade for no expressiveness a jsonb column parsed
  through a schema does not already have — the same trade-off `agents.permissions` already made.
- **Let a stored policy replace the permission-derived `deny` outright.** Rejected: this is the one
  alternative that would have made a Builder's `PUT` capable of widening an agent past the
  checkboxes an Owner configured through the UI, silently, the next time a run composed it.

## Consequences

- **Migration is additive and reversible.** One nullable jsonb column; `ALTER TABLE agents DROP
  COLUMN policy` loses only policies written after a rollback, never a row written by an earlier
  release. Compatible with a running deployment that has not yet been redeployed: old code never
  selects the column.
- **Two sources of truth for tool rules exist**, mitigated by the read-time union above and by
  `apps/web/server/compose/run-request.test.ts`'s regression that a stored policy cannot re-grant
  a tool `permissions` denies. If that union is ever dropped from `agentConfigFor`, a Builder could
  widen an agent past its own permission checkboxes through the policy route — the one invariant
  this ADR exists to keep visible.
- **A Viewer can read a policy.** The `agents`/`policy` sub-resource inherits its parent's §21
  grants (`apps/web/server/rbac/declarations/SDK-02-AGENT-POLICY-234.ts`), and Viewer already has
  `agents: read 'any'`. The policy carries no credential, so this is consistent with a Viewer
  already reading the agent, but it is a widening of what a Viewer can see worth naming here.
