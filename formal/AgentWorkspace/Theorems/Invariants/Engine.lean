import AgentWorkspace.Concepts.Engine

namespace AgentWorkspace.Theorems.Invariants.Engine

open AgentWorkspace AgentWorkspace.Concepts.Engine

/-- A session is well formed when every run it holds carries the engine it is pinned to. -/
private def Pinned (s : SessionRuns) : Prop := ∀ r ∈ s.runs, r.engine = s.pinned

private theorem launch_preserves {s s' : SessionRuns} {e : Engine}
    (h : s.launch e = some s') : s'.pinned = s.pinned ∧ (Pinned s → Pinned s') := by
  unfold SessionRuns.launch at h
  split at h
  · next heq =>
    injection h with h
    subst h
    refine ⟨rfl, ?_⟩
    intro hp r hr
    simp only [List.mem_append, List.mem_cons, List.not_mem_nil, or_false] at hr
    rcases hr with hr | hr
    · exact hp r hr
    · subst hr; exact heq
  · simp at h

private theorem launchAll_preserves {reqs : List Engine} :
    ∀ {s s' : SessionRuns}, SessionRuns.launchAll s reqs = some s' →
      s'.pinned = s.pinned ∧ (Pinned s → Pinned s') := by
  induction reqs with
  | nil =>
    intro s s' h
    have h' : some s = some s' := h
    injection h' with h'
    subst h'
    exact ⟨rfl, id⟩
  | cons e rest ih =>
    intro s s' h
    have h2 : (s.launch e).bind (fun x => SessionRuns.launchAll x rest) = some s' := h
    cases hl : s.launch e with
    | none =>
      rw [hl] at h2
      simp at h2
    | some t =>
      rw [hl] at h2
      have h3 : SessionRuns.launchAll t rest = some s' := h2
      have hi := ih h3
      have hp := launch_preserves hl
      exact ⟨hi.1.trans hp.1, fun hw => hi.2 (hp.2 hw)⟩

/-- Every run reachable in a session pinned to an engine carries that engine: a launch for a
different engine is refused (`409 session_engine_mismatch`) rather than re-pinning the session. -/
@[aw_spec (tier := T2)
  (doc := "docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md#d8--a-session-is-pinned-to-one-engine")]
theorem every_run_of_a_session_carries_the_session_engine
    (e : Engine) (requests : List Engine) (s : SessionRuns)
    (h : SessionRuns.launchAll (SessionRuns.pin e) requests = some s) :
    s.pinned = e ∧ ∀ r ∈ s.runs, r.engine = e := by
  have hp := launchAll_preserves h
  have hpinned : s.pinned = e := hp.1
  refine ⟨hpinned, ?_⟩
  have hwf : Pinned s := hp.2 (by intro r hr; simp [SessionRuns.pin] at hr)
  intro r hr
  rw [hwf r hr, hpinned]

/-- Witness: three runs on the pinned engine all land, in order. -/
example :
    SessionRuns.launchAll (SessionRuns.pin .claudeAgentSdk)
        [.claudeAgentSdk, .claudeAgentSdk, .claudeAgentSdk]
      = some ⟨.claudeAgentSdk, [⟨.claudeAgentSdk⟩, ⟨.claudeAgentSdk⟩, ⟨.claudeAgentSdk⟩]⟩ := by
  decide +kernel

/-- Witness: a request for another engine refuses rather than re-pinning the session. -/
example :
    SessionRuns.launchAll (SessionRuns.pin .claudeAgentSdk) [.claudeAgentSdk, .pi] = none := by
  decide +kernel

end AgentWorkspace.Theorems.Invariants.Engine
