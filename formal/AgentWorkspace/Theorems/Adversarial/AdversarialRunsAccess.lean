import AgentWorkspace.Behaviour.Runs
import AgentWorkspace.Authz.RunToken
import AgentWorkspace.Authz.Tenancy
import AgentWorkspace.Theorems.Invariants.BehaviourRuns

/-!
Adversarial access to runs. The attacker chooses a credential, route, identifier and request
contents, including identifiers learned from another workspace. The authenticated principal and
token claims are resolved by the authentication boundary; a request cannot choose those claims.
This model deliberately retains the handler's separate ownership and scope checks.
-/

namespace AgentWorkspace.Theorems.Adversarial.AdversarialRunsAccess

open AgentWorkspace.Behaviour.Runs
open AgentWorkspace.Authz.TokenScope AgentWorkspace.Authz.Resources
  AgentWorkspace.Authz.Permissions AgentWorkspace.Concepts.BrowserToken

/-- Credentials offered to a run surface. A gateway run token is a separate authentication kind;
the HTTP run API does not turn it into a browser principal. -/
private inductive Credential where
  | session | apiKey | browserRun | browserSession | gatewayRun
  deriving DecidableEq, Repr

/-- Attacker-controlled request material together with the facts the handler derived from it.
`principal` is resolved at authentication; `request.ownership` and the validation flags are
server facts, constrained by `ownershipBound` and the scenario fixture, not attacker assertions. -/
private structure Attempt where
  credential : Credential
  principal : Principal
  request : Request
  suppliedPathId : String
  suppliedSessionId : Option String := none
  suppliedAgentId : Option String := none
  bearerPresent : Bool := true
  revoked : Bool := false
  expired : Bool := false
  deriving Repr

/-- The operations that name one run. -/
def namesRun : Route → Bool
  | .read | .stream | .interrupt | .revoke | .revokeAlias => true
  | _ => false

/-- A foreign run is one whose workspace differs from the resolved principal's workspace. -/
def foreignTarget (a : Attempt) (row : RunRow) : Bool :=
  row.id == a.suppliedPathId && row.workspaceId != a.principal.workspaceId

/-- The attacker cannot claim ownership by writing an id or header. For a found run, the
ownership fact handed to RBAC must agree with its stored owner. -/
def ownershipBound (s : State) (a : Attempt) : Bool :=
  match found s a.principal a.suppliedPathId with
  | none => true
  | some row => a.request.ownership ==
      (if row.ownerId == a.principal.id then .own else .other)

/-- For a found row owned by another member, a bound ownership fact cannot be forged to `.own`.
The actual handler supplies this fact through `ownsRun`; `Request` alone does not establish it. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/runs/api.ts#readRun")
  (ts := "apps/web/server/runs/api.ts#interruptRun")]
theorem bound_other_member_is_not_own (s : State) (a : Attempt) (row : RunRow)
    (hfound : found s a.principal a.suppliedPathId = some row)
    (hother : row.ownerId ≠ a.principal.id)
    (hbound : ownershipBound s a = true) : a.request.ownership = .other := by
  simp [ownershipBound, hfound, hother] at hbound
  exact hbound

/-- Whether the actual handler refused success for the attempted named request. Its value
tracks the response even for an own run, so a universally true replacement is observable. -/
def namedAccessDenied (s : State) (a : Attempt) : Bool :=
  (step s a.principal { a.request with id := a.suppliedPathId }).reply.status != 200

/-- Any named run route whose workspace-scoped lookup is absent cannot return 200, for every
request flag and principal role. An invalid path or missing authentication may deny earlier. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/runs/api.ts#findRunForPrincipal")]
theorem absent_scoped_run_never_succeeds (s : State) (p : Principal) (r : Request)
    (hnamed : namesRun r.route = true) (habsent : found s p r.id = none) :
    (step s p r).reply.status ≠ 200 := by
  cases hr : r.route <;> simp [namesRun, hr] at hnamed
  all_goals
    simp [step, hr, habsent]
    cases hc : r.configured <;>
      cases ha : r.authenticated <;>
      cases hp : r.pathValid <;>
      cases hcur : r.cursorValid <;>
      cases hs : p.scope <;>
      cases hrole : AgentWorkspace.Authz.Roles.parseRoleInput p.role <;>
      cases hg : AgentWorkspace.Authz.Decide.revokeTokensRoleGate p.role <;>
      simp_all [Id.run, pure, finishReply, problem]

/-- A list may return only workspace rows and, for Builder/Viewer, only owned rows. This is a
postcondition for real-store replay: `Behaviour.Runs.Reply` represents the filter, not items. -/
def listRowAllowed (p : Principal) (row : RunRow) : Bool :=
  row.workspaceId == p.workspaceId &&
    (listGrantAny p || row.ownerId == p.id)

/-- A browser token is bounded to one run or session before any role grant is considered. -/
def browserScopeAllows (a : Attempt) (row : RunRow) : Bool :=
  match a.principal.scope with
  | none => true
  | some (.run id) => row.id == id.val
  | some (.session id) => row.sessionId == id.val

/-- The route model's targeted foreign-state observation. This also includes a forged
same-identifier row in a different workspace. -/
def preservesForeign (s : State) (a : Attempt) : Prop :=
  (step s a.principal a.request).state.foreignRuns a.principal.workspaceId =
    s.foreignRuns a.principal.workspaceId

/-- A resolved attacker cannot make a run-route transition change another workspace's row,
even by choosing an identifier that is present in that workspace. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/runs/api.ts#findRunForPrincipal")
  (ts := "apps/web/server/runs/api.ts#startRun")
  (ts := "apps/web/server/runs/api.ts#interruptRun")]
theorem all_routes_preserve_foreign (s : State) (p : Principal) (r : Request) :
    (step s p r).state.foreignRuns p.workspaceId = s.foreignRuns p.workspaceId := by
  exact AgentWorkspace.Theorems.Invariants.BehaviourRuns.every_route_preserves_foreign
    s p r

/-- A listed foreign row fails the list postcondition, regardless of role and owner id. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/runs/api.ts#listRuns")
  (ts := "apps/web/server/runs/store.ts#listRuns")]
theorem foreign_row_fails_list_postcondition (p : Principal) (row : RunRow)
    (h : row.workspaceId ≠ p.workspaceId) : listRowAllowed p row = false := by
  simp [listRowAllowed, h]

/-- Builder and Viewer list postconditions refuse any row owned by a different member. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/runs/api.ts#listRuns")
  (ts := "apps/web/server/runs/api.ts#parseRunListQuery")]
theorem other_member_fails_list_postcondition (p : Principal) (row : RunRow)
    (hrole : p.role = "builder" ∨ p.role = "viewer") (howner : row.ownerId ≠ p.id) :
    listRowAllowed p row = false := by
  rcases hrole with h | h <;> simp [listRowAllowed, listGrantAny, h, howner]

/-- A run token refuses a different row, including after canonical UUID comparison. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/rbac/decide.ts#checkTokenScope")]
theorem run_browser_scope_rejects_other_id (runId otherId : String) (sub : Option String)
    (h : sameRunId (some otherId) runId = false) :
    checkTokenScope (.run ⟨runId⟩) .runs .read sub (some otherId) = some .runIdMismatch := by
  simp [checkTokenScope, inGrammar, grammar, Scope.kind, Scope.id, h]

/-- Run-scoped browser tokens cannot reach the collection or minting route. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/rbac/decide.ts#checkTokenScope")]
theorem run_browser_scope_cannot_list_or_mint (runId : String) (sub : Option String) :
    checkTokenScope (.run ⟨runId⟩) .runs .read sub none = some .collectionRead ∧
    checkTokenScope (.run ⟨runId⟩) .tokens .write sub none = some .notInGrammar := by
  simp [checkTokenScope, inGrammar, grammar, Scope.kind]

/-- A session-scoped browser token cannot read a run joined to another session. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/runs/api.ts#requireSessionScopeMatch")]
theorem session_browser_scope_rejects_other_session (p : Principal)
    (sessionId otherId : String) (h : otherId ≠ sessionId) :
    scopeMatches { p with scope := some (.session ⟨sessionId⟩) } (some otherId) = false := by
  simp [scopeMatches, h]

/-- A session scope admits the agent run verb and a matching session for later role checks,
but refuses collection reads, token minting, and agent writes. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/rbac/decide.ts#checkTokenScope")
  (ts := "apps/web/server/runs/api.ts#requireSessionScopeMatch")]
theorem session_browser_scope_grammar (p : Principal) (sessionId agentId : String)
    (sub : Option String) :
    checkTokenScope (.session ⟨sessionId⟩) .runs .read sub none = some .collectionRead ∧
    checkTokenScope (.session ⟨sessionId⟩) .tokens .write sub none = some .notInGrammar ∧
    checkTokenScope (.session ⟨sessionId⟩) .agents .run sub (some agentId) = none ∧
    checkTokenScope (.session ⟨sessionId⟩) .agents .write sub (some agentId) =
      some .notInGrammar ∧
    scopeMatches { p with scope := some (.session ⟨sessionId⟩) } (some sessionId) = true := by
  simp [checkTokenScope, inGrammar, grammar, Scope.kind, scopeMatches]

/-- Builder and Viewer cannot revoke a run token regardless of a chosen run id. Configuration,
authentication and browser-scope gates may produce earlier denials, never a success. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/runs/api.ts#revokeRunTokens")]
theorem builder_viewer_revoke_denied (s : State) (p : Principal) (r : Request)
    (hrole : p.role = "builder" ∨ p.role = "viewer") :
    (step s p { r with route := .revoke }).reply.status ≠ 200 := by
  have hb : AgentWorkspace.Authz.Roles.parseRoleInput "builder" = some .builder := by decide
  have hv : AgentWorkspace.Authz.Roles.parseRoleInput "viewer" = some .viewer := by decide
  rcases hrole with h | h <;> cases hs : p.scope <;>
    cases hc : r.configured <;> cases ha : r.authenticated <;>
    simp_all [step, AgentWorkspace.Authz.Decide.revokeTokensRoleGate,
      finishReply, problem]

private def viewerPrincipal : Principal :=
  { id := "viewer-a", workspaceId := "workspace-a", role := "viewer" }

private def viewerOtherStart : Request :=
  { route := .start, id := "agent-b", ownership := .other }

private def viewerGrantedStart : Request :=
  { route := .start, id := "agent-b", ownership := .permitted }

/-- A Viewer cannot start another member's agent merely because their role admits runs on
explicitly permitted agents. The handler-established ownership answer distinguishes an absent
grant (`other`) from a present grant (`permitted`) at the real route's RBAC gate. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/runs/api.ts#startRun")
  (ts := "apps/web/server/rbac/decide.ts#applyGrant")
  (doc := "docs/adr/W9-AUTH-117-viewer-permitted-agent-grants.md#decision")]
theorem viewer_other_agent_start_denied_but_granted_start_admitted (s : State) :
    (step s viewerPrincipal viewerOtherStart).reply.status = 403 ∧
    (step s viewerPrincipal viewerGrantedStart).reply.status = 202 := by
  have hdenied : permission viewerOtherStart viewerPrincipal =
      some (problem 403 "forbidden") := by decide
  have hgranted : permission viewerGrantedStart viewerPrincipal = none := by decide
  simp only [viewerOtherStart, viewerGrantedStart] at hdenied hgranted ⊢
  simp only [step, hdenied, hgranted]
  simp [viewerPrincipal, scopeMatches, finishReply, problem]

/-- A different requested run is refused before gateway registry resolution. -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/auth.ts#authenticateGatewayRequest")]
theorem gateway_run_mismatch (claims : AgentWorkspace.Authz.RunToken.Claims)
    (requested : String) (resolution : AgentWorkspace.Authz.RunToken.Resolution)
    (h : requested ≠ claims.runId) :
    AgentWorkspace.Authz.RunToken.authenticate true (.valid claims)
      (some requested) resolution = .deny 403 "token_run_mismatch" := by
  simp [AgentWorkspace.Authz.RunToken.authenticate, h]

/-- Expiry refuses a run token before its target run is looked up. -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/auth.ts#authenticateGatewayRequest")]
theorem expired_gateway_token_denied
    (requested : Option String) (resolution : AgentWorkspace.Authz.RunToken.Resolution) :
    AgentWorkspace.Authz.RunToken.authenticate true .expired requested resolution =
      .deny 401 "token_expired" := by
  simp [AgentWorkspace.Authz.RunToken.authenticate]

/-- A revoked run token is refused even with a matching run claim. -/
@[aw_spec (tier := T3) (ts := "packages/gateway/src/auth.ts#authenticateGatewayRequest")]
theorem revoked_gateway_token_denied (claims : AgentWorkspace.Authz.RunToken.Claims) :
    AgentWorkspace.Authz.RunToken.authenticate true (.valid claims)
      (some claims.runId) .revoked = .deny 401 "token_revoked" := by
  simp [AgentWorkspace.Authz.RunToken.authenticate]

private def searchPrincipal : Principal :=
  { id := "member-a", workspaceId := "workspace-a", role := "owner" }

private def searchState : State :=
  { runs := [{ id := "run-b", workspaceId := "workspace-b",
               ownerId := "member-b", sessionId := "session-b" }] }

private def searchActors : List (Credential × Principal) :=
  [ (.session, searchPrincipal),
    (.apiKey, { searchPrincipal with role := "builder" }),
    (.session, { searchPrincipal with role := "viewer" }),
    (.browserRun, { searchPrincipal with scope := some (.run ⟨"run-a"⟩) }),
    (.browserSession, { searchPrincipal with scope := some (.session ⟨"session-a"⟩) }) ]

private def searchAttempts : List Attempt :=
  searchActors.flatMap fun (credential, principal) =>
    ["run-b", "missing"].flatMap fun id =>
      [ .read, .stream, .interrupt, .revoke, .revokeAlias ].map fun route =>
        { credential, principal, request := { route, id }, suppliedPathId := id }

private def ownState : State :=
  { runs := [{ id := "run-a", workspaceId := "workspace-a",
               ownerId := "member-a", sessionId := "session-a" }] }

private def ownRead : Attempt :=
  { credential := .session, principal := searchPrincipal,
    request := { route := .read, id := "run-a" }, suppliedPathId := "run-a" }

private def otherOwnerState : State :=
  { runs := [{ id := "run-b", workspaceId := "workspace-a",
               ownerId := "member-b", sessionId := "session-b" }] }

private def forgedOwner : Attempt :=
  { credential := .session, principal := { searchPrincipal with role := "builder" },
    request := { route := .read, id := "run-b", ownership := .own },
    suppliedPathId := "run-b" }

private def runScoped : Attempt :=
  { credential := .browserRun,
    principal := { searchPrincipal with scope := some (.run ⟨"run-a"⟩) },
    request := { route := .read, id := "run-b" }, suppliedPathId := "run-b" }

private def sessionScoped : Attempt :=
  { credential := .browserSession,
    principal := { searchPrincipal with scope := some (.session ⟨"session-a"⟩) },
    request := { route := .read, id := "run-b" }, suppliedPathId := "run-b" }

private def foreignRow : RunRow :=
  { id := "run-b", workspaceId := "workspace-b", ownerId := "member-b",
    sessionId := "session-b" }

private def otherSessionRow : RunRow :=
  { id := "run-b", workspaceId := "workspace-a", ownerId := "member-a",
    sessionId := "session-b" }

/-- The finite search has a real foreign target, rejects a forged owner claim, and distinguishes
both browser-scope kinds. These witnesses ensure the attacker predicates are nonvacuous. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/runs/api.ts#findRunForPrincipal")
  (ts := "apps/web/server/runs/api.ts#requireSessionScopeMatch")]
theorem attacker_boundary_witnesses :
    foreignTarget runScoped foreignRow = true ∧
    ownershipBound otherOwnerState forgedOwner = false ∧
    browserScopeAllows runScoped otherSessionRow = false ∧
    browserScopeAllows sessionScoped otherSessionRow = false ∧
    namesRun .read = true ∧ namesRun .stream = true ∧
    namesRun .interrupt = true ∧ namesRun .revoke = true ∧
    namesRun .revokeAlias = true ∧ namesRun .start = false ∧
    namesRun .list = false ∧ namedAccessDenied ownState ownRead = false := by
  decide

/-- Finite first-pass counterexample search over all named route shapes, foreign and absent ids,
Owner/Builder/Viewer actors, and both browser-scope kinds. The real-handler replay exercises
the corresponding route calls and same-id absent control. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/runs/api.ts#findRunForPrincipal")]
theorem foreign_named_route_search_has_no_success :
    searchAttempts.filter (fun a => !namedAccessDenied searchState a) = [] := by
  decide

end AgentWorkspace.Theorems.Adversarial.AdversarialRunsAccess
