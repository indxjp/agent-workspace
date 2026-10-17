import AgentWorkspace.Behaviour.EnginePort

/-!
# T2 — an unregistered engine answers before any output frame (ENG-04, #303)

The acceptance criterion is *"a missing package answers the `/run` request with a typed
`run-error {code: 'engine_not_installed'}` **before any output**"*, and "before any output" is
the load-bearing half: a refusal discovered after the first frame has already put a partial run
on the wire and into `run_events`, and a consumer that saw those frames has to be told to
discard them.

The invariant holds structurally rather than by discipline, which is the point of modelling it:
`serveRun` looks the engine up and compiles *before* it starts, so there is no path through the
function that emits a frame and then refuses.
-/

namespace AgentWorkspace.Theorems.Invariants.EnginePort

open AgentWorkspace.Behaviour.EnginePort

/-- An engine this image does not carry produces **zero** frames, whatever the engine would have
produced had it been there. Quantified over `framesIfStarted`, which is exactly the "before any
output" claim: the number of frames a started run would have made cannot change the answer. -/
@[aw_spec (tier := T2) (doc := "docs/sdk/site/building/extending-the-platform.mdx#registering-it")
  (ts := "apps/runner/src/engines.ts#loadEngine")
  (ts := "apps/runner/src/server.ts#streamEngineRefusal")]
theorem unregistered_engine_emits_no_frame (table : List InstalledAdapter)
    (capabilities : Capabilities) (request : Request) (projectKey configDir : String)
    (framesIfStarted : Nat)
    (h : loadEngine table request.engine = .refused .engineNotInstalled) :
    serveRun table capabilities request projectKey configDir framesIfStarted =
      { frames := 0, terminal := "run-error", code := some "engine_not_installed" } := by
  simp [serveRun, h, Refusal.code]

/-- An engine absent from the table is refused, and an engine present but unloadable is refused
the same way. From the caller's side those are one fact about this image. -/
@[aw_spec (tier := T2) (ts := "apps/runner/src/engines.ts#loadEngine")]
theorem absent_and_unloadable_are_the_same_refusal (version dir : String) :
    loadEngine [] "openai-agents-sdk" = .refused .engineNotInstalled ∧
    loadEngine [{ id := "claude-agent-sdk", version, protectedConfigDirectory := dir,
                  loads := false }] "claude-agent-sdk" = .refused .engineNotInstalled := by
  simp [loadEngine]

/-- `/healthz` never reports an engine whose package did not load. This is the other half of the
same claim: the catalogue's `installed` flag is the result of loading, not a reading of a list. -/
@[aw_spec (tier := T2) (ts := "apps/runner/src/engines.ts#installedEngines")
  (ts := "apps/runner/src/server.ts#listEngines")]
theorem healthz_reports_only_what_loaded (table : List InstalledAdapter) (id version : String)
    (h : (id, version) ∈ installedEngines table) :
    ∃ row ∈ table, row.id = id ∧ row.version = version ∧ row.loads = true := by
  simp only [installedEngines, List.mem_map, List.mem_filter] at h
  obtain ⟨row, ⟨hmem, hloads⟩, hpair⟩ := h
  refine ⟨row, hmem, ?_, ?_, by simpa using hloads⟩
  · exact (Prod.mk.injEq .. ▸ hpair).1
  · exact (Prod.mk.injEq .. ▸ hpair).2

/-- An image carrying no adapter reports no engines, which is the `/healthz` half of the
acceptance criterion. -/
@[aw_spec (tier := T2) (ts := "apps/runner/src/engines.ts#installedEngines")]
theorem an_image_with_no_adapter_reports_none :
    installedEngines [{ id := "claude-agent-sdk", version := "0.3.278",
                        protectedConfigDirectory := ".claude", loads := false }] = [] := by
  decide

/-- In the model, a `run-error` terminal carries no frame — because the model's only `run-error`
is a refusal *before start*. A policy the adapter cannot read and a credential it refuses are
decided by `compile`, which runs before `start`, so the property is about the *ordering* rather
than about one code.

Read the hypothesis as "the model answered `run-error`", not as "the server sent `run-error`":
`apps/runner/src/server.ts` also ends a run that started, streamed frames and then threw with
`run-error`, and `serveRun` has no arm for such a mid-stream failure. The implementation-shaped
statement is `every_refusal_before_start_emits_no_frame` below, which is quantified over the
refusal itself and stays true whatever arms `RunOutcome` later gains. -/
@[aw_spec (tier := T2) (ts := "apps/runner/src/runtime.ts#startEngineAgent")]
theorem every_refusal_emits_no_frame (table : List InstalledAdapter) (capabilities : Capabilities)
    (request : Request) (projectKey configDir : String) (framesIfStarted : Nat)
    (h : (serveRun table capabilities request projectKey configDir framesIfStarted).terminal =
      "run-error") :
    (serveRun table capabilities request projectKey configDir framesIfStarted).frames = 0 := by
  unfold serveRun at h ⊢
  cases hl : loadEngine table request.engine with
  | refused _ => simp
  | found _ =>
    cases hc : compileTarget capabilities request projectKey configDir with
    | refused _ => simp
    | compiled _ => simp [hl, hc] at h

/-- Every refusal *before start* emits no frame and answers `run-error` with the refusal's code:
the engine did not load, or it loaded and `compile` refused. Stated over the refusal rather than
over the terminal name, so it does not depend on `run-error` meaning only a refusal — which it
does not in the server, where a run that fails mid-stream also ends with `run-error`. -/
@[aw_spec (tier := T2) (ts := "apps/runner/src/runtime.ts#startEngineAgent")
  (ts := "apps/runner/src/server.ts#streamEngineRefusal")]
theorem every_refusal_before_start_emits_no_frame (table : List InstalledAdapter)
    (capabilities : Capabilities) (request : Request) (projectKey configDir : String)
    (framesIfStarted : Nat) (reason : Refusal)
    (h : loadEngine table request.engine = .refused reason ∨
      (∃ adapter, loadEngine table request.engine = .found adapter) ∧
        compileTarget capabilities request projectKey configDir = .refused reason) :
    (serveRun table capabilities request projectKey configDir framesIfStarted).frames = 0 ∧
    (serveRun table capabilities request projectKey configDir framesIfStarted).terminal =
      "run-error" ∧
    (serveRun table capabilities request projectKey configDir framesIfStarted).code =
      some reason.code := by
  rcases h with hl | ⟨⟨adapter, hl⟩, hc⟩
  · simp [serveRun, hl]
  · simp [serveRun, hl, hc]

end AgentWorkspace.Theorems.Invariants.EnginePort
