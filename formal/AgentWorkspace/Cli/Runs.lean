import AgentWorkspace.Sdk.Runs

/-! Observable command routing, output and exit decisions of `aw runs`. -/

namespace AgentWorkspace.Cli.Runs

open AgentWorkspace

inductive Command where
  | start | get | list | events | follow | interrupt | wait
  deriving DecidableEq, Repr

def commands : List Command := [.start, .get, .list, .events, .follow, .interrupt, .wait]

inductive SdkCall where
  | start | get | list | events | follow | interrupt | waitForOutcome
  deriving DecidableEq, Repr

def sdkCall : Command → SdkCall
  | .start => .start
  | .get => .get
  | .list => .list
  | .events => .events
  | .follow => .follow
  | .interrupt => .interrupt
  | .wait => .waitForOutcome

inductive StartMode where
  | plain | wait | follow | invalid
  deriving DecidableEq, Repr

def startMode (wait follow : Bool) : StartMode :=
  if wait && follow then .invalid
  else if wait then .wait
  else if follow then .follow
  else .plain

def startCalls (mode : StartMode) : List SdkCall :=
  match mode with
  | .invalid => []
  | .plain => [.start]
  | .wait => [.start, .waitForOutcome]
  | .follow => [.start, .follow]

inductive PromptSource where
  | missing | inline | file | stdin | conflict
  deriving DecidableEq, Repr

def promptSource (inline file : Bool) (filePath : String) : PromptSource :=
  if inline && file then .conflict
  else if inline then .inline
  else if !file then .missing
  else if filePath == "-" then .stdin
  else .file

def promptFileFailure (source : PromptSource) (readable : Bool) : Bool :=
  source == .file && !readable

/-- The first colon separates a nonempty connection from a nonempty provider model. -/
def modelOverride (raw : String) : Option (String × String) :=
  let (connection, rest) := raw.toList.span (· != ':')
  match rest with
  | [] => none
  | _ :: model =>
      if connection.isEmpty || model.isEmpty then none
      else some (String.ofList connection, String.ofList model)

inductive OutputMode where
  | human | json | jsonl | raw
  deriving DecidableEq, Repr

/-- `--raw` wins for stream frames; for record values JSONL wins over JSON. -/
def streamOutputMode (raw json jsonl : Bool) : OutputMode :=
  if raw then .raw else if json || jsonl then .jsonl else .human

def recordOutputMode (json jsonl : Bool) : OutputMode :=
  if jsonl then .jsonl else if json then .json else .human

inductive FrameKind where
  | runtime | platform | done
  deriving DecidableEq, Repr

/-- A done frame prints no structured line; raw emits its exact classified frame. -/
def outputFrameKind (mode : OutputMode) (frame : FrameKind) : List String :=
  if mode == .raw then ["raw"]
  else match frame with
  | .done => []
  | .platform => ["platform"]
  | .runtime => [if mode == .human then "human-agent" else "json-agent"]

inductive Failure where
  | usage | apiProblem | contractViolation | transport | unexpected
  deriving DecidableEq, Repr

def fromSdkFailure : Sdk.Runs.Failure → Failure
  | .transport _ => .transport
  | .apiProblem _ _ => .apiProblem
  | .contractViolation => .contractViolation

def courtesyTimeoutMs : Nat := 5000

def eventsAfter (encodedId : String) (after : Option String) : Sdk.Runs.Request :=
  Sdk.Runs.events encodedId after

def listFilters (status agent project : Option String) (limit : Option Int)
    (cursor : Option String) : List (String × String) :=
  (Sdk.Runs.list { status, agent, project, limit, cursor }).2

def exitCode (interrupted : Bool) (failure : Option Failure) : Nat :=
  if interrupted then 130
  else match failure with
  | none => 0
  | some .usage => 2
  | some .apiProblem => 1
  | some .contractViolation => 3
  | some .transport => 4
  | some .unexpected => 1

def commandExit (_command : Command) (interrupted : Bool) (failure : Option Failure) : Nat :=
  exitCode interrupted failure

/-- Today's wait command treats every settled SDK return as a successful command result. -/
def waitExitCurrent (_status : Contracts.RunStatus) : Nat := exitCode false none

/-- The documented target would make an unsuccessful run outcome visible in process status. -/
def waitExitTarget (status : Contracts.RunStatus) : Nat :=
  if status == .completed then 0 else 1

/-- The courtesy interrupt uses a new signal and leaves the original SIGINT exit intact. -/
def interruptOnCancel (flag signalAborted : Bool) : Bool := flag && signalAborted

def interruptedExitAfterCourtesy (_courtesySucceeded : Bool) : Nat := exitCode true none

/-- `--json` returns the whole page; human mode and `--jsonl` (one row per line, BH061-042)
select its rows. -/
def listOutputShape (mode : OutputMode) : String :=
  if mode == .json then "page" else "rows"

def noticeLines (quiet : Bool) (message : String) : List String :=
  if quiet then [] else [message]

/-- The next-page notice goes to stderr wherever stdout carries rows only: human and `--jsonl`. -/
def listNoticeLines (mode : OutputMode) (quiet : Bool) (message : String) : List String :=
  if mode == .json then [] else noticeLines quiet message

/-- stderr line order matches `reportFailure`, including API detail lines after the headline. -/
def reportLines (interrupted : Bool) (failure : Failure) (code message : String)
    (details : List String := []) : List String :=
  if interrupted then ["interrupted"]
  else match failure with
  | .usage => ["error: " ++ message, "run \"aw --help\" for usage"]
  | .apiProblem => ["error: " ++ code ++ ": " ++ message] ++
      details.map ("  " ++ ·)
  | .contractViolation => ["error: contract_violation: " ++ message]
  | .transport => ["error: transport: " ++ message]
  | .unexpected => ["error: unexpected: " ++ message]

end AgentWorkspace.Cli.Runs
