import AgentWorkspace.Lifecycle.Run

/-! T1 — documented run lifecycle sentences. -/

namespace AgentWorkspace.Theorems.Normative.Runs

open AgentWorkspace.Contracts AgentWorkspace.Lifecycle

/-- "`queued` and `running` are live; the other three are terminal." -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#from-start-to-a-terminal-status")
  (ts := "packages/contracts/src/runs.ts#TERMINAL_RUN_STATUSES")]
theorem live_and_terminal_statuses :
    RunStatus.queued.isTerminal = false ∧ RunStatus.running.isTerminal = false ∧
    RunStatus.completed.isTerminal ∧ RunStatus.failed.isTerminal ∧
    RunStatus.cancelled.isTerminal := by
  decide +kernel

/-- A run moves to `running` only from `queued`, and `markRunning` on a queued run always moves
it (so `startedAt` is stamped exactly once). -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#from-start-to-a-terminal-status")
  (ts := "packages/core/src/db/repositories/runs.ts#markRunning")]
theorem running_is_entered_only_from_queued (s t : RunStatus) :
    runStep s .markRunning = .moved t ↔ s = .queued ∧ t = .running := by
  cases s <;> cases t <;> decide +kernel

/-- The documented edges `queued → running → {completed, failed, cancelled}` are all admitted. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#from-start-to-a-terminal-status")]
theorem documented_run_edges_are_admitted :
    RunTransition .queued .running ∧ RunTransition .running .completed ∧
    RunTransition .running .failed ∧ RunTransition .running .cancelled :=
  ⟨⟨.markRunning, rfl⟩, ⟨.finish .completed, rfl⟩, ⟨.finish .failed, rfl⟩,
    ⟨.finish .cancelled, rfl⟩⟩

/-- Today's stores also let a `queued` run finish directly (a cancel before the runtime claims
it). The docs page leaves this open; finding F-001 records it. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#open-questions")
  (ts := "packages/core/src/db/repositories/runs.ts#finish")]
theorem queued_run_may_finish_directly (t : RunStatus) (h : t.isTerminal = true) :
    RunTransition .queued t :=
  ⟨.finish t, by cases t <;> simp_all [runStep, RunStatus.isTerminal]⟩

/-- `finish` with a live target is refused as a programming error, never applied. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/repositories/runs.ts#finish")
  (ts := "apps/web/server/runs/memory-store.ts#InMemoryRunStore")]
theorem finish_requires_terminal_target (s t : RunStatus) (h : t.isTerminal = false) :
    runStep s (.finish t) = .invalidCall := by
  simp [runStep, h]

end AgentWorkspace.Theorems.Normative.Runs
