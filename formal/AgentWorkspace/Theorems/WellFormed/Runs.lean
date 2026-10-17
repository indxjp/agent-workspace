import AgentWorkspace.Contracts.Runs

/-! T0 — the run status codec and enumeration are well formed. -/

namespace AgentWorkspace.Theorems.WellFormed.Runs

open AgentWorkspace AgentWorkspace.Contracts

/-- Decoding the JSON encoding of any run status gives that status back. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#RUN_STATUSES")]
theorem run_status_json_round_trips (s : RunStatus) :
    WireEnum.fromJsonValue? (WireEnum.toJsonValue s) = some s :=
  WireEnum.fromJsonValue?_toJsonValue s

/-- The wire spellings are exactly `RUN_STATUSES`, in its order. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#RUN_STATUSES")]
theorem run_status_wires_match_contract :
    WireEnum.wires RunStatus = ["queued", "running", "completed", "failed", "cancelled"] := by
  decide

/-- A string that is not one of the five spellings decodes to no status. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#RUN_STATUSES")]
theorem run_status_rejects_unknown_spelling (s : String)
    (h : s ∉ ["queued", "running", "completed", "failed", "cancelled"]) :
    WireEnum.ofWire? (α := RunStatus) s = none := by
  rw [WireEnum.ofWire?_eq_none_iff, run_status_wires_match_contract]
  exact h

/-- `isTerminalRunStatus` holds exactly for the members of `TERMINAL_RUN_STATUSES`. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#isTerminalRunStatus")
  (ts := "packages/contracts/src/runs.ts#TERMINAL_RUN_STATUSES")]
theorem is_terminal_iff_mem_terminal (s : RunStatus) :
    s.isTerminal = true ↔ s ∈ RunStatus.terminal := by
  cases s <;> decide

end AgentWorkspace.Theorems.WellFormed.Runs
