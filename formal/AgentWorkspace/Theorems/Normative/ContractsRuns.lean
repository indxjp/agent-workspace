import AgentWorkspace.Theorems.WellFormed.ContractsRuns

namespace AgentWorkspace.Theorems.Normative.ContractsRuns

open AgentWorkspace AgentWorkspace.Contracts.Runs

/-- SPEC §5.12: the 202 body is a run plus a nonempty stream path. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#512-runs-and-the-event-stream--awruns")
  (ts := "packages/contracts/src/runs.ts#StartRunResponseSchema")]
theorem start_202_contract :
    startRunResponse = object [("run", runResource), ("events", stringMin 1)] := rfl

/-- The list envelope uses `runs`, with a nullable opaque cursor. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#512-runs-and-the-event-stream--awruns")
  (ts := "packages/contracts/src/runs.ts#RunListResponseSchema")]
theorem list_envelope_refuses_items_key :
    runListResponse (.obj [("items", .arr []), ("nextCursor", .null)]) = false := by decide +kernel

/-- A cursor is opaque to this response schema but must be nonempty when present. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#512-runs-and-the-event-stream--awruns")
  (ts := "packages/contracts/src/runs.ts#RunListResponseSchema")]
theorem list_envelope_refuses_empty_cursor :
    runListResponse (.obj [("runs", .arr []), ("nextCursor", .str "")]) = false := by decide +kernel

end AgentWorkspace.Theorems.Normative.ContractsRuns
