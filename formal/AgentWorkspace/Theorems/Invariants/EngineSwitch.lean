import AgentWorkspace.Behaviour.Engines.EngineSwitch

/-!
# T2 — an engine switch never widens (ADR-0074 D12, PR #339)

* **The tool plan.** Whatever `openai-agents` arm the translation produces, the OpenAI Agents
  adapter's tool plan under the narrowed permissions offers only tools whose capability the old
  Claude arm allowed — for every permission set and every read-only-grant state.
* **The refusals.** A translation succeeds exactly when no denial is untranslatable, so an MCP
  denial is never dropped: it is either absent from the old arm or the switch is refused naming it.
* **The network switch** is never widened by the narrowing.
* **The reverse half** denies every Claude tool of every withheld switch.
-/

namespace AgentWorkspace.Theorems.Invariants.EngineSwitch

open AgentWorkspace.Behaviour.Engines.OpenAiAgents AgentWorkspace.Behaviour.Engines.EngineSwitch

/-- A tool whose switch is on after narrowing had it on before, and its key is not withheld. -/
private theorem permitted_narrow {p : Permissions} {w : List Key} {t : Tool}
    (h : t.permitted (narrow p w) = true) : t.permitted p = true ∧ w.contains (toolKey t) = false := by
  cases t <;> simp_all [Tool.permitted, narrow, toolKey]

/-- Every governed key the old arm does not allow is in the translated list. -/
private theorem withheld_in_result {a : ClaudeArm} {existing w : List Key} {t : Tool}
    (h : translate a existing = .ok w) (hk : keyAllowed a (toolKey t) = false) :
    w.contains (toolKey t) = true := by
  unfold translate at h
  split at h
  · cases h
    have hg : (toolKey t) ∈ governedKeys := by cases t <;> simp [toolKey, governedKeys]
    have hw : (toolKey t) ∈ withheldBy a := by simp [withheldBy, hg, hk]
    have ha : (toolKey t) ∈ Key.all := by cases h : (toolKey t) <;> simp [Key.all]
    simp [ha, hw]
  · cases h

/-- The switch never widens the tool plan: every tool the OpenAI Agents adapter offers under the
translated arm is one whose capability the old Claude arm allowed. -/
@[aw_spec (tier := T2) (doc := "docs/formal/units/engine-openai-agents.md#engine-switch")
  (ts := "packages/contracts/src/agents.ts#translatePolicyForEngineSwitch")
  (ts := "packages/contracts/src/agents.ts#policyNarrowedPermissions")
  (ts := "packages/engine-openai-agents/src/tools.ts#openAiAgentsToolPlan")]
theorem the_switch_never_widens_the_tool_plan (a : ClaudeArm) (existing w : List Key)
    (p : Permissions) (hasReadOnlyGrant : Bool) (t : Tool) (h : translate a existing = .ok w)
    (ht : t ∈ toolPlan (narrow p w) hasReadOnlyGrant) : claudeAllowsTool p a t = true := by
  have hp : t.permitted (narrow p w) = true := by
    simp only [toolPlan, List.mem_filter, Bool.and_eq_true] at ht
    exact ht.2.1
  obtain ⟨hperm, hnot⟩ := permitted_narrow hp
  cases hk : keyAllowed a (toolKey t)
  · have := withheld_in_result h hk
    simp_all
  · simp [claudeAllowsTool, hperm, hk]

/-- A translation succeeds exactly when no denial of the old arm is untranslatable, and a refusal
names exactly those denials — so an MCP or glob denial is never silently dropped. -/
@[aw_spec (tier := T2) (doc := "docs/formal/units/engine-openai-agents.md#engine-switch")
  (ts := "packages/contracts/src/agents.ts#translatePolicyForEngineSwitch")
  (ts := "apps/web/server/agents/policy.ts#carryEngineSwitch")]
theorem the_switch_refuses_exactly_what_it_cannot_express (a : ClaudeArm) (existing : List Key) :
    (∀ w, translate a existing = .ok w → ∀ r ∈ a.deny, untranslatableRule r = false) ∧
    (∀ names, translate a existing = .error names →
      names = untranslatable a ∧ names ≠ []) := by
  constructor
  · intro w h r hr
    unfold translate at h
    split at h
    · rename_i hempty
      cases hu : untranslatableRule r
      · rfl
      · have : r ∈ untranslatable a := by simp [untranslatable, hr, hu]
        simp_all [List.isEmpty_iff]
    · cases h
  · intro names h
    unfold translate at h
    split at h
    · cases h
    · rename_i hne
      cases h
      exact ⟨rfl, fun he => by simp_all⟩

/-- The narrowing never turns the network switch on. -/
@[aw_spec (tier := T2) (doc := "docs/formal/units/engine-openai-agents.md#engine-switch")
  (ts := "packages/contracts/src/agents.ts#policyNarrowedPermissions")]
theorem the_narrowing_never_opens_the_network (p : Permissions) (w : List Key) :
    (narrow p w).unrestrictedNetwork = true → p.unrestrictedNetwork = true := by
  simp [narrow]
  intro h _
  exact h

private theorem foldl_keeps (ks : List Key) (acc : List String) (n : String) (hn : n ∈ acc) :
    n ∈ ks.foldl (fun acc k => acc ++ (claudeTools k).filter fun m => !acc.contains m) acc := by
  induction ks generalizing acc with
  | nil => exact hn
  | cons k rest ih => exact ih _ (List.mem_append_left _ hn)

private theorem foldl_adds (ks : List Key) (acc : List String) (k : Key) (hk : k ∈ ks)
    (n : String) (hn : n ∈ claudeTools k) :
    n ∈ ks.foldl (fun acc k => acc ++ (claudeTools k).filter fun m => !acc.contains m) acc := by
  induction ks generalizing acc with
  | nil => cases hk
  | cons k' rest ih =>
    simp only [List.foldl_cons]
    rcases List.mem_cons.mp hk with rfl | hrest
    · apply foldl_keeps
      by_cases hin : n ∈ acc
      · exact List.mem_append_left _ hin
      · exact List.mem_append_right _ (by simp [hn, hin])
    · exact ih _ hrest

/-- The reverse switch denies every Claude tool of every switch the `openai-agents` arm withheld,
and keeps every denial the new body already had. -/
@[aw_spec (tier := T2) (doc := "docs/formal/units/engine-openai-agents.md#engine-switch")
  (ts := "packages/contracts/src/agents.ts#translatePolicyForEngineSwitch")]
theorem the_reverse_switch_denies_every_withheld_tool (withheld : List Key) (deny : List String) :
    (∀ k ∈ withheld, ∀ n ∈ claudeTools k, n ∈ reverseDeny withheld deny) ∧
    (∀ n ∈ deny, n ∈ reverseDeny withheld deny) := by
  constructor
  · intro k hk n hn
    have hall : k ∈ Key.all.filter withheld.contains := by
      simp only [List.mem_filter, List.elem_eq_mem, decide_eq_true_eq]
      exact ⟨by cases k <;> simp [Key.all], hk⟩
    exact foldl_adds _ deny k hall n hn
  · intro n hn
    exact foldl_keeps _ deny n hn

end AgentWorkspace.Theorems.Invariants.EngineSwitch
