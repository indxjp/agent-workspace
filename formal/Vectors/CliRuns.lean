import AgentWorkspace.Theorems.WellFormed.CliRuns
import AgentWorkspace.Theorems.Normative.CliRuns
import AgentWorkspace.Theorems.Invariants.CliRuns
import AgentWorkspace.Theorems.Refinement.CliRuns
import Vectors.Common

namespace Vectors.CliRuns

open Lean AgentWorkspace AgentWorkspace.Cli.Runs

private def t0 (name : String) : String :=
  "AgentWorkspace.Theorems.WellFormed.CliRuns." ++ name
private def t1 (name : String) : String :=
  "AgentWorkspace.Theorems.Normative.CliRuns." ++ name
private def t2 (name : String) : String :=
  "AgentWorkspace.Theorems.Invariants.CliRuns." ++ name
private def t4 (name : String) : String :=
  "AgentWorkspace.Theorems.Refinement.CliRuns." ++ name

private def commandString : AgentWorkspace.Cli.Runs.Command → String
  | .start => "start" | .get => "get" | .list => "list" | .events => "events"
  | .follow => "follow" | .interrupt => "interrupt" | .wait => "wait"

private def callString : SdkCall → String
  | .start => "start" | .get => "get" | .list => "list" | .events => "events"
  | .follow => "follow" | .interrupt => "interrupt" | .waitForOutcome => "waitForOutcome"

def commandVectors : List Vector := commands.map fun command =>
  { id := commandString command, input := Json.mkObj [("command", commandString command)],
    expected := Json.mkObj [("sdkCall", callString (sdkCall command))],
    witnesses := [t0 "commands_are_exact", t1 "every_command_routes_to_sdk"] }

private def modeString : StartMode → String
  | .plain => "plain" | .wait => "wait" | .follow => "follow" | .invalid => "invalid"

def startVectors : List Vector :=
  [(false, false), (true, false), (false, true), (true, true)].map fun (wait, follow) =>
    { id := s!"{wait}/{follow}", input := Json.mkObj [("wait", toJson wait),
        ("follow", toJson follow)],
      expected := Json.mkObj [("mode", modeString (startMode wait follow)),
        ("calls", toJson ((startCalls (startMode wait follow)).map callString))],
      witnesses := [t1 "start_mode_cases", t1 "start_secondary_dispatch"] }

private def promptString : PromptSource → String
  | .missing => "missing" | .inline => "inline" | .file => "file"
  | .stdin => "stdin" | .conflict => "conflict"

def promptVectors : List Vector :=
  [(false, false, "", true), (true, false, "", true),
   (true, true, "file", true), (false, true, "-", true),
   (false, true, "missing.txt", false)].map fun (inline, file, path, readable) =>
    let source := promptSource inline file path
    { id := promptString source ++ "/" ++ path,
      input := Json.mkObj [("inline", toJson inline), ("file", toJson file),
        ("path", path), ("readable", toJson readable)],
      expected := Json.mkObj [("source", promptString source),
        ("fileFailure", promptFileFailure source readable)],
      witnesses := [t0 "prompt_source_cases", t0 "unreadable_prompt_file_is_usage"] }

private def outputString : OutputMode → String
  | .human => "human" | .json => "json" | .jsonl => "jsonl" | .raw => "raw"

def outputVectors : List Vector :=
  [(false, false, false, false), (false, true, false, false),
   (false, false, true, false), (true, true, true, true)].map fun (raw, json, jsonl, quiet) =>
    let streamMode := streamOutputMode raw json jsonl
    let recordMode := recordOutputMode json jsonl
    { id := s!"{raw}/{json}/{jsonl}/{quiet}",
      input := Json.mkObj [("raw", toJson raw), ("json", toJson json),
        ("jsonl", toJson jsonl), ("quiet", toJson quiet)],
      expected := Json.mkObj [("streamMode", outputString streamMode),
        ("recordMode", outputString recordMode),
        ("doneLines", toJson (outputFrameKind streamMode .done)),
        ("notice", toJson (listNoticeLines recordMode quiet "next page: --cursor next"))],
      witnesses := [t0 "output_mode_precedence", t1 "stream_frame_output_cases",
        t1 "notices_never_enter_stdout"] }

def flagVectors : List Vector :=
  [{ id := "resume", input := Json.mkObj [("after", "7")],
     expected := toJson (eventsAfter "r" (some "7")).headers,
     witnesses := [t1 "resume_and_list_flags"] },
   { id := "list", input := Json.mkObj [("status", "completed"), ("agent", "agent"),
       ("project", "project"), ("limit", toJson (2 : Nat)), ("cursor", "next")],
     expected := toJson (listFilters (some "completed") (some "agent")
       (some "project") (some 2) (some "next")),
     witnesses := [t1 "resume_and_list_flags"] }]

def waitVectors : List Vector :=
  [Contracts.RunStatus.completed, .failed, .cancelled].map fun status =>
    { id := status.toWire, input := Json.mkObj [("status", status.toWire)],
      expected := Json.mkObj [("currentExit", toJson (waitExitCurrent status)),
        ("targetExit", toJson (waitExitTarget status))],
      witnesses := [t4 "failed_wait_exit_diverges"] }

private def failureString : Failure → String
  | .usage => "usage" | .apiProblem => "apiProblem" | .contractViolation => "contractViolation"
  | .transport => "transport" | .unexpected => "unexpected"

def exitVectors : List Vector :=
  [.usage, .apiProblem, .contractViolation, .transport, .unexpected].map fun failure =>
    { id := failureString failure, input := Json.mkObj [("failure", failureString failure)],
      expected := Json.mkObj [("exit", toJson (exitCode false (some failure)))],
      witnesses := [t0 "exit_code_table", t2 "sdk_failure_maps_to_exit"] }

def stderrVectors : List Vector :=
  [false, true].map fun interrupted =>
    { id := if interrupted then "interrupted" else "api-details",
      input := Json.mkObj [("interrupted", toJson interrupted)],
      expected := toJson (reportLines interrupted .apiProblem "conflict" "try later"
        ["field: bad"]),
      witnesses := [t0 "error_stderr_order", t2 "sigint_exit_priority"] }

def files : List (String × Json) :=
  [("commands.json", file "cli-runs" "Run command dispatch" commandVectors),
   ("start.json", file "cli-runs" "Start mode combinations" startVectors),
   ("prompt.json", file "cli-runs" "Prompt source and file failure" promptVectors),
   ("output.json", file "cli-runs" "Output precedence and notices" outputVectors),
   ("flags.json", file "cli-runs" "Resume and list flags" flagVectors),
   ("wait.json", file "cli-runs" "Current versus target wait exit" waitVectors),
   ("exits.json", file "cli-runs" "Typed failure exits" exitVectors),
   ("stderr.json", file "cli-runs" "Failure line order" stderrVectors)]

end Vectors.CliRuns
