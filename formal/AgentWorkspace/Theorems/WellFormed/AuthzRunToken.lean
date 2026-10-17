import AgentWorkspace.Authz.RunToken

namespace AgentWorkspace.Theorems.WellFormed.AuthzRunToken

open AgentWorkspace AgentWorkspace.Authz.RunToken

/-- Valid run-token claims survive the identity codec unchanged. -/
@[aw_spec (tier := T0) (ts := "packages/gateway/src/tokens/run-token.ts#RunTokenClaimsSchema")]
theorem claims_codec_roundtrip (j : JValue) (h : claimsShape j = true) :
    claimsCodec.decode (claimsCodec.encode j) = some j :=
  claimsCodec.decode_encode j h

/-- The claims schema rejects fields outside its closed vocabulary. -/
@[aw_spec (tier := T0) (ts := "packages/gateway/src/tokens/run-token.ts#RunTokenClaimsSchema")]
theorem claims_refuse_unknown_key :
    claimsShape (.obj [("version", .num 1 0), ("tokenId", .str "token"),
      ("runId", .str "run"), ("sessionId", .str "session"),
      ("workspaceId", .str "workspace"), ("agentId", .str "agent"),
      ("modelConnectionId", .str "connection"), ("issuedAt", .num 100 0),
      ("expiresAt", .num 200 0), ("extra", .bool true)]) = false := by decide

/-- A token whose expiry equals its issuance time is invalid. -/
@[aw_spec (tier := T0) (ts := "packages/gateway/src/tokens/run-token.ts#RunTokenClaimsSchema")]
theorem claims_refuse_equal_expiry :
    claimsShape (.obj [("version", .num 1 0), ("tokenId", .str "token"),
      ("runId", .str "run"), ("sessionId", .str "session"),
      ("workspaceId", .str "workspace"), ("agentId", .str "agent"),
      ("modelConnectionId", .str "connection"), ("issuedAt", .num 100 0),
      ("expiresAt", .num 100 0)]) = false := by decide

/-- The default and valid TTL boundaries match the gateway constants. -/
@[aw_spec (tier := T0) (ts := "packages/gateway/src/tokens/run-token.ts#DEFAULT_TTL_SECONDS")]
theorem ttl_edges :
    defaultTtlSeconds = 300 ∧ validTtl 1 = true ∧ validTtl 3600 = true ∧
      validTtl 0 = false ∧ validTtl 3601 = false := by decide

/-- Issuance refuses a blank claim subject. -/
@[aw_spec (tier := T0) (ts := "packages/gateway/src/tokens/run-token.ts#createRunTokenCodec")]
theorem issue_refuses_blank_subject :
    issueClaims { runId := " ", sessionId := "s", workspaceId := "w", agentId := "a", modelConnectionId := "m" } "token" 100 300 = none := by decide

/-- Issuance derives both timestamps from the supplied clock and TTL. -/
@[aw_spec (tier := T0) (ts := "packages/gateway/src/tokens/run-token.ts#createRunTokenCodec")]
theorem issue_uses_injected_clock :
    (issueClaims { runId := "r", sessionId := "s", workspaceId := "w", agentId := "a", modelConnectionId := "m" } "token" 100 60).map (fun c => (c.issuedAt, c.expiresAt)) =
      some (100, 160) := by decide

private def claimFixture : JValue := .obj
  [("version", .num 1 0), ("tokenId", .str "token"), ("runId", .str "run"),
   ("sessionId", .str "session"), ("workspaceId", .str "workspace"),
   ("agentId", .str "agent"), ("modelConnectionId", .str "connection"),
   ("issuedAt", .num 100 0), ("expiresAt", .num 200 0)]

private def replaceIssuedAt : JValue → JValue
  | .obj fs => .obj (fs.map fun (key, value) =>
      if key == "issuedAt" then (key, .num (-9007199254740992) 0) else (key, value))
  | j => j

/-- Claims accept a safe timestamp and refuse an unsafe integer even when it precedes expiry. -/
@[aw_spec (tier := T0) (ts := "packages/gateway/src/tokens/run-token.ts#RunTokenClaimsSchema")]
theorem claims_refuse_unsafe_issued_at :
    claimsShape claimFixture = true ∧
    claimsShape (replaceIssuedAt claimFixture) = false := by decide

end AgentWorkspace.Theorems.WellFormed.AuthzRunToken
