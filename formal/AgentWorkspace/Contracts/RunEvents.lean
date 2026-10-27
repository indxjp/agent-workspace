import AgentWorkspace.Contracts.Runs

/-! The four event payload schemas and the three event-name vocabularies of the run stream. -/

namespace AgentWorkspace.Contracts.RunEvents

open AgentWorkspace AgentWorkspace.Contracts

@[aw_spec (ts := "packages/contracts/src/run-events.ts#CONTROL_FRAME_NAMES")]
def controlFrameNames : List String := ["done", "run-failed", "stream-reset"]

@[aw_spec (ts := "packages/contracts/src/run-events.ts#RUN_STATUS_EVENT")]
def runStatusEvent : String := "run.status"

@[aw_spec (ts := "packages/contracts/src/run-events.ts#RUN_WARNING_EVENT")]
def runWarningEvent : String := "run.warning"

/-- The durable names only the platform writes, in wire order. -/
@[aw_spec (ts := "packages/contracts/src/run-events.ts#PLATFORM_EVENT_NAMES")]
def platformEventNames : List String := [runStatusEvent, runWarningEvent]

@[aw_spec (ts := "packages/contracts/src/run-events.ts#RELAYED_EVENT_NAMES")]
def relayedEventNames : List String :=
  ["system", "system-unknown", "result", "result-unknown", "sdk-event", "unknown", "malformed"]

@[aw_spec (ts := "packages/contracts/src/run-events.ts#EVENT_NAME_PATTERN")]
def eventNamePattern (s : String) : Bool :=
  match s.toList with
  | [] => false
  | c :: rest =>
    (('A' ≤ c && c ≤ 'Z') || ('a' ≤ c && c ≤ 'z')) &&
      rest.all (fun x =>
        ('A' ≤ x && x ≤ 'Z') || ('a' ≤ x && x ≤ 'z') || ('0' ≤ x && x ≤ '9') ||
          x == '.' || x == '_' || x == '-') && rest.length ≤ 63

private def string (j : JValue) : Bool := (Codec.string.decode j).isSome
private def nonempty (j : JValue) : Bool := ((Codec.stringLen 1 none).decode j).isSome
private def status (j : JValue) : Bool :=
  Runs.enum ((WireEnum.all : List RunStatus).map RunStatus.toWire) j

/-- `{status, error}` is strict; the public failure is explicitly nullable. -/
@[aw_spec (ts := "packages/contracts/src/run-events.ts#RunStatusEventDataSchema")]
def runStatusData : JValue → Bool := Runs.object
  [("status", status), ("error", Runs.nullable string)]

/-- `{code, message?}` is strict: a nonempty `code`, and `message` text when present. -/
@[aw_spec (ts := "packages/contracts/src/run-events.ts#RunWarningEventDataSchema")]
def runWarningData : JValue → Bool
  | .obj fs =>
    Obj.onlyKeys ["code", "message"] fs && (JValue.lookup "code" fs).any nonempty &&
      Runs.optField string "message" fs
  | _ => false

/-- A stream failure also admits the outcome `unknown`. -/
@[aw_spec (ts := "packages/contracts/src/run-events.ts#RunFailedFrameDataSchema")]
def runFailedData : JValue → Bool := Runs.object
  [("status", fun j => status j || j == .str "unknown"), ("message", string)]

/-- The reset marker names the oldest id still resumable, or `null`. -/
@[aw_spec (ts := "packages/contracts/src/run-events.ts#StreamResetFrameDataSchema")]
def streamResetData : JValue → Bool := Runs.object
  [("reason", string), ("resumedAfter", Runs.nullable string)]

/-- Runtime data is extensible; only a nonempty `kind` is required. -/
@[aw_spec (ts := "packages/contracts/src/run-events.ts#RelayedEventDataSchema")]
def relayedEventData : JValue → Bool
  | .obj fs => (JValue.lookup "kind" fs).any nonempty
  | _ => false

/-! ## The neutral agent frames (ENG-03, #302)

The closed set the stream carries, and the two closed sets its frames are written in. Transcribed
position by position from the TypeScript `as const` arrays: the order is the wire order and is not
re-sorted. -/

@[aw_spec (ts := "packages/contracts/src/run-events.ts#AGENT_FRAME_NAMES")]
def agentFrameNames : List String :=
  ["agent.session", "agent.message", "agent.message.delta", "agent.tool.call",
   "agent.tool.result", "agent.usage", "agent.result", "agent.native", "agent.malformed",
   "agent.approval.requested", "agent.handoff"]

@[aw_spec (ts := "packages/contracts/src/run-events.ts#AGENT_TOOL_KINDS")]
def agentToolKinds : List String :=
  ["read", "edit", "delete", "move", "search", "execute", "fetch", "mcp", "other"]

@[aw_spec (ts := "packages/contracts/src/run-events.ts#AGENT_STOP_REASONS")]
def agentStopReasons : List String :=
  ["end_turn", "max_turns", "max_budget", "refusal", "cancelled", "error"]

/-- `raw` over the cap is truncated with a marker, never rejected: the marker's own shape is what a
consumer checks positively, because a clipped JSON fragment answers no question at all. -/
@[aw_spec (ts := "packages/contracts/src/run-events.ts#AgentFrameRawTruncationSchema")]
def agentFrameRawTruncation : JValue → Bool := Runs.object
  [("truncated", fun j => j == .bool true),
   ("encodedBytes", Runs.nullable Runs.nonnegativeInt),
   ("limitBytes", Runs.nonnegativeInt)]

def runStatusDataCodec : Codec JValue := Runs.checked runStatusData
def runFailedDataCodec : Codec JValue := Runs.checked runFailedData
def streamResetDataCodec : Codec JValue := Runs.checked streamResetData
def relayedEventDataCodec : Codec JValue := Runs.checked relayedEventData

end AgentWorkspace.Contracts.RunEvents
