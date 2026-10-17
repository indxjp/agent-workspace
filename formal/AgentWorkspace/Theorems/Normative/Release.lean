import AgentWorkspace.Concepts.Release

/-!
# T1 — production runs only a version that passed the gate (issue #614)

With a bar set, `promote … production` succeeds only when the version the source environment
points at has a recorded score at or above the bar, and a version with no score is refused. With no
bar set, promotion needs no evaluation.
-/

namespace AgentWorkspace.Theorems.Normative.Release

open AgentWorkspace AgentWorkspace.Concepts.Release

/-- With a bar set, `promote … production` succeeds only if the promoted version's score is at least
the bar; a version with no score is refused. -/
@[aw_spec (tier := T1) (doc := "docs/formal/domains/release.md#the-release-model")
  (ts := "apps/web/server/agent-versions/release.ts#decidePromote")]
theorem promote_requires_gate (b : Score) (r r' : Release) (a : AgentId) (src : Env)
    (h : step (some b) r (.promote a src .production) = .ok r') :
    ∃ v s, r.pointer a src = some v ∧ r.evals a v = some s ∧ b ≤ s := by
  simp only [step] at h
  split at h; · cases h
  rename_i v hp
  split at h; · cases h
  rename_i hg
  cases he : r.evals a v with
  | none => simp [he, gateFor, gate] at hg
  | some s =>
    refine ⟨v, s, hp, he, ?_⟩
    by_cases hbs : b ≤ s
    · exact hbs
    · simp [he, gateFor, gate, hbs] at hg

/-- With no bar set, promotion needs no evaluation: whenever the source environment points at a
version, promoting it to any environment succeeds and moves the target's pointer to it. -/
@[aw_spec (tier := T1) (doc := "docs/formal/domains/release.md#the-release-model")
  (ts := "apps/web/server/agent-versions/release.ts#decidePromote")]
theorem promote_without_a_bar_needs_no_evaluation (r : Release) (a : AgentId) (src dst : Env)
    (v : VersionNo) (hp : r.pointer a src = some v) :
    step none r (.promote a src dst) = .ok (r.movePointer a dst v) := by
  simp [step, hp, gateFor, gate]

end AgentWorkspace.Theorems.Normative.Release
