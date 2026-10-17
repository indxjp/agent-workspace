import AgentWorkspace.Behaviour.RunCompose
import AgentWorkspace.Theorems.Invariants.PolicyCeiling

/-!
# T3 — a composed run never exceeds the ceiling (S2-04c, ADR-0102 SD6, C14, C16)

Whatever a run's stored state is — an agent saved before the ceiling was lowered, a null limit, a
connector the ceiling no longer lists — `composeWithCeiling` either refuses it or composes a
configuration the ceiling no longer objects to. The refusal is only ever for an engine or a
resolved model, which the meet cannot narrow (`meet_le_ceiling`), and it names them.
-/

namespace AgentWorkspace.Theorems.Adversarial.PolicyCeiling

open AgentWorkspace.Behaviour.RunCompose AgentWorkspace.Concepts.PolicyCeiling
  AgentWorkspace.Theorems.Invariants.PolicyCeiling

/-- Any stored state composes at or under the ceiling: an `ok` run has no widening left. -/
@[aw_spec (tier := T3)
  (doc := "docs/adr/0102-content-owners-edit-engineers-build-admins-narrow-stop-and-approve.md#slice-2-acceptance")
  (ts := "apps/web/server/compose/run-request.ts#meetRunCeiling")]
theorem composed_run_le_ceiling_for_any_stored_state (s : StoredRun) (c : Option Ceiling)
    (e : Config) (h : composeWithCeiling s c = .ok e) : violations e c = [] := by
  unfold composeWithCeiling at h
  split at h
  · rename_i hv
    cases h
    exact hv
  · cases h

/-- A refusal names only the engine and the model, exactly as `meet_le_ceiling` leaves them. -/
@[aw_spec (tier := T3)
  (ts := "apps/web/server/compose/run-request.ts#meetRunCeiling")
  (ts := "packages/contracts/src/policy-ceiling.ts#policyWidenings")]
theorem composed_run_refuses_only_engine_or_model (s : StoredRun) (c : Option Ceiling)
    (ds : List String) (h : composeWithCeiling s c = .refused ds) :
    ds = ((widenings s.config c).filter Widening.fixed).map Widening.wire := by
  unfold composeWithCeiling at h
  split at h
  · cases h
  · cases h
    exact meet_le_ceiling _ _

private theorem refused_of_mem (s : StoredRun) (c : Option Ceiling) (d : String)
    (h : d ∈ violations (meet s.config c) c) :
    ∃ ds, composeWithCeiling s c = .refused ds ∧ d ∈ ds := by
  unfold composeWithCeiling
  split
  · rename_i hv
    simp [hv] at h
  · exact ⟨_, rfl, h⟩

/-- A stored engine the ceiling does not list is refused, and the refusal names it. -/
@[aw_spec (tier := T3)
  (doc := "docs/adr/0102-content-owners-edit-engineers-build-admins-narrow-stop-and-approve.md#slice-2-acceptance")
  (ts := "apps/web/server/compose/run-request.ts#meetRunCeiling")
  (ts := "apps/web/server/compose/run-preflight.ts#createRunPreflight")]
theorem composed_run_refuses_engine_outside (s : StoredRun) (c : Ceiling) (es : List String)
    (hes : c.engines = some es) (hout : s.engine ∉ es) :
    ∃ ds, composeWithCeiling s (some c) = .refused ds ∧ ("engine:" ++ s.engine) ∈ ds := by
  apply refused_of_mem
  simp [violations, widenings, meet, StoredRun.config, hes, hout, Widening.wire]

/-- A model the S1-23 ladder resolves outside the ceiling is refused, and the refusal names it. -/
@[aw_spec (tier := T3)
  (doc := "docs/adr/0102-content-owners-edit-engineers-build-admins-narrow-stop-and-approve.md#slice-2-acceptance")
  (ts := "apps/web/server/compose/run-request.ts#meetRunCeiling")
  (ts := "apps/web/server/compose/run-preflight.ts#createRunPreflight")]
theorem composed_run_refuses_resolved_model_outside (s : StoredRun) (c : Ceiling) (m : String)
    (ms : List String) (hm : s.model = some m) (hms : c.models = some ms) (hout : m ∉ ms) :
    ∃ ds, composeWithCeiling s (some c) = .refused ds ∧ ("model:" ++ m) ∈ ds := by
  apply refused_of_mem
  simp [violations, widenings, meet, StoredRun.config, hm, hms, hout, Widening.wire]

/-- Every connector a composed run keeps is one the ceiling's `tools` lists (C16: the snapshot
records only these). -/
@[aw_spec (tier := T3)
  (doc := "docs/adr/0102-content-owners-edit-engineers-build-admins-narrow-stop-and-approve.md#slice-2-acceptance")
  (ts := "apps/web/server/compose/run-request.ts#buildRunRequestFor")]
theorem composed_tools_subset_ceiling (s : StoredRun) (c : Ceiling) (ts : List String)
    (e : Config) (hts : c.tools = some ts) (h : composeWithCeiling s (some c) = .ok e) :
    ∀ t ∈ e.tools, t ∈ ts := by
  intro t ht
  unfold composeWithCeiling at h
  split at h
  · cases h
    simp only [meet, hts] at ht
    simpa using (List.mem_filter.mp ht).2
  · cases h

end AgentWorkspace.Theorems.Adversarial.PolicyCeiling
