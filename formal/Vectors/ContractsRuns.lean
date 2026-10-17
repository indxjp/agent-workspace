import AgentWorkspace.Theorems.WellFormed.ContractsRuns
import Vectors.Common

namespace Vectors.ContractsRuns

open Lean AgentWorkspace AgentWorkspace.Contracts.Runs

private def witness (name : String) : String :=
  "AgentWorkspace.Theorems.WellFormed.ContractsRuns." ++ name

private def vector (schema id : String) (input : JValue) (check : JValue → Bool)
    (theoremName : String) : Vector :=
  { id := schema ++ "/" ++ id, input := Json.mkObj [("schema", schema), ("body", input.toJson)],
    expected := Json.mkObj [("output", if check input then input.toJson else Json.null)],
    witnesses := [witness theoremName] }

private def cost (amount currency : JValue) (version : JValue := .null) : JValue :=
  .obj [("amount", amount), ("currency", currency), ("priceTableVersion", version)]

private def usage : JValue := .obj
  [("inputTokens", .num 1 0), ("outputTokens", .num 2 0),
   ("cacheReadInputTokens", .num 3 0), ("cacheCreationInputTokens", .num 4 0),
   ("totalTokens", .num 10 0), ("toolCalls", .num 0 0)]

private def run : JValue := .obj
  [("id", .str "run"), ("workspaceId", .str "ws"), ("agentId", .str "agent"),
   ("projectId", .null), ("initiatingUserId", .null), ("sessionId", .str "session"),
   ("status", .str "queued"), ("createdAt", .str "2026-01-02T03:04:05Z"),
   ("startedAt", .null), ("endedAt", .null), ("durationMs", .null),
   ("model", .null), ("provider", .null), ("modelConnectionId", .null),
   ("engine", .str "claude-agent-sdk"), ("engineVersion", .null),
   ("usage", usage), ("cost", cost (.str "0.000000") (.str "USD")),
   ("error", .null), ("accountingState", .str "pending"), ("accountingError", .null)]

private def session : JValue := .obj
  [("id", .str "session"), ("workspaceId", .str "ws"), ("agentId", .str "agent"),
   ("userId", .null), ("ownerPrincipalId", .str "principal"), ("projectId", .null),
   ("engineSessionId", .null), ("engine", .null), ("title", .null), ("status", .str "active"),
   ("resumable", .bool false), ("createdAt", .str "2026-01-02T03:04:05Z"),
   ("updatedAt", .str "2026-01-02T03:04:05Z")]

private def req (extra : JValue.Fields := []) : JValue :=
  .obj ([("prompt", .str "go")] ++ extra)

private def uuid : JValue := .str "123e4567-e89b-42d3-a456-426614174000"

def schemaVectors : List Vector :=
  let requestCases : List (String × JValue) :=
    [("minimal", req), ("blank", req [("prompt", .str " \n")]),
     ("empty", req [("prompt", .str "")]),
     ("max", req [("prompt", .str (String.ofList (List.replicate 100000 'a')))]),
     ("over-max", req [("prompt", .str (String.ofList (List.replicate 100001 'a')))]),
     ("null-session", req [("sessionId", .null)]),
     ("valid-session", req [("sessionId", uuid)]),
     ("bad-session", req [("sessionId", .str "bad")]),
     ("null-pair", req [("modelConnectionId", .null), ("model", .null)]),
     ("valid-pair", req [("modelConnectionId", uuid), ("model", .str "m")]),
     ("model-only", req [("model", .str "m")]),
     ("connection-only", req [("modelConnectionId", uuid)]),
     ("model-empty", req [("modelConnectionId", uuid), ("model", .str "")]),
     ("unknown-key", req [("extra", .bool true)]),
     ("not-object", .arr []), ("missing-prompt", .obj [])]
  let requestVs := requestCases.map fun (id, j) =>
    vector "StartRunRequestSchema" id j startRunRequest "start_request_roundtrip"
  let costCases : List (String × JValue) :=
    [("valid", cost (.str "0.000000") (.str "USD")),
     ("nondecimal", cost (.str "not-money") (.str "X")),
     ("empty-amount", cost (.str "") (.str "USD")),
     ("empty-currency", cost (.str "1") (.str "")),
     ("number", cost (.num 1 0) (.str "USD")),
     ("missing-version", .obj [("amount", .str "1"), ("currency", .str "USD")]),
     ("unknown-key", .obj [("amount", .str "1"), ("currency", .str "USD"),
       ("priceTableVersion", .null), ("extra", .null)])]
  let costVs := costCases.map fun (id, j) => vector "RunCostSchema" id j runCost "run_cost_roundtrip"
  let usageCases : List (String × JValue) :=
    [("valid", usage), ("missing", .obj []),
     ("negative", .obj (match usage with
       | .obj fs => fs.filter (·.1 != "inputTokens") ++ [("inputTokens", .num (-1) 0)]
       | _ => [])),
     ("fraction", .obj (match usage with
       | .obj fs => fs.filter (·.1 != "toolCalls") ++ [("toolCalls", .num 15 1)]
       | _ => [])),
     ("sum-not-enforced", .obj (match usage with
       | .obj fs => fs.filter (·.1 != "totalTokens") ++ [("totalTokens", .num 0 0)]
       | _ => []))]
  let usageVs := usageCases.map fun (id, j) =>
    vector "RunUsageSchema" id j runUsage "run_usage_roundtrip"
  let resourceCases : List (String × JValue) :=
    [("queued", run),
     ("missing", .obj [("id", .str "r")]),
     ("unknown-key", .obj (match run with | .obj fs => fs ++ [("extra", .null)] | _ => [])),
     ("bad-status", .obj (match run with
       | .obj fs => fs.filter (·.1 != "status") ++ [("status", .str "paused")]
       | _ => [])),
     ("bad-usage", .obj (match run with
       | .obj fs => fs.filter (·.1 != "usage") ++ [("usage", .obj [])]
       | _ => []))]
  let resourceVs := resourceCases.map fun (id, j) =>
    vector "RunResourceSchema" id j runResource "run_resource_roundtrip"
  let sessionCases : List (String × JValue) :=
    [("valid", session), ("archived-resumable", .obj (match session with
      | .obj fs => fs.filter (·.1 != "status") ++ [("status", .str "archived")]
      | _ => [])),
     ("missing", .obj []), ("bad-resumable", .obj (match session with
      | .obj fs => fs.filter (·.1 != "resumable") ++ [("resumable", .str "true")]
      | _ => []))]
  let sessionVs := sessionCases.map fun (id, j) =>
    vector "SessionResourceSchema" id j AgentWorkspace.Contracts.Sessions.resource
      "session_resource_roundtrip"
  let sessionEnvelope : List (String × String × JValue × (JValue → Bool)) :=
    [("SessionResponseSchema", "valid", .obj [("session", session)],
       AgentWorkspace.Contracts.Sessions.response),
     ("SessionListResponseSchema", "empty", .obj [("sessions", .arr []),
       ("projectKey", .str "ws"), ("nextCursor", .null)],
       AgentWorkspace.Contracts.Sessions.listResponse),
     ("SessionListResponseSchema", "page", .obj [("sessions", .arr [session]),
       ("projectKey", .str "ws"), ("nextCursor", .str "opaque")],
       AgentWorkspace.Contracts.Sessions.listResponse),
     ("SessionListResponseSchema", "no-cursor", .obj [("sessions", .arr []),
       ("projectKey", .str "ws")], AgentWorkspace.Contracts.Sessions.listResponse),
     ("SessionListResponseSchema", "empty-cursor", .obj [("sessions", .arr []),
       ("projectKey", .str "ws"), ("nextCursor", .str "")],
       AgentWorkspace.Contracts.Sessions.listResponse),
     ("SessionListResponseSchema", "bad-key", .obj [("sessions", .arr []),
       ("projectKey", .str ""), ("nextCursor", .null)],
       AgentWorkspace.Contracts.Sessions.listResponse)]
  let sessionEnvelopeVs := sessionEnvelope.map fun (schema, id, j, p) =>
    vector schema id j p "session_list_roundtrip"
  let envelope : List (String × String × JValue × (JValue → Bool)) :=
    [("StartRunResponseSchema", "valid", .obj [("run", run), ("events", .str "/api/runs/run/events")], startRunResponse),
     ("StartRunResponseSchema", "empty-events", .obj [("run", run), ("events", .str "")], startRunResponse),
     ("RunResponseSchema", "valid", .obj [("run", run)], runResponse),
     ("InterruptRunResponseSchema", "valid", .obj [("run", run)], interruptRunResponse),
     ("RunListResponseSchema", "empty", .obj [("runs", .arr []), ("nextCursor", .null)], runListResponse),
     ("RunListResponseSchema", "page", .obj [("runs", .arr [run]), ("nextCursor", .str "opaque")], runListResponse),
     ("RunListResponseSchema", "empty-cursor", .obj [("runs", .arr []), ("nextCursor", .str "")], runListResponse),
     ("RevokeRunTokensResponseSchema", "revoked", .obj [("revoked", .num 1 0), ("outcome", .str "revoked")], revokeRunTokensResponse),
     ("RevokeRunTokensResponseSchema", "negative", .obj [("revoked", .num (-1) 0), ("outcome", .str "revoked")], revokeRunTokensResponse),
     ("RevokeRunTokensResponseSchema", "bad-outcome", .obj [("revoked", .num 0 0), ("outcome", .str "lost")], revokeRunTokensResponse)]
  let envelopeVs := envelope.map fun (schema, id, j, p) =>
    vector schema id j p "constants_match_exports"
  requestVs ++ costVs ++ usageVs ++ resourceVs ++ sessionVs ++ sessionEnvelopeVs ++ envelopeVs

private def queryVector (id : String) (query : Json) (model : RunListQuery) : Vector :=
  let entries := runListSearchParams model
  { id, input := query,
    expected := Json.arr ((entries.map fun (name, value) =>
      Json.arr #[toJson name, toJson value]).toArray),
    witnesses := [witness "list_query_field_order"] }

def queryVectors : List Vector :=
  [queryVector "empty" (Json.mkObj []) {},
   queryVector "sparse" (Json.mkObj [("status", "running"), ("agent", "a"),
     ("limit", toJson (20 : Nat)), ("cursor", "x")])
     { status := some "running", agent := some "a", limit := some 20,
       cursor := some "x" },
   queryVector "all" (Json.mkObj [("status", "running"), ("agent", "a"),
     ("project", "p"), ("provider", "openai"), ("model", "m"),
     ("from", "2026-01-01T00:00:00Z"), ("to", "2026-01-02T00:00:00Z"),
     ("user", "u"), ("limit", toJson (200 : Nat)), ("cursor", "a+/=")])
     { status := some "running", agent := some "a", project := some "p",
       provider := some "openai", model := some "m",
       fromInstant := some "2026-01-01T00:00:00Z",
       toInstant := some "2026-01-02T00:00:00Z", user := some "u", limit := some 200,
       cursor := some "a+/=" }]

def files : List (String × Json) :=
  [("schemas.json", file "contracts-runs"
    "Run request, resource, cost, usage and response schema values and rejection boundaries"
    schemaVectors),
   ("query.json", file "contracts-runs" "Optional run list filters in serialization order"
    queryVectors)]

end Vectors.ContractsRuns
