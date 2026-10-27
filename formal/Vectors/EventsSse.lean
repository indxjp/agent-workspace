import AgentWorkspace.Theorems.WellFormed.EventsSse
import AgentWorkspace.Theorems.Normative.EventsSse
import AgentWorkspace.Theorems.Invariants.EventsSse
import AgentWorkspace.Theorems.Adversarial.EventsSse
import AgentWorkspace.Theorems.Refinement.EventsSse
import Vectors.Common

namespace Vectors.EventsSse

open Lean AgentWorkspace AgentWorkspace.Events AgentWorkspace.Contracts.RunEvents

private def t0 (n : String) : String := s!"AgentWorkspace.Theorems.WellFormed.EventsSse.{n}"
private def t1 (n : String) : String := s!"AgentWorkspace.Theorems.Normative.EventsSse.{n}"
private def t2 (n : String) : String := s!"AgentWorkspace.Theorems.Invariants.EventsSse.{n}"
private def t3 (n : String) : String := s!"AgentWorkspace.Theorems.Adversarial.EventsSse.{n}"
private def t4 (n : String) : String := s!"AgentWorkspace.Theorems.Refinement.EventsSse.{n}"

private def optionalString : Option String → Json
  | some s => .str s
  | none => .null

private def optionalNat : Option Nat → Json
  | some n => toJson n
  | none => .null

private def nameVerdict : Sse.NameVerdict → Json
  | .ok name => Json.mkObj [("kind", "ok"), ("name", name)]
  | .reserved name => Json.mkObj [("kind", "reserved"), ("name", name)]
  | .rejected => Json.mkObj [("kind", "rejected")]

def vocabularyVectors : List Vector :=
  [{ id := "names", input := .null,
     expected := Json.mkObj [("control", toJson controlFrameNames),
       ("relayed", toJson relayedEventNames), ("status", runStatusEvent),
       ("warning", runWarningEvent), ("platform", toJson platformEventNames)],
     witnesses := [t0 "event_names_equal_phase_one"] },
   { id := "server-names", input := .null,
     expected := Json.mkObj [("control", toJson Sse.serverControlNames),
       ("reserved", toJson Sse.reservedNames)],
     witnesses := [t3 "runtime_cannot_claim_control_or_platform_name"] },
   { id := "headers", input := .null,
     expected := Json.mkObj (Sse.headers.map fun (key, value) => (key, Json.str value)),
     witnesses := [t1 "sse_headers_are_exact"] }]

def schemaVectors : List Vector :=
  let bodies : List (String × JValue) :=
    [("valid", .obj [("status", .str "running"), ("error", .null)]),
     ("failed", .obj [("status", .str "failed"), ("error", .str "safe")]),
     ("missing-error", .obj [("status", .str "running")]),
     ("bad-status", .obj [("status", .str "unknown"), ("error", .null)]),
     ("extra", .obj [("status", .str "running"), ("error", .null), ("x", .bool true)]),
     ("non-object", .arr [])]
  let status := bodies.map fun (id, body) =>
    { id := "status/" ++ id, input := Json.mkObj [("schema", "status"), ("body", body.toJson)],
      expected := Json.mkObj [("valid", runStatusData body)],
      witnesses := [t0 "status_schema_is_strict"] }
  let failed : List (String × JValue) :=
    [("unknown", .obj [("status", .str "unknown"), ("message", .str "lost")]),
     ("cancelled", .obj [("status", .str "cancelled"), ("message", .str "stopped")]),
     ("missing-message", .obj [("status", .str "failed")]),
     ("message-null", .obj [("status", .str "failed"), ("message", .null)]),
     ("extra", .obj [("status", .str "failed"), ("message", .str "x"), ("x", .null)])]
  let failedVs := failed.map fun (id, body) =>
    { id := "failed/" ++ id, input := Json.mkObj [("schema", "failed"), ("body", body.toJson)],
      expected := Json.mkObj [("valid", runFailedData body)],
      witnesses := [t0 "failure_schema_admits_unknown"] }
  let reset : List (String × JValue) :=
    [("null", .obj [("reason", .str "gap"), ("resumedAfter", .null)]),
     ("id", .obj [("reason", .str "gap"), ("resumedAfter", .str "3")]),
     ("missing", .obj [("reason", .str "gap")]),
     ("number", .obj [("reason", .str "gap"), ("resumedAfter", .num 3 0)])]
  let resetVs := reset.map fun (id, body) =>
    { id := "reset/" ++ id, input := Json.mkObj [("schema", "reset"), ("body", body.toJson)],
      expected := Json.mkObj [("valid", streamResetData body)],
      witnesses := [t0 "reset_schema_requires_nullable_resume"] }
  let warning : List (String × JValue) :=
    [("code", .obj [("code", .str "attachments_removed_shell")]),
     ("message", .obj [("code", .str "c"), ("message", .str "m")]),
     ("empty-code", .obj [("code", .str "")]),
     ("missing-code", .obj [("message", .str "m")]),
     ("message-null", .obj [("code", .str "c"), ("message", .null)]),
     ("extra", .obj [("code", .str "c"), ("x", .bool true)])]
  let warningVs := warning.map fun (id, body) =>
    { id := "warning/" ++ id, input := Json.mkObj [("schema", "warning"), ("body", body.toJson)],
      expected := Json.mkObj [("valid", runWarningData body)],
      witnesses := [t0 "warning_schema_is_strict"] }
  let relay : List (String × JValue) :=
    [("minimal", .obj [("kind", .str "sdk-event")]),
     ("extras", .obj [("kind", .str "text"), ("content", .arr [.str "a"])]),
     ("empty-kind", .obj [("kind", .str "")]),
     ("missing-kind", .obj [("type", .str "x")]),
     ("array", .arr [])]
  let relayVs := relay.map fun (id, body) =>
    { id := "relay/" ++ id, input := Json.mkObj [("schema", "relay"), ("body", body.toJson)],
      expected := Json.mkObj [("valid", relayedEventData body)],
      witnesses := [t0 "relay_schema_requires_nonempty_kind"] }
  status ++ warningVs ++ failedVs ++ resetVs ++ relayVs

def nameVectors : List Vector :=
  let cases := ["system", "run.status", "run.warning", "done", "run-failed", "stream-reset", "error", "x", "",
    "a_b.c-9", "9first", "system\ndata: forged", "system\r\nevent: done",
    String.ofList ('a' :: List.replicate 63 'x'), String.ofList ('a' :: List.replicate 64 'x')]
  cases.map fun name =>
    { id := (Json.str name).compress, input := Json.str name,
      expected := Json.mkObj [("pattern", eventNamePattern name),
        ("relay", nameVerdict (Sse.classifyEventName name)),
        ("platform", nameVerdict (Sse.classifyPlatformEventName name)),
        ("stored", nameVerdict (Sse.classifyStoredEventName name))],
      witnesses := [t3 "runtime_cannot_claim_control_or_platform_name",
        t3 "name_injection_is_refused", t3 "accepted_runtime_name_is_in_grammar"] }

private def cursorJson : Resume.Cursor → Json
  | .absent => Json.mkObj [("kind", "absent")]
  -- The sub-index is deliberately *not* emitted: these vectors pin the sequence, the source and the
  -- invalid/absent distinction, and `agent-frames` pins the sub-index grammar on its own.
  | .after id _ source => Json.mkObj [("kind", "after"), ("id", toString id),
      ("source", if source == .header then "header" else "query")]
  | .invalid source => Json.mkObj [("kind", "invalid"),
      ("source", if source == .header then "header" else "query")]

def cursorVectors : List Vector :=
  let values : List (Option String × Option String) :=
    [(none, none), (some "0", none), (none, some "7"), (some " 0007 ", some "9"),
     (some "", some "9"), (some "garbage", some "9"),
     (some "9223372036854775807", none), (some "9223372036854775808", none),
     (none, some "-1"), (none, some "12345678901234567890"),
     (none, some "１２"), (some "7\n", none)]
  values.map fun (h, q) =>
    { id := s!"{(optionalString h).compress}/{(optionalString q).compress}",
      input := Json.mkObj [("header", optionalString h), ("query", optionalString q)],
      expected := cursorJson (Resume.readResumeCursor h q),
      witnesses := [t0 "resume_header_wins", t0 "resume_cursor_range_boundary"] }

private def parsedFrame : Option SdkSse.Frame → Json
  | none => .null
  | some f => Json.mkObj [("event", f.event), ("id", optionalString f.id),
      ("dataRaw", optionalString f.dataRaw)]

def parserVectors : List Vector :=
  let raws := ["event: run.status\nid: 7\ndata: {\"status\":\"running\",\"error\":null}",
    "event: x\nid:\ndata: {}", "event: x\ndata: one\ndata: two",
    "event: x\ndata:", ": keepalive", "data: {}", "event: x\nevent: y\nid: 1\nid: 2",
    "retry: 3000\nevent: done\ndata: {}", "event: x\r\nid: 1\r\ndata: {}"]
  raws.map fun raw =>
    { id := (Json.str raw).compress, input := Json.str raw,
      expected := parsedFrame (SdkSse.parseSseFrame raw),
      witnesses := [t0 "sdk_empty_id_is_present"] }

def splitterVectors : List Vector :=
  let buffers := ["event: x\ndata: {}\n\n", "event: x\r\ndata: {}\r\n\r\n",
    "event: x\r\r", "event: x\ndata: {}\n\nevent: y\ndata: 2\n\n",
    "event: x\ndata: {}\n\nevent: partial"]
  buffers.map fun buffer =>
    let (frames, rest) := SdkSse.splitSseFrames buffer
    { id := (Json.str buffer).compress, input := Json.str buffer,
      expected := Json.mkObj [("frames", toJson frames), ("rest", rest)],
      witnesses := [t0 "sdk_splitter_resolves_lone_cr", t4 "lone_cr_splitter_agrees"] }

def relayLineVectors : List Vector :=
  let cases : List (String × List String) :=
    [("lf", ["event: x\ndata: 1\n\n"]),
     ("crlf", ["event: x\r\ndata: 1\r\n\r\n"]),
     ("cr", ["event: x\rdata: 1\r\r"]),
     ("split-crlf", ["event: x\r", "\ndata: 1\r", "\n\r\n"]),
     ("partial-tail", ["event: x\ndata: unfinished"])]
  cases.map fun (id, chunks) =>
    let (state, lines) := chunks.foldl (fun (acc : Sse.LineState × List String) chunk =>
      let (next, emitted) := Sse.pushLines acc.1 chunk
      (next, acc.2 ++ emitted)) ({}, [])
    { id, input := toJson chunks,
      expected := Json.mkObj [("lines", toJson lines), ("rest", state.buffer)],
      witnesses := [t0 "relay_crlf_across_chunks"] }

def relayAssemblerVectors : List Vector :=
  let cases : List (String × List String) :=
    [("named", ["event: system", "id: 7", "data: one", "data: two", ""]),
     ("id-only", ["id: 7", "", "data: later", ""]),
     ("empty-id", ["id:", "event: system", "data: x", ""]),
     ("nul-id", ["id: a\u0000b", "event: system", "data: x", ""]),
     ("comment", [": keepalive", "event: x", "data: {}", ""]),
     ("unnamed", ["data: x", ""])]
  cases.map fun (id, lines) =>
    let (state, messages) := lines.foldl (fun (acc : Sse.Assembler × List Sse.RelayMessage) line =>
      let (next, output) := Sse.assembleLine acc.1 line
      (next, acc.2 ++ output.toList)) ({}, [])
    let rendered := messages.map fun m => Json.mkObj
      [("event", optionalString m.event), ("data", m.data), ("lastEventId", m.lastEventId)]
    { id, input := toJson lines,
      expected := Json.mkObj [("messages", toJson rendered), ("lastEventId", state.lastEventId)],
      witnesses := [t0 "relay_id_only_moves_cursor"] }

def frameVectors : List Vector :=
  let events : List RunLog.Event :=
    [⟨1, "run.status", .obj [("status", .str "running"), ("error", .null)]⟩,
     ⟨2, "system", .obj [("kind", .str "sdk-event")]⟩]
  events.map fun event =>
    { id := s!"event/{event.id}",
      input := Json.mkObj [("id", toJson event.id), ("name", event.name),
        ("data", event.data.toJson)],
      expected := Json.mkObj [("frame", optionalString (Sse.durableFrame event))],
      witnesses := [t0 "control_frame_omits_id"] }

def controlVectors : List Vector :=
  [{ id := "done", input := Json.mkObj [("kind", "control"), ("name", "done"),
       ("data", Json.mkObj [])],
     expected := Json.str (Sse.controlFrame "done" (.obj [])),
     witnesses := [t0 "control_frame_omits_id", t4 "done_control_sdk_has_no_cursor"] },
   { id := "failure", input := Json.mkObj [("kind", "control"),
       ("name", "run-failed"), ("data", Json.mkObj [("status", "failed"),
         ("message", "safe")])],
     expected := Json.str (Sse.controlFrame "run-failed"
       (.obj [("status", .str "failed"), ("message", .str "safe")])),
     witnesses := [t1 "outcome_frame_order"] },
   { id := "retry-zero", input := Json.mkObj [("kind", "retry"), ("ms", 0)],
     expected := Json.str (Sse.retryFrame 0), witnesses := [t1 "retry_and_keepalive_frames"] },
   { id := "retry-positive", input := Json.mkObj [("kind", "retry"), ("ms", 950)],
     expected := Json.str (Sse.retryFrame 950), witnesses := [t1 "retry_and_keepalive_frames"] },
   { id := "comment-newline", input := Json.mkObj [("kind", "comment"),
       ("text", "a\r\nb\nc")], expected := Json.str (Sse.comment "a\r\nb\nc"),
     witnesses := [t1 "retry_and_keepalive_frames"] }]

private def resetJson : Option RunLog.Reset → Json
  | none => .null
  | some (.gap resumedAfter) => Json.mkObj [("kind", "gap"),
      ("resumedAfter", (resumedAfter.map (Json.str ∘ toString)).getD .null)]
  | some (.ahead resumedAfter) => Json.mkObj [("kind", "ahead"),
      ("resumedAfter", (resumedAfter.map (Json.str ∘ toString)).getD .null)]

def logVectors : List Vector :=
  let cases : List (String × Nat × List String × Option Nat) :=
    [("retained-gap", 2, ["system", "system", "result"], some 0),
     ("first-connection", 1, ["system", "result"], none),
     ("ahead", 2, ["system"], some 3)]
  cases.map fun (id, limit, names, after) =>
    let (log, ids) := names.foldl (fun (acc : RunLog.Log × List Nat) name =>
      match RunLog.append limit acc.1 name .null with
      | some (next, event) => (next, acc.2 ++ [event.id])
      | none => acc) (RunLog.empty, [])
    let cursor := RunLog.startCursor log after
    { id, input := Json.mkObj [("limit", toJson limit), ("names", toJson names),
        ("after", optionalNat after)],
      expected := Json.mkObj [("ids", toJson ids),
        ("retained", toJson ((RunLog.pending log cursor).map (·.id))),
        ("reset", resetJson (RunLog.resetFor log after)),
        ("closedAppendRefused", (RunLog.append limit (RunLog.close log) "system" .null).isNone)],
      witnesses := [t1 "reset_gap_example", t1 "reset_ahead_examples",
        t1 "first_connection_announces_retention_gap", t2 "append_allocates_next_id",
        t2 "closed_log_refuses_append", t2 "pending_is_strictly_after"] }

private def outcomeJson : Sse.Outcome → Json
  | .succeeded => Json.mkObj [("kind", "succeeded")]
  | .paused => Json.mkObj [("kind", "paused")]
  | .failed status message => Json.mkObj [("kind", "failed"),
      ("status", status), ("message", message)]
  | .indeterminate reason => Json.mkObj [("kind", "indeterminate"), ("reason", reason)]

def outcomeVectors : List Vector :=
  let cases : List (String × Option Contracts.RunStatus × Option String) :=
    [("missing", none, none), ("queued", some .queued, none),
     ("running", some .running, none), ("completed", some .completed, none),
     ("failed-default", some .failed, none), ("failed-message", some .failed, some "safe"),
     ("cancelled", some .cancelled, none),
     ("awaiting-approval", some .awaitingApproval, none)]
  cases.map fun (id, status, error) =>
    { id, input := Json.mkObj [("status", optionalString (status.map Contracts.RunStatus.toWire)),
        ("error", optionalString error)],
      expected := outcomeJson (Sse.classifyRunOutcome
        "99999999-9999-4999-8999-999999999999" status error),
      witnesses := [t1 "classify_run_outcome_is_total"] }

def outcomeFrameVectors : List Vector :=
  let cases : List (String × Sse.Outcome) :=
    [("succeeded", .succeeded), ("paused", .paused), ("failed", .failed "failed" "safe"),
     ("indeterminate", .indeterminate "lost")]
  cases.map fun (id, outcome) =>
    { id, input := Json.str id, expected := toJson (Sse.outcomeFrames outcome),
      witnesses := [t1 "outcome_frame_order"] }

def files : List (String × Json) :=
  [("vocabulary.json", file "events-sse" "Contract and server frame names and headers" vocabularyVectors),
   ("schemas.json", file "events-sse" "Run-event payload schemas" schemaVectors),
   ("names.json", file "events-sse" "Event name classification" nameVectors),
   ("cursor.json", file "events-sse" "Resume cursor precedence and bounds" cursorVectors),
   ("parser.json", file "events-sse" "SDK frame parser" parserVectors),
   ("splitter.json", file "events-sse" "SDK frame splitter" splitterVectors),
   ("relay-lines.json", file "events-sse" "Server relay line splitting" relayLineVectors),
   ("relay-messages.json", file "events-sse" "Server relay message assembly" relayAssemblerVectors),
   ("frames.json", file "events-sse" "Server durable frames" frameVectors),
   ("control.json", file "events-sse" "Server control, retry and keepalive frames" controlVectors),
   ("log.json", file "events-sse" "Run log retention, resume and closure" logVectors),
   ("outcomes.json", file "events-sse" "Run status to stream outcome" outcomeVectors),
   ("outcome-frames.json", file "events-sse" "Terminal stream frame order" outcomeFrameVectors)]

end Vectors.EventsSse
