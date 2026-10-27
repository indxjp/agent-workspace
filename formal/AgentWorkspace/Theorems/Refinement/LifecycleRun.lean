import AgentWorkspace.Lifecycle.Run

namespace AgentWorkspace.Theorems.Refinement.LifecycleRun

open AgentWorkspace.Contracts AgentWorkspace.Lifecycle

/-- Interrupt and launcher finish under one per-run commit, so only the winner publishes. -/
@[aw_spec (tier := T4)
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#the-event-stream")
  (ts := "apps/web/server/composition/wiring/run-api.ts#interruptRun")
  (ts := "apps/web/server/runs/launcher.ts#createRunnerLauncher")]
theorem interrupt_conclude_race_agrees :
    let current := runActions ({} : RunState)
      [.finishWithStatusEvent .cancelled 1, .finishWithStatusEvent .completed 1]
    current.status = .cancelled ∧
      current.terminalEvents = [.cancelled] ∧
      terminalEventAgrees current := by
  simp [terminalEventAgrees, runActions, runAction, RunStatus.isTerminal]

/-- The target pairs the sole terminal event with the status that committed. -/
@[aw_spec (tier := T4)
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#the-event-stream")
  (ts := "apps/web/server/runs/launcher.ts#createRunnerLauncher")]
theorem serialized_terminal_target_agrees :
    let target := terminalCommitTarget
      (terminalCommitTarget ({} : RunState) .cancelled 1) .completed 1
    terminalEventAgrees target := by
  simp [terminalEventAgrees, terminalCommitTarget, runAction, RunStatus.isTerminal]

end AgentWorkspace.Theorems.Refinement.LifecycleRun
