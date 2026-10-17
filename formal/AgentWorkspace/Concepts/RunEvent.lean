import AgentWorkspace.Prelude.Json
import AgentWorkspace.Prelude.Ids

/-!
# Run event

A **run event** is one durable, ordered entry of a run's event stream (`run_events`, keyed by
`(run_id, sequence)`): "Durable, ordered SSE events for one run. Sequence numbers are contiguous
per run." Its `sequence` is the resume cursor the stream sends as the SSE `id:`.

The stream vocabulary (`packages/contracts/src/run-events.ts`) has three kinds of frame, and only
two of them are run events:

* control frames (`done`, `run-failed`, `stream-reset`) are written by the stream itself, carry
  no `id:` and are never stored;
* the platform's lifecycle event `run.status` is durable;
* relayed runtime events (`system`, `sdk-event`, `result`, …) are durable.

Retention prunes the oldest events, so the stored sequences of a run are a contiguous window
`[lo, hi]` with `lo ≥ 1`, not necessarily starting at 1. Appending and pruning are behaviour
(Phase 4); this module states only the shape a stored log has.
-/

namespace AgentWorkspace.Concepts.RunEvent

open AgentWorkspace

/-- One stored event. `data` is the JSON text of the `jsonb` column. -/
@[aw_spec (ts := "packages/core/src/db/schema/run-events.ts#runEvents")
  (doc := "docs/sdk/04-api-specification.md#2-resource-model")]
structure RunEvent where
  key : RunEventKey
  workspace : WorkspaceId
  type : String
  data : String
  createdAt : Nat
  deriving DecidableEq, Repr, Inhabited

/-- `CONTROL_FRAME_NAMES`. -/
@[aw_spec (ts := "packages/contracts/src/run-events.ts#CONTROL_FRAME_NAMES")]
def controlFrameNames : List String := ["done", "run-failed", "stream-reset"]

/-- `RUN_STATUS_EVENT`. -/
@[aw_spec (ts := "packages/contracts/src/run-events.ts#RUN_STATUS_EVENT")]
def runStatusEvent : String := "run.status"

/-- `RELAYED_EVENT_NAMES`. -/
@[aw_spec (ts := "packages/contracts/src/run-events.ts#RELAYED_EVENT_NAMES")]
def relayedEventNames : List String :=
  ["system", "system-unknown", "result", "result-unknown", "sdk-event", "unknown", "malformed"]

/-- The three kinds of frame a client tells apart by name. -/
@[aw_spec (ts := "packages/contracts/src/run-events.ts#CONTROL_FRAME_NAMES")
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#the-event-stream")]
inductive FrameKind where
  | control
  | platform
  | relayed
  deriving DecidableEq, Repr, Inhabited

/-- The kind of a listed frame name. -/
def frameKind? (name : String) : Option FrameKind :=
  if controlFrameNames.contains name then some .control
  else if name == runStatusEvent then some .platform
  else if relayedEventNames.contains name then some .relayed
  else none

/-- Whether frames of a kind carry a resume `id:` (are durable run events). -/
@[aw_spec (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#the-event-stream")
  (ts := "packages/contracts/src/run-events.ts#CONTROL_FRAME_NAMES")]
def FrameKind.durable : FrameKind → Bool
  | .control => false
  | .platform | .relayed => true

/-- A character `EVENT_NAME_PATTERN` admits after the first: `[A-Za-z0-9._-]`. -/
def isEventNameChar (c : Char) : Bool :=
  ('A' ≤ c && c ≤ 'Z') || ('a' ≤ c && c ≤ 'z') || ('0' ≤ c && c ≤ '9') || c == '.' ||
    c == '_' || c == '-'

/-- `EVENT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/`. -/
@[aw_spec (ts := "packages/contracts/src/run-events.ts#EVENT_NAME_PATTERN")]
def isEventName (s : String) : Bool :=
  match s.toList with
  | [] => false
  | c :: rest =>
    (('A' ≤ c && c ≤ 'Z') || ('a' ≤ c && c ≤ 'z')) && rest.all isEventNameChar && rest.length ≤ 63

/-- The sequences a list of stored events holds for one run, in list order. -/
def sequencesOf (events : List RunEvent) (run : RunId) : List Nat :=
  (events.filter (·.key.run == run)).map (·.key.sequence)

/-- A contiguous window of sequence numbers starting at `lo ≥ 1`, in increasing order. -/
def isWindow : List Nat → Bool
  | [] => true
  | lo :: rest => 1 ≤ lo && rest == List.range' (lo + 1) rest.length

/-- The stored log of a run is a window: "Sequence numbers are contiguous per run", and the
oldest may have been pruned. -/
@[aw_spec (ts := "packages/core/src/db/schema/run-events.ts#runEvents")
  (ts := "packages/core/src/db/repositories/runs.ts#createDatabaseRunEventRepositoryProvider")]
def logContiguous (events : List RunEvent) (run : RunId) : Bool := isWindow (sequencesOf events run)

end AgentWorkspace.Concepts.RunEvent
