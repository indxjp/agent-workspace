import AgentWorkspace.Authz.Decide

/-!
T0 — the authorisation vocabulary and `decide()` are well formed: the closed lists are exactly the
TypeScript lists in their order, the sub-resource composition succeeds, every role's policy names
each resource at most once, and `decide()` answers every classified query while every refusal
names the step that failed.
-/

namespace AgentWorkspace.Theorems.WellFormed.AuthzDecide

open AgentWorkspace AgentWorkspace.Concepts.Membership AgentWorkspace.Concepts.BrowserToken
  AgentWorkspace.Authz.Roles AgentWorkspace.Authz.Resources AgentWorkspace.Authz.Permissions
  AgentWorkspace.Authz.TokenScope AgentWorkspace.Authz.Surface AgentWorkspace.Authz.Decide

/-- `RESOURCES` is exactly these 29 path segments, in this order. -/
@[aw_spec (tier := T0) (ts := "apps/web/server/rbac/resources.ts#RESOURCES")
  (doc := "docs/formal/domains/d1-runs.md#authorisation")]
theorem resource_wires_are_the_twenty_nine_resources :
    WireEnum.wires Resource =
      ["agents", "api-keys", "audit-events", "connectors", "endpoint-clients", "engines", "files",
        "invitations", "me", "memberships", "metrics", "model-connections", "models", "platforms", "projects",
        "runs", "runtime-connections", "runtime-profiles", "runtimes", "secrets", "sessions", "shares",
        "sharing-policies", "skills", "setup", "tool-bundles", "tokens", "users", "workspaces"] := by
  decide

/-- The operation, grant, ownership, surface and method vocabularies are exactly the TypeScript
unions and lists (`Operation`, `Grant`, `OWNERSHIPS`, `Surface`, `METHODS`), in their order. -/
@[aw_spec (tier := T0) (ts := "apps/web/server/rbac/decide.ts#OWNERSHIPS")
  (ts := "apps/web/server/rbac/decide.ts#METHODS") (ts := "apps/web/server/rbac/permissions.ts#Grant")
  (ts := "apps/web/server/auth/paths.ts#Surface")]
theorem decision_vocabularies_match_typescript :
    WireEnum.wires Operation = ["read", "write", "run"] ∧
      WireEnum.wires Grant = ["none", "own", "permitted", "any"] ∧
      WireEnum.wires Ownership = ["own", "other", "unknown", "not-applicable", "permitted"] ∧
      WireEnum.wires Surface = ["api", "public", "page"] ∧
      methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] ∧
      (roles.map WireEnum.toWire) = ["owner", "admin", "builder", "viewer"] := by decide

/-- `composeSubResources` does not throw on the tracked declarations, and `SUB_RESOURCES` is §34's
three pairs plus the thirty declared ones: 33 classified `(resource, sub)` pairs. -/
@[aw_spec (tier := T0) (ts := "apps/web/server/rbac/permissions.ts#SUB_RESOURCES")
  (ts := "apps/web/server/rbac/declared-sub-resources.ts#composeSubResources")
  (doc := "docs/adr/0040-sub-resource-classification-is-partitioned-by-the-task-that-ships-the-routes.md#decision")]
theorem sub_resource_composition_yields_thirty_three_pairs :
    (match composeSubResources spec34SubResources declaredSubResources with
      | .ok _ => true | .error _ => false) = true ∧
      pairsOf subResources =
        [(.agents, "runs"), (.agents, "promote"), (.agents, "rollback"), (.agents, "evaluations"), (.agents, "evaluation-runs"), (.agents, "evaluation-advance"), (.agents, "feedback"), (.agents, "versions"), (.agents, "pointers"), (.agents, "platform-exports"), (.agents, "platform-archives"), (.agents, "policy"), (.agents, "grants"), (.agents, "resources"),
          (.connectors, "test-connection"), (.endpointClients, "keys"), (.endpointClients, "secret"), (.invitations, "resend"),
          (.modelConnections, "test"),
          (.modelConnections, "credential"), (.projects, "sessions"), (.projects, "archive"),
          (.projects, "restore"), (.runs, "events"), (.runs, "feedback"), (.runs, "interrupt"),
          (.runs, "revoke-tokens"), (.sessions, "messages"), (.sessions, "state-entries"),
          (.sessions, "state-streams"), (.sessions, "state-blobs"), (.sessions, "transcript"),
          (.sessions, "subkeys")] ∧
      (pairsOf subResources).length = 33 ∧ (pairsOf subResources).Nodup := by decide

/-- Every role's policy names each resource at most once, so no override silently shadows
another (a duplicate key in a TypeScript object literal would). -/
@[aw_spec (tier := T0) (ts := "apps/web/server/rbac/permissions.ts#POLICY")]
theorem every_role_policy_names_each_resource_once :
    ∀ r : Role, ((policy r).byResource.map (·.1)).Nodup := by decide

/-- `decide()` never refuses a query whose role parses, whose path is on the `api` surface and
parses, and whose method maps to an operation: every such cell is `allow` or `deny`. -/
@[aw_spec (tier := T0) (ts := "apps/web/server/rbac/decide.ts#decide")
  (ts := "apps/web/server/rbac/authorisation-matrix.test.ts#undecidedCells")
  (doc := "docs/adr/0031-a-static-gate-cannot-be-complete-so-undecidable-must-mean-refused.md#decision")]
theorem decide_decides_every_classified_query (q : Query) {role : Role} {res : Resource}
    {sub id : Option String} {op : Operation} (hr : parseRoleInput q.role = some role)
    (hs : classifyPath q.path = .api) (hp : parsePath q.path = .ok res sub id)
    (ho : parseOperation q.method sub = .ok op) : (decideOrdinary q).effect ≠ .refuse := by
  simp only [decideOrdinary, hr, hs, hp, ho, decideClassified]
  split
  · simp [Decision.effect]
  · split <;> simp [Decision.effect]

example : (decideOrdinary ⟨"viewer", "GET", "/api/runs/:id", .other, none⟩).effect ≠ .refuse :=
  decide_decides_every_classified_query _ (role := .viewer) (res := .runs) (sub := none)
    (id := some ":id") (op := .read) (by decide) (by decide) (by decide) (by decide)

/-- Every refusal names the step that failed: an unrecognised role, the page surface, a path the
grammar rejects, or a method with no operation — and nothing else refuses. -/
@[aw_spec (tier := T0) (ts := "apps/web/server/rbac/decide.ts#decide")
  (doc := "docs/adr/0015-gates-decide-on-positive-assertions.md#decision")]
theorem every_refusal_names_the_failed_step (q : Query) (r : RefuseReason)
    (h : decideOrdinary q = .refuse r) :
    (r = .unknownRole ∧ parseRoleInput q.role = none) ∨
      (r = .pageSurface ∧ classifyPath q.path = .page) ∨
      (∃ p, r = .path p ∧ parsePath q.path = p ∧ ∀ a b c, p ≠ .ok a b c) ∨
      (∃ m res sub id, r = .method m ∧ parsePath q.path = .ok res sub id ∧
        parseOperation q.method sub = .refused m) := by
  unfold decideOrdinary at h
  cases hr : parseRoleInput q.role with
  | none => simp [hr] at h; exact Or.inl ⟨h.symm, rfl⟩
  | some role =>
    simp only [hr] at h
    cases hs : classifyPath q.path with
    | «public» => simp [hs] at h
    | page => simp [hs] at h; exact Or.inr (Or.inl ⟨h.symm, rfl⟩)
    | api =>
      simp only [hs] at h
      cases hp : parsePath q.path with
      | ok res sub id =>
        simp only [hp] at h
        cases ho : parseOperation q.method sub with
        | refused m =>
          simp [ho] at h
          exact Or.inr (Or.inr (Or.inr ⟨m, res, sub, id, h.symm, rfl, ho⟩))
        | ok op =>
          simp only [ho, decideClassified] at h
          split at h
          · cases h
          · split at h <;> cases h
      | notApiShape => simp [hp] at h; exact Or.inr (Or.inr (Or.inl ⟨_, h.symm, rfl, by simp⟩))
      | unknownResource s =>
        simp [hp] at h; exact Or.inr (Or.inr (Or.inl ⟨_, h.symm, rfl, by simp⟩))
      | unclassifiedSub a s =>
        simp [hp] at h; exact Or.inr (Or.inr (Or.inl ⟨_, h.symm, rfl, by simp⟩))
      | tooDeep => simp [hp] at h; exact Or.inr (Or.inr (Or.inl ⟨_, h.symm, rfl, by simp⟩))

example : decideOrdinary ⟨"superuser", "GET", "/api/users", .notApplicable, none⟩ =
    .refuse .unknownRole := by decide

/-- Whether a declared route reaches a decision on its own: it is public, or it is an `/api`
path the grammar parses with a method that maps to an operation. -/
private def routeClassified (r : DeclaredRoute) : Bool :=
  match classifyPath r.path with
  | .«public» => true
  | .page => false
  | .api =>
    match parsePath r.path with
    | .ok _ sub _ =>
      match parseOperation r.method sub with
      | .ok _ => true
      | .refused _ => false
    | _ => false

/-- The authorisation matrix is total: its 132 routes (the declared union minus the fourteen
pre-authentication routes and the nine identity-only routes) are decided — `allow` or `deny`, never
`refuse` — for every role and every ownership answer, 2 640 cells. -/
@[aw_spec (tier := T0) (ts := "apps/web/server/rbac/authorisation-matrix.test.ts#undecidedCells")
  (doc := "docs/adr/0031-a-static-gate-cannot-be-complete-so-undecidable-must-mean-refused.md#decision")]
theorem every_matrix_route_is_decided :
    matrixRoutes.length = 132 ∧ ∀ r ∈ matrixRoutes, ∀ role : Role, ∀ o : Ownership,
      (decideOrdinary ⟨WireEnum.toWire role, r.method, r.path, o, none⟩).effect ≠ .refuse := by
  have hall : matrixRoutes.all routeClassified = true := by decide +kernel
  refine ⟨by decide +kernel, fun r hr role o => ?_⟩
  have hc := List.all_eq_true.mp hall r hr
  have hrole : parseRoleInput (WireEnum.toWire role) = some role := WireEnum.ofWire?_toWire role
  unfold routeClassified at hc
  split at hc
  · rename_i hs
    simp [decideOrdinary, hrole, hs, Decision.effect]
  · cases hc
  · rename_i hs
    split at hc
    · rename_i res sub id hp
      split at hc
      · rename_i op ho
        exact decide_decides_every_classified_query ⟨WireEnum.toWire role, r.method, r.path, o, none⟩
          hrole hs hp ho
      · cases hc
    · cases hc

end AgentWorkspace.Theorems.WellFormed.AuthzDecide
