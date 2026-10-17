import AgentWorkspace.Contracts.Sessions

namespace AgentWorkspace.Theorems.WellFormed.ContractsRuns

open AgentWorkspace AgentWorkspace.Contracts AgentWorkspace.Contracts.Runs

/-- The checked codec accepts exactly the values its predicate accepts. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#RunResourceSchema")]
theorem checked_accepts_iff (p : JValue → Bool) (j : JValue) :
    (checked p).decode j = some j ↔ p j = true := by
  simp [checked]

/-- Valid usage values survive decoding and encoding unchanged. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#RunUsageSchema")]
theorem run_usage_roundtrip (j : JValue) (h : runUsage j = true) :
    runUsageCodec.decode (runUsageCodec.encode j) = some j :=
  runUsageCodec.decode_encode j h

/-- Valid cost values survive decoding and encoding unchanged. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#RunCostSchema")]
theorem run_cost_roundtrip (j : JValue) (h : runCost j = true) :
    runCostCodec.decode (runCostCodec.encode j) = some j :=
  runCostCodec.decode_encode j h

/-- Valid run resources survive decoding and encoding unchanged. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#RunResourceSchema")]
theorem run_resource_roundtrip (j : JValue) (h : runResource j = true) :
    runResourceCodec.decode (runResourceCodec.encode j) = some j :=
  runResourceCodec.decode_encode j h

/-- Valid start requests survive decoding and encoding unchanged. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#StartRunRequestSchema")]
theorem start_request_roundtrip (j : JValue) (h : startRunRequest j = true) :
    startRunRequestCodec.decode (startRunRequestCodec.encode j) = some j :=
  startRunRequestCodec.decode_encode j h

/-- Valid start responses survive decoding and encoding unchanged. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#StartRunResponseSchema")]
theorem start_response_roundtrip (j : JValue) (h : startRunResponse j = true) :
    startRunResponseCodec.decode (startRunResponseCodec.encode j) = some j :=
  startRunResponseCodec.decode_encode j h

/-- Valid run responses survive decoding and encoding unchanged. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#RunResponseSchema")]
theorem run_response_roundtrip (j : JValue) (h : runResponse j = true) :
    runResponseCodec.decode (runResponseCodec.encode j) = some j :=
  runResponseCodec.decode_encode j h

/-- Valid interrupt responses survive decoding and encoding unchanged. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#InterruptRunResponseSchema")]
theorem interrupt_response_roundtrip (j : JValue) (h : interruptRunResponse j = true) :
    interruptRunResponseCodec.decode (interruptRunResponseCodec.encode j) = some j :=
  interruptRunResponseCodec.decode_encode j h

/-- Valid revoke responses survive decoding and encoding unchanged. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#RevokeRunTokensResponseSchema")]
theorem revoke_response_roundtrip (j : JValue) (h : revokeRunTokensResponse j = true) :
    revokeRunTokensResponseCodec.decode (revokeRunTokensResponseCodec.encode j) = some j :=
  revokeRunTokensResponseCodec.decode_encode j h

/-- Valid run-list responses survive decoding and encoding unchanged. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#RunListResponseSchema")]
theorem list_response_roundtrip (j : JValue) (h : runListResponse j = true) :
    runListResponseCodec.decode (runListResponseCodec.encode j) = some j :=
  runListResponseCodec.decode_encode j h

/-- Valid session resources survive decoding and encoding unchanged. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/sessions.ts#SessionResourceSchema")]
theorem session_resource_roundtrip (j : JValue)
    (h : Contracts.Sessions.resource j = true) :
    Contracts.Sessions.resourceCodec.decode (Contracts.Sessions.resourceCodec.encode j) = some j :=
  Contracts.Sessions.resourceCodec.decode_encode j h

/-- Valid session responses survive decoding and encoding unchanged. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/sessions.ts#SessionResponseSchema")]
theorem session_response_roundtrip (j : JValue)
    (h : Contracts.Sessions.response j = true) :
    Contracts.Sessions.responseCodec.decode (Contracts.Sessions.responseCodec.encode j) = some j :=
  Contracts.Sessions.responseCodec.decode_encode j h

/-- Valid session-list responses survive decoding and encoding unchanged. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/sessions.ts#SessionListResponseSchema")]
theorem session_list_roundtrip (j : JValue)
    (h : Contracts.Sessions.listResponse j = true) :
    Contracts.Sessions.listResponseCodec.decode (Contracts.Sessions.listResponseCodec.encode j) = some j :=
  Contracts.Sessions.listResponseCodec.decode_encode j h

/-- The model's provider, accounting, prompt, and page constants match the public exports. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#MODEL_PROVIDERS")]
theorem constants_match_exports :
    maxPromptChars = 100000 ∧ defaultListLimit = 20 ∧ maxListLimit = 200 ∧
    modelProviders = ["anthropic", "anthropic-compatible", "openai", "azure-openai",
      "openai-compatible"] ∧
    accountingStates = ["pending", "complete", "partial", "failed", "unavailable"] := by
  decide

/-- An empty list query serializes to no search parameters. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#runListSearchParams")]
theorem list_query_omits_absent_fields :
    runListSearchParams {} = [] := by decide

/-- Run-list filters serialize in the public interface's stable field order. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#runListSearchParams")]
theorem list_query_field_order :
    runListSearchParams (RunListQuery.mk (some "running") (some "a") none none none
      none none none (some 20) (some "x")) =
      [("status", "running"), ("agent", "a"), ("limit", "20"),
       ("cursor", "x")] := by decide

/-- Distinct lower and upper time filters retain their own names and values. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#runListSearchParams")]
theorem list_query_preserves_time_bounds :
    runListSearchParams (RunListQuery.mk none none none none none
      (some "lower") (some "upper") none none none) =
      [("from", "lower"), ("to", "upper")] := by decide

/-- Whitespace-only prompts are refused by the start-request contract. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#StartRunRequestSchema")]
theorem start_request_refuses_blank :
    startRunRequest (.obj [("prompt", .str " \t\n")]) = false := by decide

/-- A model without its connection is refused by the start-request contract. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#StartRunRequestSchema")]
theorem start_request_refuses_unpaired_model :
    startRunRequest (.obj [("prompt", .str "go"), ("model", .str "gpt")]) = false := by decide

/-- Explicit null model fields are accepted as no override. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#StartRunRequestSchema")]
theorem start_request_accepts_null_pair :
    startRunRequest (.obj [("prompt", .str "go"), ("model", .null),
      ("modelConnectionId", .null)]) = true := by decide

/-- The start-request contract refuses unrecognized body fields. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#StartRunRequestSchema")]
theorem start_request_refuses_unknown_key :
    startRunRequest (.obj [("prompt", .str "go"), ("extra", .bool true)]) = false := by decide

/-- A revoke response cannot report a negative token count. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#RevokeRunTokensResponseSchema")]
theorem revoke_refuses_negative_count :
    revokeRunTokensResponse (.obj [("revoked", .num (-1) 0),
      ("outcome", .str "revoked")]) = false := by decide

/-- A revoke response refuses outcomes outside its closed vocabulary. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#RevokeRunTokensResponseSchema")]
theorem revoke_refuses_other_outcome :
    revokeRunTokensResponse (.obj [("revoked", .num 0 0),
      ("outcome", .str "lost")]) = false := by decide

/-- The current cost schema accepts non-decimal nonempty amount text. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#RunCostSchema")]
theorem run_cost_accepts_non_decimal_text :
    runCost (.obj [("amount", .str "not-money"), ("currency", .str "X"),
      ("priceTableVersion", .null)]) = true := by decide

/-- An archived session with an SDK id is not derived as resumable. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/sessions.ts#SessionResourceSchema")]
theorem session_schema_does_not_derive_resumable :
    Contracts.Sessions.derivedResumable "archived" (some "sdk") = false := by decide

private def usageFixture : JValue := .obj
  [("inputTokens", .num 1 0), ("outputTokens", .num 2 0),
   ("cacheReadInputTokens", .num 3 0), ("cacheCreationInputTokens", .num 4 0),
   ("totalTokens", .num 10 0), ("toolCalls", .num 0 0)]

private def runFixture : JValue := .obj
  [("id", .str "run"), ("workspaceId", .str "ws"), ("agentId", .str "agent"),
   ("projectId", .null), ("initiatingUserId", .null), ("sessionId", .str "session"),
   ("status", .str "queued"), ("createdAt", .str "2026-01-02T03:04:05Z"),
   ("startedAt", .null), ("endedAt", .null), ("durationMs", .null),
   ("model", .null), ("provider", .null), ("modelConnectionId", .null),
   ("engine", .str "claude-agent-sdk"), ("engineVersion", .null),
   ("usage", usageFixture),
   ("cost", .obj [("amount", .str "0.000000"), ("currency", .str "USD"),
     ("priceTableVersion", .null)]),
   ("error", .null), ("accountingState", .str "pending"),
   ("accountingError", .null)]

private def sessionFixture : JValue := .obj
  [("id", .str "session"), ("workspaceId", .str "ws"), ("agentId", .str "agent"),
   ("userId", .null), ("ownerPrincipalId", .str "principal"), ("projectId", .null),
   ("engineSessionId", .null), ("engine", .null), ("title", .null), ("status", .str "active"),
   ("resumable", .bool false), ("createdAt", .str "2026-01-02T03:04:05Z"),
   ("updatedAt", .str "2026-01-02T03:04:05Z")]

private def replaceField (j : JValue) (name : String) (value : JValue) : JValue :=
  match j with
  | .obj fs => .obj (fs.map fun (key, prior) =>
      if key == name then (key, value) else (key, prior))
  | _ => j

/-- A cost with a currency is valid, while an empty currency is rejected. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#RunCostSchema")]
theorem cost_requires_nonempty_currency :
    runCost (.obj [("amount", .str "0.000000"), ("currency", .str "USD"),
      ("priceTableVersion", .null)]) = true ∧
    runCost (.obj [("amount", .str "0.000000"), ("currency", .str ""),
      ("priceTableVersion", .null)]) = false := by decide

/-- The total token count must be nonnegative even if every other count is valid. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#RunUsageSchema")]
theorem usage_rejects_negative_total_tokens :
    runUsage usageFixture = true ∧
    runUsage (replaceField usageFixture "totalTokens" (.num (-1) 0)) = false := by decide

/-- Only active and archived session statuses belong to the public enum. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/sessions.ts#SessionResourceSchema")]
theorem session_status_enum_excludes_paused :
    Contracts.Sessions.statuses = ["active", "archived"] ∧
    Contracts.Sessions.resource sessionFixture = true ∧
    Contracts.Sessions.resource
      (replaceField sessionFixture "status" (.str "paused")) = false := by decide

/-- Usage requires toolCalls even when every other counter is valid. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#RunUsageSchema")]
theorem usage_requires_tool_calls :
    runUsage usageFixture = true ∧
    runUsage (.obj [("inputTokens", .num 1 0), ("outputTokens", .num 2 0),
      ("cacheReadInputTokens", .num 3 0), ("cacheCreationInputTokens", .num 4 0),
      ("totalTokens", .num 10 0)]) = false := by decide

/-- A valid resource status is accepted while an unknown status is refused. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#RunResourceSchema")]
theorem resource_status_is_enum :
    runResource runFixture = true ∧
    runResource (replaceField runFixture "status" (.str "paused")) = false := by decide

/-- Run creation timestamps must be ISO instants rather than arbitrary text. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#RunResourceSchema")]
theorem resource_created_at_is_instant :
    runResource runFixture = true ∧
    runResource (replaceField runFixture "createdAt" (.str "yesterday")) = false := by decide

/-- Session identifiers are canonical UUID text when supplied. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#StartRunRequestSchema")]
theorem request_session_requires_uuid :
    startRunRequest (.obj [("prompt", .str "go"),
      ("sessionId", .str "123e4567-e89b-42d3-a456-426614174000")]) = true ∧
    startRunRequest (.obj [("prompt", .str "go"), ("sessionId", .str "bad")]) = false := by decide

/-- Every prompt beyond the UTF-16 limit is refused. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#StartRunRequestSchema")]
theorem request_prompt_respects_max (s : String)
    (h : Text.utf16Length s > maxPromptChars) :
    startRunRequest (.obj [("prompt", .str s)]) = false := by
  have hb : decide (Text.utf16Length s ≤ maxPromptChars) = false := by
    simp [Nat.not_le.mpr h]
  simp [startRunRequest, JValue.lookup, hb]

/-- A paired model override cannot name an empty provider model. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#StartRunRequestSchema")]
theorem request_model_is_nonempty :
    startRunRequest (.obj [("prompt", .str "go"),
      ("modelConnectionId", .str "123e4567-e89b-42d3-a456-426614174000"),
      ("model", .str "m")]) = true ∧
    startRunRequest (.obj [("prompt", .str "go"),
      ("modelConnectionId", .str "123e4567-e89b-42d3-a456-426614174000"),
      ("model", .str "")]) = false := by decide

/-- The session resource requires a Boolean resumable field. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/sessions.ts#SessionResourceSchema")]
theorem session_resumable_is_boolean :
    Contracts.Sessions.resource sessionFixture = true ∧
    Contracts.Sessions.resource
      (replaceField sessionFixture "resumable" (.str "true")) = false := by decide

end AgentWorkspace.Theorems.WellFormed.ContractsRuns
