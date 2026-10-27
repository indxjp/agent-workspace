import AgentWorkspace.Authz.Decide

/-!
T2 — properties of `decide()` that hold for **every** query: a browser-token scope only narrows
(it can turn an answer into a `token_out_of_scope` deny, never change it otherwise); an
undetermined owner is treated exactly as another member's row; and an `allow` is always backed by
the table cell and by the ownership fact that cell requires.
-/

namespace AgentWorkspace.Theorems.Invariants.AuthzDecide

open AgentWorkspace AgentWorkspace.Concepts.Membership AgentWorkspace.Concepts.BrowserToken
  AgentWorkspace.Authz.Roles AgentWorkspace.Authz.Resources AgentWorkspace.Authz.Permissions
  AgentWorkspace.Authz.TokenScope AgentWorkspace.Authz.Surface AgentWorkspace.Authz.Decide

private theorem classified_scope_narrows (role : Role) (q : Query) (res : Resource)
    (sub id : Option String) (op : Operation) (s : Scope) :
    decideClassified role { q with scope := some s } res sub id op =
        decideClassified role { q with scope := none } res sub id op ∨
      ∃ d, decideClassified role { q with scope := some s } res sub id op = .deny none (some d) := by
  unfold decideClassified
  cases h : checkTokenScope s res op sub id with
  | none => left; simp [h]
  | some d => right; exact ⟨d, by simp [h]⟩

/-- A browser-token scope only narrows: the scoped decision is the unscoped one, or a
`token_out_of_scope` deny — never an `allow` the minter would not get, and never a different
refusal. -/
@[aw_spec (tier := T2) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "apps/web/server/rbac/decide.ts#checkTokenScope")]
theorem scope_only_narrows (q : Query) (s : Scope) :
    decideOrdinary { q with scope := some s } = decideOrdinary { q with scope := none } ∨
      ∃ d, decideOrdinary { q with scope := some s } = .deny none (some d) := by
  unfold decideOrdinary
  dsimp only
  cases parseRoleInput q.role with
  | none => left; rfl
  | some role =>
    dsimp only
    cases classifyPath q.path with
    | «public» => left; rfl
    | page => left; rfl
    | api =>
      dsimp only
      cases parsePath q.path with
      | ok res sub id =>
        dsimp only
        cases parseOperationFor q.method res sub with
        | refused m => left; rfl
        | ok op => exact classified_scope_narrows role q res sub id op s
      | _ => left; rfl

/-- A scoped query is allowed only if the same query without the scope is allowed, with the same
route facts. -/
@[aw_spec (tier := T2) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "apps/web/server/rbac/decide.ts#decide")]
theorem scoped_allow_implies_unscoped_allow (q : Query) (s : Scope) (f : Option RouteFacts)
    (h : decideOrdinary { q with scope := some s } = .allow f) :
    decideOrdinary { q with scope := none } = .allow f := by
  rcases scope_only_narrows q s with h' | ⟨d, h'⟩
  · rw [← h', h]
  · rw [h] at h'; cases h'

example : decideOrdinary ⟨"owner", "GET", "/api/runs/r", .own, none⟩ = .allow (some ⟨.runs, .read, .any⟩) :=
  scoped_allow_implies_unscoped_allow ⟨"owner", "GET", "/api/runs/r", .own, none⟩ (.run ⟨"r"⟩) _
    (by decide +kernel)

/-- An undetermined owner (`unknown`) is decided exactly as another member's row (`other`): the
handler that has not read the row gains nothing by saying so. -/
@[aw_spec (tier := T2)
  (doc := "docs/adr/0031-a-static-gate-cannot-be-complete-so-undecidable-must-mean-refused.md#decision")
  (ts := "apps/web/server/rbac/decide.ts#applyGrant")]
theorem unknown_owner_is_decided_as_other (q : Query) :
    decideOrdinary { q with ownership := .unknown } = decideOrdinary { q with ownership := .other } := by
  have hg : ∀ g, applyGrant g .unknown = applyGrant g .other := by decide +kernel
  unfold decideOrdinary decideClassified
  dsimp only
  cases parseRoleInput q.role with
  | none => rfl
  | some role =>
    dsimp only
    cases classifyPath q.path with
    | api =>
      dsimp only
      cases parsePath q.path with
      | ok res sub id =>
        dsimp only
        cases parseOperationFor q.method res sub with
        | refused m => rfl
        | ok op => simp only [hg]
      | _ => rfl
    | _ => rfl

/-- Every `allow` that consulted §21's table is backed by it: the role parses, the path parses to
the allowed resource, the grant is that role's cell, it is not `none`, an `own` grant saw an `own`
or `not-applicable` fact, and a `permitted` grant saw an `own` or `permitted` fact (ADR-0152). -/
@[aw_spec (tier := T2) (doc := "docs/sdk/04-api-specification.md#33-roles")
  (doc := "docs/adr/W9-AUTH-117-viewer-permitted-agent-grants.md#decision")
  (ts := "apps/web/server/rbac/decide.ts#decide")]
theorem every_allow_is_backed_by_the_table (q : Query) (f : RouteFacts)
    (h : decideOrdinary q = .allow (some f)) :
    ∃ role sub id op, parseRoleInput q.role = some role ∧
      parsePath q.path = .ok f.resource sub id ∧
      f.operation = RouteOperation.ofOperation op ∧
      f.grant = grantFor role f.resource op ∧ f.grant ≠ .none ∧
      (f.grant = .own → q.ownership = .own ∨ q.ownership = .notApplicable) ∧
      (f.grant = .permitted → q.ownership = .own ∨ q.ownership = .permitted) := by
  unfold decideOrdinary at h
  cases hr : parseRoleInput q.role with
  | none => simp [hr] at h
  | some role =>
    simp only [hr] at h
    cases hs : classifyPath q.path with
    | «public» => simp [hs] at h
    | page => simp [hs] at h
    | api =>
      simp only [hs] at h
      cases hp : parsePath q.path with
      | ok res sub id =>
        simp only [hp] at h
        cases ho : parseOperationFor q.method res sub with
        | refused m => simp [ho] at h
        | ok op =>
          simp only [ho, decideClassified] at h
          split at h
          · cases h
          · split at h
            · rename_i hap
              cases h
              refine ⟨role, sub, id, op, rfl, rfl, rfl, rfl, ?_, ?_, ?_⟩
              · intro hn; dsimp only at hn; rw [hn] at hap; simp [applyGrant] at hap
              · intro ho'; dsimp only at ho'; rw [ho'] at hap; revert hap; cases q.ownership <;> simp [applyGrant]
              · intro hp'; dsimp only at hp'; rw [hp'] at hap; revert hap; cases q.ownership <;> simp [applyGrant]
            · cases h
      | _ => simp [hp] at h

example : ∃ role sub id op, parseRoleInput "builder" = some role ∧
    parsePath "/api/agents/a" = .ok Resource.agents sub id ∧
    RouteOperation.write = RouteOperation.ofOperation op ∧
    Grant.own = grantFor role .agents op ∧ Grant.own ≠ .none ∧
    (Grant.own = .own → Ownership.own = .own ∨ Ownership.own = .notApplicable) ∧
    (Grant.own = .permitted → Ownership.own = .own ∨ Ownership.own = .permitted) :=
  every_allow_is_backed_by_the_table ⟨"builder", "PATCH", "/api/agents/a", .own, none⟩
    ⟨.agents, .write, .own⟩ (by decide +kernel)

end AgentWorkspace.Theorems.Invariants.AuthzDecide
