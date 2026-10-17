import AgentWorkspace.Behaviour.EngineImages

/-!
# T2 — a run starts only in its own engine's image (ENG-07, #306)

ADR-0073 D3's two invariants, for every image-taking driver and for the one-image ACA pool:

* a driver creates a sandbox only in an image whose `io.agent-workspace.engine` label equals the
  run's engine — over a single `create()` and over any sequence of them;
* an engine with no configured image answers `engine_not_installed` **before any sandbox is
  created**: the driver's sandbox set is unchanged, and the run route writes no run row.

## The hypothesis

What an image *contains* is outside Lean. The label theorems assume `LabelHonest label images`:
the image configured under engine `e` carries label `e`. `runtime.Dockerfile` derives the label
from the adapter manifest it copied (`scripts/engine-images.mjs --verify-label`), which is what
enforces that the label describes the bytes; the PR lists it under Declared gaps.
-/

namespace AgentWorkspace.Theorems.Invariants.EngineImages

open AgentWorkspace.Behaviour.EngineImages

/-- Whatever the driver, a sandbox is created only in the image the map holds for the run's engine,
so under a label-honest map its engine label is the run's engine. -/
@[aw_spec (tier := T2)
  (doc := "docs/adr/0073-one-runtime-image-per-engine.md#d3--dispatch-picks-the-image-of-the-runs-engine")
  (ts := "packages/runtime/src/engine-images.ts#requireEngineImage")
  (ts := "packages/runtime/src/docker.ts#createDockerDriver")
  (ts := "packages/runtime/src/kubernetes.ts#createKubernetesDriver")
  (ts := "packages/runtime/src/cloud-run.ts#createCloudRunDriver")]
theorem driver_starts_only_in_the_runs_engine_image (driver : ImageDriver)
    (images : EngineImageMap) (label : String → String) (state state' : Sandboxes)
    (session engine image : String) (honest : LabelHonest label images)
    (h : create driver images state session engine = (.created image, state')) :
    label image = engine ∧ state'.created = state.created ++ [(session, image)] := by
  rcases hl : lookup images engine with _ | found
  · simp [create, hl] at h
  · simp only [create, hl, Prod.mk.injEq, CreateResult.created.injEq] at h
    obtain ⟨rfl, rfl⟩ := h
    exact ⟨honest _ _ (lookup_some_mem images engine found hl), rfl⟩

private theorem createAll_sound (driver : ImageDriver) (images : EngineImageMap)
    (label : String → String) (honest : LabelHonest label images) :
    ∀ (requests : List (String × String)) (state : Sandboxes) (session image : String),
      (session, image) ∈ (createAll driver images state requests).created →
        (session, image) ∈ state.created ∨
          ∃ engine, (session, engine) ∈ requests ∧ label image = engine := by
  intro requests
  induction requests with
  | nil => intro state session image h; exact Or.inl h
  | cons head rest ih =>
    intro state session image h
    obtain ⟨s, e⟩ := head
    rcases ih _ session image h with h' | ⟨engine, hmem, hlabel⟩
    · rcases hl : lookup images e with _ | found
      · simp only [create, hl] at h'
        exact Or.inl h'
      · simp only [create, hl, List.mem_append, List.mem_singleton, Prod.mk.injEq] at h'
        rcases h' with h' | ⟨rfl, rfl⟩
        · exact Or.inl h'
        · exact Or.inr ⟨e, List.mem_cons_self, honest _ _ (lookup_some_mem images e _ hl)⟩
    · exact Or.inr ⟨engine, List.mem_cons_of_mem _ hmem, hlabel⟩

/-- Over any sequence of runs started from no sandbox, every sandbox a driver holds was created for
one of those runs, in an image labelled with that run's engine. -/
@[aw_spec (tier := T2)
  (doc := "docs/adr/0073-one-runtime-image-per-engine.md#d3--dispatch-picks-the-image-of-the-runs-engine")
  (ts := "packages/runtime/src/engine-images.ts#requireEngineImage")]
theorem every_sandbox_carries_its_runs_engine (driver : ImageDriver) (images : EngineImageMap)
    (label : String → String) (honest : LabelHonest label images)
    (requests : List (String × String)) (session image : String)
    (h : (session, image) ∈ (createAll driver images {} requests).created) :
    ∃ engine, (session, engine) ∈ requests ∧ label image = engine := by
  rcases createAll_sound driver images label honest requests {} session image h with h' | h'
  · simp at h'
  · exact h'

/-- The ACA session pool holds one image for one engine; under an honest pool label it too creates
a session only in an image labelled with the run's engine. -/
@[aw_spec (tier := T2)
  (doc := "docs/adr/0073-one-runtime-image-per-engine.md#d6--one-engine-per-aca-session-pool")
  (ts := "packages/runtime/src/aca-sessions.ts#createAcaSessionsDriver")]
theorem pool_starts_only_in_the_runs_engine_image (poolEngine poolImage : String)
    (label : String → String) (state state' : Sandboxes) (session engine image : String)
    (honest : label poolImage = poolEngine)
    (h : createInPool poolEngine poolImage state session engine = (.created image, state')) :
    label image = engine := by
  unfold createInPool at h
  split at h
  · rename_i heq
    simp only [Prod.mk.injEq, CreateResult.created.injEq] at h
    obtain ⟨rfl, _⟩ := h
    simp only [beq_iff_eq] at heq
    rw [honest, heq]
  · simp at h

/-- An engine with no configured image is refused with `engine_not_installed` by every driver, and
the driver's sandboxes are exactly what they were. -/
@[aw_spec (tier := T2)
  (doc := "docs/adr/0073-one-runtime-image-per-engine.md#d3--dispatch-picks-the-image-of-the-runs-engine")
  (ts := "packages/runtime/src/engine-images.ts#resolveEngineImage")
  (ts := "packages/runtime/src/engine-images.ts#requireEngineImage")]
theorem engine_without_image_creates_no_sandbox (driver : ImageDriver) (images : EngineImageMap)
    (state : Sandboxes) (session engine : String) (h : installed images engine = false) :
    create driver images state session engine = (.refused "engine_not_installed", state) := by
  unfold installed at h
  rcases hl : lookup images engine with _ | found
  · simp [create, hl]
  · simp [hl] at h

/-- The ACA pool refuses every engine but its own, before an allocation. -/
@[aw_spec (tier := T2)
  (doc := "docs/adr/0073-one-runtime-image-per-engine.md#d6--one-engine-per-aca-session-pool")
  (ts := "packages/runtime/src/aca-sessions.ts#createAcaSessionsDriver")]
theorem pool_refuses_other_engines (poolEngine poolImage : String) (state : Sandboxes)
    (session engine : String) (h : engine ≠ poolEngine) :
    createInPool poolEngine poolImage state session engine =
      (.refused "engine_not_installed", state) := by
  simp [createInPool, h]

/-- The run route answers `422 engine_not_installed` for an engine with no image, and the run
store is unchanged: no run row exists for a run no sandbox could carry. -/
@[aw_spec (tier := T2)
  (doc := "docs/adr/0073-one-runtime-image-per-engine.md#d3--dispatch-picks-the-image-of-the-runs-engine")
  (ts := "apps/web/server/runs/api.ts#startRun")
  (ts := "apps/web/server/engines/images.ts#engineIsInstalled")]
theorem route_refuses_before_a_run_row (images : EngineImageMap) (runs : List String)
    (runId engine : String) (h : installed images engine = false) :
    startRun images runs runId engine = .refused 422 "engine_not_installed" runs := by
  simp [startRun, h]

/-- Witness: an honest two-engine map, a Claude run and a pi run each start in their own image. -/
example :
    create .docker [("claude-agent-sdk", "runtime-claude"), ("pi", "runtime-pi")] {} "s1" "pi" =
      (.created "runtime-pi", { created := [("s1", "runtime-pi")] }) := by
  decide

/-- Witness: a map lacking `pi` refuses a pi run and creates nothing. -/
example :
    create .kubernetes [("claude-agent-sdk", "runtime-claude")] {} "s1" "pi" =
      (.refused "engine_not_installed", {}) := by
  decide

/-- Witness: a map lacking `pi` answers a pi run `422` and writes no run row. -/
example :
    startRun [("claude-agent-sdk", "runtime-claude")] ["r0"] "r1" "pi" =
      .refused 422 "engine_not_installed" ["r0"] := by
  decide

/-- Witness: a Claude pool starts a Claude session and refuses a pi one. -/
example :
    createInPool "claude-agent-sdk" "runtime-claude" {} "s1" "claude-agent-sdk" =
        (.created "runtime-claude", { created := [("s1", "runtime-claude")] }) ∧
      createInPool "claude-agent-sdk" "runtime-claude" {} "s2" "pi" =
        (.refused "engine_not_installed", {}) := by
  decide

/-- Witness for the label hypothesis: a label function under which a two-engine map is honest. -/
example :
    LabelHonest (fun image => if image == "runtime-pi" then "pi" else "claude-agent-sdk")
      [("claude-agent-sdk", "runtime-claude"), ("pi", "runtime-pi")] := by
  intro engine image h
  simp only [List.mem_cons, Prod.mk.injEq, List.not_mem_nil, or_false] at h
  rcases h with ⟨rfl, rfl⟩ | ⟨rfl, rfl⟩ <;> decide

end AgentWorkspace.Theorems.Invariants.EngineImages
