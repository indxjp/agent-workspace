import AgentWorkspace.Behaviour.EngineImages

/-!
# T1 — the catalogue is the map, and a malformed map is refused by key (ENG-07, #306)

Two normative sentences of ADR-0073:

* D2 — `installed` in `GET /api/engines` holds **exactly** when the configured map has an image for
  the engine, for every registered engine alike;
* D5 — a malformed map fails parsing, and the refusal names configuration keys and **never a
  value**.

The second is stated three ways, because each alone leaves a gap: an entry at fault always makes
parsing fail and is always named; the refusal is determined by the keys and the values' verdicts,
so two configurations that differ only in their values are refused identically; and every key the
refusal names is one the configuration used — at the control plane, an engine id.

D5's digest rule is stated where the value is consumed: the runner manager refuses an unpinned
reference in production (`runner_manager_requires_digests_in_production`), and the control plane,
which never starts a container, never does (`control_plane_never_requires_a_digest`).
-/

namespace AgentWorkspace.Theorems.Normative.EngineImages

open AgentWorkspace.Behaviour.EngineImages

/-- Every registered engine is listed, and a row reports `installed` exactly when the configured
map has an image for that engine. -/
@[aw_spec (tier := T1) (doc := "docs/adr/0073-one-runtime-image-per-engine.md#d2--the-catalogue-is-the-map")
  (ts := "apps/web/server/engines/registry.ts#registeredEngines")
  (ts := "packages/runtime/src/engine-images.ts#engineImageInstalled")]
theorem catalogue_is_the_map (registered : List Registered) (images : EngineImageMap) :
    (catalogue registered images).map (·.id) = registered.map (·.id) ∧
      ∀ row ∈ catalogue registered images,
        row.installed = true ↔ ∃ image, (row.id, image) ∈ images := by
  refine ⟨by simp [catalogue, Function.comp_def], ?_⟩
  intro row hrow
  simp only [catalogue, List.mem_map] at hrow
  obtain ⟨engine, _, rfl⟩ := hrow
  exact lookup_isSome_iff images engine.id

private theorem faultFold_mono (known : List String) :
    ∀ (vs : List (String × ValueVerdict)) (accepted : List String) (f : Faults) (k : String),
      k ∈ f.keys → k ∈ (faultFold known accepted f vs).keys := by
  intro vs
  induction vs with
  | nil => intro accepted f k h; simpa [faultFold] using h
  | cons head rest ih =>
    intro accepted f k h
    obtain ⟨key, verdict⟩ := head
    simp only [faultFold]
    split
    · exact ih _ _ _ (by simp only [Faults.keys, List.mem_append] at h ⊢; rcases h with ((h | h) | h) | h <;> simp [h])
    · split
      · exact ih _ _ _ (by simp only [Faults.keys, List.mem_append] at h ⊢; rcases h with ((h | h) | h) | h <;> simp [h])
      · cases verdict
        · exact ih _ _ _ h
        · exact ih _ _ _ (by simp only [Faults.keys, List.mem_append] at h ⊢; rcases h with ((h | h) | h) | h <;> simp [h])
        · exact ih _ _ _ (by simp only [Faults.keys, List.mem_append] at h ⊢; rcases h with ((h | h) | h) | h <;> simp [h])

private theorem faultFold_reports (known : List String) :
    ∀ (vs : List (String × ValueVerdict)) (accepted : List String) (f : Faults)
      (key : String) (verdict : ValueVerdict),
      (key, verdict) ∈ vs → (known.contains key = false ∨ verdict ≠ .ok) →
        key ∈ (faultFold known accepted f vs).keys := by
  intro vs
  induction vs with
  | nil => intro _ _ _ _ hmem; simp at hmem
  | cons head rest ih =>
    intro accepted f key verdict hmem hbad
    obtain ⟨key', verdict'⟩ := head
    rcases List.mem_cons.mp hmem with hhead | hrest
    · simp only [Prod.mk.injEq] at hhead
      obtain ⟨rfl, rfl⟩ := hhead
      simp only [faultFold]
      split
      · exact faultFold_mono known _ _ _ _ (by simp [Faults.keys])
      · split
        · exact faultFold_mono known _ _ _ _ (by simp [Faults.keys])
        · rename_i hknown
          cases verdict
          · rcases hbad with hbad | hbad
            · simp_all
            · exact absurd rfl hbad
          · exact faultFold_mono known _ _ _ _ (by simp [Faults.keys])
          · exact faultFold_mono known _ _ _ _ (by simp [Faults.keys])
    · simp only [faultFold]
      split
      · exact ih _ _ _ _ hrest hbad
      · split
        · exact ih _ _ _ _ hrest hbad
        · cases verdict' <;> exact ih _ _ _ _ hrest hbad

private theorem faultFold_keys_from (known : List String) :
    ∀ (vs : List (String × ValueVerdict)) (accepted : List String) (f : Faults) (k : String),
      k ∈ (faultFold known accepted f vs).keys → k ∈ f.keys ∨ k ∈ vs.map (·.1) := by
  intro vs
  induction vs with
  | nil => intro _ _ _ h; exact Or.inl (by simpa [faultFold] using h)
  | cons head rest ih =>
    intro accepted f k h
    obtain ⟨key, verdict⟩ := head
    have step : ∀ f' : Faults, (∀ x, x ∈ f'.keys → x ∈ f.keys ∨ x = key) →
        (k ∈ f'.keys ∨ k ∈ rest.map (·.1)) →
          k ∈ f.keys ∨ k ∈ ((key, verdict) :: rest).map (·.1) := by
      intro f' hf' hk
      rcases hk with hk | hk
      · rcases hf' k hk with h | h
        · exact Or.inl h
        · exact Or.inr (by simp [h])
      · exact Or.inr (by simp [hk])
    have grow : ∀ x, x ∈ f.keys → x ∈ f.keys ∨ x = key := fun _ hx => Or.inl hx
    simp only [faultFold] at h
    split at h
    · exact step _ (by
        intro x hx
        simpa [Faults.keys, or_assoc, or_comm, or_left_comm] using hx) (ih _ _ _ h)
    · split at h
      · exact step _ (by
          intro x hx
          simpa [Faults.keys, or_assoc, or_comm, or_left_comm] using hx) (ih _ _ _ h)
      · cases verdict
        · exact step _ grow (ih _ _ _ h)
        · exact step _ (by
            intro x hx
            simpa [Faults.keys, or_assoc, or_comm, or_left_comm] using hx) (ih _ _ _ h)
        · exact step _ (by
            intro x hx
            simpa [Faults.keys, or_assoc, or_comm, or_left_comm] using hx) (ih _ _ _ h)

/-- A configuration with an entry at fault — a key the catalogue does not publish, or a value the
parser does not accept — fails parsing as a whole, and the refusal names that entry's key. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0073-one-runtime-image-per-engine.md#d5--a-malformed-map-fails-start-up-and-names-no-value")
  (ts := "packages/runtime/src/engine-images.ts#parseEngineImageMap")
  (ts := "packages/runtime/src/engine-images.ts#EngineImageConfigurationError")]
theorem malformed_map_fails_parsing (known : List String) (shaped : String → Bool)
    (requireDigest : Bool) (entries : EngineImageMap) (key value : String)
    (hmem : (key, value) ∈ entries)
    (hbad : known.contains key = false ∨ classify shaped requireDigest value ≠ .ok) :
    ∃ faults, parse known shaped requireDigest entries = .error faults ∧ key ∈ faults.keys := by
  have hv : (key, classify shaped requireDigest value) ∈
      verdicts (classify shaped requireDigest) entries := by
    simp only [verdicts, List.mem_map]
    exact ⟨(key, value), hmem, rfl⟩
  have hk := faultFold_reports known _ [] {} key _ hv hbad
  refine ⟨_, ?_, hk⟩
  unfold parse
  dsimp only
  have hne : (faultFold known [] {} (verdicts (classify shaped requireDigest) entries)).keys.isEmpty
      = false := by
    cases hkeys : (faultFold known [] {} (verdicts (classify shaped requireDigest) entries)).keys
    · rw [hkeys] at hk; simp at hk
    · rfl
  simp [hne]

/-- The refusal is determined by the configured keys and the verdicts on their values: two
configurations that agree on those are refused identically, whatever their values are. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0073-one-runtime-image-per-engine.md#d5--a-malformed-map-fails-start-up-and-names-no-value")
  (ts := "packages/runtime/src/engine-images.ts#parseEngineImageMap")]
theorem refusal_names_no_value (known : List String) (shaped₁ shaped₂ : String → Bool)
    (requireDigest₁ requireDigest₂ : Bool) (entries₁ entries₂ : EngineImageMap)
    (same : verdicts (classify shaped₁ requireDigest₁) entries₁ =
      verdicts (classify shaped₂ requireDigest₂) entries₂)
    (faults : Faults) (h : parse known shaped₁ requireDigest₁ entries₁ = .error faults) :
    parse known shaped₂ requireDigest₂ entries₂ = .error faults := by
  unfold parse at h ⊢
  dsimp only at h ⊢
  rw [← same]
  by_cases hc : (faultFold known [] {} (verdicts (classify shaped₁ requireDigest₁) entries₁)).keys.isEmpty
  · simp [hc] at h
  · simp only [hc] at h ⊢
    exact h

/-- Every key a refusal names is a key the configuration used. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0073-one-runtime-image-per-engine.md#d5--a-malformed-map-fails-start-up-and-names-no-value")
  (ts := "packages/runtime/src/engine-images.ts#parseEngineImageMap")]
theorem refusal_names_only_configured_keys (known : List String) (shaped : String → Bool)
    (requireDigest : Bool) (entries : EngineImageMap) (faults : Faults)
    (h : parse known shaped requireDigest entries = .error faults) :
    ∀ k ∈ faults.keys, k ∈ entries.map (·.1) := by
  intro k hk
  unfold parse at h
  dsimp only at h
  split at h
  · cases h
  · cases h
    rcases faultFold_keys_from known _ [] {} k hk with h | h
    · simp [Faults.keys] at h
    · simpa [verdicts, Function.comp_def] using h

private theorem envEntry_key (env : Env) (engine key value : String)
    (h : envEntry env engine = some (key, value)) : key = engine := by
  unfold envEntry at h
  dsimp only at h
  split at h
  · split at h
    · cases h
    · simp only [Option.some.injEq, Prod.mk.injEq] at h
      exact h.1.symm
  · cases h

/-- At the control plane the configuration is the environment, and a start-up refusal names only
engine ids the catalogue publishes — never a variable's value. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0073-one-runtime-image-per-engine.md#d5--a-malformed-map-fails-start-up-and-names-no-value")
  (ts := "apps/web/server/engines/images.ts#readConfiguredEngineImages")
  (ts := "packages/runtime/src/engine-images.ts#readEngineImageMap")]
theorem startup_refusal_names_only_engine_ids (known : List String) (shaped : String → Bool)
    (env : Env) (faults : Faults) (h : controlPlane known shaped env = .error faults) :
    ∀ k ∈ faults.keys, k ∈ known := by
  intro k hk
  have hread : readEnv known shaped false env = .error faults := by
    unfold controlPlane at h
    dsimp only at h
    split at h
    · split at h <;> cases h
    · exact h
  have hkey := refusal_names_only_configured_keys _ _ _ _ _ hread k hk
  simp only [List.mem_map, List.mem_filterMap] at hkey
  obtain ⟨⟨key, value⟩, ⟨engine, hengine, hentry⟩, rfl⟩ := hkey
  rw [envEntry_key env engine key value hentry]
  exact hengine

private theorem faultFold_unpinned (known : List String) :
    ∀ (vs : List (String × ValueVerdict)) (accepted : List String) (f : Faults),
      (∀ p ∈ vs, p.2 ≠ .unpinned) → (faultFold known accepted f vs).unpinned = f.unpinned := by
  intro vs
  induction vs with
  | nil => intro _ _ _; simp [faultFold]
  | cons head rest ih =>
    intro accepted f hvs
    obtain ⟨key, verdict⟩ := head
    have hrest : ∀ p ∈ rest, p.2 ≠ .unpinned := fun p hp => hvs p (List.mem_cons_of_mem _ hp)
    have hhead : verdict ≠ .unpinned := hvs (key, verdict) List.mem_cons_self
    simp only [faultFold]
    split
    · exact ih _ _ hrest
    · split
      · exact ih _ _ hrest
      · cases verdict
        · exact ih _ _ hrest
        · exact ih _ _ hrest
        · exact absurd rfl hhead

/-- The control plane never refuses a value for being unpinned, in production or out: the digest
rule belongs to the process that starts containers from the value (ADR-0073 D5). A refusal at the
control plane is only ever an unknown engine, a value that is not a reference, or a duplicate. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0073-one-runtime-image-per-engine.md#d5--a-malformed-map-fails-start-up-and-names-no-value")
  (ts := "apps/web/server/engines/images.ts#readConfiguredEngineImages")]
theorem control_plane_never_requires_a_digest (known : List String) (shaped : String → Bool)
    (env : Env) (faults : Faults) (h : controlPlane known shaped env = .error faults) :
    faults.unpinned = [] := by
  have hread : readEnv known shaped false env = .error faults := by
    unfold controlPlane at h
    dsimp only at h
    split at h
    · split at h <;> cases h
    · exact h
  unfold readEnv parse at hread
  dsimp only at hread
  split at hread
  · cases hread
  · cases hread
    rw [faultFold_unpinned]
    intro p hp
    simp only [verdicts, List.mem_map] at hp
    obtain ⟨entry, _, rfl⟩ := hp
    unfold classify
    split <;> simp

/-- The runner manager, which starts sandboxes from the map, refuses in production any published
engine configured with a well-shaped reference that is not pinned by `sha256` digest, and names that
engine. This is where ADR-0073 D5's digest rule lives. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0073-one-runtime-image-per-engine.md#d5--a-malformed-map-fails-start-up-and-names-no-value")
  (ts := "apps/runner/src/manager-start.ts#engineImagesFor")
  (ts := "packages/runtime/src/engine-images.ts#readEngineImageMap")]
theorem runner_manager_requires_digests_in_production (known : List String)
    (shaped : String → Bool) (env : Env) (engine value : String)
    (hprod : env.get "NODE_ENV" = some "production") (hknown : engine ∈ known)
    (hentry : envEntry env engine = some (engine, value)) (hshaped : shaped value = true)
    (hunpinned : digestPinned value = false) :
    ∃ faults, runnerManager known shaped env = .error faults ∧ engine ∈ faults.keys := by
  have hmem : (engine, value) ∈ known.filterMap (envEntry env) :=
    List.mem_filterMap.mpr ⟨engine, hknown, hentry⟩
  have hbad : known.contains engine = false ∨ classify shaped true value ≠ .ok := by
    right
    simp [classify, hshaped, hunpinned]
  obtain ⟨faults, hparse, hkey⟩ :=
    malformed_map_fails_parsing known shaped true _ engine value hmem hbad
  refine ⟨faults, ?_, hkey⟩
  unfold runnerManager readEnv
  rw [hprod]
  simp only [beq_self_eq_true]
  rw [hparse]

/-- A well-formed map parses whole. -/
example :
    parse ["claude-agent-sdk", "pi"] charShaped false
        [("claude-agent-sdk", "agent-workspace/runtime:dev"), ("pi", "agent-workspace/runtime-pi:dev")] =
      .ok [("claude-agent-sdk", "agent-workspace/runtime:dev"),
        ("pi", "agent-workspace/runtime-pi:dev")] := by
  decide +kernel

/-- The hypotheses of `malformed_map_fails_parsing` are satisfiable: an unpublished key. -/
example : ("pie", "agent-workspace/runtime:dev") ∈ [("pie", "agent-workspace/runtime:dev")] ∧
    (["claude-agent-sdk"].contains "pie" = false) := by
  decide +kernel

end AgentWorkspace.Theorems.Normative.EngineImages
