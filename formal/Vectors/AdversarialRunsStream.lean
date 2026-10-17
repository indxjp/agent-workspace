import AgentWorkspace.Theorems.Adversarial.AdversarialRunsStream
import Vectors.Common

namespace Vectors.AdversarialRunsStream

open Lean AgentWorkspace AgentWorkspace.Events AgentWorkspace.Lifecycle

private def witness (name : String) : String :=
  s!"AgentWorkspace.Theorems.Adversarial.AdversarialRunsStream.{name}"

private def loneCr : Vector :=
  { id := "sdk-lone-cr", input := Json.mkObj [("wire", "event: x\rdata: {}\r\rX")],
    expected := Json.mkObj [("frames", toJson (["event: x\ndata: {}"] : List String)),
      ("rest", "X")],
    witnesses := [witness "sdk_lone_cr_frame_delivered"] }

private def nameInjection : Vector :=
  let name := "model.result\nevent: run.status"
  { id := "runtime-name-injection", input := Json.mkObj [("name", name)],
    expected := Json.mkObj [("kind", "rejected")],
    witnesses := [witness "newline_name_injection_rejected"] }

private def invalidResume : Vector :=
  { id := "invalid-header-no-query-fallback",
    input := Json.mkObj [("header", "1\nevent: forged"), ("query", "7")],
    expected := Json.mkObj [("kind", "invalid"), ("source", "header")],
    witnesses := [witness "invalid_resume_header_cannot_fall_back_to_query"] }

private def channelNames : Vector :=
  { id := "separate-event-name-channels",
    input := Json.mkObj [("runtimeControl", "done"), ("platformRuntime", "model.result"),
      ("storedControl", "stream-reset"),
      ("allControls", toJson (["done", "run-failed", "stream-reset", "error"] : List String))],
    expected := Json.mkObj [("runtimeControl", "reserved"),
      ("platformRuntime", "rejected"), ("storedControl", "rejected"),
      ("allRuntime", toJson (["reserved", "reserved", "reserved", "reserved"] : List String)),
      ("allStored", toJson (["rejected", "rejected", "rejected", "rejected"] : List String))],
    witnesses := [witness "stream_name_channels_stay_separate"] }

private def oversizedResume : Vector :=
  { id := "oversized-resume-id",
    input := Json.mkObj [("header", "9223372036854775808"),
      ("zeroPadded", "00000000000000000000")],
    expected := Json.mkObj [("kind", "invalid"), ("source", "header"),
      ("zeroPaddedKind", "invalid")],
    witnesses := [witness "oversized_resume_id_is_rejected"] }

private def multilineData : Vector :=
  { id := "sdk-multiline-data",
    input := Json.mkObj [("wire", "event: x\ndata: {\"a\":\ndata: 1}\n\n"),
      ("threeLineWire", "event: x\ndata: {\ndata: \"a\":\ndata: 1}\n\n")],
    expected := Json.mkObj [("event", "x"), ("data", Json.mkObj [("a", toJson (1 : Nat))]),
      ("threeLineData", Json.mkObj [("a", toJson (1 : Nat))])],
    witnesses := [witness "multiline_sdk_data_is_preserved"] }

private def emptySdkId : Vector :=
  { id := "sdk-empty-id-reconnect",
    input := Json.mkObj [("wire", "event: run.status\nid:\ndata: {}\n\n"),
      ("previousAfter", "7")],
    expected := Json.mkObj [("id", ""), ("reconnectHeader", Json.null)],
    witnesses := [witness "empty_sdk_id_clears_reconnect_header"] }

private def tailDrain : Vector :=
  { id := "repository-terminal-tail-drain",
    input := Json.mkObj [("listedLastId", toJson (0 : Nat)),
      ("afterListLastId", toJson (1 : Nat)), ("cursor", toJson (0 : Nat)),
      ("terminal", toJson true)],
    expected := Json.mkObj [("deliveredIds", toJson ([1] : List Nat)),
      ("cursor", toJson (1 : Nat)), ("currentEnds", toJson true),
      ("targetEnds", toJson true)],
    witnesses := [witness "repository_terminal_read_drains_tail"] }

private def duplicateTerminal : Vector :=
  { id := "interrupt-conclude-one-terminal-event",
    input := Json.mkObj [("interleaving", toJson
      (["finish-cancelled", "finish-completed"] : List String))],
    expected := Json.mkObj [("storedStatus", "cancelled"),
      ("terminalEvents", toJson (["cancelled"] : List String))],
    witnesses := [witness "interrupt_conclude_commits_one_terminal_event"] }

private def truncatedFirstConnection : Vector :=
  { id := "truncated-first-connection-reset",
    input := Json.mkObj [("lastId", toJson (3 : Nat)),
      ("retainedIds", toJson ([3] : List Nat)), ("after", Json.null)],
    expected := Json.mkObj [("oldest", toJson (3 : Nat)), ("resumedAfter", "2")],
    witnesses := [witness "first_connection_to_truncated_log_resets"] }

private def aheadCursor : Vector :=
  { id := "ahead-cursor-reset",
    input := Json.mkObj [("after", toJson (7 : Nat)), ("lastId", toJson (1 : Nat)),
      ("emptyLastId", toJson (0 : Nat))],
    expected := Json.mkObj [("reset", "ahead"), ("resumedAfter", "0"),
      ("emptyResumedAfter", Json.null)],
    witnesses := [witness "ahead_cursor_requests_reset"] }

private def terminalClose : Vector :=
  { id := "terminal-finish-closes-log",
    input := Json.mkObj [("status", "running"), ("queuedStatus", "queued"),
      ("finish", "completed")],
    expected := Json.mkObj [("status", "completed"), ("appendRejected", toJson true),
      ("queuedStatus", "completed"), ("queuedAppendRejected", toJson true)],
    witnesses := [witness "terminal_finish_closes_log_and_revokes_token"] }

private def indeterminateDone : Vector :=
  { id := "indeterminate-unknown-then-done",
    input := Json.mkObj [("runStatus", "running"), ("reason", "lost")],
    expected := Json.mkObj [("frames", toJson (["run-failed", "done"] : List String)),
      ("failureStatus", "unknown"), ("waitError", "contract-violation")],
    witnesses := [witness "indeterminate_done_stops_follow_but_live_wait_fails"] }

def files : List (String × Json) :=
  [("attacks.json", file "adversarial-runs-stream"
    "Stream parser and interleaving counterexample candidates" 
    [loneCr, nameInjection, invalidResume, channelNames, oversizedResume, multilineData,
      emptySdkId, tailDrain, duplicateTerminal, truncatedFirstConnection, aheadCursor,
      terminalClose, indeterminateDone])]

end Vectors.AdversarialRunsStream
