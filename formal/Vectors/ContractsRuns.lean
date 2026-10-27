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
   ("agentVersion", .null), ("status", .str "queued"), ("createdAt", .str "2026-01-02T03:04:05Z"),
   ("startedAt", .null), ("endedAt", .null), ("durationMs", .null),
   ("model", .null), ("provider", .null), ("modelConnectionId", .null),
   ("engine", .str "claude-agent-sdk"), ("engineVersion", .null),
   ("usage", usage), ("cost", cost (.str "0.000000") (.str "USD")),
   ("error", .null), ("output", .null), ("accountingState", .str "pending"),
   ("accountingError", .null), ("pendingApproval", .null)]

private def session : JValue := .obj
  [("id", .str "session"), ("workspaceId", .str "ws"), ("agentId", .str "agent"),
   ("userId", .null), ("ownerPrincipalId", .str "principal"), ("projectId", .null),
   ("engineSessionId", .null), ("engine", .null), ("title", .null), ("status", .str "active"),
   ("resumable", .bool false), ("createdAt", .str "2026-01-02T03:04:05Z"),
   ("updatedAt", .str "2026-01-02T03:04:05Z")]

private def req (extra : JValue.Fields := []) : JValue :=
  .obj ([("prompt", .str "go")] ++ extra)

private def uuid : JValue := .str "123e4567-e89b-42d3-a456-426614174000"

private def attachment (fileId : String) : JValue := .obj [("fileId", .str fileId)]

/-- `n` attachments with distinct one-letter ids `a`, `b`, … -/
private def attachmentList (n : Nat) : JValue :=
  .arr ((List.range n).map fun i => attachment (String.singleton (Char.ofNat (97 + i))))

/-- `n` distinct paths `p0`, `p1`, … -/
private def pathList (n : Nat) : JValue :=
  .arr ((List.range n).map fun i => .str s!"p{i}")

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
     ("attachments-one", req [("attachments", attachmentList 1)]),
     ("attachments-ten", req [("attachments", attachmentList 10)]),
     ("attachments-empty", req [("attachments", .arr [])]),
     ("attachments-eleven", req [("attachments", attachmentList 11)]),
     ("attachments-duplicate", req [("attachments", .arr [attachment "a", attachment "a"])]),
     ("attachments-unknown-item-key",
       req [("attachments", .arr [.obj [("fileId", .str "a"), ("access", .str "write")]])]),
     ("attachments-empty-id", req [("attachments", .arr [attachment ""])]),
     ("output-schema", req [("outputSchema", .obj [("type", .str "object")])]),
     ("output-schema-string-root", req [("outputSchema", .obj [("type", .str "string")])]),
     ("file-scope-one", req [("fileScope", .arr [.str "docs/alice"])]),
     ("file-scope-max", req [("fileScope", pathList 100)]),
     ("file-scope-empty", req [("fileScope", .arr [])]),
     ("file-scope-over-max", req [("fileScope", pathList 101)]),
     ("file-scope-duplicate", req [("fileScope", .arr [.str "a", .str "a"])]),
     ("file-scope-parent-segment", req [("fileScope", .arr [.str "a/../b"])]),
     ("file-scope-dot-segment", req [("fileScope", .arr [.str "a/./b"])]),
     ("file-scope-leading-slash", req [("fileScope", .arr [.str "/a"])]),
     ("file-scope-trailing-slash", req [("fileScope", .arr [.str "a/"])]),
     ("file-scope-backslash", req [("fileScope", .arr [.str "a\\b"])]),
     ("file-scope-empty-path", req [("fileScope", .arr [.str ""])]),
     ("file-scope-max-length",
       req [("fileScope", .arr [.str (String.ofList (List.replicate 1024 'a'))])]),
     ("file-scope-over-length",
       req [("fileScope", .arr [.str (String.ofList (List.replicate 1025 'a'))])]),
     ("file-scope-not-array", req [("fileScope", .str "a")]),
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
     ("with-output", .obj (match run with
       | .obj fs => fs.filter (·.1 != "output") ++
           [("output", .obj [("text", .str "done"), ("structured", .obj [("total", .num 3 0)])])]
       | _ => [])),
     ("output-without-structured", .obj (match run with
       | .obj fs => fs.filter (·.1 != "output") ++ [("output", .obj [("text", .str "done")])]
       | _ => [])),
     ("awaiting-approval", .obj (match run with
       | .obj fs => fs.filter (fun f => f.1 != "status" && f.1 != "pendingApproval") ++
           [("status", .str "awaiting_approval"), ("pendingApproval",
             .obj [("toolName", .str "Bash"), ("canonicalCall", .str "Bash(ls)")])]
       | _ => [])),
     ("pending-approval-empty-call", .obj (match run with
       | .obj fs => fs.filter (·.1 != "pendingApproval") ++
           [("pendingApproval", .obj [("toolName", .str "Bash"), ("canonicalCall", .str "")])]
       | _ => [])),
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
  let approvalCases : List (String × String × JValue × (JValue → Bool)) :=
    [("RunApprovalRequestSchema", "approve", .obj [("decision", .str "approve")], runApprovalRequest),
     ("RunApprovalRequestSchema", "reject-comment",
       .obj [("decision", .str "reject"), ("comment", .str "use the staging bucket")], runApprovalRequest),
     ("RunApprovalRequestSchema", "max-comment", .obj [("decision", .str "approve"),
       ("comment", .str (String.ofList (List.replicate 1000 'a')))], runApprovalRequest),
     ("RunApprovalRequestSchema", "over-max-comment", .obj [("decision", .str "approve"),
       ("comment", .str (String.ofList (List.replicate 1001 'a')))], runApprovalRequest),
     ("RunApprovalRequestSchema", "blank-comment",
       .obj [("decision", .str "approve"), ("comment", .str " 
")], runApprovalRequest),
     ("RunApprovalRequestSchema", "bad-decision", .obj [("decision", .str "maybe")], runApprovalRequest),
     ("RunApprovalRequestSchema", "missing-decision", .obj [], runApprovalRequest),
     ("RunApprovalRequestSchema", "unknown-key",
       .obj [("decision", .str "approve"), ("extra", .bool true)], runApprovalRequest),
     ("RunApprovalResponseSchema", "valid",
       .obj [("run", run), ("events", .str "/api/runs/run/events")], runApprovalResponse),
     ("RunApprovalResponseSchema", "empty-events",
       .obj [("run", run), ("events", .str "")], runApprovalResponse)]
  let approvalVs := approvalCases.map fun (schema, id, j, p) =>
    vector schema id j p "approval_constants_match_exports"
  requestVs ++ costVs ++ usageVs ++ resourceVs ++ sessionVs ++ sessionEnvelopeVs ++ envelopeVs ++
    approvalVs

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
