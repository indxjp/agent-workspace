import AgentWorkspace.Theorems.Invariants.CliRuns

namespace AgentWorkspace.Theorems.Refinement.CliRuns

open AgentWorkspace AgentWorkspace.Cli.Runs

/-- A failed or cancelled settled run currently exits zero; the documented outcome target differs. -/
@[aw_spec (tier := T4) (doc := "docs/sdk/site/cli/output-and-exit-codes.mdx#exit-codes")
  (ts := "packages/aw/src/commands/runs.ts#runs wait")]
theorem failed_wait_exit_diverges :
    waitExitCurrent .failed = 0 ∧ waitExitCurrent .cancelled = 0 ∧
    waitExitTarget .failed = 1 ∧ waitExitTarget .cancelled = 1 := by decide

end AgentWorkspace.Theorems.Refinement.CliRuns
