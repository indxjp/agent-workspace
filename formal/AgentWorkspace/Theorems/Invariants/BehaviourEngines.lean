import AgentWorkspace.Behaviour.Engines

namespace AgentWorkspace.Theorems.Invariants.BehaviourEngines

open AgentWorkspace AgentWorkspace.Behaviour.Engines AgentWorkspace.Contracts.Engines

/-! # T2 — session engine pinning, on the real launch behaviour

ADR-0065 D8: a session stays on the engine it started with.
`Theorems/Invariants/Engine.lean` (ENG-01) proves that over the *abstract* session of
`Concepts/Engine.lean`, whose engine is pinned when the session is created. This file proves it over
the state the control plane really has — `sessions.engine` NULL until a run pins it, and the `runs`
rows — and so it can state the half the abstract model cannot: **no run row is created**.

The statements are about `Behaviour.Engines.startRun`, which is `apps/web/server/runs/api.ts`'s
`startRun` in the one dimension this unit decides. They quantify over every state and every pair of
engine ids, not over a chosen list, because the acceptance criterion is about "a run" and not about
one fixture.
-/

private def claude : String := EngineId.toWire EngineId.claudeAgentSdk

/-- A test-only registered engine. It exists here for the same reason `registerEngineForTests` does
(`apps/web/server/engines/registry.ts`): while `ENGINE_IDS` publishes one member, a refusal between
two engine ids cannot be exercised at all without a second id. -/
private def testOnly : String := "test-only-engine"

/-! ## The refusal -/

/-- A run whose agent's engine differs from `sessions.engine` is refused, and the state is
**unchanged**: no run row is created, not created-and-rolled-back. -/
@[aw_spec (tier := T2)
  (doc := "docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md#d8--a-session-is-pinned-to-one-engine")
  (ts := "apps/web/server/runs/api.ts#startRun")]
theorem session_engine_mismatch_creates_no_run (agentEngine : String) (s : LaunchState)
    (h : (startRun agentEngine s).1 = LaunchVerdict.engineMismatch) :
    (startRun agentEngine s).2 = s := by
  obtain ⟨sessionEngine, engineSessionId, runs⟩ := s
  cases sessionEngine with
  | none => simp [startRun] at h
  | some pinned =>
    by_cases hp : pinned = agentEngine
    · simp [startRun, hp] at h
    · simp [startRun, hp]

/-- The refusal happens **exactly** when the session is pinned to another engine: a session pinned to
the agent's own engine is never refused, and one pinned to any other engine always is. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/engines/session-engine.ts#pinSessionEngine")]
theorem session_engine_mismatch_is_exactly_a_different_pin
    (agentEngine pinned : String) (engineSessionId : Option String) (runs : List RunRow) :
    (startRun agentEngine ⟨some pinned, engineSessionId, runs⟩).1
        = LaunchVerdict.engineMismatch ↔ pinned ≠ agentEngine := by
  by_cases hp : pinned = agentEngine
  · subst hp; simp [startRun]
  · simp [startRun, hp]

/-- The refusal travels as `409 session_engine_mismatch`, apart from `session_not_usable`: the
request is well formed, and the session has a history this run does not belong to. -/
@[aw_spec (tier := T2) (ts := "packages/contracts/src/engines.ts#ENGINE_PROBLEM_CODES")]
theorem session_engine_mismatch_is_a_four_oh_nine :
    LaunchVerdict.engineMismatch.code = some "session_engine_mismatch" ∧
    LaunchVerdict.engineMismatch.status = 409 := by decide +kernel

/-! ## What a permitted run does -/

/-- A run in a session pinned to a **published** engine records that engine, and appends exactly
one row.

The hypothesis is the code's, not a convenience: `pinSessionEngine` narrows the engine it records
with `publishedEngineId`, which throws — and so writes no row — for an id outside `ENGINE_IDS`
(`apps/web/server/runs/api.test.ts`, "refuses to record a run for an engine the contracts do not
publish"). `startRun` below models the published case only. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/runs/api.ts#startRun")]
theorem a_run_records_the_engine_the_session_is_pinned_to
    (engine : String) (engineSessionId : Option String) (runs : List RunRow) :
    engine ∈ engineIds →
    startRun engine ⟨some engine, engineSessionId, runs⟩
      = (LaunchVerdict.created engine, ⟨some engine, engineSessionId, runs ++ [⟨engine⟩]⟩) := by
  intro _
  simp [startRun]

/-- A session no run has pinned accepts any **published** engine, and records the agent's own. This
is what makes `sessions.engine` NULL a real state rather than a missing value: a project session
created before its first run is launched, not refused.

"Any" is every id the contracts publish, not every string: `pinSessionEngine` narrows the agent's
engine with `publishedEngineId` before it can be recorded, and that throws, writing no row, for an
id outside `ENGINE_IDS`. The refusal theorems above need no such hypothesis, because a refusal and a
throw both leave the rows as they were. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/engines/session-engine.ts#pinSessionEngine")]
theorem an_unpinned_session_accepts_any_engine
    (agentEngine : String) (engineSessionId : Option String) (runs : List RunRow) :
    agentEngine ∈ engineIds →
    startRun agentEngine ⟨Option.none, engineSessionId, runs⟩
      = (LaunchVerdict.created agentEngine,
         ⟨Option.none, engineSessionId, runs ++ [⟨agentEngine⟩]⟩) := by
  intro _
  simp [startRun]

/-- No run ever re-pins its session, whatever it asks for. Switching a live session to another engine
is a non-goal of the engine programme: the session's history belongs to the engine that produced it,
so a run that cannot join it is refused rather than allowed to take it over. -/
@[aw_spec (tier := T2)
  (doc := "docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md#d8--a-session-is-pinned-to-one-engine")
  (ts := "apps/web/server/runs/api.ts#startRun")]
theorem a_run_never_repins_the_session (agentEngine : String) (s : LaunchState) :
    (startRun agentEngine s).2.sessionEngine = s.sessionEngine := by
  obtain ⟨sessionEngine, engineSessionId, runs⟩ := s
  cases sessionEngine with
  | none => simp [startRun]
  | some pinned =>
    by_cases hp : pinned = agentEngine
    · simp [startRun, hp]
    · simp [startRun, hp]

/-- A run never writes an engine session id either: the identity is recorded only after the runner
reports one, by {@link recordIdentity}. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/composition/session-launch.ts#sessionForLaunch")]
theorem a_run_never_claims_an_engine_session_id (agentEngine : String) (s : LaunchState) :
    (startRun agentEngine s).2.engineSessionId = s.engineSessionId := by
  obtain ⟨sessionEngine, engineSessionId, runs⟩ := s
  cases sessionEngine with
  | none => simp [startRun]
  | some pinned =>
    by_cases hp : pinned = agentEngine
    · simp [startRun, hp]
    · simp [startRun, hp]

/-! ## The pairing the identity write establishes -/

/-- Recording a reported identity pins the engine and the id together, so the pairing invariant holds
of the state it produces from **any** prior state. Migration 0025 closes the same gap for rows
written before this code. -/
@[aw_spec (tier := T2)
  (ts := "apps/web/server/composition/session-launch.ts#recordReportedSessionIdentity")]
theorem recording_identity_establishes_the_pairing (engine reported : String) (s : LaunchState) :
    launchPaired (recordIdentity engine reported s) = true := by
  simp [launchPaired, recordIdentity]

/-- A fresh session satisfies the pairing, and a run does not break it: a run writes neither cell. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/sessions.ts#sessions")]
theorem a_run_preserves_the_pairing (agentEngine : String) (s : LaunchState)
    (h : launchPaired s = true) : launchPaired (startRun agentEngine s).2 = true := by
  have hengine := a_run_never_repins_the_session agentEngine s
  have hid := a_run_never_claims_an_engine_session_id agentEngine s
  unfold launchPaired at h ⊢
  rw [hengine, hid]
  exact h

/-! ## Witnesses

Concrete runs, so that every theorem above has a state that satisfies its hypotheses. -/

/-- Witness: the published-engine hypotheses above are satisfiable — `claude-agent-sdk` is
published. -/
example : claude ∈ engineIds := by decide +kernel

/-- Witness: two runs on the pinned engine land, in order. -/
example :
    startRun claude (startRun claude (recordIdentity claude "s1" freshSession)).2
      = (LaunchVerdict.created claude,
         ⟨some claude, some "s1", [⟨claude⟩, ⟨claude⟩]⟩) := by decide +kernel

/-- Witness: a request for another engine is refused and leaves both prior runs untouched. -/
example :
    startRun testOnly ⟨some claude, some "s1", [⟨claude⟩, ⟨claude⟩]⟩
      = (LaunchVerdict.engineMismatch, ⟨some claude, some "s1", [⟨claude⟩, ⟨claude⟩]⟩) := by decide +kernel

/-- Witness: the refusal is symmetric. A session pinned to a test-only engine does not quietly become
a `claude-agent-sdk` session either. -/
example :
    (startRun claude ⟨some testOnly, some "s1", []⟩).1 = LaunchVerdict.engineMismatch := by decide +kernel

/-- Witness: the very first run of a session pins nothing by itself — the engine is still NULL until
the runner reports an identity — and it is still recorded on the run. -/
example :
    startRun claude freshSession
      = (LaunchVerdict.created claude, ⟨Option.none, Option.none, [⟨claude⟩]⟩) := by decide +kernel

end AgentWorkspace.Theorems.Invariants.BehaviourEngines
