import AgentWorkspace.Events.Resume
import AgentWorkspace.Events.Sse

namespace AgentWorkspace.Theorems.Normative.EventsSse

open AgentWorkspace AgentWorkspace.Events

/-- A first connection announces lost earlier events; an untruncated log needs no reset. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#resuming")
  (ts := "apps/web/server/runs/store.ts#RunEventLog")]
theorem first_connection_announces_retention_gap :
    RunLog.resetFor ⟨3, [⟨3, "result", .null⟩], false⟩ none =
      some (.gap (some 2)) ∧
    RunLog.resetFor RunLog.empty none = none := by decide

/-- A cursor behind retention resets to the event just before the oldest retained id. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#resuming")
  (ts := "apps/web/server/runs/store.ts#RunEventLog")]
theorem reset_gap_example :
    RunLog.resetFor ⟨5, [⟨4, "system", .null⟩, ⟨5, "result", .null⟩], false⟩ (some 1) =
      some (.gap (some 3)) := by decide

/-- A cursor at exactly `oldest - 1` still has a contiguous replay and needs no reset. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/runs/store.ts#RunEventLog")]
theorem reset_gap_boundary_is_contiguous :
    RunLog.resetFor ⟨5, [⟨4, "system", .null⟩, ⟨5, "result", .null⟩], false⟩
      (some 3) = none := by decide

/-- An ahead cursor announces a reset, including when the log is empty. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#resuming")
  (ts := "apps/web/server/runs/store.ts#RunEventLog")]
theorem reset_ahead_examples :
    RunLog.resetFor RunLog.empty (some 1) = some (.ahead none) ∧
    RunLog.resetFor ⟨2, [⟨1, "system", .null⟩, ⟨2, "result", .null⟩], false⟩
      (some 3) = some (.ahead (some 0)) := by decide

/-- A cursor equal to the latest id waits for future events; it is not ahead of the log. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/runs/store.ts#RunEventLog")]
theorem reset_latest_boundary_is_not_ahead :
    RunLog.resetFor ⟨5, [⟨4, "system", .null⟩, ⟨5, "result", .null⟩], false⟩
      (some 5) = none := by decide

/-- The three response headers are fixed; a client receives the SSE content type without
proxy buffering. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/site/guides/streaming.mdx#the-wire-format")
  (ts := "apps/web/server/runs/sse.ts#SSE_HEADERS")]
theorem sse_headers_are_exact :
    Sse.headers = [("Content-Type", "text/event-stream; charset=utf-8"),
      ("Cache-Control", "no-cache, no-transform"), ("X-Accel-Buffering", "no")] := rfl

/-- Retry uses the default for zero, and keepalive comments flatten line breaks. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/runs/sse.ts#sseRetryFrame")
  (ts := "apps/web/server/runs/sse.ts#sseComment")]
theorem retry_and_keepalive_frames :
    Sse.retryFrame 0 = "retry: 3000\n\n" ∧
    Sse.retryFrame 950 = "retry: 950\n\n" ∧
    Sse.comment "a\r\nb\nc" = ": a b c\n\n" := by decide

/-- A known failure emits `run-failed` before `done`; an indeterminate outcome has status
`unknown` but still emits `done`. A producer throw has no `done`. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/site/guides/streaming.mdx#what-done-does-and-does-not-mean")
  (ts := "apps/web/server/runs/sse.ts#sseStreamResponse")]
theorem outcome_frame_order (status message : String) :
    Sse.outcomeFrames (.failed status message) =
      [Sse.controlFrame "run-failed" (.obj [("status", .str status), ("message", .str message)]),
       Sse.controlFrame "done" (.obj [])] ∧
    Sse.outcomeFrames (.indeterminate message) =
      [Sse.controlFrame "run-failed" (.obj [("status", .str "unknown"), ("message", .str message)]),
       Sse.controlFrame "done" (.obj [])] ∧
    Sse.producerThrowFrames message =
      [Sse.controlFrame "run-failed" (.obj [("status", .str "unknown"),
        ("message", .str message)])] := by
  exact ⟨rfl, rfl, rfl⟩

/-- Only a completed run is a successful stream outcome; every other status is not. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/runs/api.ts#classifyRunOutcome")]
theorem classify_run_outcome_is_total (runId : String)
    (status : Option Contracts.RunStatus) (error : Option String) :
    (Sse.classifyRunOutcome runId status error = .succeeded) ↔
      status = some .completed := by
  cases status with
  | none => simp [Sse.classifyRunOutcome]
  | some status => cases status <;> simp [Sse.classifyRunOutcome]

end AgentWorkspace.Theorems.Normative.EventsSse
