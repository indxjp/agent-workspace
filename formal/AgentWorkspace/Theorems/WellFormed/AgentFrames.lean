import AgentWorkspace.Events.AgentFrames

/-!
# T0 — the neutral frame vocabulary is well formed (ENG-03, #302)

Three properties the rest of the unit rests on: the vocabulary this model names is the one the
contract names, every frame name is a legal SSE `event:` name, and a frame survives the wire.
-/

namespace AgentWorkspace.Theorems.WellFormed.AgentFrames

open AgentWorkspace AgentWorkspace.Contracts.RunEvents AgentWorkspace.Events.AgentFrames

/-- One frame of every arm, with a payload that exercises each of its fields. `frames_cover_the_
vocabulary` is what keeps this list honest: a frame added to the union and not to this list stops
that theorem, so nothing below is proved over an incomplete sample. -/
def witnesses : List Frame :=
  [.session "sess_1" (some "claude-opus-5"),
   .message (some "msg_1") .assistant [.reasoning "hmm", .text "hello"],
   .delta (some "msg_1") .text "he",
   .toolCall "tool_1" "Read" .read (.obj [("path", .str "/a")]),
   .toolResult "tool_1" .completed "contents" false,
   .usage ⟨10, 20, some 5, none, some 8⟩,
   .result .endTurn (some 2) (some ⟨4, 3⟩),
   .native "system/status" (.obj [("type", .str "system")]),
   .malformed "an SDK event must be an object; got the string \"nope\"",
   .approvalRequested "tool_2" "Bash" "Bash(rm -rf build)",
   .handoff (some "The visitor asked for a person.")]

/-- The model's frame names are the contract's, in the contract's order, and the witnesses cover
every one of them. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/run-events.ts#AGENT_FRAME_NAMES")
  (ts := "packages/run-protocol/src/types.ts#agentFrameNames")]
theorem frames_cover_the_vocabulary :
    witnesses.map Frame.name = agentFrameNames := by decide +kernel

/-- The two closed sets a frame is written in are the contract's, in the contract's order. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/run-events.ts#AGENT_TOOL_KINDS")
  (ts := "packages/contracts/src/run-events.ts#AGENT_STOP_REASONS")]
theorem tool_kinds_and_stop_reasons_are_the_contract :
    ToolKind.all.map ToolKind.toWire = agentToolKinds ∧
    StopReason.all.map StopReason.toWire = agentStopReasons := by decide +kernel

/-- Every frame name is a legal SSE `event:` name, and none of them is `error`.

SSE has no escaping, so a name outside the grammar could terminate the field and inject a frame; and
HTML §9.2 dispatches `event: error` into `EventSource`'s own transport-error listener, where a
client's watchdog swallows it. -/
@[aw_spec (tier := T0) (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#the-event-stream")
  (ts := "packages/contracts/src/run-events.ts#EVENT_NAME_PATTERN")]
theorem frame_names_are_legal_sse_names :
    agentFrameNames.all eventNamePattern = true ∧
    agentFrameNames.contains "error" = false := by decide +kernel

/-- The neutral vocabulary and the pre-ENG-03 relayed vocabulary are disjoint.

This is what lets the event-read path decide, from a stored row's name alone, whether the row must be
upgraded — a positive membership test rather than a guess about the payload's shape. -/
@[aw_spec (tier := T0) (ts := "apps/web/server/runs/agent-frames.ts#upgradeStoredEvent")
  (ts := "packages/contracts/src/run-events.ts#RELAYED_EVENT_NAMES")]
theorem neutral_and_legacy_vocabularies_are_disjoint :
    agentFrameNames.all (fun name => !relayedEventNames.contains name) = true ∧
    relayedEventNames.all (fun name => !agentFrameNames.contains name) = true := by decide +kernel

/-- The frame codec round-trips: a frame encoded with its engine and its engine-native payload
decodes back to exactly that engine, that payload and that frame. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/run-events.ts#AgentFrameSchema")
  (ts := "packages/sdk/src/events/agent-event.ts#toAgentEvent")]
theorem frame_codec_round_trips :
    witnesses.all (fun frame =>
      decode (encode "claude-agent-sdk" (.obj [("type", .str "assistant")]) frame) ==
        some ("claude-agent-sdk", .obj [("type", .str "assistant")], frame)) = true := by decide +kernel

/-- A visitor's `agent.handoff` — served without the operator's `reason` (ADR-0145 D4) — is still a
frame the parser reads, and reads as a handoff with no reason. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/run-events.ts#AgentHandoffFrameSchema")
  (ts := "apps/web/server/runs/agent-frames.ts#forVisitor")]
theorem visitor_handoff_round_trips :
    decode (encode "claude-agent-sdk" .null (.handoff none)) =
      some ("claude-agent-sdk", .null, .handoff none) ∧
    (Frame.handoff none).body = [] := by decide +kernel

/-- The parser is exactly as strict as the contract on the closed fields: a `role`, a delta `block`, a
tool `status` outside their enums, a negative or non-numeric `engineCostUsd`, and an empty string
where the contract says `min(1)` are all refused. Without this, the round-trip above would hold over
payloads the real parser rejects and prove less than it reads as proving. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/run-events.ts#AgentFrameSchema")
  (ts := "packages/sdk/src/events/agent-event.ts#toAgentEvent")]
theorem decode_refuses_what_the_contract_refuses :
    let head (name : String) : JValue.Fields :=
      [("frame", .str name), ("engine", .str "claude-agent-sdk"), ("raw", .null)]
    decode (.obj (head "agent.message" ++
      [("messageId", .null), ("role", .str "system"), ("blocks", .arr [])])) = none ∧
    decode (.obj (head "agent.message.delta" ++
      [("messageId", .null), ("block", .str "image"), ("text", .str "x")])) = none ∧
    decode (.obj (head "agent.tool.result" ++
      [("toolCallId", .str "t"), ("status", .str "running"), ("output", .str ""),
       ("isError", .bool false)])) = none ∧
    decode (.obj (head "agent.result" ++
      [("stopReason", .str "end_turn"), ("turns", .null), ("engineCostUsd", .num (-1) 0)])) =
      none ∧
    decode (.obj (head "agent.result" ++
      [("stopReason", .str "end_turn"), ("turns", .null), ("engineCostUsd", .str "free")])) =
      none ∧
    decode (.obj (head "agent.native" ++ [("type", .str ""), ("payload", .null)])) = none ∧
    decode (.obj (head "agent.malformed" ++ [("reason", .str "")])) = none ∧
    decode (.obj (head "agent.handoff" ++ [("reason", .str "")])) = none ∧
    decode (.obj (head "agent.malformed")) = none ∧
    decode (.obj (head "agent.tool.call" ++
      [("toolCallId", .str ""), ("name", .str "Read"), ("kind", .str "read"),
       ("input", .null)])) = none := by decide +kernel

/-- The SDK's classification answers a frame for a runtime frame and nothing for the platform's own,
and it refuses a runtime frame whose `event:` name disagrees with its payload's `frame` field. -/
@[aw_spec (tier := T0) (ts := "packages/sdk/src/events/agent-event.ts#toAgentEvent")]
theorem platform_frames_carry_no_agent_event :
    toAgentEvent .runStatus = none ∧ toAgentEvent .runFailed = none ∧
    toAgentEvent .streamReset = none ∧ toAgentEvent .done = none ∧
    toAgentEvent (.runtime "agent.malformed"
      (encode "claude-agent-sdk" .null (.malformed "x"))) = some (.malformed "x") ∧
    toAgentEvent (.runtime "agent.result"
      (encode "claude-agent-sdk" .null (.malformed "x"))) = none := by decide +kernel

/-- `raw` over the cap becomes the marker, and the marker satisfies the published schema: a payload
too large is **truncated, never rejected**, because the neutral fields beside it are what a consumer
renders. -/
@[aw_spec (tier := T0) (ts := "packages/run-protocol/src/schemas.ts#capAgentFrameRaw")
  (ts := "packages/contracts/src/run-events.ts#AgentFrameRawTruncationSchema")]
theorem oversized_raw_is_truncated_not_rejected :
    capRaw (some 8) (.str "small") = .str "small" ∧
    capRaw (some (rawMaxBytes + 1)) (.str "huge") = truncationMarker (some (rawMaxBytes + 1)) ∧
    capRaw none (.str "cyclic") = truncationMarker none ∧
    agentFrameRawTruncation (truncationMarker (some (rawMaxBytes + 1))) = true ∧
    agentFrameRawTruncation (truncationMarker none) = true := by decide +kernel

/-- Only a spoken assistant turn reaches the conversation. -/
@[aw_spec (tier := T0)
  (ts := "packages/sdk/src/events/agent-event.ts#assistantResponseFromAgentEvent")]
theorem only_a_spoken_assistant_turn_is_a_chat_message :
    assistantResponse (.message (some "m") .assistant [.reasoning "private", .text "Tokyo."]) =
      some ("m", ["Tokyo."]) ∧
    assistantResponse (.message (some "m") .user [.text "Tokyo."]) = none ∧
    assistantResponse (.message none .assistant [.text "Tokyo."]) = none ∧
    assistantResponse (.message (some "m") .assistant [.text "   "]) = none ∧
    assistantResponse (.message (some "m") .assistant [.reasoning "private"]) = none ∧
    assistantResponse (.result .endTurn none none) = none := by decide +kernel

/-! ## Successors of the neutral-view theorems `WellFormed/SdkRuns.lean` held before ENG-03

`toAgentEvents`, the Claude-shaped projection each client re-derived, is gone; the properties it
carried are restated here over the frames the runner now streams. `platform_frames_do_not_invent_
events` is `platform_frames_carry_no_agent_event` above; the other three follow. -/

/-- The subtype and type lists these statements classify against: `packages/core`'s, cut down to the
members they exercise. -/
private def systemSubtypes : List String := ["init", "status"]
private def resultSubtypes : List String := ["success", "error_max_turns", "error_max_budget_usd"]
private def eventTypes : List String := ["assistant", "user", "stream_event"]

private def fanoutMessage : JValue :=
  .obj [("type", .str "assistant"),
    ("message", .obj [("id", .str "m"),
      ("content", .arr [
        .obj [("type", .str "thinking"), ("thinking", .str "plan")],
        .obj [("type", .str "text"), ("text", .str "hello")],
        .obj [("type", .str "tool_use"), ("id", .str "c1"), ("name", .str "Read"),
          ("input", .obj [])],
        .obj [("type", .str "image")],
        .obj [("type", .str "tool_use"), ("id", .str "c2"), ("name", .str "Bash"),
          ("input", .obj [])]])])]

/-- **One engine message fans out in order** (successor of `agent_event_fanout_order`).

The message frame comes first with its prose blocks in the model's order, then one call frame per
`tool_use` block in the order the blocks appeared; a block with no neutral meaning (the image) adds
no frame. Served from a stored row, the frames take sub-indices `0, 1, 2` in exactly that order, and
the ids are strictly increasing. `Invariants/AgentFrames.lean`'s
`served_frames_keep_emission_order` is the same statement for every row. -/
@[aw_spec (tier := T0) (ts := "packages/run-protocol/src/schemas.ts#toAgentFrames")
  (ts := "apps/web/server/runs/agent-frames.ts#upgradeStoredEvent")]
theorem engine_message_fans_out_in_order :
    toAgentFrames (classify systemSubtypes resultSubtypes eventTypes fanoutMessage) =
      [.message (some "m") .assistant [.reasoning "plan", .text "hello"],
       .toolCall "c1" "Read" .read (.obj []),
       .toolCall "c2" "Bash" .execute (.obj [])] ∧
    serveLegacyRow systemSubtypes resultSubtypes eventTypes 7
        (legacyEnvelope "sdk-event" fanoutMessage) =
      [((7, some 0), .message (some "m") .assistant [.reasoning "plan", .text "hello"]),
       ((7, some 1), .toolCall "c1" "Read" .read (.obj [])),
       ((7, some 2), .toolCall "c2" "Bash" .execute (.obj []))] ∧
    idsIncreasing ((serveLegacyRow systemSubtypes resultSubtypes eventTypes 7
        (legacyEnvelope "sdk-event" fanoutMessage)).map Prod.fst) = true := by decide +kernel

/-- **A `result` with no readable subtype never claims success** (successor of
`missing_result_subtype_is_provider`).

Before ENG-03 such a message stayed an opaque provider event. It is now refused by name as
`agent.malformed` — still not a result, and still not a success — and a subtype this build does not
know is a result whose stop reason is `error`. `end_turn` is reachable from `success` alone. -/
@[aw_spec (tier := T0) (ts := "packages/run-protocol/src/schemas.ts#classifySdkEvent")
  (ts := "packages/run-protocol/src/schemas.ts#toAgentFrames")]
theorem result_without_a_readable_subtype_never_claims_success :
    toAgentFrames (classify systemSubtypes resultSubtypes eventTypes
        (.obj [("type", .str "result")])) =
      [.malformed "a 'result' event must carry a string 'subtype'; got a value of type undefined"] ∧
    toAgentFrames (classify systemSubtypes resultSubtypes eventTypes
        (.obj [("type", .str "result"), ("subtype", .str "error_from_the_future")])) =
      [.result .error none none] ∧
    ∀ subtype, stopReasonOf subtype = .endTurn → subtype = "success" := by
  refine ⟨by decide +kernel, by decide +kernel, ?_⟩
  intro subtype h
  unfold stopReasonOf at h
  by_cases h1 : (subtype == "success") = true
  · exact beq_iff_eq.mp h1
  · simp only [h1, Bool.false_eq_true, ite_false] at h
    split at h
    · cases h
    · split at h
      · cases h
      · cases h

private def accountingMessage : JValue :=
  .obj [("type", .str "result"), ("subtype", .str "success"),
    ("total_cost_usd", .num 125 4), ("num_turns", .ofInt 1),
    ("modelUsage", .obj [("claude-opus-5", .obj [("inputTokens", .ofInt 2),
      ("outputTokens", .ofInt 3), ("cacheReadInputTokens", .ofInt 1),
      ("cacheCreationInputTokens", .ofInt 0)])])]

/-- **The result frame preserves the accounting and the engine's own message** (successor of
`result_preserves_accounting_and_raw`).

The engine's counters reach `agent.usage` and its turn count and cost reach `agent.result`, exactly;
every frame the message produced carries the message itself as `raw` (under the cap, which a
message this size is), and the SDK's parser hands all of it back. -/
@[aw_spec (tier := T0) (ts := "packages/run-protocol/src/schemas.ts#toAgentFrames")
  (ts := "packages/sdk/src/events/agent-event.ts#toAgentEvent")]
theorem result_frame_preserves_accounting_and_raw :
    toAgentFramesJson "claude-agent-sdk" (some 256)
        (classify systemSubtypes resultSubtypes eventTypes accountingMessage) =
      [encode "claude-agent-sdk" accountingMessage (.usage ⟨2, 3, some 1, some 0, none⟩),
       encode "claude-agent-sdk" accountingMessage (.result .endTurn (some 1) (some ⟨125, 4⟩))] ∧
    (toAgentFramesJson "claude-agent-sdk" (some 256)
        (classify systemSubtypes resultSubtypes eventTypes accountingMessage)).map decode =
      [some ("claude-agent-sdk", accountingMessage, .usage ⟨2, 3, some 1, some 0, none⟩),
       some ("claude-agent-sdk", accountingMessage,
         .result .endTurn (some 1) (some ⟨125, 4⟩))] := by decide +kernel

/-- And for every message, not only that one: each frame it maps to carries the same capped message
as its `raw`. -/
@[aw_spec (tier := T0) (ts := "packages/run-protocol/src/schemas.ts#toAgentFrames")]
theorem every_frame_of_a_message_carries_its_raw (engine : String) (encodedBytes : Option Nat)
    (classified : Classified) :
    ∀ j ∈ toAgentFramesJson engine encodedBytes classified, ∃ frame ∈ toAgentFrames classified,
      j = encode engine (capRaw encodedBytes classified.message) frame := by
  intro j hj
  simp only [toAgentFramesJson, List.mem_map] at hj
  obtain ⟨frame, hf, rfl⟩ := hj
  exact ⟨frame, hf, rfl⟩

end AgentWorkspace.Theorems.WellFormed.AgentFrames
