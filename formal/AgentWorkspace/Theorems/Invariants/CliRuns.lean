import AgentWorkspace.Theorems.Normative.CliRuns

namespace AgentWorkspace.Theorems.Invariants.CliRuns

open AgentWorkspace AgentWorkspace.Cli.Runs

/-- Each typed SDK error class determines one CLI exit code regardless of command. -/
@[aw_spec (tier := T2) (ts := "packages/aw/src/output.ts#reportFailure")]
theorem typed_failure_exit_is_command_independent (first second : Command) (failure : Failure) :
    commandExit first false (some failure) =
      commandExit second false (some failure) := by rfl

/-- SDK transport, API and contract failures retain their three distinct CLI exit classes. -/
@[aw_spec (tier := T2) (ts := "packages/aw/src/output.ts#reportFailure")]
theorem sdk_failure_maps_to_exit :
    exitCode false (some (fromSdkFailure (.transport false))) = 4 ∧
    exitCode false (some (fromSdkFailure (.apiProblem 409 "conflict"))) = 1 ∧
    exitCode false (some (fromSdkFailure .contractViolation)) = 3 := by decide +kernel

/-- SIGINT wins over every error classification, including a failed courtesy interrupt. -/
@[aw_spec (tier := T2) (ts := "packages/aw/src/output.ts#reportFailure")]
theorem sigint_exit_priority (failure : Option Failure) :
    exitCode true failure = 130 := by cases failure <;> rfl

/-- The courtesy interrupt's own outcome cannot replace the original interrupt exit. -/
@[aw_spec (tier := T2) (ts := "packages/aw/src/commands/runs.ts#interrupt-on-cancel")]
theorem courtesy_interrupt_preserves_exit (succeeded : Bool) :
    interruptedExitAfterCourtesy succeeded = 130 := rfl

/-- Conflicting start flags stop command routing before any SDK request. -/
@[aw_spec (tier := T2) (ts := "packages/aw/src/commands/runs.ts#start")]
theorem conflicting_start_flags_make_no_sdk_calls :
    startCalls (startMode true true) = [] := by decide +kernel

end AgentWorkspace.Theorems.Invariants.CliRuns
