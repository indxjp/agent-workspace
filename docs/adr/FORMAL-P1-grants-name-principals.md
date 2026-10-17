# ADR-FORMAL-P1-grants-name-principals — A grant names the member's principal, not its user id

Status: proposed
Date: 2026-09-23
Decided by: formal specification programme, unit P1-synthesis (`er-synthesis`); needs Owner ratification
Scope: `packages/core/src/db/schema/agent-grants.ts`, `packages/core/src/db/repositories/agent-grants.ts`, `apps/web/server/agents/run-ownership.ts`

## Context

`docs/sdk/site/concepts/workspaces-and-principals.mdx` says "_Authorisation always compares
principals, never user ids_". `agent_grants` stores the membership's `user_id`, keyed
`(workspace_id, user_id) → memberships`, and the run check reads it by user
(`hasGrant(agentId, principal.userId)`), while the wire (`principalIds`) and the documents speak of
membership principals. The round trip `listPrincipalIds ∘ replacePrincipalIds` holds only while each
user has exactly one principal (catalog finding 6). The Lean target
(`AgentWorkspace.Er.Target.schema`) re-keys the table, and
`AgentWorkspace.Theorems.Refinement.ErSynthesis.diverges_at_a_grant_without_principal` shows a state
today's schema admits (a grant held by a member with no principal) that the target refuses.

## Decision

Replace `agent_grants.user_id` by `principal_id uuid NOT NULL`, with the tenant-paired key
`agent_grants_principal_workspace_fk (workspace_id, principal_id) → workspace_principals
(workspace_id, id) ON DELETE CASCADE` and the unique key `(workspace_id, agent_id, principal_id)`.
Migrate each row to the principal of its user's membership in the grant's workspace
(`AgentWorkspace.Er.Refinement.principalOfUser`). `hasGrant` compares principal ids.

## Alternatives considered

- **Keep the user id and document the exception.** Cheaper, but the grant would remain the one
  authorisation input that is not a principal, and a revoked principal would keep a hidden grant
  (`Meta.ConceptCatalog.revoked_principal_keeps_a_hidden_grant`).
- **Store both.** Two keys for one fact invite them to disagree.

## Consequences

- The target proves `target_grant_names_one_principal_of_its_workspace`: a grant names exactly one
  principal, of its own workspace. `every_tenancy_constraint_is_kept` shows the tenant pairing of
  the old key survives in the new one.
- The migration needs every granted member to have a principal first, which
  [FORMAL-P1-every-source-has-a-principal](FORMAL-P1-every-source-has-a-principal.md) guarantees.
- `tests/formal/er-synthesis.test.ts` pins today's key (`changed-key/agent_grants/…`) and fails when
  this lands, so the Lean model is updated with the migration.
