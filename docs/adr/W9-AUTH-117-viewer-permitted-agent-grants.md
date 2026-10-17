# ADR-W9-AUTH-117-viewer-permitted-agent-grants — `agent_grants`, and closing `decide()`'s `permitted` case

Status: accepted
Date: 2026-09-11
Decided by: W9-AUTH-117
Scope: `packages/core/src/db/schema/agent-grants.ts`, `packages/core/src/db/repositories/agent-grants.ts`, `apps/web/server/rbac/decide.ts`, `apps/web/server/agents/{run-ownership,agent-grants-store}.ts`

## Context

`docs/adr/W2-CP-06-the-four-roles-and-their-permission-split.md` left Viewer's "run permitted
agents" clause denying unconditionally, naming the reason in `permissions.ts`'s own header:
*"neither §21 nor §27's table list contains a mechanism that could populate it."* Issue #117's
card is that mechanism: *"add one `agent_grants(workspace_id, agent_id, user_id)` table…
`permitted` resolves against `agent_grants` for Viewers on the run operation, and against nothing
else. Membership removal is enforced by the composite FK, so revocation is `ON DELETE CASCADE`
rather than a background job."*

`decide.ts`'s `Ownership` type (`'own' | 'other' | 'unknown' | 'not-applicable'`) had no member for
"an explicit grant names this caller" — `Grant`'s own `'permitted'` value is a **policy width**
(what a role *may* have), not a fact about one request, and conflating the two would make
`applyGrant`'s `case 'permitted':` unable to tell "the mechanism does not exist" from "the
mechanism exists and said no."

## Decision

`agent_grants` is a join table shaped exactly like `agent_files`/`agent_skills`
(`packages/core/src/db/schema/agent-files.ts`'s header is the template): `workspace_id`, `agent_id`
and `user_id` all tenant-paired the same way, a `unique(workspace_id, agent_id, user_id)` natural
key, and **no `access` column** — §21's clause is binary, so there is nothing to widen or narrow.
`agent_id` cascades on the agent's own deletion (a grant on a row that no longer exists is not a
fact about anything); `user_id`, paired with `workspace_id` against
`memberships(workspace_id, user_id)`, cascades **on the membership's deletion** — this is the
literal mechanism the card names, and it is why revocation needs no cleanup job: the row is gone
in the same transaction that removes the membership.

`Ownership` gains a fifth value, `'permitted'` — a caller-established *fact* ("an `agent_grants`
row names this caller and this row"), read the same way `'own'` already is. `applyGrant`'s
`case 'permitted':` (the *policy width*) now allows exactly when `ownership === 'permitted'`, and
denies with a named reason otherwise (`'other'` → "not one of the rows a grant names"; anything
else → the ADR-0031 "undetermined denies" reading, unchanged).

The repository (`packages/core/src/db/repositories/agent-grants.ts`) exposes exactly one read,
`hasGrant(agentId, userId): Promise<boolean>` — no create, list or delete. The card's own
"Deliberately not built" list is explicit that no grant-management API is in scope for this task
("No grants for files, skills or connectors" — and, by the same reasoning applied to the one
resource that does get a table, no CRUD surface for it either); a grant is populated today by
direct database access, the same way the verifier attack for this card describes proving it
("Insert the grant… Delete the Viewer's membership").

## Alternatives considered

- **A boolean or enum on `agents` naming "who may run this."** Rejected: §21's clause is
  per-(agent, user), and a single column on `agents` cannot name more than one Viewer.
- **Widening `Grant`'s existing `'permitted'` value's meaning instead of adding an `Ownership`
  member.** Rejected: `Grant` answers "how wide is this role's window", a `POLICY`-table constant;
  `Ownership` answers "what is true about this specific row for this specific caller." Merging them
  would make `applyGrant` unable to express "the role has this width, but the row does not qualify"
  separately from "no role has this width at all" — the exact distinction `case 'permitted':`'s
  existing comment already draws between `Grant` and the caller's fact.
- **A CRUD API for `agent_grants`** (e.g. `PUT /api/agents/:id/grants`). Considered and declined:
  it is the elaboration the card's "Deliberately not built" section rules out, and no route
  declaration or sub-resource classification names it.

## Consequences

- A Viewer's "permitted" run check now costs one extra read (`hasGrant`) beyond the agent lookup
  `resolveAgentRunOwnership` already does for the "own" check — acceptable, and consistent with
  every other ownership check this task adds.
- Grant management remains entirely a database operation until a later task (if ever) adds an API
  — declared explicitly, not silently, in the card's own "Deliberately not built" and repeated on
  this task's PR body.
- `agentGrants` on `apps/web/server/agents/runtime.ts`'s `AgentsRuntime` is optional: when a
  composition root has not wired it, `resolveAgentRunOwnership` answers `'other'` rather than
  `'permitted'` for a genuinely granted Viewer — a stricter default (over-refusal, never
  over-grant), matching ADR-0031's "undecidable means refused." See
  `docs/adr/W9-AUTH-117-out-of-globs-run-ownership-and-collateral-fixes.md` for the composition-root
  wiring this task did and did not do.
