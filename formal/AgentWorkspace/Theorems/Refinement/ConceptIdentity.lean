import AgentWorkspace.Theorems.Invariants.ConceptIdentity

/-!
T4 — where today's identity model (`…Current`) and the documented target (`…Target`) agree and
where they diverge.

* **Principal coverage (RF-101).** The target has "one human principal per Membership and one
  machine principal per APIKey". Today's schema enforces *at most* one (the
  `(workspace_id, membership_id)` and `(workspace_id, api_key_id)` unique keys) but not *at least*
  one: nothing references a principal from its source. `consistentTarget` refines `consistent`,
  and the two diverge exactly at a source with no principal.
* **`GET /api/me` (`MeResponseSchema`).** Its comment documents "`userId` is `null` for exactly an
  API-key principal"; the Zod schema accepts any nullable `userId` whatever the kind. The target
  refines the current schema and diverges at a mismatched pair.
-/

namespace AgentWorkspace.Theorems.Refinement.ConceptIdentity

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Er.Current.Identity
  AgentWorkspace.Concepts.Principal

/-- A workspace with one member and no principal for that membership. -/
private def membershipWithoutPrincipal : Er.Core.State
  | .workspaces =>
    [⟨[("id", "w1"), ("slug", "acme"), ("name", "Acme"), ("public_sharing_enabled", "true"),
       ("created_at", "1000"), ("updated_at", "1000")]⟩]
  | .users =>
    [⟨[("id", "u1"), ("email", "ada@example.com"), ("name", "Ada"), ("created_at", "1000"),
       ("updated_at", "1000")]⟩]
  | .memberships =>
    [⟨[("id", "m1"), ("workspace_id", "w1"), ("user_id", "u1"), ("role", "owner"),
       ("created_at", "1000"), ("updated_at", "1000")]⟩]
  | _ => []

/-- Every state the RF-101 target admits, today's schema admits; today's schema also admits a
membership with no principal, which the target refuses. -/
@[aw_spec (tier := T4)
  (doc := "docs/architecture/refactoring/claude-agent-workspace-refactoring-plan.md#rf-101--introduce-workspaceprincipal-and-split-identity-ownership-and-attribution")
  (ts := "packages/core/src/db/schema/workspace-principals.ts#workspace_principals_workspace_membership_key")]
theorem principal_coverage_target_refines_current :
    (∀ st : Er.Core.State, consistentTarget st = true →
        Er.Current.Identity.consistent st = true) ∧
      ∃ st : Er.Core.State, Er.Current.Identity.consistent st = true ∧
        consistentTarget st = false := by
  refine ⟨fun st h => ?_, membershipWithoutPrincipal, by decide +kernel, by decide +kernel⟩
  simp only [consistentTarget, Bool.and_eq_true] at h
  exact h.1

/-- The target is satisfiable by a realistic state: the witness state of the invariants, where
every membership and every key has its principal. -/
@[aw_spec (tier := T4)
  (doc := "docs/architecture/refactoring/claude-agent-workspace-refactoring-plan.md#rf-101--introduce-workspaceprincipal-and-split-identity-ownership-and-attribution")]
theorem principal_coverage_target_is_satisfiable :
    ∃ st : Er.Core.State, consistentTarget st = true :=
  ⟨Invariants.ConceptIdentity.Witness.state, by decide +kernel⟩

/-- Every `GET /api/me` body the documented rule accepts, today's schema accepts; today's schema
also accepts an API-key principal with a user id, which the documented rule refuses. -/
@[aw_spec (tier := T4) (ts := "packages/contracts/src/team.ts#MeResponseSchema")
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#workspace-and-principal")]
theorem me_schema_target_refines_current :
    (∀ m : MeResponse, m.acceptedTarget = true → m.acceptedCurrent = true) ∧
      ∃ m : MeResponse, m.acceptedCurrent = true ∧ m.acceptedTarget = false := by
  refine ⟨fun m h => ?_, ⟨"p1", .apiKey, .viewer, "w1", some "u1", "CI"⟩, by decide, by decide⟩
  simp only [MeResponse.acceptedTarget, Bool.and_eq_true] at h
  exact h.1

/-- On every well-formed authenticated principal the current and target `me` rules agree: the
divergence is reachable only by a body the server does not build. -/
@[aw_spec (tier := T4) (ts := "packages/contracts/src/team.ts#MeResponseSchema")
  (ts := "apps/web/server/rbac/principal.ts#isPrincipal")]
theorem me_rules_agree_on_well_formed_principals (a : Actor) (h : a.wellFormed = true) :
    a.me.acceptedTarget = a.me.acceptedCurrent := by
  obtain ⟨pid, kind, ws, label, user, actor, role, via, key, scope, owner⟩ := a
  cases kind <;> cases user <;> simp_all [Actor.wellFormed, Actor.me, MeResponse.acceptedTarget]

example : (fromApiKey ⟨"p", "k", "w", .viewer, "CI", none⟩).me.acceptedTarget =
    (fromApiKey ⟨"p", "k", "w", .viewer, "CI", none⟩).me.acceptedCurrent :=
  me_rules_agree_on_well_formed_principals _ rfl

end AgentWorkspace.Theorems.Refinement.ConceptIdentity
