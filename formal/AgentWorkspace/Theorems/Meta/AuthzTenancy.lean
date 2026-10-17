import AgentWorkspace.Authz.Tenancy

/-!
T5 — properties of the specification itself. F-007 is settled here: the model's tenancy rule
(`Er.Core.tenancyWellFormed`) and `tenancy.test.ts`'s rule 1 (`testRule1`, with the index fact
transcribed as `leadingIndexedColumns`) are different predicates — each admits a schema the other
refuses — and both hold of every one of today's 33 tables. And one of today's own guards is dead
where it is called: `Principal.fromSession`'s slug check cannot fire at its only production call
site, because that site copies the slug from the claims it is compared with.
-/

namespace AgentWorkspace.Theorems.Meta.AuthzTenancy

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Authz.Tenancy

/-- Every table of today's schema satisfies both the model's tenancy rule and the test's rule 1
(including "`workspace_id` leads an index"): on today's catalogue the two rules agree. -/
@[aw_spec (tier := T5) (doc := "docs/formal/findings.md#f-007--the-models-tenancy-rule-differs-from-tenancytestts-rule-1-and-the-docstring-now-says-so-instead-of-claiming-equivalence")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#TENANT_COLUMN")]
theorem tenancy_rules_agree_on_the_catalogue (t : TableName) :
    tenancyWellFormed catalogue t = true ∧ testRule1 catalogue leadingIndexedColumns t = true := by
  cases t <;> decide

/-- The two tenancy rules are different predicates: a `text` `workspace_id` passes the test's rule
and fails the model's (the model also requires `uuid`), and a `workspace_id` that leads no index
passes the model's rule and fails the test's. -/
@[aw_spec (tier := T5) (doc := "docs/formal/findings.md#f-007--the-models-tenancy-rule-differs-from-tenancytestts-rule-1-and-the-docstring-now-says-so-instead-of-claiming-equivalence")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#leadingIndexedColumns")]
theorem tenancy_rules_differ_off_the_catalogue :
    (let S := catalogue.update .auditEvents (·.mapColumn "workspace_id" fun c => { c with type := .text })
     tenancyWellFormed S .auditEvents = false ∧ testRule1 S leadingIndexedColumns .auditEvents = true) ∧
    (let leaders := fun t => if t = .auditEvents then ["actor_user_id"] else leadingIndexedColumns t
     tenancyWellFormed catalogue .auditEvents = true ∧ testRule1 catalogue leaders .auditEvents = false) := by
  decide

/-- `Principal.fromSession`'s workspace-correspondence check can never refuse at its production
call site: `resolveActor` passes `{ id: member.workspaceId, slug: verified.claims.ws }`, so the slug
compared with the claims is the claims' own. The binding of the session to its workspace is made
by `resolveMembership`'s slug lookup alone. -/
@[aw_spec (tier := T5) (ts := "apps/web/server/composition/session-rbac.ts#installRbacApi")
  (ts := "apps/web/server/rbac/principal.ts#fromSession")]
theorem session_slug_check_is_dead_at_its_call_site (claims : SessionClaims) (id role : String)
    (identity : MemberIdentity) :
    fromSession claims ⟨id, claims.ws⟩ role identity ≠ .error .workspaceMismatch := by
  unfold fromSession
  simp only [bne_self_eq_false, Bool.false_eq_true, ite_false]
  split
  · intro h; cases h
  · intro h; cases h

/-! ## Witnesses -/

/-- The guard itself is live: with a slug other than the claims', it refuses. -/
example : fromSession ⟨"ada@example.com", "one"⟩ ⟨"w2", "two"⟩ "owner" ⟨"p1", "u1", "Ada"⟩ =
    .error .workspaceMismatch := rfl

end AgentWorkspace.Theorems.Meta.AuthzTenancy
