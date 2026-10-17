import AgentWorkspace.Theorems.Normative.PolicyCeiling
import AgentWorkspace.Theorems.Invariants.EngineSwitch

/-!
# T2 — the meet never widens (ADR-0102 SD6, C14)

* **At the ceiling.** After `meetPolicyCeiling`, the only widenings left are the engine and the
  model, which the meet cannot narrow and the caller refuses.
* **Below the input.** The meet asks for no more than the configuration it was given.
* **Monotone.** A tighter ceiling meets to a configuration no wider than a looser one's.
* **After an engine switch.** The narrowing an engine switch carries, met with the ceiling, keeps
  every capped switch off, and the OpenAI Agents tool plan under it still offers only tools the
  old Claude arm allowed.
-/

namespace AgentWorkspace.Theorems.Invariants.PolicyCeiling

open AgentWorkspace.Concepts.Agent AgentWorkspace.Concepts.PolicyCeiling
  AgentWorkspace.Theorems.Normative.PolicyCeiling

private theorem exceeds_capped (v cap : Option Nat) : exceeds (capped v cap) cap = false := by
  cases v <;> cases cap <;> simp [capped, exceeds, Nat.not_lt, Nat.min_le_right]

private theorem limitLe_refl (v : Option Nat) : limitLe v v := by
  cases v <;> simp [limitLe]

private theorem capped_le_input (v cap : Option Nat) : limitLe (capped v cap) v := by
  cases v <;> cases cap <;> simp [capped, limitLe, Nat.min_le_left]

private theorem capped_monotone (v : Option Nat) {a b : Option Nat} (h : limitLe a b) :
    limitLe (capped v a) (capped v b) := by
  cases v <;> cases a <;> cases b <;> simp_all [capped, limitLe] <;> omega

private theorem filter_sublist_filter {p q : String → Bool} (h : ∀ a, p a = true → q a = true) :
    ∀ l : List String, (l.filter p).Sublist (l.filter q)
  | [] => by simp
  | x :: xs => by
    have ih := filter_sublist_filter h xs
    cases hp : p x
    · cases hq : q x
      · simpa [List.filter_cons, hp, hq] using ih
      · simpa [List.filter_cons, hp, hq] using ih.cons x
    · simpa [List.filter_cons, hp, h x hp] using ih

private theorem tools_met_within (tl ts : List String) :
    (sortedDistinct (tl.filter ts.contains)).filter (fun t => !decide (t ∈ ts)) = [] := by
  simp only [List.filter_eq_nil_iff]
  intro t ht
  have := List.mem_filter.mp (mem_sortedDistinct.mp ht)
  simpa using this.2

private theorem filter_none (l : List String) : l.filter (fun _ => false) = [] := by
  simp [List.filter_eq_nil_iff]

private theorem filter_fixed_maxTurns (b : Bool) :
    (if b = true then [Widening.maxTurns] else []).filter Widening.fixed = [] := by
  cases b <;> simp [Widening.fixed]

private theorem filter_fixed_maxBudget (b : Bool) :
    (if b = true then [Widening.maxBudget] else []).filter Widening.fixed = [] := by
  cases b <;> simp [Widening.fixed]

/-- After the meet, the only widenings left are the engine and the model — exactly those of the
input, which the meet cannot narrow and the caller refuses instead. -/
@[aw_spec (tier := T2)
  (doc := "docs/adr/0102-content-owners-edit-engineers-build-admins-narrow-stop-and-approve.md#slice-2-acceptance")
  (ts := "packages/contracts/src/policy-ceiling.ts#meetPolicyCeiling")
  (ts := "packages/contracts/src/policy-ceiling.ts#policyWidenings")]
theorem meet_le_ceiling (e : Config) (c : Option Ceiling) :
    violations (meet e c) c = ((widenings e c).filter Widening.fixed).map Widening.wire := by
  cases c with
  | none => simp [violations, widenings]
  | some c =>
    obtain ⟨⟨r, w, x, n⟩, mt, mb, en, mo, tl⟩ := e
    obtain ⟨caps, cmt, cmb, ces, cms, cts, _⟩ := c
    cases ces <;> cases mo <;> cases cms <;> cases cts <;>
      simp [violations, widenings, meet, permissionKeys, perm, exceeds_capped,
        List.filter_append, List.filter_map, Function.comp_def, Widening.fixed,
        filter_fixed_maxTurns, filter_fixed_maxBudget, tools_met_within, filter_none] <;>
      (try split) <;> (try split) <;> simp [Widening.fixed, List.filter_cons]

/-- The meet asks for no more than the configuration it was given. -/
@[aw_spec (tier := T2)
  (doc := "docs/adr/0102-content-owners-edit-engineers-build-admins-narrow-stop-and-approve.md#slice-2-acceptance")
  (ts := "packages/contracts/src/policy-ceiling.ts#meetPolicyCeiling")]
theorem meet_le_input (e : Config) (c : Option Ceiling) : (meet e c).le e := by
  cases c with
  | none => exact ⟨fun _ h => h, limitLe_refl _, limitLe_refl _, List.Sublist.refl _, rfl, rfl⟩
  | some c =>
    refine ⟨?_, capped_le_input _ _, capped_le_input _ _, ?_, rfl, rfl⟩
    · intro k hk
      simp only [meet, perm] at hk ⊢
      split at hk <;> simp_all
    · simp only [meet]
      split
      · exact List.filter_sublist
      · exact List.Sublist.refl _

/-- A tighter ceiling meets to a configuration no wider than a looser ceiling's. -/
@[aw_spec (tier := T2)
  (doc := "docs/adr/0102-content-owners-edit-engineers-build-admins-narrow-stop-and-approve.md#slice-2-acceptance")
  (ts := "packages/contracts/src/policy-ceiling.ts#meetPolicyCeiling")]
theorem meet_monotone_in_ceiling (e : Config) (c₁ c₂ : Ceiling) (h : c₁.le c₂) :
    (meet e (some c₁)).le (meet e (some c₂)) := by
  obtain ⟨hcaps, hmt, hmb, -, -, htools, -⟩ := h
  refine ⟨?_, capped_monotone _ hmt, capped_monotone _ hmb, ?_, rfl, rfl⟩
  · intro k hk
    simp only [meet, perm] at hk ⊢
    split at hk <;> simp_all <;> intro hc <;> exact hk.2 (hcaps _ hc)
  · simp only [meet]
    revert htools
    cases c₁.tools <;> cases c₂.tools <;> simp [allowLe]
    · intro hsub
      exact filter_sublist_filter (fun a ha => by simpa using hsub a (by simpa using ha)) _

open AgentWorkspace.Behaviour.Engines.OpenAiAgents AgentWorkspace.Behaviour.Engines.EngineSwitch
  AgentWorkspace.Theorems.Invariants.EngineSwitch

/-- §17 Step 4's switches, as the agent row stores them. -/
def toAgentPermissions (p : AgentWorkspace.Behaviour.Engines.OpenAiAgents.Permissions) :
    AgentWorkspace.Concepts.Agent.Permissions :=
  ⟨p.readFiles, p.writeFiles, p.runCommands, p.unrestrictedNetwork⟩

/-- §17 Step 4's switches, as the OpenAI Agents adapter reads them. -/
def ofAgentPermissions (p : AgentWorkspace.Concepts.Agent.Permissions) :
    AgentWorkspace.Behaviour.Engines.OpenAiAgents.Permissions :=
  ⟨p.readFiles, p.writeFiles, p.runCommands, p.unrestrictedNetwork⟩

/-- An engine switch, then the ceiling: when the permissions are the switch's narrowing, the meet
keeps every switch the ceiling caps off, and every tool the OpenAI Agents adapter offers under the
met permissions is one the old Claude arm allowed (`the_switch_never_widens_the_tool_plan`). -/
@[aw_spec (tier := T2)
  (doc := "docs/adr/0102-content-owners-edit-engineers-build-admins-narrow-stop-and-approve.md#slice-2-acceptance")
  (ts := "packages/contracts/src/policy-ceiling.ts#meetPolicyCeiling")
  (ts := "packages/contracts/src/agents.ts#translatePolicyForEngineSwitch")
  (ts := "packages/contracts/src/agents.ts#policyNarrowedPermissions")]
theorem switch_then_meet_le_ceiling (a : ClaudeArm) (existing w : List Key)
    (p : AgentWorkspace.Behaviour.Engines.OpenAiAgents.Permissions) (hasReadOnlyGrant : Bool)
    (e : Config) (c : Ceiling) (h : translate a existing = .ok w)
    (he : e.permissions = toAgentPermissions (narrow p w)) :
    (∀ k ∈ c.caps, perm (meet e (some c)).permissions k = false) ∧
    ∀ t ∈ toolPlan (ofAgentPermissions (meet e (some c)).permissions) hasReadOnlyGrant,
      claudeAllowsTool p a t = true := by
  constructor
  · intro k hk
    simp only [meet, perm]
    split <;> simp_all
  · intro t ht
    apply the_switch_never_widens_the_tool_plan a existing w p hasReadOnlyGrant t h
    simp only [toolPlan, List.mem_filter, Bool.and_eq_true] at ht ⊢
    refine ⟨ht.1, ?_, ht.2.2⟩
    have hp := ht.2.1
    cases t <;> simp_all [Tool.permitted, meet, ofAgentPermissions, toAgentPermissions]

end AgentWorkspace.Theorems.Invariants.PolicyCeiling
