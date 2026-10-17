import AgentWorkspace.Authz.VisitorSession
import AgentWorkspace.Behaviour.GatewayIngress
import AgentWorkspace.Concepts.Release
import AgentWorkspace.Theorems.Normative.AuthzRunToken

namespace AgentWorkspace.Theorems.Adversarial.AuthzRunToken

open AgentWorkspace.Authz.RunToken

/-- The expected run is compared before resolver activity. A token minted for one run cannot be
used for another run id, regardless of the resolver's state. -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/auth.ts#authenticateGatewayRequest")]
theorem token_for_another_run_denied (claims : Claims) (other : String)
    (resolution : Resolution) (h : other ≠ claims.runId) :
    authenticate true (.valid claims) (some other) resolution =
      .deny 403 "token_run_mismatch" := by
  simp [authenticate, h]

/-- Registry revocation never authenticates the same token again. -/
@[aw_spec (tier := T3) (ts := "packages/core/src/db/repositories/run-tokens.ts#isActive")]
theorem revoked_row_inactive (entry : RegistryEntry) (workspaceId runId tokenId tokenHash : String)
    (now : Int) (h : entry.revoked = true) :
    isActive entry workspaceId runId tokenId tokenHash now = false := by
  simp [isActive, h]

/-- The registry's expiry is strict: at expiry and every later time, its row is inactive. -/
@[aw_spec (tier := T3) (ts := "packages/core/src/db/repositories/run-tokens.ts#isActive")]
theorem expired_row_inactive (entry : RegistryEntry) (workspaceId runId tokenId tokenHash : String)
    (now : Int) (h : entry.expiresAt ≤ now) :
    isActive entry workspaceId runId tokenId tokenHash now = false := by
  simp [isActive, Int.not_lt.mpr h]

/-- An issued token always expires after issuance when the requested TTL passes validation. -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/tokens/run-token.ts#createRunTokenCodec")]
theorem issued_claims_have_future_expiry (subject : Subject) (tokenId : String)
    (now ttl : Int) (claims : Claims)
    (h : issueClaims subject tokenId now ttl = some claims) :
    claims.issuedAt < claims.expiresAt := by
  unfold issueClaims at h
  split at h
  · cases h
    simp only [Bool.and_eq_true, validTtl, decide_eq_true_eq] at *
    omega
  · cases h

/-- A runner token must still be in the registry; matching claims alone are insufficient. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/composition/session-rbac.ts#installSessionTranscripts")]
theorem inactive_token_cannot_be_runner (claims : Claims) (run : Option RunRow) :
    runnerPrincipal false claims run = false := by simp [runnerPrincipal]

private def activeRow : RegistryEntry :=
  { workspaceId := "w", runId := "r", tokenId := "t", tokenHash := "h", expiresAt := 200, revoked := false }

/-- A matching live row authenticates before revocation and fails immediately after it. -/
@[aw_spec (tier := T3) (ts := "packages/core/src/db/repositories/run-tokens.ts#isActive")]
theorem revocation_has_live_witness :
    isActive activeRow "w" "r" "t" "h" 100 = true ∧
    isActive { activeRow with revoked := true } "w" "r" "t" "h" 100 = false := by decide

/-- A matching row is live before its expiry and inactive at that exact second. -/
@[aw_spec (tier := T3) (ts := "packages/core/src/db/repositories/run-tokens.ts#isActive")]
theorem expiry_has_live_witness :
    isActive activeRow "w" "r" "t" "h" 199 = true ∧
    isActive activeRow "w" "r" "t" "h" 200 = false := by decide

/-- Registry activity requires the exact workspace and hash even for an otherwise live row. -/
@[aw_spec (tier := T3) (ts := "packages/core/src/db/repositories/run-tokens.ts#isActive")]
theorem registry_checks_workspace_and_hash :
    isActive activeRow "w" "r" "t" "h" 100 = true ∧
    isActive activeRow "other" "r" "t" "h" 100 = false ∧
    isActive activeRow "w" "r" "t" "other" 100 = false := by decide

/-- Revoking a run's tokens leaves the same run id in another workspace untouched. -/
@[aw_spec (tier := T3) (ts := "packages/core/src/db/repositories/run-tokens.ts#revokeForRun")]
theorem revoke_for_run_preserves_other_workspace :
    let foreign := { activeRow with workspaceId := "other" }
    revokeForRun [activeRow, foreign] "w" "r" =
      ([{ activeRow with revoked := true }, foreign], 1) := by decide

/-! ## The tool route (ADR-0113 C16) -/

section ToolRoute

open AgentWorkspace.Behaviour.GatewayIngress

/-- Before the registry is read, the tool route refuses exactly as `authenticate` does: a missing
bearer, an invalid token and an expired token keep their codes and their order. -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/auth.ts#verifyRunToken")
  (ts := "packages/gateway/src/tools/endpoint.ts#handleToolRequest")]
theorem tool_decision_matches_authenticate_before_the_registry (hasBearer : Bool)
    (verification : Verification) (tokenActive : Bool) (run : Option ToolRun)
    (connector : Option ToolConnector) (workspaceId connectorId : String)
    (resolution : Resolution)
    (h : hasBearer = false ∨ verification = .invalid ∨ verification = .expired) :
    toolDecision hasBearer verification tokenActive run connector workspaceId connectorId =
      authenticate hasBearer verification none resolution := by
  rcases h with h | h | h
  · subst h; simp [toolDecision, authenticate]
  all_goals (subst h; cases hasBearer <;> simp [toolDecision, authenticate])

/-- A live run's token reaches only the connectors its run snapshotted: run A's token naming run
B's connector is the one `403 tool_not_in_run`, whatever that connector is. -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/tools/authorize.ts#authorizeToolCall")]
theorem run_a_token_cannot_reach_run_b_connector (claims : Claims) (run : ToolRun)
    (connector : Option ToolConnector) (workspaceId connectorId : String)
    (hLive : run.terminal = false) (h : connectorId ∉ run.toolConnectorIds) :
    toolDecision true (.valid claims) true (some run) connector workspaceId connectorId =
      .deny 403 "tool_not_in_run" := by
  cases connector <;> simp [toolDecision, hLive, h]

/-- A revoked or expired registry row, a run that cannot be read and a terminal run all refuse
with `401 tool_run_not_active`, before any connector is considered. -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/tools/authorize.ts#authorizeToolCall")]
theorem ended_run_token_refused (claims : Claims) (tokenActive : Bool) (run : Option ToolRun)
    (connector : Option ToolConnector) (workspaceId connectorId : String)
    (h : tokenActive = false ∨ run.all (·.terminal) = true) :
    toolDecision true (.valid claims) tokenActive run connector workspaceId connectorId =
      .deny 401 "tool_run_not_active" := by
  cases run with
  | none => simp [toolDecision]
  | some r =>
    rcases h with h | h
    · simp [toolDecision, h]
    · simp only [Option.all_some] at h
      simp [toolDecision, h]

/-- A disabled connector is refused even when its live run snapshotted it. -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/tools/authorize.ts#authorizeToolCall")]
theorem disabled_connector_refused (claims : Claims) (run : ToolRun) (connector : ToolConnector)
    (workspaceId connectorId : String) (hLive : run.terminal = false)
    (h : connector.enabled = false) :
    toolDecision true (.valid claims) true (some run) (some connector) workspaceId connectorId =
      .deny 403 "tool_not_in_run" := by
  simp [toolDecision, hLive, h]

/-- A connector of another workspace is refused, with the same code as one that does not exist. -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/tools/authorize.ts#authorizeToolCall")]
theorem foreign_workspace_connector_refused (claims : Claims) (run : ToolRun)
    (connector : ToolConnector) (workspaceId connectorId : String)
    (hLive : run.terminal = false) (h : connector.workspaceId ≠ workspaceId) :
    toolDecision true (.valid claims) true (some run) (some connector) workspaceId connectorId =
      .deny 403 "tool_not_in_run" := by
  simp [toolDecision, hLive, h]

/-- A `postgres` connector has no executor in the gateway yet, so it is refused like one outside
the run (`// ponytail:` in `authorizeToolCall`, until S2-02e). -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/tools/authorize.ts#authorizeToolCall")]
theorem postgres_connector_refused_until_its_executor (claims : Claims) (run : ToolRun)
    (connector : ToolConnector) (workspaceId connectorId : String)
    (hLive : run.terminal = false) (h : connector.kind = .postgres) :
    toolDecision true (.valid claims) true (some run) (some connector) workspaceId connectorId =
      .deny 403 "tool_not_in_run" := by
  simp [toolDecision, hLive, h]

private def toolClaims : Claims :=
  { runId := "r", sessionId := "s", workspaceId := "w", agentId := "a",
    modelConnectionId := "m", version := 1, tokenId := "t", issuedAt := 100, expiresAt := 400 }

/-- The refusals are not vacuous: a live run's active token reaches its own enabled `openapi`
connector, and the same call is refused once the run ends or the connector is disabled. -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/tools/authorize.ts#authorizeToolCall")]
theorem tool_call_has_allow_witness :
    toolDecision true (.valid toolClaims) true (some ⟨false, ["c"]⟩) (some ⟨"w", .openapi, true⟩)
        "w" "c" = .allow ∧
    toolDecision true (.valid toolClaims) true (some ⟨true, ["c"]⟩) (some ⟨"w", .openapi, true⟩)
        "w" "c" = .deny 401 "tool_run_not_active" ∧
    toolDecision true (.valid toolClaims) true (some ⟨false, ["c"]⟩) (some ⟨"w", .openapi, false⟩)
        "w" "c" = .deny 403 "tool_not_in_run" := by decide

end ToolRoute

/-! ## An anonymous visitor's session token (issue #622) -/

section Visitor

open AgentWorkspace.Authz.VisitorSession AgentWorkspace.Authz.TokenScope
  AgentWorkspace.Authz.Resources AgentWorkspace.Authz.Permissions AgentWorkspace.Concepts.BrowserToken

/-- A visitor's session-scoped token for session `s` is refused with `403 token_out_of_scope` on
every request naming another session `s′ ≠ s`: reading one of its runs or their events, a turn
whose body names it, and a rating of one of its runs. Whatever the route, the scope grammar or the
session match refuses it, and both with the same code. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/runs/api.ts#requireSessionScopeMatch")
  (ts := "apps/web/server/rbac/decide.ts#checkTokenScope")
  (doc := "docs/formal/domains/visitor-sessions.md#the-visitor-token")]
theorem visitor_token_reaches_only_its_session (s : SessionId) (req : Request)
    (h : req.sessionId ≠ some s.val) :
    visitorDecision (.session s) req = .deny 403 "token_out_of_scope" := by
  unfold visitorDecision
  split
  · rfl
  · simp [sessionScopeMatch, h]

/-- The token goes on only inside its grammar and its own session: reading one run by id (and its
events), running an agent, or rating a run (`feedback`), and in each case for session `s`. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/rbac/decide.ts#TOKEN_SCOPE_GRAMMAR")
  (ts := "apps/web/server/runs/api.ts#requireSessionScopeMatch")
  (doc := "docs/formal/domains/visitor-sessions.md#the-visitor-token")]
theorem visitor_token_proceeds_only_inside_its_grammar (s : SessionId) (req : Request)
    (h : visitorDecision (.session s) req = .proceed) :
    req.sessionId = some s.val ∧
      ((req.resource = .runs ∧ req.op = .read ∧ req.pathId.isSome) ∨
        (req.resource = .agents ∧ req.op = .run) ∨
        (req.resource = .runs ∧ req.op = .run ∧ req.sub = some "feedback")) := by
  obtain ⟨resource, op, sub, pathId, sessionId⟩ := req
  unfold visitorDecision at h
  split at h
  · cases h
  · split at h
    · cases h
    · rename_i hs hm
      simp only [sessionScopeMatch, Bool.not_eq_true', beq_eq_false_iff_ne, ne_eq,
        Decidable.not_not] at hm
      refine ⟨hm, ?_⟩
      simp only [checkTokenScope, inGrammar, grammar, Scope.kind] at hs
      cases resource <;> cases op <;> cases pathId <;> simp_all

/-- The refusals are not vacuous: the token reads a run of its own session, starts a turn in it
and rates one of its runs, and the same requests for another session are refused. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/runs/api.ts#requireSessionScopeMatch")]
theorem visitor_token_has_allow_witness :
    let s : SessionId := ⟨"s"⟩
    visitorDecision (.session s) ⟨.runs, .read, none, some "r", some "s"⟩ = .proceed ∧
    visitorDecision (.session s) ⟨.agents, .run, some "runs", some "a", some "s"⟩ = .proceed ∧
    visitorDecision (.session s) ⟨.runs, .run, some "feedback", some "r", some "s"⟩ = .proceed ∧
    visitorDecision (.session s) ⟨.runs, .read, none, some "r", some "t"⟩ =
      .deny 403 "token_out_of_scope" := by decide

/-- On the allowed-origin branch, a cross-origin bootstrap opens a session only when its `Origin`
is one the surface lists, and that `Origin` is the one echoed back. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/surfaces/public/conditions.ts#mayOpenSession")
  (doc := "docs/formal/domains/visitor-sessions.md#opening-a-session")]
theorem cross_origin_visitor_opens_only_from_an_allowed_origin (loopback : Bool)
    (allowed : List String) (origin : Option String) (o : String)
    (h : openVerdict loopback false allowed origin .session = .allowedOrigin (some o)) :
    origin = some o ∧ o ∈ allowed := by
  cases origin with
  | none => cases loopback <;> by_cases he : allowed.isEmpty <;> simp [openVerdict, he] at h
  | some x =>
    cases loopback <;> by_cases he : allowed.isEmpty <;> by_cases hx : allowed.contains x <;>
      simp_all [openVerdict]

/-- A cross-origin bootstrap with no `Origin`, or the opaque `null` one, never opens a session
off loopback: neither equals an origin the surface may list. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/surfaces/public/conditions.ts#mayOpenSession")
  (doc := "docs/formal/domains/visitor-sessions.md#opening-a-session")]
theorem missing_origin_never_opens_a_session (allowed : List String) (origin : Option String)
    (hNull : "null" ∉ allowed) (h : origin = none ∨ origin = some "null") :
    openVerdict false false allowed origin .session = .refused := by
  rcases h with h | h <;> subst h <;> simp [openVerdict, hNull]

/-- A visitor token is minted only after `mayOpenSession` admits the bootstrap: whatever the
loopback flag, same-origin verdict, allowed list, `Origin` and the route's later steps, a minted
token means `openVerdict` did not refuse, and its scope is the one session `runtime.open` opened. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/surfaces/public/handlers.ts#createSurfaceSession")
  (ts := "apps/web/server/surfaces/public/conditions.ts#mayOpenSession")
  (doc := "docs/formal/domains/visitor-sessions.md#opening-a-session")]
theorem visitor_token_minted_only_after_open_verdict (loopback sameOrigin admitted : Bool)
    (allowed : List String) (origin : Option String) (opened : Option SessionId) (scope : Scope)
    (h : mintAfterOpen (openVerdict loopback sameOrigin allowed origin .session) admitted opened =
      some scope) :
    openVerdict loopback sameOrigin allowed origin .session ≠ .refused ∧
      ∃ s, opened = some s ∧ scope = .session s := by
  generalize openVerdict loopback sameOrigin allowed origin .session = v at h ⊢
  cases v <;> cases admitted <;> cases opened <;> simp_all [mintAfterOpen]

/-- The step is not vacuous: an admitted loopback bootstrap mints its session's token, and the same
bootstrap mints nothing once `mayOpenSession` refuses it. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/surfaces/public/handlers.ts#createSurfaceSession")]
theorem visitor_mint_has_witness :
    mintAfterOpen (openVerdict true true [] none .session) true (some ⟨"s"⟩) =
      some (.session ⟨"s"⟩) ∧
    mintAfterOpen (openVerdict false true [] none .session) true (some ⟨"s"⟩) = none := by
  decide

/-- A visitor session opened on an environment is pinned to the version that environment pointed
at (`sessions.agent_version_id = resolved.versionId`); with `session_version_stable`, no later
push, promote or rollback moves it. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/agent-versions/session-version.ts#resolveSessionVersion")
  (doc := "docs/formal/domains/visitor-sessions.md#the-pinned-version")]
theorem visitor_session_pins_the_resolved_version (t : Option Concepts.Release.Score)
    (r r' : Concepts.Release.Release) (s : SessionId) (a : AgentId) (e : Concepts.Release.Env)
    (h : Concepts.Release.step t r (.startSession s a e) = .ok r') :
    ∃ v, r.pointer a e = some v ∧ r'.sessions s = some (a, v) := by
  simp only [Concepts.Release.step] at h
  split at h
  · cases h
  · split at h
    · cases h
    · rename_i v hv
      cases h
      exact ⟨v, hv, by simp⟩

end Visitor

end AgentWorkspace.Theorems.Adversarial.AuthzRunToken
