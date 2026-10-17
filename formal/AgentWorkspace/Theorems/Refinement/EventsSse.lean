import AgentWorkspace.Events.RunLog
import AgentWorkspace.Events.SdkSse

namespace AgentWorkspace.Theorems.Refinement.EventsSse

open AgentWorkspace AgentWorkspace.Events

private def first : RunLog.Event := ⟨1, "run.status", .obj [("status", .str "running")]⟩
private def tail : RunLog.Event := ⟨2, "run.status", .obj [("status", .str "completed")]⟩

/-- The repository's first list can see event 1, then a concurrent append and terminal transition
can produce event 2 before its separate run read. The final drain now delivers both events, so
the current and target exit decisions agree with the in-memory exit test. -/
@[aw_spec (tier := T4) (doc := "docs/sdk/site/guides/streaming.mdx#resuming-with-after-and-last-event-id")
  (ts := "apps/web/server/runs/store.ts#createRepositoryRunStore")
  (ts := "apps/web/server/runs/store.ts#InMemoryRunStore")]
theorem repository_follow_delivers_terminal_tail :
    let before : RunLog.Log := ⟨1, [first], false⟩
    let after : RunLog.Log := ⟨2, [first, tail], true⟩
    let cycle := RunLog.repositoryCycle before after 0 true
    cycle.delivered = [first, tail] ∧ cycle.cursor = 2 ∧ cycle.currentEnds = true ∧
      cycle.targetEnds = true ∧ RunLog.memoryMayEnd after cycle.cursor = true := by
  decide

/-- If no event appears between the list and terminal read, the two exit conditions agree once
the listed cursor has reached the log's latest id. -/
@[aw_spec (tier := T4) (ts := "apps/web/server/runs/store.ts#createRepositoryRunStore")]
theorem repository_exit_agrees_when_caught_up (log : RunLog.Log) (cursor : Nat)
    (terminal : Bool) (h : cursor ≥ log.lastId) :
    RunLog.repositoryMayEndCurrent terminal =
      RunLog.repositoryMayEndTarget log cursor terminal := by
  simp [RunLog.repositoryMayEndCurrent, RunLog.repositoryMayEndTarget, h]

/-- The server and SDK now agree on lone-CR frame separators once the following bytes resolve
the line ending. -/
@[aw_spec (tier := T4) (ts := "apps/web/server/runs/relay.ts#SseLineSplitter")
  (ts := "packages/sdk/src/events/sse.ts#splitSseFrames")]
theorem lone_cr_splitter_agrees :
    Sse.normalizeNewlines "event: x\r\revent: y\n\n".toList =
      "event: x\n\nevent: y\n\n".toList ∧
    SdkSse.splitSseFrames "event: x\r\revent: y\n\n" =
      (["event: x", "event: y"], "") := by
  decide

/-- The server's durable status frame round-trips through the SDK parser with its cursor. -/
@[aw_spec (tier := T4) (ts := "apps/web/server/runs/sse.ts#sseFrame")
  (ts := "packages/sdk/src/events/sse.ts#parseSseFrame")]
theorem status_frame_sdk_roundtrip :
    (Sse.durableFrame ⟨7, "run.status", .obj [("status", .str "running"),
      ("error", .null)]⟩).bind SdkSse.parseSseFrame =
      some ⟨"run.status", some "7", some "{\"status\":\"running\",\"error\":null}"⟩ := by
  decide

/-- Control frames also parse, but carry no cursor. -/
@[aw_spec (tier := T4) (ts := "apps/web/server/runs/sse.ts#sseControlFrame")
  (ts := "packages/sdk/src/events/sse.ts#parseSseFrame")]
theorem done_control_sdk_has_no_cursor :
    SdkSse.parseSseFrame (Sse.controlFrame "done" (.obj [])) =
      some ⟨"done", none, some "{}"⟩ := by
  decide

end AgentWorkspace.Theorems.Refinement.EventsSse
