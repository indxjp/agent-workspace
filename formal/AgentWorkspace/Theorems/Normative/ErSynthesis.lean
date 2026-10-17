import AgentWorkspace.Er.Refinement

/-!
T1 — "A session proves identity; RBAC proves permission; a repository scope proves tenant
selection. None substitutes for another." (`docs/architecture.md`, runtime and trust boundaries.)

On the model of browser-session resolution (`Er.Target.Resolution`):

* the role a request gets is read from the membership, never from the token;
* the same identity (one user) holds different roles in different workspaces, so identity does
  not determine permission;
* a workspace selection is honoured only through a membership of that workspace, whose principal
  belongs to the selected workspace, so identity does not determine the tenant either.
-/

namespace AgentWorkspace.Theorems.Normative.ErSynthesis

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Er AgentWorkspace.Er.Target.Resolution

private theorem resolveMember_some {st : State} {wid uid : Option String} {p r : String}
    (h : resolveMember st wid uid = some (p, r)) :
    ∃ m ∈ st .memberships, m.get "workspace_id" = wid ∧ m.get "user_id" = uid ∧
      m.get "role" = some r ∧ ∃ pr ∈ st .workspacePrincipals, pr.get "id" = some p ∧
        pr.get "workspace_id" = wid ∧ pr.get "membership_id" = m.get "id" ∧
        pr.get "kind" = some "membership" ∧ pr.get "revoked_at" = none := by
  unfold resolveMember at h
  split at h
  · cases h
  · rename_i m hm
    split at h
    · cases h
    · rename_i pr hpr
      have hmm := List.mem_of_find?_eq_some hm
      have hmp := List.find?_some hm
      have hpm := List.mem_of_find?_eq_some hpr
      have hpp := List.find?_some hpr
      simp only [activeMemberPrincipal, Bool.and_eq_true, beq_iff_eq, Option.isNone_iff_eq_none]
        at hmp hpp
      obtain ⟨pid, hpid, hrest⟩ := Option.bind_eq_some_iff.mp h
      obtain ⟨role, hrole, hpair⟩ := Option.map_eq_some_iff.mp hrest
      cases hpair
      exact ⟨m, hmm, hmp.1, hmp.2, hrole, pr, hpm, hpid, hpp.1.1.1, hpp.1.1.2, hpp.1.2, hpp.2⟩

/-- What today's resolution found, when it answers: the user the email names, the workspace the
slug selects, and that user's membership there. -/
private theorem resolveCurrent_some {st : State} {c : ClaimsCurrent} {p r : String}
    (h : resolveCurrent st c = some (p, r)) :
    ∃ u ∈ st .users, u.get "email" = some c.sub ∧ ∃ w ∈ st .workspaces, w.get "slug" = some c.ws ∧
      resolveMember st (w.get "id") (u.get "id") = some (p, r) := by
  unfold resolveCurrent at h
  split at h
  · cases h
  · split at h
    · rename_i u w hu hw
      have hum := List.mem_of_find?_eq_some hu
      have hup := List.find?_some hu
      have hwm := List.mem_of_find?_eq_some hw
      have hwp := List.find?_some hw
      simp only [beq_iff_eq] at hup hwp
      exact ⟨u, hum, hup, w, hwm, hwp, h⟩
    · cases h

/-- In the proposed target resolution, the role a browser session resolves to is the role stored on
the membership of the session's user in the selected workspace, never a value carried by the
token. -/
@[aw_spec (tier := T1) (doc := "docs/architecture.md#runtime-and-trust-boundaries")
  (doc := "docs/adr/FORMAL-P1-identity-permission-tenant-selection.md#decision")]
theorem role_is_read_from_the_membership (st : State) (c : ClaimsTarget) (p r : String)
    (h : resolveTarget st c = some (p, r)) :
    ∃ m ∈ st .memberships, m.get "user_id" = some c.sub ∧ m.get "role" = some r := by
  unfold resolveTarget at h
  split at h
  · obtain ⟨m, hm, _, hu, hr, _⟩ := resolveMember_some h
    exact ⟨m, hm, hu, hr⟩
  · cases h

/-- In the proposed target resolution, a workspace selection is honoured only through a membership in
that workspace: the resolved principal belongs to the workspace the slug selects. -/
@[aw_spec (tier := T1) (doc := "docs/architecture.md#runtime-and-trust-boundaries")
  (doc := "docs/sdk/04-api-specification.md#32-workspace-selection")
  (doc := "docs/adr/FORMAL-P1-identity-permission-tenant-selection.md#decision")]
theorem tenant_selection_requires_a_membership (st : State) (c : ClaimsTarget) (p r : String)
    (h : resolveTarget st c = some (p, r)) :
    ∃ w ∈ st .workspaces, w.get "slug" = some c.ws ∧
      (∃ m ∈ st .memberships, m.get "workspace_id" = w.get "id" ∧ m.get "user_id" = some c.sub) ∧
      ∃ pr ∈ st .workspacePrincipals, pr.get "id" = some p ∧ pr.get "workspace_id" = w.get "id" := by
  unfold resolveTarget at h
  split at h
  · rename_i w hw
    obtain ⟨m, hm, hmw, hmu, _, pr, hpr, hpid, hpw, _⟩ := resolveMember_some h
    have hwm := List.mem_of_find?_eq_some hw
    have hws := List.find?_some hw
    simp only [beq_iff_eq] at hws
    exact ⟨w, hwm, hws, ⟨m, hm, hmw, hmu⟩, pr, hpr, hpid, hpw⟩
  · cases h

/-- One identity holds different permissions in different workspaces: in the witness state the
user `u2` is a viewer of workspace `one` and the owner of workspace `two`, so no function of the
user alone decides a role. -/
@[aw_spec (tier := T1) (doc := "docs/architecture.md#runtime-and-trust-boundaries")
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#workspace-and-principal")]
theorem identity_does_not_determine_permission :
    resolveTarget Current.Witness.state ⟨"u2", "one"⟩ = some ("p2", "viewer") ∧
      resolveTarget Current.Witness.state ⟨"u2", "two"⟩ = some ("p4", "owner") := by decide

example : ∃ m ∈ Current.Witness.state .memberships, m.get "user_id" = some "u2" ∧
    m.get "role" = some "viewer" :=
  role_is_read_from_the_membership _ ⟨"u2", "one"⟩ "p2" "viewer" (by decide)

example : ∃ w ∈ Current.Witness.state .workspaces, w.get "slug" = some "two" ∧
    (∃ m ∈ Current.Witness.state .memberships, m.get "workspace_id" = w.get "id" ∧
      m.get "user_id" = some "u2") ∧
    ∃ pr ∈ Current.Witness.state .workspacePrincipals, pr.get "id" = some "p4" ∧
      pr.get "workspace_id" = w.get "id" :=
  tenant_selection_requires_a_membership _ ⟨"u2", "two"⟩ "p4" "owner" (by decide)

/-! ## Today's resolution: `DatabaseRoot.resolveMembership(email, workspaceSlug)` -/

/-- Today, the role a browser session resolves to is the role stored on the membership of the user
the session's email names, in the workspace its slug selects; the token's role claim is not read. -/
@[aw_spec (tier := T1) (doc := "docs/architecture.md#runtime-and-trust-boundaries")
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#three-separate-questions-three-separate-mechanisms")
  (ts := "packages/core/src/db/repositories/root.ts#resolveMembership")]
theorem current_role_is_read_from_the_membership (st : State) (c : ClaimsCurrent) (p r : String)
    (h : resolveCurrent st c = some (p, r)) :
    ∃ u ∈ st .users, u.get "email" = some c.sub ∧
      ∃ m ∈ st .memberships, m.get "user_id" = u.get "id" ∧ m.get "role" = some r := by
  obtain ⟨u, hu, he, _, _, _, hm⟩ := resolveCurrent_some h
  obtain ⟨m, hmm, _, hmu, hr, _⟩ := resolveMember_some hm
  exact ⟨u, hu, he, m, hmm, hmu, hr⟩

/-- Today, a workspace slug is honoured only through a membership in the workspace it selects,
and the resolved principal belongs to that workspace. -/
@[aw_spec (tier := T1) (doc := "docs/architecture.md#runtime-and-trust-boundaries")
  (doc := "docs/sdk/04-api-specification.md#32-workspace-selection")
  (ts := "packages/core/src/db/repositories/root.ts#resolveMembership")]
theorem current_tenant_selection_requires_a_membership (st : State) (c : ClaimsCurrent)
    (p r : String) (h : resolveCurrent st c = some (p, r)) :
    ∃ w ∈ st .workspaces, w.get "slug" = some c.ws ∧
      (∃ m ∈ st .memberships, m.get "workspace_id" = w.get "id") ∧
      ∃ pr ∈ st .workspacePrincipals, pr.get "id" = some p ∧ pr.get "workspace_id" = w.get "id" := by
  obtain ⟨_, _, _, w, hw, hs, hm⟩ := resolveCurrent_some h
  obtain ⟨m, hmm, hmw, _, _, pr, hpr, hpid, hpw, _⟩ := resolveMember_some hm
  exact ⟨w, hw, hs, ⟨m, hmm, hmw⟩, pr, hpr, hpid, hpw⟩

/-- Today, a browser session resolves only to a principal that is not revoked: every principal it
returns has no `revoked_at`. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#workspace-and-principal")
  (ts := "packages/core/src/db/repositories/root.ts#resolveMembership")]
theorem resolved_principal_is_not_revoked (st : State) (c : ClaimsCurrent) (p r : String)
    (h : resolveCurrent st c = some (p, r)) :
    ∃ pr ∈ st .workspacePrincipals, pr.get "id" = some p ∧ pr.get "revoked_at" = none := by
  obtain ⟨_, _, _, _, _, _, hm⟩ := resolveCurrent_some h
  obtain ⟨_, _, _, _, _, pr, hpr, hpid, _, _, _, hrev⟩ := resolveMember_some hm
  exact ⟨pr, hpr, hpid, hrev⟩

/-- Today, a browser session resolves only to a principal of kind `membership` that names the
member's own membership, never to an API-key principal. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#workspace-and-principal")
  (ts := "packages/core/src/db/repositories/root.ts#resolveMembership")]
theorem resolved_principal_is_a_membership_principal (st : State) (c : ClaimsCurrent)
    (p r : String) (h : resolveCurrent st c = some (p, r)) :
    ∃ m ∈ st .memberships, ∃ pr ∈ st .workspacePrincipals, pr.get "id" = some p ∧
      pr.get "kind" = some "membership" ∧ pr.get "membership_id" = m.get "id" := by
  obtain ⟨_, _, _, _, _, _, hm⟩ := resolveCurrent_some h
  obtain ⟨m, hmm, _, _, _, pr, hpr, hpid, _, hmid, hkind, _⟩ := resolveMember_some hm
  exact ⟨m, hmm, pr, hpr, hpid, hkind, hmid⟩

/-- Revoking the owner's principal stops today's resolution of the owner's browser session, although
the user, the membership and the workspace are unchanged; the revoked state is itself a consistent
state of today's schema. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#workspace-and-principal")
  (ts := "packages/core/src/db/repositories/root.ts#resolveMembership")]
theorem a_revoked_principal_never_resolves :
    Current.consistent Refinement.ResolutionCells.revoked = true ∧
      resolveCurrent Current.Witness.state ⟨"ada@example.com", "one", "owner"⟩ =
        some ("p1", "owner") ∧
      resolveCurrent Refinement.ResolutionCells.revoked ⟨"ada@example.com", "one", "owner"⟩ =
        none := by
  decide +kernel

/-- A principal whose kind is not `membership` never resolves a browser session, even when it names
the member's membership. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#workspace-and-principal")
  (ts := "packages/core/src/db/repositories/root.ts#resolveMembership")]
theorem a_principal_of_another_kind_never_resolves :
    resolveCurrent Refinement.ResolutionCells.otherKind ⟨"ada@example.com", "one", "owner"⟩ =
      none := by
  decide

example : ∃ u ∈ Current.Witness.state .users, u.get "email" = some "bob@example.com" ∧
    ∃ m ∈ Current.Witness.state .memberships, m.get "user_id" = u.get "id" ∧
      m.get "role" = some "viewer" :=
  current_role_is_read_from_the_membership _ ⟨"bob@example.com", "one", "owner"⟩ "p2" "viewer"
    (by decide)

example : ∃ w ∈ Current.Witness.state .workspaces, w.get "slug" = some "two" ∧
    (∃ m ∈ Current.Witness.state .memberships, m.get "workspace_id" = w.get "id") ∧
    ∃ pr ∈ Current.Witness.state .workspacePrincipals, pr.get "id" = some "p4" ∧
      pr.get "workspace_id" = w.get "id" :=
  current_tenant_selection_requires_a_membership _ ⟨"bob@example.com", "two", "owner"⟩ "p4"
    "owner" (by decide)

example : ∃ pr ∈ Current.Witness.state .workspacePrincipals, pr.get "id" = some "p1" ∧
    pr.get "revoked_at" = none :=
  resolved_principal_is_not_revoked _ ⟨"ada@example.com", "one", "owner"⟩ "p1" "owner" (by decide)

example : ∃ m ∈ Current.Witness.state .memberships,
    ∃ pr ∈ Current.Witness.state .workspacePrincipals,
      pr.get "id" = some "p1" ∧ pr.get "kind" = some "membership" ∧
        pr.get "membership_id" = m.get "id" :=
  resolved_principal_is_a_membership_principal _ ⟨"ada@example.com", "one", "owner"⟩ "p1" "owner"
    (by decide)

end AgentWorkspace.Theorems.Normative.ErSynthesis

