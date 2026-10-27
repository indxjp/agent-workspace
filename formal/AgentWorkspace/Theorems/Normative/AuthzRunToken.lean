import AgentWorkspace.Theorems.WellFormed.AuthzRunToken

namespace AgentWorkspace.Theorems.Normative.AuthzRunToken

open AgentWorkspace AgentWorkspace.Authz.RunToken

private def subject : Subject :=
  { runId := "run-a", sessionId := "session", workspaceId := "workspace", agentId := "agent", modelConnectionId := "connection" }

private def claims : Claims :=
  { toSubject := subject, version := 1, tokenId := "token", issuedAt := 100, expiresAt := 400 }

/-- Verification accepts the final pre-expiry second and rejects the expiry instant. -/
@[aw_spec (tier := T1) (ts := "packages/gateway/src/tokens/run-token.ts#createRunTokenCodec")]
theorem verification_expires_at_boundary :
    verifyVerdict true true claims 399 = .valid claims ∧
    verifyVerdict true true claims 400 = .expired := by decide +kernel

/-- Bad signatures or claims stay invalid even when the token is also expired. -/
@[aw_spec (tier := T1) (ts := "packages/gateway/src/tokens/run-token.ts#createRunTokenCodec")]
theorem invalid_verdict_precedes_expiry :
    verifyVerdict false true claims 400 = .invalid ∧
    verifyVerdict true false claims 400 = .invalid ∧
    verifyVerdict false false claims 399 = .invalid := by decide +kernel

/-- Gateway authentication returns the first applicable public failure in its defined order. -/
@[aw_spec (tier := T1) (ts := "packages/gateway/src/auth.ts#authenticateGatewayRequest")]
theorem gateway_error_order :
    authenticate false (.valid claims) (some "run-b") .revoked =
      .deny 401 "token_missing" ∧
    authenticate true .expired (some "run-b") .revoked =
      .deny 401 "token_expired" ∧
    authenticate true .invalid (some "run-b") .revoked =
      .deny 401 "token_invalid" ∧
    authenticate true (.valid claims) (some "run-b") .revoked =
      .deny 403 "token_run_mismatch" ∧
    authenticate true (.valid claims) (some "run-a") .revoked =
      .deny 401 "token_revoked" ∧
    authenticate true (.valid claims) (some "run-a") .deleted =
      .deny 410 "run_deleted" ∧
    authenticate true (.valid claims) (some "run-a") .missing =
      .deny 404 "run_not_found" ∧
    authenticate true (.valid claims) (some "run-a") .active = .allow := by decide +kernel

/-- Gateway refusal uses the stable authentication error envelope. -/
@[aw_spec (tier := T1) (ts := "packages/gateway/src/auth.ts#authenticateGatewayRequest")]
theorem gateway_error_envelope :
    gatewayEnvelope "token_revoked" = .obj
      [("type", .str "error"), ("error", .obj
        [("type", .str "authentication_error"), ("code", .str "token_revoked"),
          ("message", .str "The gateway run token has been revoked.")])] := by decide +kernel

/-- Revoking a token distinguishes absent, active, and already revoked rows. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/repositories/run-tokens.ts#revoke")]
theorem revocation_outcomes :
    (revokeOne none).2 = .notFound ∧
    (revokeOne (some { workspaceId := "w", runId := "r", tokenId := "t", tokenHash := "h", expiresAt := 200, revoked := false })).2 = .revoked ∧
    (revokeOne (some { workspaceId := "w", runId := "r", tokenId := "t", tokenHash := "h", expiresAt := 200, revoked := true })).2 = .alreadyRevoked := by decide +kernel

/-- Runner authentication requires the token's scoped identity to match the run row. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/composition/session-rbac.ts#installSessionTranscripts")]
theorem runner_principal_checks_run_row :
    runnerPrincipal true claims (some { id := "run-a", workspaceId := "workspace", sessionId := "session", agentId := "agent" }) = true ∧
    runnerPrincipal true claims (some { id := "run-a", workspaceId := "other", sessionId := "session", agentId := "agent" }) = false := by decide +kernel

/-- A runner principal requires the persisted session id to match its signed claim. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/composition/session-rbac.ts#installSessionTranscripts")]
theorem runner_principal_checks_session :
    runnerPrincipal true claims (some { id := "run-a", workspaceId := "workspace", sessionId := "session", agentId := "agent" }) = true ∧
    runnerPrincipal true claims (some { id := "run-a", workspaceId := "workspace", sessionId := "other", agentId := "agent" }) = false := by decide +kernel

end AgentWorkspace.Theorems.Normative.AuthzRunToken
