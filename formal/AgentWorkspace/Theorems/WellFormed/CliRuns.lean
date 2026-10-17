import AgentWorkspace.Cli.Runs

namespace AgentWorkspace.Theorems.WellFormed.CliRuns

open AgentWorkspace AgentWorkspace.Cli.Runs

/-- The seven implemented run commands have distinct command identities. -/
@[aw_spec (tier := T0) (ts := "packages/aw/src/commands/runs.ts#runCommands")]
theorem commands_are_exact :
    commands = [.start, .get, .list, .events, .follow, .interrupt, .wait] := rfl

/-- Prompt sources are exclusive, and the dash file path selects stdin. -/
@[aw_spec (tier := T0) (ts := "packages/aw/src/commands/runs.ts#promptOf")]
theorem prompt_source_cases :
    promptSource false false "" = .missing ∧
    promptSource true true "file" = .conflict ∧
    promptSource false true "-" = .stdin ∧
    promptSource false true "file" = .file := by decide

/-- A failed path read is a usage failure; stdin does not attempt that path read. -/
@[aw_spec (tier := T0) (ts := "packages/aw/src/commands/runs.ts#promptOf")]
theorem unreadable_prompt_file_is_usage :
    promptFileFailure .file false = true ∧
    promptFileFailure .stdin false = false := by decide

/-- The model flag splits at the first colon and requires both sides. -/
@[aw_spec (tier := T0) (ts := "packages/aw/src/commands/runs.ts#modelOverride")]
theorem model_override_cases :
    modelOverride "conn:model:variant" = some ("conn", "model:variant") ∧
    modelOverride "conn:" = none ∧ modelOverride ":model" = none ∧
    modelOverride "missing" = none := by decide

/-- Raw stream output wins over structured flags; JSONL wins for record output. -/
@[aw_spec (tier := T0) (ts := "packages/aw/src/stream.ts#renderFrame")
  (ts := "packages/aw/src/output.ts#writeResult")]
theorem output_mode_precedence :
    streamOutputMode true true true = .raw ∧
    streamOutputMode false true false = .jsonl ∧
    recordOutputMode true true = .jsonl ∧
    recordOutputMode true false = .json := by decide

/-- The public exit-code table and its failure priority are exact. -/
@[aw_spec (tier := T0) (ts := "packages/aw/src/output.ts#EXIT_CODE")
  (ts := "packages/aw/src/output.ts#reportFailure")]
theorem exit_code_table :
    exitCode false none = 0 ∧
    exitCode false (some .apiProblem) = 1 ∧
    exitCode false (some .usage) = 2 ∧
    exitCode false (some .contractViolation) = 3 ∧
    exitCode false (some .transport) = 4 ∧
    exitCode true (some .contractViolation) = 130 := by decide

/-- API details follow the headline, while interruption suppresses every other failure line. -/
@[aw_spec (tier := T0) (ts := "packages/aw/src/output.ts#reportFailure")]
theorem error_stderr_order :
    reportLines false .apiProblem "conflict" "try later" ["field: bad"] =
      ["error: conflict: try later", "  field: bad"] ∧
    reportLines true .apiProblem "conflict" "try later" ["field: bad"] =
      ["interrupted"] := by decide

end AgentWorkspace.Theorems.WellFormed.CliRuns
