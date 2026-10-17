import AgentWorkspace.Theorems.WellFormed.SdkRuns
import AgentWorkspace.Theorems.Normative.SdkRuns
import AgentWorkspace.Theorems.Invariants.SdkRuns
import AgentWorkspace.Theorems.Refinement.SdkRuns
import Vectors.Common

namespace Vectors.SdkRuns

open Lean AgentWorkspace AgentWorkspace.Sdk.Runs

private def t0 (name : String) : String :=
  "AgentWorkspace.Theorems.WellFormed.SdkRuns." ++ name
private def t1 (name : String) : String :=
  "AgentWorkspace.Theorems.Normative.SdkRuns." ++ name
private def t2 (name : String) : String :=
  "AgentWorkspace.Theorems.Invariants.SdkRuns." ++ name
private def t4 (name : String) : String :=
  "AgentWorkspace.Theorems.Refinement.SdkRuns." ++ name

private def methodString : Method → String
  | .get => "GET"
  | .post => "POST"

private def requestJson (request : Request) : Json :=
  Json.mkObj [("method", methodString request.method), ("path", request.path),
    ("headers", Json.mkObj (request.headers.map fun (k, v) => (k, Json.str v))),
    ("body", (request.body.map JValue.toJson).getD .null),
    ("expect", toJson request.expect)]

def requestVectors : List Vector :=
  [{ id := "start/absent", input := Json.mkObj [("method", "start"), ("agentId", "agent"),
       ("prompt", "go")], expected := requestJson (start "agent" "go" none none),
     witnesses := [t1 "start_request_normalizes_absent_fields"] },
   { id := "start/override", input := Json.mkObj [("method", "start"),
       ("agentId", "agent"), ("prompt", "go"), ("sessionId", "session"),
       ("modelConnectionId", "connection"), ("model", "model")],
     expected := requestJson (start "agent" "go" (some "session")
       (some ("connection", "model"))), witnesses := [t1 "start_request_keeps_override"] },
   { id := "get", input := Json.mkObj [("method", "get"), ("runId", "r")],
     expected := requestJson (get "r"), witnesses := [t1 "record_and_mutation_requests"] },
   { id := "interrupt", input := Json.mkObj [("method", "interrupt"), ("runId", "r")],
     expected := requestJson (interrupt "r"), witnesses := [t1 "record_and_mutation_requests"] },
   { id := "revoke/absent", input := Json.mkObj [("method", "revoke"), ("runId", "r")],
     expected := requestJson (revokeTokens "r" none),
     witnesses := [t1 "record_and_mutation_requests"] },
   { id := "revoke/one", input := Json.mkObj [("method", "revoke"),
       ("runId", "r"), ("tokenId", "token")],
     expected := requestJson (revokeTokens "r" (some "token")),
     witnesses := [t1 "revoke_one_token_body"] },
   { id := "events/initial", input := Json.mkObj [("method", "events"), ("runId", "r")],
     expected := requestJson (events "r" none),
     witnesses := [t1 "initial_events_have_no_resume_header"] },
   { id := "events/resume", input := Json.mkObj [("method", "events"), ("runId", "r"),
       ("after", "7")], expected := requestJson (events "r" (some "7")),
     witnesses := [t1 "list_and_events_requests"] }]

def listVectors : List Vector :=
  let query : Contracts.Runs.RunListQuery :=
    { status := some "completed", agent := some "agent", limit := some 2 }
  [{ id := "nonempty", input := Json.mkObj [("status", "completed"),
      ("agent", "agent"), ("limit", toJson (2 : Nat))],
     expected := toJson ((list query).2.map fun (key, value) => [key, value]),
     witnesses := [t1 "list_keeps_nonempty_query"] }]

private def actionJson : FollowAction → Json
  | .reconnect state => Json.mkObj [("kind", "reconnect"),
      ("after", (state.after.map Json.str).getD .null),
      ("reconnects", toJson state.reconnects)]
  | .stop _ => Json.mkObj [("kind", "stop")]

def followVectors : List Vector :=
  let drops : List Vector := [0, 1, 2, 5].map fun n =>
    { id := s!"drop/{n}", input := Json.mkObj [("reconnects", toJson n),
        ("maxReconnects", toJson (2 : Nat)), ("after", "7"), ("callerAborted", false)],
      expected := actionJson (onDrop { reconnects := n } (some "7") 2 false (.transport false)),
      witnesses := [t2 "reconnect_count_increments", t2 "follow_never_exceeds_reconnect_budget"] }
  let abortedInput := Json.mkObj [("reconnects", toJson (0 : Nat)),
    ("maxReconnects", toJson (5 : Nat)), ("after", "7"), ("callerAborted", true)]
  let abort : Vector :=
    { id := "abort", input := abortedInput,
      expected := actionJson (onDrop {} (some "7") 5 true (.transport true)),
      witnesses := [t2 "follow_never_reconnects_after_caller_abort"] }
  drops ++ [abort]

def traceVectors : List Vector :=
  [(0, 0), (1, 1), (2, 5), (5, 8)].map fun (maxReconnects, drops) =>
    { id := s!"{maxReconnects}/{drops}",
      input := Json.mkObj [("maxReconnects", toJson maxReconnects),
        ("drops", toJson drops)],
      expected := Json.mkObj [("reconnects", toJson (reconnectCount maxReconnects drops 0))],
      witnesses := [t2 "repeated_drops_stay_within_budget",
        t2 "reconnect_budget_is_cumulative_witness"] }

def waitVectors : List Vector :=
  [Contracts.RunStatus.queued, .running, .completed, .failed, .cancelled].map fun status =>
    { id := "wait/" ++ status.toWire,
      input := Json.mkObj [("status", status.toWire), ("done", true)],
      expected := Json.mkObj [("violation", (waitOutcome true status).isSome)],
      witnesses := [t1 "wait_requires_settled_record",
        t4 "indeterminate_done_diverges_from_settled_wait"] }

def files : List (String × Json) :=
  [("requests.json", file "sdk-runs" "Observable request shapes" requestVectors),
   ("list.json", file "sdk-runs" "Nonempty list query ordering" listVectors),
   ("follow.json", file "sdk-runs" "Cumulative reconnect decisions" followVectors),
   ("trace.json", file "sdk-runs" "Multi-drop cumulative reconnect bound" traceVectors),
   ("wait.json", file "sdk-runs" "Settled-record decision" waitVectors)]

end Vectors.SdkRuns
