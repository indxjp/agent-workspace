# ADR-FORMAL-P1-every-source-has-a-principal — Every membership and every API key has its principal

Status: proposed
Date: 2026-09-23
Decided by: formal specification programme, unit P1-synthesis (`er-synthesis`); needs Owner ratification
Scope: `packages/core/src/db/schema/workspace-principals.ts`, `packages/core/src/db/repositories/directory.ts`

## Context

RF-101 (`docs/architecture/refactoring/claude-agent-workspace-refactoring-plan.md`): "_Backfill one
human principal per Membership and one machine principal per APIKey_". The schema guarantees at
most one principal per source (`workspace_principals_workspace_{membership,api_key}_key`) but not
at least one; the repositories create the pair in one transaction, so this is an unenforced
invariant, not an observed defect (identity finding 3). A member without a principal cannot sign in
and cannot be granted anything by principal.
`AgentWorkspace.Theorems.Refinement.ErSynthesis.diverges_at_a_source_without_principal` exhibits the
consistent state today's schema admits.

## Decision

Make source coverage a database invariant (`AgentWorkspace.Er.Current.Identity.everySourceHasPrincipal`,
a state invariant of `AgentWorkspace.Er.Target.consistent`): a deferrable constraint trigger on
`memberships` and `api_keys` that requires the matching `workspace_principals` row at commit.

## Alternatives considered

- **Invert the reference**: `memberships.principal_id` and `api_keys.principal_id NOT NULL`,
  tenant-paired. Declarative, but it creates a second reference cycle beside the existing
  principal → source key, and both directions must be deferred.
- **Leave it to the repositories.** Today's state; the formal model then keeps it as an assumption
  of every theorem that needs it (`Invariants.ConceptCatalog.grants_round_trip`).

## Consequences

- The commit-time check composes with the reachability theorems of `Theorems/Invariants/ErSynthesis.lean`:
  a transaction that leaves a source without a principal rolls back.
- Tests that insert a membership alone must insert its principal in the same transaction.
