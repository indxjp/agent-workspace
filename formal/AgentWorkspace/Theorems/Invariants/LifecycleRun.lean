import AgentWorkspace.Lifecycle.Run
import AgentWorkspace.Lifecycle.RunAccounting

namespace AgentWorkspace.Theorems.Invariants.LifecycleRun

open AgentWorkspace.Contracts AgentWorkspace.Lifecycle AgentWorkspace.Concepts.Usage

/-- A store-created run keeps the terminal timestamp, stream closure and gateway-token
revocation coupled to its terminal status. -/
private def lifecycleInvariant (s : RunState) : Prop :=
  s.endedAt.isSome = s.status.isTerminal ∧
  s.logClosed = s.status.isTerminal ∧
  s.runTokenRevoked = s.status.isTerminal

private theorem action_preserves_invariant (s : RunState) (h : lifecycleInvariant s)
    (action : RunAction) : lifecycleInvariant (runAction s action) := by
  cases action with
  | markRunning elapsed =>
    by_cases hs : s.status = .queued
    · simp_all [runAction, lifecycleInvariant, RunStatus.isTerminal]
    · simpa [runAction, hs] using h
  | appendRunning =>
    by_cases hc : s.logClosed
    · simpa [runAction, hc] using h
    · simpa [runAction, hc, lifecycleInvariant] using h
  | appendTerminal target =>
    by_cases hc : target.isTerminal && !s.logClosed
    · simpa [runAction, hc, lifecycleInvariant] using h
    · simpa [runAction, hc] using h
  | finish target elapsed =>
    by_cases hc : target.isTerminal && !s.status.isTerminal
    · simp_all [runAction, lifecycleInvariant]
    · simpa [runAction, hc] using h
  | finishWithStatusEvent target elapsed =>
    by_cases hc : target.isTerminal && !s.status.isTerminal
    · simp_all [runAction, lifecycleInvariant]
    · simpa [runAction, hc] using h
  | revokeBrowserTokens => simpa [runAction, lifecycleInvariant] using h
  | signalRuntime => simpa [runAction, lifecycleInvariant] using h

private theorem sequence_preserves_invariant (s : RunState) (h : lifecycleInvariant s)
    (actions : List RunAction) : lifecycleInvariant (runActions s actions) := by
  induction actions generalizing s with
  | nil => exact h
  | cons action rest ih =>
    simp only [runActions, List.foldl_cons]
    exact ih (runAction s action) (action_preserves_invariant s h action)

/-- Every sequence from creation has an end stamp exactly when terminal, a closed log, and
revoked gateway run tokens at the same transition. -/
@[aw_spec (tier := T2)
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#from-start-to-a-terminal-status")
  (ts := "apps/web/server/runs/memory-store.ts#InMemoryRunStore")
  (ts := "packages/core/src/db/repositories/runs.ts#finish")]
theorem every_sequence_closes_at_terminal (actions : List RunAction) :
    let s := runActions ({} : RunState) actions
    s.endedAt.isSome = s.status.isTerminal ∧
      s.logClosed = s.status.isTerminal ∧
      s.runTokenRevoked = s.status.isTerminal := by
  change lifecycleInvariant (runActions ({} : RunState) actions)
  exact sequence_preserves_invariant {} (by simp [lifecycleInvariant, RunStatus.isTerminal]) actions

/-- Every accepted new response recomputes the state from the complete response ledger. -/
@[aw_spec (tier := T2)
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#usage-cost-and-accounting")
  (ts := "packages/core/src/db/repositories/runs.ts#recordUsage")]
theorem new_settlement_recomputes_state (a : RunAccounting) (priced : Bool) :
    (recordAccounting a priced true).state =
      accountingFromLedger (a.ledger ++ [priced]) := by
  simp [recordAccounting]

/-- A duplicate provider response leaves both the ledger and aggregate accounting unchanged. -/
@[aw_spec (tier := T2)
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#usage-cost-and-accounting")
  (ts := "packages/core/src/db/repositories/runs.ts#recordUsage")]
theorem duplicate_settlement_is_noop (a : RunAccounting) (priced : Bool) :
    recordAccounting a priced false = a := by
  simp [recordAccounting]

/-- A failed settlement cannot overwrite an accounting state already derived from responses. -/
@[aw_spec (tier := T2)
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#usage-cost-and-accounting")
  (ts := "packages/core/src/db/repositories/runs.ts#markAccountingFailed")]
theorem failure_preserves_settled_accounting (a : RunAccounting)
    (h : a.state ≠ .pending) : failAccounting a = a := by
  simp [failAccounting, h]

/-- A duplicate unpriced response leaves a mixed ledger partial and unchanged. -/
example : recordAccounting
    { ledger := [true, false], state := .«partial» } false false =
    { ledger := [true, false], state := .«partial» } := by
  exact duplicate_settlement_is_noop _ false

end AgentWorkspace.Theorems.Invariants.LifecycleRun
