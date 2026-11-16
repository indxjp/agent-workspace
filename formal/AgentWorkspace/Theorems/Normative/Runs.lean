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
  (ts := "packages/core/src/db/repositories/runs/lifecycle.ts#markRunning")]
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
  (ts := "packages/core/src/db/repositories/runs/lifecycle.ts#finish")]
theorem queued_run_may_finish_directly (t : RunStatus) (h : t.isTerminal = true) :
    RunTransition .queued t :=
  ⟨.finish t, by
    cases t <;> simp_all [runStep, runMayMove, runStatusesThatMayMoveTo, RunStatus.isTerminal]⟩

/-- `finish` with a live target is refused as a programming error, never applied. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/repositories/runs/lifecycle.ts#finish")
  (ts := "apps/web/server/runs/memory-store.ts#InMemoryRunStore")]
theorem finish_requires_terminal_target (s t : RunStatus) (h : t.isTerminal = false) :
    runStep s (.finish t) = .invalidCall := by
  simp [runStep, h]

/-- A paused run resolves only to `completed` or `cancelled`; `finish failed` leaves it paused.
PostgreSQL and the in-memory store read the same rule (ADR-0145). -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#from-start-to-a-terminal-status")
  (ts := "packages/core/src/runs/transitions.ts#runStatusesThatMayMoveTo")]
theorem paused_run_finishes_only_completed_or_cancelled (t : RunStatus) :
    RunTransition .awaitingApproval t ↔ t = .completed ∨ t = .cancelled := by
  constructor
  · rintro ⟨op, h⟩
    cases op with
    | markRunning => simp [runStep, runMayMove, runStatusesThatMayMoveTo] at h
    | finish x =>
      cases x <;> cases t <;>
        simp [runStep, runMayMove, runStatusesThatMayMoveTo, RunStatus.isTerminal] at h ⊢
  · rintro (rfl | rfl)
    · exact ⟨.finish .completed, rfl⟩
    · exact ⟨.finish .cancelled, rfl⟩

/-- `finish` with a terminal target moves the run exactly when the shared transition rule
(`runStatusesThatMayMoveTo`) lists its status. -/
@[aw_spec (tier := T1)
  (ts := "packages/core/src/runs/transitions.ts#runMayMove")
  (ts := "packages/core/src/db/repositories/runs/lifecycle.ts#finish")
  (ts := "apps/web/server/runs/memory-store.ts#InMemoryRunStore")]
theorem finish_moves_iff_the_rule_allows (s t : RunStatus) (h : t.isTerminal = true) :
    runStep s (.finish t) = .moved t ↔ runMayMove s t = true := by
  cases s <;> cases t <;>
    simp_all [runStep, runMayMove, runStatusesThatMayMoveTo, RunStatus.isTerminal]

/-- A paused run that a decision finishes keeps the end time of its pause
(`coalesce(ended_at, now())`). -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#from-start-to-a-terminal-status")
  (ts := "packages/core/src/db/repositories/runs/lifecycle.ts#finish")]
theorem paused_run_keeps_its_end_time (s : RunState) (e elapsed : Nat)
    (hs : s.status = .awaitingApproval) (he : s.endedAt = some e) (t : RunStatus)
    (ht : t = .completed ∨ t = .cancelled) :
    (runAction s (.finish t elapsed)).status = t ∧
      (runAction s (.finish t elapsed)).endedAt = some e := by
  rcases ht with rfl | rfl <;>
    simp [runAction, hs, he, runMayMove, runStatusesThatMayMoveTo, RunStatus.isTerminal]

end AgentWorkspace.Theorems.Normative.Runs
