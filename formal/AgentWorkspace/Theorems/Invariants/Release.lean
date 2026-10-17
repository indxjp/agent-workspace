import AgentWorkspace.Concepts.Release

/-!
# T2 — the release state machine keeps its history (issue #614)

* **Append-only.** No step deletes or changes a saved version.
* **Pointers name versions.** Every pointer, and every entry of its history, names a saved version
  of the same agent.
* **Rollback is one step back.** It takes the pointer off the history so the previous entry is the
  pointer, so promote then rollback leaves the pointer where it was and a second rollback steps
  back again rather than forward (BH061-004).
-/

namespace AgentWorkspace.Theorems.Invariants.Release

open AgentWorkspace AgentWorkspace.Concepts.Release

private theorem movePointer_versions (r : Release) (a : AgentId) (e : Env) (v : VersionNo) :
    (r.movePointer a e v).versions = r.versions := rfl

private theorem movePointer_history (r : Release) (a b : AgentId) (e f : Env) (v : VersionNo) :
    (r.movePointer a e v).history b f
      = if b = a ∧ f = e then v :: r.history b f else r.history b f := rfl

private theorem dropPointer_history (r : Release) (a b : AgentId) (e f : Env) :
    (r.dropPointer a e).history b f
      = if b = a ∧ f = e then (r.history b f).tail else r.history b f := rfl

/-- Only `push` touches the versions, and it appends one to its own agent. -/
private theorem step_versions (t : Option Score) (r r' : Release) (op : Op)
    (h : step t r op = .ok r') (a : AgentId) :
    r'.versions a = r.versions a ∨
      ∃ body, op = .push a body ∧ r'.versions a = r.versions a ++ [⟨(r.versions a).length + 1, body⟩] := by
  cases op with
  | push b body =>
    simp only [step, Except.ok.injEq] at h; subst h
    by_cases hb : a = b
    · subst hb; exact .inr ⟨body, rfl, by simp⟩
    · exact .inl (by simp [hb])
  | point b e v =>
    simp only [step] at h
    split at h; · cases h
    split at h; · cases h
    cases h; exact .inl rfl
  | promote b s d =>
    simp only [step] at h
    split at h; · cases h
    split at h; · cases h
    cases h; exact .inl rfl
  | rollback b e =>
    simp only [step] at h
    split at h
    · cases h; exact .inl rfl
    · cases h
  | startSession s b e =>
    simp only [step] at h
    split at h; · cases h
    split at h; · cases h
    cases h; exact .inl rfl
  | recordEval b v score =>
    simp only [step] at h
    split at h; · cases h
    cases h; exact .inl rfl

/-- No step deletes or changes a saved version: every agent's versions before a step are a prefix
of its versions after it. -/
@[aw_spec (tier := T2) (doc := "docs/formal/domains/release.md#the-release-model")]
theorem versions_append_only (t : Option Score) (r r' : Release) (op : Op)
    (h : step t r op = .ok r') (a : AgentId) :
    r.versions a <+: r'.versions a := by
  rcases step_versions t r r' op h a with hv | ⟨_, _, hv⟩
  · rw [hv]; exact List.prefix_refl _
  · rw [hv]; exact List.prefix_append _ _

private theorem hasVersion_mono (t : Option Score) (r r' : Release) (op : Op)
    (h : step t r op = .ok r') (a : AgentId) (v : VersionNo) :
    r.hasVersion a v = true → r'.hasVersion a v = true := by
  intro hv
  obtain ⟨l, hl⟩ := versions_append_only t r r' op h a
  rw [Release.hasVersion] at hv
  rw [Release.hasVersion, ← hl, List.any_append, hv, Bool.true_or]

/-- Every environment points at a version that exists, for the same agent: a step from a
well-formed state (every history entry names a saved version) reaches a well-formed state, so every
pointer it leaves names a saved version. -/
@[aw_spec (tier := T2) (doc := "docs/formal/domains/release.md#the-release-model")]
theorem pointer_targets_existing_version (t : Option Score) (r r' : Release) (op : Op)
    (hw : r.WellFormed) (h : step t r op = .ok r') :
    r'.WellFormed ∧ ∀ a e v, r'.pointer a e = some v → r'.hasVersion a v = true := by
  have hmono := hasVersion_mono t r r' op h
  have wf : r'.WellFormed := by
    intro a e v hmem
    cases op with
    | push b body =>
      simp only [step, Except.ok.injEq] at h; subst h
      exact hmono a v (hw a e v hmem)
    | point b f w =>
      simp only [step] at h
      split at h; · cases h
      rename_i hb
      split at h; · cases h
      cases h
      rw [movePointer_history] at hmem
      split at hmem
      · rename_i hab
        obtain ⟨rfl, rfl⟩ := hab
        rcases List.mem_cons.mp hmem with rfl | hmem
        · have hb' : r.hasVersion a v = true := by simpa using hb
          exact hb'
        · exact hw _ _ _ hmem
      · exact hw a e v hmem
    | promote b s d =>
      simp only [step] at h
      split at h; · cases h
      rename_i w hp
      split at h; · cases h
      cases h
      rw [movePointer_history] at hmem
      split at hmem
      · rename_i hab
        obtain ⟨rfl, rfl⟩ := hab
        rcases List.mem_cons.mp hmem with rfl | hmem
        · exact hw a s v (List.mem_of_mem_head? hp)
        · exact hw _ _ _ hmem
      · exact hw a e v hmem
    | rollback b f =>
      simp only [step] at h
      split at h
      · cases h
        rw [dropPointer_history] at hmem
        split at hmem
        · exact hw a e v (List.mem_of_mem_tail hmem)
        · exact hw a e v hmem
      · cases h
    | startSession s b f =>
      simp only [step] at h
      split at h; · cases h
      split at h; · cases h
      cases h; exact hw a e v hmem
    | recordEval b w score =>
      simp only [step] at h
      split at h; · cases h
      cases h; exact hw a e v hmem
  exact ⟨wf, fun a e v hp => wf a e v (List.mem_of_mem_head? hp)⟩

/-- After `rollback`, the pointer equals the second entry of the history before the step, and the
version it left comes off the history, so a second rollback steps further back (BH061-004). -/
@[aw_spec (tier := T2) (doc := "docs/formal/domains/release.md#the-release-model")
  (ts := "apps/web/server/agent-versions/release.ts#decideRollback")]
theorem rollback_restores_previous (t : Option Score) (r r' : Release) (a : AgentId) (e : Env)
    (h : step t r (.rollback a e) = .ok r') :
    ∃ cur prev rest, r.history a e = cur :: prev :: rest ∧
      r'.pointer a e = some prev ∧ r'.history a e = prev :: rest := by
  simp only [step] at h
  split at h
  · rename_i cur prev rest hh
    cases h
    exact ⟨cur, prev, rest, hh, by simp [Release.pointer, dropPointer_history, hh],
      by simp [dropPointer_history, hh]⟩
  · cases h

/-- Promote then rollback leaves the pointer where it was, whenever the target environment already
pointed somewhere. -/
@[aw_spec (tier := T2) (doc := "docs/formal/domains/release.md#the-release-model")
  (ts := "apps/web/server/agent-versions/release.ts#decidePromote") (ts := "apps/web/server/agent-versions/release.ts#decideRollback")]
theorem rollback_after_promote_is_identity (t : Option Score) (r r₁ : Release) (a : AgentId)
    (src dst : Env) (h : step t r (.promote a src dst) = .ok r₁) (hp : (r.pointer a dst).isSome) :
    ∃ r₂, step t r₁ (.rollback a dst) = .ok r₂ ∧ r₂.pointer a dst = r.pointer a dst := by
  simp only [step] at h
  split at h; · cases h
  rename_i v _
  split at h; · cases h
  cases h
  cases hd : r.history a dst with
  | nil => simp [Release.pointer, hd] at hp
  | cons p rest =>
    refine ⟨(r.movePointer a dst v).dropPointer a dst, ?_, ?_⟩
    · simp [step, movePointer_history, hd]
    · simp [Release.pointer, dropPointer_history, movePointer_history, hd]

/-- The empty state is well formed, so `pointer_targets_existing_version` holds of every state a
sequence of steps reaches from it. The `release` vectors witness the other hypotheses. -/
example : Release.empty.WellFormed := by intro _ _ _ h; simp [Release.empty] at h

end AgentWorkspace.Theorems.Invariants.Release
