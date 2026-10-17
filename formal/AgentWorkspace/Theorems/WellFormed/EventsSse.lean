import AgentWorkspace.Concepts.RunEvent
import AgentWorkspace.Events.SdkSse
import AgentWorkspace.Events.Resume

namespace AgentWorkspace.Theorems.WellFormed.EventsSse


open AgentWorkspace AgentWorkspace.Contracts.RunEvents AgentWorkspace.Events

/-- The new contract vocabulary is independently pinned to the Phase-1 concept vocabulary. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/run-events.ts#CONTROL_FRAME_NAMES")
  (ts := "packages/contracts/src/run-events.ts#RUN_STATUS_EVENT")
  (ts := "packages/contracts/src/run-events.ts#RELAYED_EVENT_NAMES")]
theorem event_names_equal_phase_one :
    controlFrameNames = Concepts.RunEvent.controlFrameNames ∧
    runStatusEvent = Concepts.RunEvent.runStatusEvent ∧
    relayedEventNames = Concepts.RunEvent.relayedEventNames := by
  decide

/-- Status data requires its nullable error field and refuses unknown properties. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/run-events.ts#RunStatusEventDataSchema")]
theorem status_schema_is_strict :
    runStatusData (.obj [("status", .str "running"), ("error", .null)]) = true ∧
    runStatusData (.obj [("status", .str "running")]) = false ∧
    runStatusData (.obj [("status", .str "running"), ("error", .null),
      ("x", .bool true)]) = false := by decide

/-- The failure frame admits `unknown`, but still requires public message text. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/run-events.ts#RunFailedFrameDataSchema")]
theorem failure_schema_admits_unknown :
    runFailedData (.obj [("status", .str "unknown"), ("message", .str "lost")]) = true ∧
    runFailedData (.obj [("status", .str "failed")]) = false := by decide

/-- A reset requires `resumedAfter`, including when the value is null. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/run-events.ts#StreamResetFrameDataSchema")]
theorem reset_schema_requires_nullable_resume :
    streamResetData (.obj [("reason", .str "gap"), ("resumedAfter", .null)]) = true ∧
    streamResetData (.obj [("reason", .str "gap")]) = false := by decide

/-- The relayed event kind must be nonempty. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/run-events.ts#RelayedEventDataSchema")]
theorem relay_schema_requires_nonempty_kind :
    relayedEventData (.obj [("kind", .str "sdk-event")]) = true ∧
    relayedEventData (.obj [("kind", .str "")]) = false := by decide

/-- A control frame has no `id:` line and cannot advance a resume cursor. -/
@[aw_spec (tier := T0) (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#the-event-stream")
  (ts := "apps/web/server/runs/sse.ts#sseControlFrame")]
theorem control_frame_omits_id (name : String) (data : JValue) :
    Sse.controlFrame name data = s!"event: {name}\ndata: {Sse.dataText data}\n\n" := rfl

/-- The header, including an invalid one, always decides before a present query cursor. -/
@[aw_spec (tier := T0) (doc := "docs/sdk/site/guides/streaming.mdx#resuming-with-after-and-last-event-id")
  (ts := "apps/web/server/runs/cursor.ts#readResumeCursor")]
theorem resume_header_wins (h q₁ q₂ : String) :
    Resume.readResumeCursor (some h) (some q₁) =
      Resume.readResumeCursor (some h) (some q₂) := by
  rfl

/-- The SDK keeps an explicitly empty `id:`; it does not turn it into absence. -/
@[aw_spec (tier := T0) (ts := "packages/sdk/src/events/sse.ts#parseSseFrame")]
theorem sdk_empty_id_is_present :
    SdkSse.parseSseFrame "event: run.status\nid:\ndata: {}\n" =
      some ⟨"run.status", some "", some "{}"⟩ := by
  decide

/-- Multiple data fields are joined with one LF before the SDK interprets the payload. -/
@[aw_spec (tier := T0) (ts := "packages/sdk/src/events/sse.ts#parseSseFrame")]
theorem sdk_joins_multiline_data :
    SdkSse.parseSseFrame "event: system\ndata: one\ndata: two" =
      some ⟨"system", none, some "one\ntwo"⟩ := by
  decide

/-- A trailing CR waits for the next chunk, while resolved lone CR and CRLF line endings both
separate frames. -/
@[aw_spec (tier := T0) (ts := "packages/sdk/src/events/sse.ts#splitSseFrames")]
theorem sdk_splitter_resolves_lone_cr :
    SdkSse.splitSseFrames "event: x\r\r" = ([], "event: x\n\r") ∧
    SdkSse.splitSseFrames "event: x\r\n\r\n" = (["event: x"], "") ∧
    SdkSse.splitSseFrames "event: x\r\revent: y\n\n" = (["event: x", "event: y"], "") := by
  decide

/-- A 19-digit value still needs a range check: the maximum passes and its successor fails. -/
@[aw_spec (tier := T0) (ts := "apps/web/server/runs/cursor.ts#readResumeCursor")]
theorem resume_cursor_range_boundary :
    Resume.parseId "9223372036854775807" = some Resume.maxEventId ∧
    Resume.parseId "9223372036854775808" = none := by
  decide

/-- A CR at the end of a relay chunk and an LF at the beginning of the next make one line break. -/
@[aw_spec (tier := T0) (ts := "apps/web/server/runs/relay.ts#SseLineSplitter")]
theorem relay_crlf_across_chunks :
    let first := Sse.pushLines {} "event: x\r"
    first.2 = ["event: x"] ∧
      (Sse.pushLines first.1 "\ndata: 1\r\n\r\n").2 = ["data: 1", ""] := by
  decide

/-- The relay does not dispatch a frame containing only an id; that id still becomes the next
message's `lastEventId`. -/
@[aw_spec (tier := T0) (ts := "apps/web/server/runs/relay.ts#SseMessageAssembler")]
theorem relay_id_only_moves_cursor :
    let a := (Sse.assembleLine {} "id: 7").1
    let b := Sse.assembleLine a ""
    b.2 = none ∧ b.1.lastEventId = "7" := by
  decide

end AgentWorkspace.Theorems.WellFormed.EventsSse
