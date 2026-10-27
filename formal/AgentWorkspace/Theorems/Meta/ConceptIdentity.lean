import AgentWorkspace.Er.Current.Identity

/-!
T5 — properties of the identity specification itself: where two of its sources disagree, or
where a definition admits what its documentation says it should not. Each theorem pins one
finding of `docs/formal/units/concept-identity.md`.
-/

namespace AgentWorkspace.Theorems.Meta.ConceptIdentity

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Er.Current.Identity
  AgentWorkspace.Concepts.Workspace AgentWorkspace.Concepts.Principal

/-- The contract bounds a workspace slug at 64 characters, but the database's slug check admits at
most 63: a 64-character slug passes `POST /api/workspaces`'s length bound and is refused by
`workspaces_slug_format`. -/
@[aw_spec (tier := T5) (ts := "packages/contracts/src/workspaces.ts#WORKSPACE_SLUG_MAX_LENGTH")
  (ts := "packages/core/src/db/schema/workspaces.ts#workspaces_slug_format")]
theorem slug_bound_is_off_by_one :
    (rep 64 'a').length ≤ slugMaxLengthContract ∧ slugFormat (rep 64 'a') = false ∧
      slugFormat (rep 63 'a') = true := by decide +kernel

/-- Every slug the database admits has at most 63 characters, one fewer than the contract's
bound. -/
@[aw_spec (tier := T5) (ts := "packages/core/src/db/schema/workspaces.ts#workspaces_slug_format")]
theorem admitted_slugs_are_shorter_than_the_contract_bound (s : String)
    (h : slugFormat s = true) : s.length < slugMaxLengthContract := by
  simp only [slugFormat, Bool.and_eq_true, decide_eq_true_eq] at h
  have := h.1.1.1.2
  simp only [String.length, slugMaxLengthContract]
  omega

example : ("acme".length < slugMaxLengthContract) :=
  admitted_slugs_are_shorter_than_the_contract_bound "acme" (by decide +kernel)

/-- The database's not-blank checks (`length(btrim(x)) > 0`) strip only spaces, so a name of tabs
or line feeds passes them, while the routes trim all whitespace before writing. -/
@[aw_spec (tier := T5) (ts := "packages/core/src/db/schema/workspaces.ts#workspaces_name_not_blank")
  (ts := "packages/core/src/db/schema/api-keys.ts#api_keys_name_not_blank")]
theorem blank_checks_admit_whitespace_other_than_spaces :
    notBlank "\t" = true ∧ notBlank "\n" = true ∧ notBlank "  " = false := by decide +kernel

/-- `Er/Core.lean`'s `principalSourceXor` passes every row whose `kind` is `NULL`, but SQL's
three-valued reading of `workspace_principals_source_xor` is `FALSE` on a row with no kind and no
source. The two agree on every row with a kind (`source_xor_refines_core`), and `kind` is
`NOT NULL`, so the difference is unreachable in a consistent state. -/
@[aw_spec (tier := T5)
  (ts := "packages/core/src/db/schema/workspace-principals.ts#workspace_principals_source_xor")]
theorem core_source_xor_differs_from_sql_at_null_kind :
    principalSourceXor ⟨[]⟩ = true ∧
      (CheckExpr.xor "kind" "membership" "membership_id" "api_key" "api_key_id").holds ⟨[]⟩ =
        false := by decide +kernel

/-- `Principal.fromDirectoryRecord` copies `userId` and `apiKeyId` without checking them against
the kind, so an incoherent record builds a frozen principal that `isPrincipal` then refuses. -/
@[aw_spec (tier := T5) (ts := "apps/web/server/rbac/principal.ts#fromDirectoryRecord")
  (ts := "apps/web/server/rbac/principal.ts#isPrincipal")]
theorem from_directory_record_accepts_an_incoherent_record :
    let r : DirectoryRecord := ⟨"p1", .apiKey, "w1", .owner, "CI", some "u1", some "k1", none⟩
    r.coherent = false ∧ (fromDirectoryRecord r).wellFormed = false := by decide +kernel

end AgentWorkspace.Theorems.Meta.ConceptIdentity
