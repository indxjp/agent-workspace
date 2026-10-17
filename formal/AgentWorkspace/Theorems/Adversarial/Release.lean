import AgentWorkspace.Concepts.Release

/-!
# T3 — concurrent writers cannot move a running conversation or skip a version (issue #614)

* **A started conversation keeps its version.** Whatever `push`, `point`, `promote`, `rollback`,
  `recordEval` or a second `startSession` another writer runs, a conversation finishes on the
  version it started on. It is the engine-pinning shape of
  `Invariants.BehaviourEngines.a_run_never_repins_the_session`, applied to versions.
* **Every content change is a version.** A UI edit is a `push`, so it adds exactly one version;
  every other operation adds none.
-/

namespace AgentWorkspace.Theorems.Adversarial.Release

open AgentWorkspace AgentWorkspace.Concepts.Release

/-- No step changes the version of a started conversation: not `push`, `point`, `promote` or
`rollback`, and not a second `startSession` for the same conversation. -/
@[aw_spec (tier := T3) (doc := "docs/formal/domains/release.md#the-release-model")
  (ts := "apps/web/server/agent-versions/session-version.ts#resolveSessionVersion")]
theorem session_version_stable (t : Option Score) (r r' : Release) (op : Op)
    (h : step t r op = .ok r') (s : SessionId) (pin : AgentId × VersionNo)
    (hs : r.sessions s = some pin) :
    r'.sessions s = some pin := by
  cases op with
  | push b body => simp only [step, Except.ok.injEq] at h; subst h; exact hs
  | point b e v =>
    simp only [step] at h
    split at h; · cases h
    split at h; · cases h
    cases h; exact hs
  | promote b src dst =>
    simp only [step] at h
    split at h; · cases h
    split at h; · cases h
    cases h; exact hs
  | rollback b e =>
    simp only [step] at h
    split at h
    · cases h; exact hs
    · cases h
  | startSession u b e =>
    simp only [step] at h
    split at h; · cases h
    rename_i hu
    split at h; · cases h
    cases h
    by_cases hsu : s = u
    · subst hsu; simp [hs] at hu
    · simp [hsu, hs]
  | recordEval b v score =>
    simp only [step] at h
    split at h; · cases h
    cases h; exact hs

/-- Every content-changing operation adds exactly one version, and every other operation adds
none: a UI edit is a `push`, so it is a version. -/
@[aw_spec (tier := T3) (doc := "docs/formal/domains/release.md#the-release-model")]
theorem ui_edit_is_a_version (t : Option Score) (r r' : Release) (op : Op)
    (h : step t r op = .ok r') (a : AgentId) :
    (r'.versions a).length = (r.versions a).length + if op.addsVersionTo a then 1 else 0 := by
  cases op with
  | push b body =>
    simp only [step, Except.ok.injEq] at h; subst h
    by_cases hb : a = b
    · subst hb; simp [Op.addsVersionTo]
    · simp [Op.addsVersionTo, hb, Ne.symm hb]
  | point b e v =>
    simp only [step] at h
    split at h; · cases h
    split at h; · cases h
    cases h; simp [Op.addsVersionTo, Release.movePointer]
  | promote b src dst =>
    simp only [step] at h
    split at h; · cases h
    split at h; · cases h
    cases h; simp [Op.addsVersionTo, Release.movePointer]
  | rollback b e =>
    simp only [step] at h
    split at h
    · cases h; simp [Op.addsVersionTo, Release.dropPointer]
    · cases h
  | startSession u b e =>
    simp only [step] at h
    split at h; · cases h
    split at h; · cases h
    cases h; simp [Op.addsVersionTo]
  | recordEval b v score =>
    simp only [step] at h
    split at h; · cases h
    cases h; simp [Op.addsVersionTo]

end AgentWorkspace.Theorems.Adversarial.Release
