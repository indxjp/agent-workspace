import AgentWorkspace.Theorems.Normative.SdkRuns

namespace AgentWorkspace.Theorems.Invariants.SdkRuns

open AgentWorkspace AgentWorkspace.Sdk.Runs

/-- Every successful reconnect increments the cumulative count by exactly one. -/
@[aw_spec (tier := T2) (ts := "packages/sdk/src/resources/runs.ts#follow")]
theorem reconnect_count_increments (state : FollowState) (lastSeen : Option String)
    (maxReconnects : Nat) (h : state.reconnects < maxReconnects) :
    onDrop state lastSeen maxReconnects false (.transport false) =
      .reconnect { after := lastSeen, reconnects := state.reconnects + 1 } := by
  simp [onDrop, Nat.not_le.mpr h]

/-- The reconnect bound stops a dropped stream once the cumulative budget is spent. -/
@[aw_spec (tier := T2) (ts := "packages/sdk/src/resources/runs.ts#follow")]
theorem follow_never_exceeds_reconnect_budget (state : FollowState)
    (maxReconnects : Nat) (h : maxReconnects ≤ state.reconnects) :
    onDrop state state.after maxReconnects false (.transport false) =
      .stop (.transport false) := by simp [onDrop, h]

/-- Any finite sequence of dropped connections stays within the cumulative reconnect budget. -/
@[aw_spec (tier := T2) (ts := "packages/sdk/src/resources/runs.ts#follow")]
theorem repeated_drops_stay_within_budget (maxReconnects drops count : Nat)
    (h : count ≤ maxReconnects) :
    reconnectCount maxReconnects drops count ≤ maxReconnects := by
  unfold reconnectCount
  split
  · exact h
  · exact Nat.min_le_left _ _

/-- Five drops with a budget of two produce exactly two reconnects. -/
@[aw_spec (tier := T2) (ts := "packages/sdk/src/resources/runs.ts#follow")]
theorem reconnect_budget_is_cumulative_witness :
    reconnectCount 2 5 0 = 2 := by decide +kernel

/-- Caller abort blocks reconnection regardless of remaining budget. -/
@[aw_spec (tier := T2) (ts := "packages/sdk/src/resources/runs.ts#follow")]
theorem follow_never_reconnects_after_caller_abort (state : FollowState)
    (maxReconnects : Nat) (failure : Failure) :
    onDrop state state.after maxReconnects true failure = .stop failure := by
  cases failure <;> simp [onDrop]

/-- API and contract errors stop following even with reconnects left. -/
@[aw_spec (tier := T2) (ts := "packages/sdk/src/resources/runs.ts#follow")]
theorem follow_retries_only_transport (state : FollowState) (maxReconnects : Nat) :
    onDrop state state.after maxReconnects false (.apiProblem 404 "run_not_found") =
      .stop (.apiProblem 404 "run_not_found") ∧
    onDrop state state.after maxReconnects false .contractViolation =
      .stop .contractViolation := by simp [onDrop]

/-- An unexpected HTTP status remains an API problem even if its body is malformed. -/
@[aw_spec (tier := T2) (ts := "packages/sdk/src/http.ts#json")]
theorem unexpected_status_precedes_body_validation (expected status : Nat)
    (bodyValid : Bool) (code : String) (h : status ≠ expected) :
    classifyResponse expected status bodyValid code = some (.apiProblem status code) := by
  simp [classifyResponse, h]

/-- A control frame cannot advance the last durable cursor, while an id-bearing runtime frame can. -/
@[aw_spec (tier := T2) (ts := "packages/sdk/src/resources/runs.ts#events")]
theorem cursor_advances_only_on_durable_id :
    recordFrameId { after := some "7" } false (some "8") = { after := some "7" } ∧
    recordFrameId { after := some "7" } true (some "8") = { after := some "8" } ∧
    recordFrameId { after := some "7" } true none = { after := some "7" } := by decide +kernel

end AgentWorkspace.Theorems.Invariants.SdkRuns
