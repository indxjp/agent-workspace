import AgentWorkspace.Lifecycle.Run

/-! T2 — invariants of the run status machine over every operation sequence. -/

namespace AgentWorkspace.Theorems.Invariants.Runs

open AgentWorkspace.Contracts AgentWorkspace.Lifecycle

/-- A single operation never moves a terminal run. -/
private theorem terminal_run_step_is_noop (s : RunStatus) (h : s.isTerminal = true) (op : RunOp) :
    applyRunOp s op = s := by
  cases op with
  | markRunning => cases s <;> simp_all [applyRunOp, runStep, RunStatus.isTerminal]
  | finish t =>
    cases ht : t.isTerminal <;> simp [applyRunOp, runStep, ht, h]

/-- A terminal run's status never changes, whatever sequence of operations follows
("first terminal transition wins"). -/
@[aw_spec (tier := T2)
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#from-start-to-a-terminal-status")
  (ts := "packages/core/src/db/repositories/runs.ts#finish")
  (ts := "apps/web/server/runs/memory-store.ts#InMemoryRunStore")]
theorem run_terminal_is_absorbing (s : RunStatus) (h : s.isTerminal = true) (ops : List RunOp) :
    applyRunOps s ops = s := by
  induction ops generalizing s with
  | nil => rfl
  | cons op rest ih =>
    simp only [applyRunOps, List.foldl_cons] at *
    rw [terminal_run_step_is_noop s h op]
    exact ih s h

/-- No reachable status is ever left for `queued`: once a run has left `queued` it never
returns. -/
@[aw_spec (tier := T2)
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#from-start-to-a-terminal-status")
  (ts := "packages/core/src/db/repositories/runs.ts#markRunning")]
theorem run_never_returns_to_queued (s : RunStatus) (h : s ≠ .queued) (ops : List RunOp) :
    applyRunOps s ops ≠ .queued := by
  induction ops generalizing s with
  | nil => exact h
  | cons op rest ih =>
    simp only [applyRunOps, List.foldl_cons] at *
    apply ih
    cases op with
    | markRunning => cases s <;> simp_all [applyRunOp, runStep]
    | finish t =>
      cases s <;> cases t <;> simp_all [applyRunOp, runStep, RunStatus.isTerminal]

end AgentWorkspace.Theorems.Invariants.Runs
