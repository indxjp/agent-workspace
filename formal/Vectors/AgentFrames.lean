import AgentWorkspace.Theorems.WellFormed.AgentFrames
import AgentWorkspace.Theorems.Invariants.AgentFrames
import AgentWorkspace.Theorems.Refinement.AgentFrames
import Vectors.Common

/-!
`agent-frames` — the differential vectors of the engine-neutral event stream (ENG-03, #302).

Five files, replayed by three suites against three implementations of the same two functions:

* `vocabulary.json`, `mapping.json` → `apps/runner/formal/agent-frames.test.ts`, against the Claude
  adapter's mapping the runner streams;
* `legacy.json`, `resume.json` → `apps/web/formal/legacy-frames.test.ts`, against the event-read
  path that upgrades a pre-ENG-03 row;
* `parser.json` → `tests/formal/sdk-agent-event.test.ts`, against the SDK's validating parser.
-/

namespace Vectors.AgentFrames

open Lean AgentWorkspace AgentWorkspace.Events.AgentFrames
open AgentWorkspace.Contracts.RunEvents

private def t0 (n : String) : String := s!"AgentWorkspace.Theorems.WellFormed.AgentFrames.{n}"
private def t2 (n : String) : String := s!"AgentWorkspace.Theorems.Invariants.AgentFrames.{n}"
private def t4 (n : String) : String := s!"AgentWorkspace.Theorems.Refinement.AgentFrames.{n}"

/-- The engine every frame in these vectors names: the only one this release registers. -/
private def engine : String := "claude-agent-sdk"

/-- The subtype and type lists `packages/core` transcribes from R-01, as far as these vectors use
them. The replay suites run the whole lists against the real TypeScript. -/
private def systemSubtypes : List String :=
  ["init", "status", "compact_boundary", "thinking_tokens", "mirror_error"]
private def resultSubtypes : List String :=
  ["success", "error_during_execution", "error_max_turns", "error_max_budget_usd",
   "error_max_structured_output_retries"]
private def eventTypes : List String :=
  ["assistant", "user", "stream_event", "tool_progress", "auth_status"]

private def frameJson (frame : Frame) : Json :=
  (encode engine .null frame).toJson

/-- A frame as the adapter sends it for one engine message: `raw` is that message. Every message in
these vectors is far below `rawMaxBytes`, so `capRaw` returns it unchanged. -/
private def frameJsonOf (message : JValue) (frame : Frame) : Json :=
  (encode engine message frame).toJson

/-! ## The vocabulary -/

def vocabularyVectors : List Vector :=
  [{ id := "names", input := .null,
     expected := Json.mkObj [("frames", toJson agentFrameNames),
       ("toolKinds", toJson agentToolKinds), ("stopReasons", toJson agentStopReasons),
       ("rawMaxBytes", toJson rawMaxBytes)],
     witnesses := [t0 "frames_cover_the_vocabulary",
       t0 "tool_kinds_and_stop_reasons_are_the_contract",
       t0 "frame_names_are_legal_sse_names"] },
   { id := "disjoint-from-legacy", input := .null,
     expected := Json.mkObj [("legacy", toJson relayedEventNames),
       ("overlap", Json.arr #[])],
     witnesses := [t0 "neutral_and_legacy_vocabularies_are_disjoint"] },
   { id := "tool-kinds", input := toJson ["Read", "Write", "Grep", "WebFetch", "Bash",
       "mcp__github__issues", "Skill", "SomeFutureTool"],
     expected := toJson (["Read", "Write", "Grep", "WebFetch", "Bash", "mcp__github__issues",
       "Skill", "SomeFutureTool"].map fun name => (toolKindOf name).toWire),
     witnesses := [t0 "tool_kinds_and_stop_reasons_are_the_contract"] },
   { id := "stop-reasons",
     input := toJson resultSubtypes,
     expected := toJson (resultSubtypes.map fun s => (stopReasonOf s).toWire),
     witnesses := [t0 "tool_kinds_and_stop_reasons_are_the_contract"] },
   { id := "raw-cap",
     input := Json.mkObj [("under", toJson (8 : Nat)), ("over", toJson (rawMaxBytes + 1))],
     expected := Json.mkObj [("under", (capRaw (some 8) (.str "small")).toJson),
       ("over", (capRaw (some (rawMaxBytes + 1)) (.str "huge")).toJson),
       ("unserialisable", (capRaw none (.str "cyclic")).toJson)],
     witnesses := [t0 "oversized_raw_is_truncated_not_rejected"] }]

/-! ## The Claude mapping -/

private def initMessage : JValue :=
  .obj [("type", .str "system"), ("subtype", .str "init"), ("session_id", .str "sess_1"),
    ("model", .str "claude-opus-5")]

private def initWithoutSession : JValue :=
  .obj [("type", .str "system"), ("subtype", .str "init")]

private def statusMessage : JValue :=
  .obj [("type", .str "system"), ("subtype", .str "status")]

private def unknownSubtypeMessage : JValue :=
  .obj [("type", .str "system"), ("subtype", .str "from_the_future")]

private def assistantMessage : JValue :=
  .obj [("type", .str "assistant"),
    ("message", .obj [("id", .str "msg_1"),
      ("content", .arr [
        .obj [("type", .str "thinking"), ("thinking", .str "let me look")],
        .obj [("type", .str "text"), ("text", .str "Reading the file.")],
        .obj [("type", .str "tool_use"), ("id", .str "tool_1"), ("name", .str "Read"),
          ("input", .obj [("path", .str "/etc/hosts")])],
        .obj [("type", .str "tool_use"), ("id", .str "tool_2"),
          ("name", .str "mcp__github__issues"), ("input", .obj [])]])])]

private def userToolResult : JValue :=
  .obj [("type", .str "user"), ("uuid", .str "u-1"),
    ("message", .obj [("content", .arr [
      .obj [("type", .str "tool_result"), ("tool_use_id", .str "tool_1"),
        ("content", .arr [.obj [("type", .str "text"), ("text", .str "127.0.0.1")]])]])])]

private def userImageOnly : JValue :=
  .obj [("type", .str "user"),
    ("message", .obj [("content", .arr [.obj [("type", .str "image")]])])]

private def resultWithUsage : JValue :=
  .obj [("type", .str "result"), ("subtype", .str "success"),
    ("total_cost_usd", .num 125 4), ("num_turns", .ofInt 3),
    ("modelUsage", .obj [
      ("claude-opus-5", .obj [("inputTokens", .ofInt 10), ("outputTokens", .ofInt 40),
        ("cacheReadInputTokens", .ofInt 5), ("cacheCreationInputTokens", .ofInt 2),
        ("thinkingTokens", .ofInt 8)]),
      ("claude-haiku-4-5", .obj [("inputTokens", .ofInt 1), ("outputTokens", .ofInt 2)])])]

private def resultWithoutUsage : JValue :=
  .obj [("type", .str "result"), ("subtype", .str "error_max_turns")]

private def unknownType : JValue := .obj [("type", .str "telepathy")]
private def streamEvent : JValue := .obj [("type", .str "stream_event")]
private def notAnObject : JValue := .str "not an object"
private def noType : JValue := .obj [("subtype", .str "init")]
private def emptyType : JValue := .obj [("type", .str "")]
private def resultNoSubtype : JValue := .obj [("type", .str "result"), ("subtype", .ofInt 7)]
private def numberMessage : JValue := .num 125 4

/-- A cost the contract refuses — negative, or not a number — is not relayed: it becomes `null`. -/
private def resultNegativeCost : JValue :=
  .obj [("type", .str "result"), ("subtype", .str "success"), ("total_cost_usd", .num (-5) 1)]
private def resultStringCost : JValue :=
  .obj [("type", .str "result"), ("subtype", .str "success"), ("total_cost_usd", .str "0.01")]

/-- A `tool_use` block with no `input`: the frame's `input` is `null`, never absent. -/
private def toolUseWithoutInput : JValue :=
  .obj [("type", .str "assistant"),
    ("message", .obj [("id", .str "msg_2"),
      ("content", .arr [.obj [("type", .str "tool_use"), ("id", .str "tool_3"),
        ("name", .str "Grep")]])])]

private def messages : List (String × JValue) :=
  [("system-init", initMessage),
   ("system-init-without-session", initWithoutSession),
   ("system-status", statusMessage),
   ("system-unknown-subtype", unknownSubtypeMessage),
   ("assistant-with-tools", assistantMessage),
   ("user-tool-result", userToolResult),
   ("user-image-only", userImageOnly),
   ("result-with-usage", resultWithUsage),
   ("result-without-usage", resultWithoutUsage),
   ("unknown-type", unknownType),
   ("stream-event", streamEvent),
   ("not-an-object", notAnObject),
   ("no-type", noType),
   ("empty-type", emptyType),
   ("result-subtype-not-a-string", resultNoSubtype),
   ("a-number", numberMessage),
   ("result-negative-cost", resultNegativeCost),
   ("result-string-cost", resultStringCost),
   ("tool-use-without-input", toolUseWithoutInput)]

private def mappedOf (message : JValue) : List Frame :=
  toAgentFrames (classify systemSubtypes resultSubtypes eventTypes message)

/-- One vector per engine message: the frames it maps to, by name and in full. Every entry asserts
the never-dropped invariant by construction — an empty `frames` array would be a failing vector. -/
def mappingVectors : List Vector :=
  messages.map fun (id, message) =>
    let frames := mappedOf message
    { id, input := message.toJson,
      expected := Json.mkObj [("names", toJson (frames.map Frame.name)),
        ("frames", Json.arr (frames.map (frameJsonOf message)).toArray),
        ("paired", toJson (paired frames))],
      witnesses := [t2 "never_drops_an_engine_message",
        t2 "unmapped_message_is_carried_natively",
        t2 "tool_frames_follow_the_turn_that_can_carry_them",
        t0 "every_frame_of_a_message_carries_its_raw",
        t0 "result_without_a_readable_subtype_never_claims_success"] }

/-- The pairing invariant over a whole exchange rather than over one message. -/
def pairingVectors : List Vector :=
  let exchange := mappedOf assistantMessage ++ mappedOf userToolResult
  [{ id := "assistant-then-user", input := Json.arr #[assistantMessage.toJson, userToolResult.toJson],
     expected := Json.mkObj [("names", toJson (exchange.map Frame.name)),
       ("callIds", toJson (callIds exchange)), ("resultIds", toJson (resultIds exchange)),
       ("paired", toJson (paired exchange))],
     witnesses := [t2 "tool_frames_follow_the_turn_that_can_carry_them"] },
   { id := "orphan-result", input := Json.arr #[userToolResult.toJson],
     expected := Json.mkObj [("names", toJson ((mappedOf userToolResult).map Frame.name)),
       ("callIds", toJson (callIds (mappedOf userToolResult))),
       ("resultIds", toJson (resultIds (mappedOf userToolResult))),
       ("paired", toJson (paired (mappedOf userToolResult)))],
     witnesses := [t2 "tool_frames_follow_the_turn_that_can_carry_them"] }]

/-! ## The legacy upgrade -/

private def legacyRows : List (String × String × JValue) :=
  [("system", "system", initMessage),
   ("sdk-event-assistant", "sdk-event", assistantMessage),
   ("sdk-event-user", "sdk-event", userToolResult),
   ("result", "result", resultWithUsage),
   ("system-unknown", "system-unknown", unknownSubtypeMessage),
   ("unknown", "unknown", unknownType),
   ("malformed", "malformed", notAnObject)]

/-- Each pre-ENG-03 row, upgraded, beside the frames a fresh run of the same message produces. The
two lists are computed independently in the model and must be equal in the code as well. -/
def legacyVectors : List Vector :=
  legacyRows.map fun (id, kind, message) =>
    let upgraded := upgradeLegacy systemSubtypes resultSubtypes eventTypes
      (legacyEnvelope kind message)
    { id, input := Json.mkObj [("type", kind), ("data", (legacyEnvelope kind message).toJson)],
      expected := Json.mkObj [("names", toJson (upgraded.map Frame.name)),
        ("frames", Json.arr (upgraded.map (frameJsonOf message)).toArray),
        ("fresh", Json.arr ((mappedOf message).map (frameJsonOf message)).toArray)],
      witnesses := [t4 "legacy_replay_equals_fresh_run", t4 "legacy_upgrade_is_deterministic",
        t2 "served_frames_keep_emission_order", t0 "engine_message_fans_out_in_order"] }

/-- A stored row that is not the relay's envelope: reported, never guessed at. The frame carries the
code's reason and, as `raw`, the stored row itself — the only thing left a reader can go on. -/
def unreadableVectors : List Vector :=
  let rows : List (String × JValue) :=
    [("null", .null), ("string", .str "a string"), ("array", .arr []),
     ("kind-not-a-string", .obj [("kind", .ofInt 42), ("event", .obj [])]),
     ("no-event-key", .obj [("kind", .str "event")])]
  rows.map fun (id, data) =>
    let upgraded := upgradeLegacy systemSubtypes resultSubtypes eventTypes data
    { id, input := Json.mkObj [("type", "sdk-event"), ("data", data.toJson)],
      expected := Json.mkObj [("names", toJson (upgraded.map Frame.name)),
        ("frames", Json.arr (upgraded.map (frameJsonOf data)).toArray)],
      witnesses := [t4 "unreadable_legacy_row_is_reported_not_guessed"] }

/-- A legacy row whose message maps to more frames than the id grammar can number: the first 999
are served and the last sub-index reports the rest. Names only — the frames' `raw` would repeat the
whole message a thousand times. -/
def oversizedRowVectors : List Vector :=
  let calls := (List.range 1001).map fun i =>
    JValue.obj [("type", .str "tool_use"), ("id", .str s!"t{i}"), ("name", .str "Read"),
      ("input", .null)]
  let message := JValue.obj [("type", .str "assistant"),
    ("message", .obj [("id", .str "msg_many"), ("content", .arr calls)])]
  let data := legacyEnvelope "sdk-event" message
  let served := serveLegacyRow systemSubtypes resultSubtypes eventTypes 5 data
  [{ id := "oversized-row", input := Json.mkObj [("type", "sdk-event"), ("data", data.toJson)],
     expected := Json.mkObj [("names", toJson (served.map fun (_, f) => f.name)),
       ("lastReason", match served.getLast? with
         | some (_, .malformed reason) => toJson reason
         | _ => Json.null),
       ("lastId", match served.getLast? with
         | some ((s, i), _) => toJson (wireEventId s i)
         | none => Json.null)],
     witnesses := [t2 "a_row_serves_at_most_the_grammar_bound"] }]

/-! ## Resume -/

/-- The ids a mixed log serves, and what a resume inside one of its rows delivers. -/
def resumeVectors : List Vector :=
  let rowFrames := upgradeLegacy systemSubtypes resultSubtypes eventTypes
    (legacyEnvelope "sdk-event" assistantMessage)
  let served := (indexed rowFrames).map fun (i, _) => ((2 : Nat), some i)
  let ids := ((1, none) :: served) ++ [(3, none)]
  [{ id := "mixed-log", input := .null,
     expected := Json.mkObj [("ids", toJson (ids.map fun (s, sub) => wireEventId s sub)),
       ("increasing", toJson (idsIncreasing ids))],
     witnesses := [t2 "wire_ids_follow_the_documented_grammar",
       t2 "row_positions_are_a_range"] },
   { id := "resume-inside-row", input := Json.mkObj [("sequence", toJson (2 : Nat)),
       ("subIndex", toJson (0 : Nat))],
     expected := Json.mkObj [
       ("whole", toJson (rowFrames.map Frame.name)),
       ("tail", toJson ((resumeWithinRow (some (2, 0)) 2 true rowFrames).map Frame.name))],
     witnesses := [t2 "resume_within_row_loses_and_repeats_nothing"] },
   { id := "resume-other-row", input := Json.mkObj [("sequence", toJson (2 : Nat)),
       ("subIndex", toJson (1 : Nat))],
     expected := Json.mkObj [
       ("tail", toJson ((resumeWithinRow (some (2, 1)) 7 true rowFrames).map Frame.name))],
     witnesses := [t2 "resume_serves_a_different_row_whole"] },
   -- A sub-indexed cursor on a row a post-ENG-03 run wrote, which is served one-to-one.
   { id := "resume-one-to-one-row", input := Json.mkObj [("sequence", toJson (2 : Nat)),
       ("subIndex", toJson (0 : Nat))],
     expected := Json.mkObj [
       ("tail", toJson ((resumeWithinRow (some (2, 0)) 2 false
         [Frame.result .endTurn none none]).map Frame.name))],
     witnesses := [t2 "resume_serves_a_one_to_one_row_whole"] }]

/-! ## The SDK parser -/

private def parserFrames : List Frame :=
  Theorems.WellFormed.AgentFrames.witnesses

/-- Every frame round-trips through the codec; a payload that is not one is refused. -/
def parserVectors : List Vector :=
  let good := parserFrames.map fun frame =>
    { id := "ok/" ++ frame.name,
      input := Json.mkObj [("name", frame.name), ("data", frameJson frame)],
      expected := Json.mkObj [("frame", frame.name), ("engine", engine), ("accepted", true)],
      witnesses := [t0 "frame_codec_round_trips"] }
  let bad : List (String × String × JValue) :=
    [("unknown-name", "agent.telepathy", .obj [("frame", .str "agent.telepathy")]),
     ("legacy-name", "sdk-event", .obj [("kind", .str "event")]),
     ("name-disagrees", "agent.result", encode engine .null (.malformed "x")),
     ("engine-shaped-message", "agent.message",
       .obj [("type", .str "assistant"),
         ("message", .obj [("id", .str "msg_1"), ("content", .arr [])])]),
     ("not-an-object", "agent.malformed", .str "nope"),
     ("role-outside-the-enum", "agent.message",
       .obj [("frame", .str "agent.message"), ("engine", .str engine), ("raw", .null),
         ("messageId", .null), ("role", .str "system"), ("blocks", .arr [])]),
     ("status-outside-the-enum", "agent.tool.result",
       .obj [("frame", .str "agent.tool.result"), ("engine", .str engine), ("raw", .null),
         ("toolCallId", .str "t"), ("status", .str "running"), ("output", .str ""),
         ("isError", .bool false)]),
     ("block-outside-the-enum", "agent.message.delta",
       .obj [("frame", .str "agent.message.delta"), ("engine", .str engine), ("raw", .null),
         ("messageId", .null), ("block", .str "image"), ("text", .str "x")]),
     ("negative-cost", "agent.result",
       .obj [("frame", .str "agent.result"), ("engine", .str engine), ("raw", .null),
         ("stopReason", .str "end_turn"), ("turns", .null), ("engineCostUsd", .num (-1) 0)]),
     ("string-cost", "agent.result",
       .obj [("frame", .str "agent.result"), ("engine", .str engine), ("raw", .null),
         ("stopReason", .str "end_turn"), ("turns", .null), ("engineCostUsd", .str "free")]),
     ("empty-native-type", "agent.native",
       .obj [("frame", .str "agent.native"), ("engine", .str engine), ("raw", .null),
         ("type", .str ""), ("payload", .null)])]
  good ++ bad.map fun (id, name, data) =>
    { id := "refused/" ++ id,
      input := Json.mkObj [("name", name), ("data", data.toJson)],
      expected := Json.mkObj [("accepted", toJson (toAgentEvent (.runtime name data)).isSome)],
      witnesses := [t0 "platform_frames_carry_no_agent_event",
        t0 "decode_refuses_what_the_contract_refuses"] }

/-- Only a spoken assistant turn becomes a chat message. -/
def assistantVectors : List Vector :=
  let cases : List (String × Frame) :=
    [("spoken", .message (some "m") .assistant [.reasoning "private", .text "Tokyo."]),
     ("user-turn", .message (some "m") .user [.text "Tokyo."]),
     ("no-id", .message none .assistant [.text "Tokyo."]),
     ("blank", .message (some "m") .assistant [.text "   "]),
     ("reasoning-only", .message (some "m") .assistant [.reasoning "private"]),
     ("not-a-message", .result .endTurn none none)]
  cases.map fun (id, frame) =>
    { id, input := Json.mkObj [("name", frame.name), ("data", frameJson frame)],
      expected := match assistantResponse frame with
        | some (mid, text) => Json.mkObj [("id", mid), ("text", toJson text)]
        | none => Json.null,
      witnesses := [t0 "only_a_spoken_assistant_turn_is_a_chat_message"] }

def files : List (String × Json) :=
  [("vocabulary.json", file "agent-frames" "The closed neutral vocabulary and its raw cap"
      vocabularyVectors),
   ("mapping.json", file "agent-frames" "The Claude adapter's mapping, message by message"
      (mappingVectors ++ pairingVectors)),
   ("legacy.json", file "agent-frames" "Pre-ENG-03 rows upgraded on read"
      (legacyVectors ++ unreadableVectors ++ oversizedRowVectors)),
   ("resume.json", file "agent-frames" "The (sequence, sub-index) ids and resume" resumeVectors),
   ("parser.json", file "agent-frames" "The SDK's validating parser"
      (parserVectors ++ assistantVectors))]

end Vectors.AgentFrames
