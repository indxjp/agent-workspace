import AgentWorkspace.Contracts.Runs
import AgentWorkspace.Events.SdkSse

/-! Observable request and stream decisions of the public runs client. -/

namespace AgentWorkspace.Sdk.Runs

open AgentWorkspace

inductive Method where
  | get | post
  deriving DecidableEq, Repr

structure Request where
  method : Method
  path : String
  headers : List (String × String) := []
  body : Option JValue := none
  expect : Nat
  deriving DecidableEq, Repr

/-- `encodedId` is the result of JavaScript's `encodeURIComponent` at the HTTP boundary. -/
def start (encodedId prompt : String) (sessionId : Option String)
    (modelOverride : Option (String × String)) : Request :=
  { method := .post, path := "/api/agents/" ++ encodedId ++ "/runs", expect := 202,
    body := some (.obj [("prompt", .str prompt),
      ("sessionId", sessionId.map JValue.str |>.getD .null),
      ("modelConnectionId", modelOverride.map (JValue.str ∘ Prod.fst) |>.getD .null),
      ("model", modelOverride.map (JValue.str ∘ Prod.snd) |>.getD .null)]) }

def get (encodedId : String) : Request :=
  { method := .get, path := "/api/runs/" ++ encodedId, expect := 200 }

def interrupt (encodedId : String) : Request :=
  { method := .post, path := "/api/runs/" ++ encodedId ++ "/interrupt", expect := 200 }

def revokeTokens (encodedId : String) (tokenId : Option String) : Request :=
  { method := .post, path := "/api/runs/" ++ encodedId ++ "/revoke-tokens", expect := 200,
    body := some (.obj [("tokenId", tokenId.map JValue.str |>.getD .null)]) }

def list (query : Contracts.Runs.RunListQuery) : Request × List (String × String) :=
  ({ method := .get, path := "/api/runs", expect := 200 },
    Contracts.Runs.runListSearchParams query)

def events (encodedId : String) (after : Option String) : Request :=
  { method := .get, path := "/api/runs/" ++ encodedId ++ "/events", expect := 200,
    headers := [("accept", "text/event-stream")] ++
      (after.map (fun id => [("last-event-id", id)])).getD [] }

inductive Failure where
  | transport (aborted : Bool)
  | apiProblem (status : Nat) (code : String)
  | contractViolation
  deriving DecidableEq, Repr

/-- The HTTP layer sends once; it does not automatically retry ordinary calls. -/
def attemptCount : Nat := 1

/-- A caller or headers deadline can abort fetch; only the caller signal aborts a body read. -/
def fetchFailure (callerAborted deadlineAborted : Bool) : Failure :=
  .transport (callerAborted || deadlineAborted)

def streamReadFailure (callerAborted : Bool) : Failure := .transport callerAborted

/-- A 200 stream must have the SSE media type and a readable body. -/
def streamResponseFailure (mediaTypeCorrect bodyPresent : Bool) : Option Failure :=
  if mediaTypeCorrect && bodyPresent then none else some .contractViolation

/-- An unexpected status is an API problem; malformed successful JSON is a contract violation. -/
def classifyResponse (expected status : Nat) (bodyValid : Bool) (problemCode : String) :
    Option Failure :=
  if status != expected then some (.apiProblem status problemCode)
  else if !bodyValid then some .contractViolation
  else none

inductive Envelope where
  | standard | detail | bare | unknown
  deriving DecidableEq, Repr

def problemCode (envelope : Envelope) (code : String) : String :=
  if envelope == .unknown then "unrecognised_error_body" else code

structure FollowState where
  after : Option String := none
  reconnects : Nat := 0
  deriving DecidableEq, Repr

inductive FollowAction where
  | reconnect (state : FollowState)
  | stop (failure : Failure)
  deriving DecidableEq, Repr

/-- Reconnect count is cumulative, and the latest durable id becomes `Last-Event-ID`. -/
def onDrop (state : FollowState) (lastSeen : Option String) (maxReconnects : Nat)
    (callerAborted : Bool) (failure : Failure) : FollowAction :=
  match failure with
  | .transport _ =>
      if callerAborted || state.reconnects ≥ maxReconnects then .stop failure
      else .reconnect { after := lastSeen, reconnects := state.reconnects + 1 }
  | _ => .stop failure

/-- The closed form of repeated transport drops from a counter within its budget. -/
def reconnectCount (maxReconnects drops count : Nat) : Nat :=
  if count ≥ maxReconnects then count else min maxReconnects (count + drops)

/-- A reset frame is yielded and does not itself clear the remembered resume cursor. -/
def onStreamReset (state : FollowState) : FollowState := state

/-- An empty SSE id clears the cursor; only nonempty durable ids can be sent on reconnect. -/
def recordFrameId (state : FollowState) (durable : Bool) (id : Option String) : FollowState :=
  if durable then
    { state with after := match id with
        | some "" => none
        | some value => some value
        | none => state.after }
  else state

/-- An indeterminate producer outcome writes `done`, then a live `get` is a contract breach. -/
def waitOutcome (done : Bool) (status : Contracts.RunStatus) : Option Failure :=
  if !done then some (.transport false)
  else if Contracts.RunStatus.isTerminal status then none
  else some .contractViolation

/-- Follow failures propagate unchanged; only a completed stream triggers the final run read. -/
def waitAfterFollow (follow : Except Failure Unit) (status : Contracts.RunStatus) :
    Option Failure :=
  match follow with
  | .error failure => some failure
  | .ok _ => waitOutcome true status

end AgentWorkspace.Sdk.Runs
