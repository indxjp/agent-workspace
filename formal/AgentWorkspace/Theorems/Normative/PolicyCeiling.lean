import AgentWorkspace.Concepts.PolicyCeiling

/-!
# T1 — a ceiling refuses exactly what it does not allow (ADR-0102 SD6, C14)

* **Refuse iff outside.** `policyWidenings` is empty exactly when every field is within the
  ceiling, so a write is refused `403 policy_cannot_widen` exactly when it would widen.
* **The details are canonical.** Each field is named at most once, in C14's fixed key order, so
  the dry run and the save, and every write path, give the same `details`.
-/

namespace AgentWorkspace.Theorems.Normative.PolicyCeiling

open AgentWorkspace AgentWorkspace.Concepts.Agent AgentWorkspace.Concepts.PolicyCeiling

private theorem bool_imp_not (b : Bool) (q : Prop) : (b = true → ¬q) ↔ (b = false ∨ ¬q) := by
  cases b <;> simp

/-- A write is refused exactly when it would widen: `policyWidenings` is empty if and only if every
field of the configuration is within the ceiling. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0102-content-owners-edit-engineers-build-admins-narrow-stop-and-approve.md#slice-2-acceptance")
  (ts := "packages/contracts/src/policy-ceiling.ts#policyWidenings")]
theorem policy_cannot_widen_iff_within (e : Config) (c : Option Ceiling) :
    violations e c = [] ↔ within e c = true := by
  cases c with
  | none => simp [violations, widenings, within]
  | some c =>
    obtain ⟨p, mt, mb, en, mo, tl⟩ := e
    obtain ⟨caps, cmt, cmb, ces, cms, cts, _⟩ := c
    cases ces <;> cases mo <;> cases cms <;> cases cts <;>
      simp [violations, widenings, within, List.filter_eq_nil_iff, List.all_eq_true,
        mem_sortedDistinct, and_assoc, bool_imp_not]

/-- The details name each field once, in C14's key order: the list has no repeats and is a
sublist of the canonical order (permissions in `AGENT_PERMISSION_KEYS` order, the two limits, the
engine, the model, then the distinct tools ascending). -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0102-content-owners-edit-engineers-build-admins-narrow-stop-and-approve.md#slice-2-acceptance")
  (ts := "packages/contracts/src/policy-ceiling.ts#policyWidenings")]
theorem violations_name_each_field_once_in_key_order (e : Config) (c : Option Ceiling) :
    (violations e c).Nodup ∧ (violations e c).Sublist (keyOrder e) := by
  have hs : (violations e c).Sublist (keyOrder e) :=
    (widenings_sublist_keyOrder e c).map Widening.wire
  exact ⟨hs.nodup (List.Pairwise.map _ (fun _ _ hab h => hab (wire_injective h))
    (nodup_keyOrderEntries e)), hs⟩

end AgentWorkspace.Theorems.Normative.PolicyCeiling
