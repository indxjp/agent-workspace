import AgentWorkspace.Authz.Decide

/-!
T5 — properties of the authorisation specification itself: in which role order the grant table is
monotone and exactly where it is not (named counterexamples, each a finding), where the documents
contradict the table or each other, and where the one run route that bypasses `decide()` disagrees
with it.
-/

namespace AgentWorkspace.Theorems.Meta.AuthzDecide

open AgentWorkspace AgentWorkspace.Concepts.Membership AgentWorkspace.Concepts.BrowserToken
  AgentWorkspace.Authz.Roles AgentWorkspace.Authz.Resources AgentWorkspace.Authz.Permissions
  AgentWorkspace.Authz.TokenScope AgentWorkspace.Authz.Surface AgentWorkspace.Authz.Decide

/-- The operations, in `Operation` order. -/
private def ops : List Operation := [.read, .write, .run]

/-- The cells where `lo`'s grant is not within `hi`'s. -/
private def notAbove (hi lo : Role) : List (Resource × Operation) :=
  Resource.all.flatMap fun r =>
    (ops.filter fun o => !Grant.le (grantFor lo r o) (grantFor hi r o)).map (r, ·)

/-! ## Monotonicity of the table -/

/-- Owner dominates every role on every cell: no role holds a grant Owner lacks. -/
@[aw_spec (tier := T5) (doc := "docs/spec.md#21-users-and-rbac")
  (ts := "apps/web/server/rbac/permissions.ts#POLICY")]
theorem owner_dominates_every_role :
    ∀ r : Role, ∀ res : Resource, ∀ op : Operation,
      Grant.le (grantFor r res op) (grantFor .owner res op) = true := by decide

/-- The table is **not** monotone in the order Admin ⊇ Builder, and the counterexamples are
exactly these cells: Admin holds nothing over `projects` where Builder does, and no `run` on
`connectors` (unreachable by any path). ADR-0116 closed the `skills` and `files` cells. -/
@[aw_spec (tier := T5)
  (doc := "docs/adr/0116-admin-manages-skills-and-files.md#decision")
  (ts := "apps/web/server/rbac/roles.ts#ROLES")]
theorem admin_is_not_above_builder_exactly_at :
    notAbove .admin .builder =
      [(.connectors, .run), (.projects, .read), (.projects, .write)] := by decide

/-- The table is **not** monotone in the order Builder ⊇ Viewer, at exactly one cell: running an
agent, where Builder holds `own` and Viewer `permitted` (suspicious point 11). Admin is above
Viewer everywhere. -/
@[aw_spec (tier := T5) (doc := "docs/formal/domains/d1-runs.md#suspicious-points-noticed-while-reading")
  (ts := "apps/web/server/rbac/permissions.ts#POLICY")]
theorem builder_is_not_above_viewer_exactly_at_agent_runs :
    notAbove .builder .viewer = [(.agents, .run)] ∧ notAbove .admin .viewer = [] := by decide

/-- Suspicious point 11 through `decide()`: a Builder named by an `agent_grants` row is denied
running that agent while a Viewer with the same grant is allowed, and a Viewer is denied running an
agent it owns. -/
@[aw_spec (tier := T5) (doc := "docs/adr/W9-AUTH-117-viewer-permitted-agent-grants.md#decision")
  (ts := "apps/web/server/agents/run-ownership.ts#resolveAgentRunOwnership")
  (ts := "apps/web/server/rbac/decide.ts#applyGrant")]
theorem granted_builder_cannot_run_the_agent_a_granted_viewer_can :
    (decideAuth ⟨"builder", "POST", "/api/agents/:id/runs", .permitted, none⟩).effect = .deny ∧
      (decideAuth ⟨"viewer", "POST", "/api/agents/:id/runs", .permitted, none⟩).effect = .allow ∧
      (decideAuth ⟨"viewer", "POST", "/api/agents/:id/runs", .own, none⟩).effect = .deny := by
  decide

/-! ## Revoke decision and handler agreement (suspicious point 10) -/

/-- Both revoke route shapes have one dedicated decision: Owner and Admin pass, while Builder and
Viewer deny, independently of the ownership answer. -/
@[aw_spec (tier := T5) (doc := "docs/sdk/04-api-specification.md#512-runs-and-the-event-stream--awruns")
  (ts := "apps/web/server/runs/api.ts#revokeRunTokens") (ts := "apps/web/server/rbac/decide.ts#decide")]
theorem decide_and_the_revoke_gate_agree_for_every_role :
    ∀ path ∈ ["/api/runs/:id/revoke-tokens", "/api/runs/:id"],
      ["owner", "admin", "builder", "viewer"].map (fun role =>
        (revokeTokensRoleGate role,
          (WireEnum.all : List Ownership).all fun o =>
            (decideAuth ⟨role, "POST", path, o, none⟩).effect == .deny)) =
        [(true, false), (true, false), (false, true), (false, true)] := by decide

/-! ## ADR against ADR (suspicious point 12) -/

/-- W9-AUTH-165's text ("an Admin still cannot start, cancel, or write a run") and SDK-03-RUN-235
(Admin `run: 'any'`, which the code follows) describe tables that differ in exactly one cell,
`(admin, runs, run)`, so an Admin's interrupt is allowed today and denied under W9-AUTH-165. -/
@[aw_spec (tier := T5) (doc := "docs/adr/W9-AUTH-165-admin-reads-workspace-run-history.md#decision")
  (doc := "docs/adr/SDK-03-RUN-235-an-interrupt-is-a-control-plane-transition.md#decision")
  (ts := "apps/web/server/rbac/permissions.ts#POLICY")]
theorem admin_run_verbs_adrs_disagree_at_one_cell :
    (∀ r : Role, ∀ res : Resource, ∀ op : Operation,
        ((grantsFor r res).get op ≠ (grantsForW9Auth165 r res).get op) ↔
          (r = .admin ∧ res = .runs ∧ op = .run)) ∧
      (grantsForW9Auth165 .admin .runs).run = .none ∧ (grantsFor .admin .runs).run = .any ∧
      (decideAuth ⟨"admin", "POST", "/api/runs/:id/interrupt", .other, none⟩).effect = .allow := by
  decide

/-! ## Document against code -/

/-- §3.3's table disagrees with `permissions.ts` on a reachable operation at exactly five cells —
Admin over `projects`, `secrets` and `audit-events`, Builder and Viewer over `audit-events` — and
is silent on `endpoint-clients`, `me`, `setup` and `tool-bundles`. -/
@[aw_spec (tier := T5) (doc := "docs/sdk/04-api-specification.md#33-roles")
  (ts := "apps/web/server/rbac/permissions.ts#POLICY")]
theorem documented_table_diverges_exactly_at :
    (Resource.all.flatMap fun res => (roles.filter fun r =>
        (documentedGrants r res).map (fun g => !agreeOnReachable res g (grantsFor r res)) =
          some true).map (·, res)) =
      [(.admin, .auditEvents), (.builder, .auditEvents), (.viewer, .auditEvents),
        (.admin, .projects), (.admin, .secrets)] ∧
      (Resource.all.filter fun res => (docRow res).isNone) =
        [.endpointClients, .me, .setup, .toolBundles] := by
  decide

/-- §3.1.1 lists two routes a run scope reaches, but `decide()`'s run-scope cell is by
`(resource, operation)` with no sub-resource key, so a run scope also passes `decide()` for
`GET`/`HEAD` on every other `runs` sub-resource of its run (`interrupt`, `revoke-tokens`,
`feedback`), shapes with no `GET` handler. -/
@[aw_spec (tier := T5) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "apps/web/server/rbac/decide.ts#TOKEN_SCOPE_GRAMMAR")]
theorem run_scope_passes_every_get_on_its_runs_shapes :
    ["/api/runs/r", "/api/runs/r/events", "/api/runs/r/interrupt", "/api/runs/r/revoke-tokens",
      "/api/runs/r/feedback"].all
      (fun p => ["GET", "HEAD"].all fun m =>
        (decideAuth ⟨"viewer", m, p, .own, some (.run ⟨"r"⟩)⟩).effect == .allow) = true := by
  decide

/-- The upper-case spelling of the scoped UUID is admitted as the same run. -/
@[aw_spec (tier := T5) (doc := "docs/formal/domains/d1-runs.md#suspicious-points-noticed-while-reading")
  (ts := "apps/web/server/rbac/decide.ts#checkTokenScope")]
theorem run_scope_id_accepts_equivalent_uuid_spelling :
    decideAuth ⟨"owner", "GET", "/api/runs/0f8fad5b-d9cb-469f-a165-70867728950e", .own,
        some (.run ⟨"0f8fad5b-d9cb-469f-a165-70867728950e"⟩)⟩ = .allow (some ⟨.runs, .read, .any⟩) ∧
      decideAuth ⟨"owner", "GET", "/api/runs/0F8FAD5B-D9CB-469F-A165-70867728950E", .own,
        some (.run ⟨"0f8fad5b-d9cb-469f-a165-70867728950e"⟩)⟩ = .allow (some ⟨.runs, .read, .any⟩) := by
  decide

/-- `MAX_DECODE_ROUNDS` is four: a pathname that reveals `/api` only after three decodings is
protected, and one that needs four stays a page. -/
@[aw_spec (tier := T5) (ts := "apps/web/server/auth/paths.ts#MAX_DECODE_ROUNDS")]
theorem path_classifier_reads_four_decodings :
    classifyPath "/%252561pi" = .api ∧ classifyPath "/%25252561pi" = .page := by decide

/-! ## The route inventory against the classification -/

/-- Of the 155 declared routes, `decide()` refuses exactly the ten `/api/auth/*` routes,
`GET /api/cron/retention` and the two `/api/a2a/*` routes (an unclassified resource each; the cron
route authenticates itself with `CRON_SECRET`, ADR-0120 clause 7, and the A2A routes with an API
key, ADR-0135), `POST /mcp/projects/:name` and the seven OAuth routes under `/.well-known/` and
`/oauth/` (paths outside `/api`, which the classifier reads as pages; the endpoint authenticates
itself with an endpoint API key, ADR-0134, and the OAuth routes are public by protocol or require a
browser session, ADR-0134 part 3) and `POST /api/invitations/:id/accept` (an unclassified
sub-resource) — twenty-two of the twenty-three routes the matrix exempts by name; the
twenty-third, `GET /api/setup/runtime-detect`, parses as a `setup` row and is decided. -/
@[aw_spec (tier := T5) (ts := "apps/web/server/rbac/authorisation-matrix.test.ts#PUBLIC_ROUTES")
  (ts := "apps/web/server/rbac/authorisation-matrix.test.ts#IDENTITY_ONLY_ROUTES")]
theorem refused_declared_routes_are_the_auth_routes_and_accept :
    ((declaredRoutes.filter fun r =>
        (decideAuth ⟨"owner", r.method, r.path, .own, none⟩).effect == .refuse).map
        fun r => (r.method, r.path)) =
      [("GET", "/api/cron/retention"),
        ("POST", "/api/a2a/agents/:agentName"),
        ("GET", "/api/a2a/agents/:agentName/.well-known/agent-card.json"),
        ("POST", "/mcp/projects/:name"),
        ("GET", "/.well-known/oauth-authorization-server"),
        ("GET", "/.well-known/oauth-protected-resource/mcp/projects/:name"),
        ("GET", "/.well-known/oauth-protected-resource/api/a2a/agents/:agentName"),
        ("GET", "/oauth/authorize"), ("POST", "/oauth/authorize"), ("POST", "/oauth/token"),
        ("POST", "/oauth/revoke"),
        ("POST", "/api/auth/cli-device"), ("GET", "/api/auth/cli-verify"),
        ("POST", "/api/auth/cli-verify"), ("POST", "/api/auth/cli-token"),
        ("DELETE", "/api/auth/cli-token"), ("POST", "/api/auth/cli-workspace"),
        ("GET", "/api/auth/login"), ("POST", "/api/auth/callback"), ("GET", "/api/auth/workspace"),
        ("POST", "/api/auth/workspace"), ("POST", "/api/invitations/:id/accept")] := by
  decide +kernel

/-- Every classified sub-resource but one has a declared route: `sessions/messages`, which spec §34
prints as `POST /api/sessions/:id/messages`, is classified (and read as the `run` verb) while no
route declares it. -/
@[aw_spec (tier := T5) (doc := "docs/spec.md#34-api-design")
  (ts := "apps/web/server/rbac/permissions.ts#SPEC_34_SUB_RESOURCES")]
theorem classified_sub_without_a_declared_route :
    (pairsOf subResources).filter (fun (res, sub) => !declaredRoutes.any fun r =>
        match parsePath r.path with
        | .ok res' (some s) _ => res' == res && s == sub
        | _ => false) = [(.sessions, "messages")] := by decide +kernel

end AgentWorkspace.Theorems.Meta.AuthzDecide
