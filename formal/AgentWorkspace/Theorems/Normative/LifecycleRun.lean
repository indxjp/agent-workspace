import AgentWorkspace.Lifecycle.Run
import AgentWorkspace.Lifecycle.RunAccounting

namespace AgentWorkspace.Theorems.Normative.LifecycleRun

open AgentWorkspace.Contracts AgentWorkspace.Lifecycle AgentWorkspace.Concepts.Usage

/-- Creation starts queued, with neither timestamp nor a closed stream. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#from-start-to-a-terminal-status")
  (ts := "apps/web/server/runs/memory-store.ts#InMemoryRunStore")]
theorem created_run_fields :
    ({} : RunState).status = .queued ∧ ({} : RunState).startedAt = none ∧
    ({} : RunState).endedAt = none ∧ ({} : RunState).logClosed = false := by
  decide +kernel

/-- A queued run can finish directly; that transition stamps both times and closes the log. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#from-start-to-a-terminal-status")
  (ts := "apps/web/server/runs/memory-store.ts#InMemoryRunStore")]
theorem queued_finish_stamps_both :
    let done := runAction ({} : RunState) (.finish .cancelled 7)
    done.status = .cancelled ∧ done.startedAt = some 7 ∧ done.endedAt = some 7 ∧
      done.logClosed ∧ done.runTokenRevoked := by
  decide +kernel

/-- Once finish closes the log, a later terminal append cannot add an event. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#the-event-stream")
  (ts := "apps/web/server/runs/memory-store.ts#InMemoryRunStore")]
theorem append_after_finish_is_refused :
    let done := runAction ({} : RunState) (.finish .completed 2)
    (runAction done (.appendTerminal .failed)).terminalEvents = done.terminalEvents := by
  decide +kernel

/-- Marking the run twice leaves the original start stamp intact. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#from-start-to-a-terminal-status")
  (ts := "apps/web/server/runs/memory-store.ts#InMemoryRunStore")]
theorem mark_running_stamps_once :
    (runActions ({} : RunState) [.markRunning 3, .markRunning 9]).startedAt = some 3 := by
  decide +kernel

/-- Interrupt revokes browser tokens and signals the runtime after the record is terminal. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/SDK-03-RUN-235-an-interrupt-is-a-control-plane-transition.md#decision")
  (ts := "apps/web/server/composition/wiring/run-api.ts#interruptRun")]
theorem interrupt_effects :
    let done := runActions ({} : RunState) (interruptActions 2)
    done.status = .cancelled ∧ done.terminalEvents = [.cancelled] ∧
      done.runTokenRevoked ∧ done.browserTokenRevoked ∧ done.runtimeSignalled := by
  decide +kernel

/-- The control plane commits terminal state and event, revokes browser tokens, then signals. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/SDK-03-RUN-235-an-interrupt-is-a-control-plane-transition.md#decision")
  (ts := "apps/web/server/composition/wiring/run-api.ts#interruptRun")]
theorem interrupt_effect_order (elapsed : Nat) :
    interruptActions elapsed =
      [.finishWithStatusEvent .cancelled elapsed,
       .revokeBrowserTokens, .signalRuntime] := by
  rfl

/-- The route admits live runs and refuses every terminal status. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/resources/runs.mdx#interrupt")
  (ts := "apps/web/server/runs/api.ts#interruptRun")]
theorem interrupt_refuses_terminal :
    interruptDecision ({ status := .queued } : RunState) = .accepted ∧
    interruptDecision ({ status := .running } : RunState) = .accepted ∧
    interruptDecision ({ status := .completed } : RunState) = .runNotInterruptible ∧
    interruptDecision ({ status := .failed } : RunState) = .runNotInterruptible ∧
    interruptDecision ({ status := .cancelled } : RunState) = .runNotInterruptible := by
  decide +kernel

/-- Normal terminal finish does not revoke browser-token rows; they are a separate table. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "packages/core/src/db/repositories/runs.ts#finish")]
theorem finish_leaves_browser_token_row :
    (runAction ({} : RunState) (.finish .completed 1)).browserTokenRevoked = false := by
  decide +kernel

/-- A preparation failure records running before failed, even without reaching the runtime. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#from-start-to-a-terminal-status")
  (ts := "apps/web/server/runs/launcher.ts#createRunnerLauncher")]
theorem preparation_failure_path :
    let done := runActions ({} : RunState)
      [.markRunning 1, .appendRunning, .finishWithStatusEvent .failed 1]
    done.startedAt = some 1 ∧ done.endedAt = some 2 ∧ done.status = .failed ∧
      done.statusEvents = [.running, .failed] := by
  decide +kernel

/-- Accounting failure can be superseded by a later priced usage settlement. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#usage-cost-and-accounting")
  (ts := "packages/core/src/db/repositories/runs.ts#recordUsage")]
theorem later_settlement_supersedes_failure :
    (recordAccounting (failAccounting {}) true true).state = .complete := by
  decide +kernel

/-- A settlement failure changes only pending accounting. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#usage-cost-and-accounting")
  (ts := "packages/core/src/db/repositories/runs.ts#markAccountingFailed")]
theorem accounting_failure_only_from_pending :
    (failAccounting ({} : RunAccounting)).state = .failed ∧
    (failAccounting (recordAccounting {} true true)).state = .complete := by
  decide +kernel

/-- A late price changes an existing unpriced response into complete accounting. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#usage-cost-and-accounting")
  (ts := "packages/core/src/db/repositories/runs.ts#recordUsage")]
theorem late_pricing_recomputes_accounting :
    let first := recordAccounting {} false true
    first.state = .unavailable ∧
      (priceFirstResponse first).state = .complete ∧
      (priceFirstResponse first).ledger.length = first.ledger.length := by
  decide +kernel

/-- A ledger with one priced and one unpriced response is partial in either arrival order. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#usage-cost-and-accounting")
  (ts := "packages/core/src/db/repositories/runs.ts#recordUsage")]
theorem mixed_ledger_is_partial_in_both_orders :
    let pricedFirst := recordAccounting (recordAccounting {} true true) false true
    let unpricedFirst := recordAccounting (recordAccounting {} false true) true true
    pricedFirst.ledger = [true, false] ∧ pricedFirst.state = .«partial» ∧
      unpricedFirst.ledger = [false, true] ∧ unpricedFirst.state = .«partial» := by
  decide +kernel

/-- Only two different priced catalogue versions refuse settlement. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#usage-cost-and-accounting")
  (ts := "packages/core/src/db/repositories/runs.ts#recordUsage")]
theorem price_version_conflict_requires_two_prices :
    priceVersionConflict (some "v1") (some "v2") ∧
    !priceVersionConflict (some "v1") (some "v1") ∧
    !priceVersionConflict none (some "v2") ∧
    !priceVersionConflict (some "v1") none := by
  decide +kernel

/-- A terminal run can still have pending accounting, then settle without reopening the run. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#usage-cost-and-accounting")
  (ts := "packages/core/src/db/repositories/runs.ts#recordUsage")]
theorem terminal_run_can_settle_later :
    let finished : AccountedRun :=
      { lifecycle := runAction {} (.finish .completed 2), accounting := {} }
    finished.lifecycle.status = .completed ∧ finished.accounting.state = .pending ∧
      (recordAccounting finished.accounting true true).state = .complete := by
  decide +kernel

end AgentWorkspace.Theorems.Normative.LifecycleRun
