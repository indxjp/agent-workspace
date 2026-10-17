import AgentWorkspace.Theorems.WellFormed.ConceptConfiguration

/-!
T4 — today's configuration schema against the documented target.

The target (`docs/sdk/04-api-specification.md` §5.5, RF-204) replaces the naming convention with
typed references: every secret a runtime profile names is a runtime connection
(`runtimeConnectionsTyped`). Today's schema diverges exactly there: its foreign key accepts any
secret of the workspace. It refines the target on every state whose referenced secrets were all
created through `POST /api/runtime-connections`, because `encodeSecretName` only produces names
recognised as runtime connections.
-/

namespace AgentWorkspace.Theorems.Refinement.ConceptConfiguration

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Concepts
open AgentWorkspace.Er.Current.Configuration
open AgentWorkspace.Theorems.WellFormed.ConceptConfiguration
  (encoded_connection_name_is_a_runtime_connection_secret)

/-- The witness with its runtime profile pointed at the plain secret `GITHUB_TOKEN`. -/
private def untyped : State := fun t =>
  if t = .runtimeProfiles then
    [⟨Witness.profile.cells.map fun (c, v) =>
      if c == "runtime_connection_id" then (c, "s2") else (c, v)⟩]
  else Witness.state t

/-- Today's schema diverges from the typed target at runtime connections: a state PostgreSQL
accepts, with every cluster check holding, has a runtime profile naming a secret that is not a
runtime connection, while the target is satisfiable by the witness state. -/
@[aw_spec (tier := T4) (doc := "docs/sdk/04-api-specification.md#55-secrets--awsecrets")
  (ts := "packages/core/src/db/schema/runtime-profiles.ts#runtime_profiles_runtime_connection_workspace_fk")]
theorem current_diverges_from_typed_runtime_connections :
    consistentConfig untyped = true ∧ runtimeConnectionsTyped untyped = false ∧
      consistentConfig Witness.state = true ∧ runtimeConnectionsTyped Witness.state = true := by
  decide +kernel

/-- Today's schema refines the typed target on every state whose secrets named by a runtime
profile carry a name `encodeSecretName` produced (as `POST /api/runtime-connections` stores them). -/
@[aw_spec (tier := T4) (doc := "docs/sdk/04-api-specification.md#55-secrets--awsecrets")
  (ts := "apps/web/server/runtimes/connections.ts#encodeSecretName")]
theorem encoded_connections_refine_the_typed_target (st : State)
    (h : ∀ p ∈ st .runtimeProfiles, ∀ s ∈ st .secrets,
      p.get "runtime_connection_id" = s.get "id" → (p.get "runtime_connection_id").isSome →
        ∃ d l n, RuntimeProfile.encodeSecretName d l = some n ∧ s.get "name" = some n) :
    runtimeConnectionsTyped st = true := by
  simp only [runtimeConnectionsTyped, List.all_eq_true]
  intro p hp
  cases hid : p.get "runtime_connection_id" with
  | none => rfl
  | some sid =>
    simp only [List.all_eq_true]
    intro s hs
    by_cases hsid : s.get "id" = some sid
    · obtain ⟨d, l, n, hn, hname⟩ := h p hp s hs (by rw [hid, hsid]) (by rw [hid]; rfl)
      have := (encoded_connection_name_is_a_runtime_connection_secret d l n hn).2
      simp [hname, this]
    · simp [hsid]

example : runtimeConnectionsTyped Witness.state = true :=
  encoded_connections_refine_the_typed_target Witness.state (by
    intro p hp s hs hid _
    refine ⟨"docker", "primary", "RUNTIME_CONNECTION__DOCKER__PRIMARY", by decide, ?_⟩
    simp only [Witness.state, List.mem_cons, List.not_mem_nil, or_false] at hp hs
    subst hp
    rcases hs with rfl | rfl | rfl <;> simp_all [Witness.secret, Witness.profile, Row.get,
      List.lookup_cons])

/-! ## Runtime-profile `PATCH`: today against S-19 -/

/-- Every runtime-profile `PATCH` body accepted today is accepted by the S-19 target. -/
@[aw_spec (tier := T4)
  (doc := "docs/sdk/04-api-specification.md#8-server-changes-this-specification-requires")
  (ts := "packages/core/src/schemas.ts#UpdateRuntimeProfileInput")]
theorem patch_current_refines_target (b : List (String × RuntimeProfile.PatchValue))
    (h : RuntimeProfile.patchAcceptsCurrent b = true) :
    RuntimeProfile.patchAcceptsTarget b = true := by
  simp only [RuntimeProfile.patchAcceptsCurrent, RuntimeProfile.patchAcceptsTarget,
    List.all_eq_true, Bool.and_eq_true, Bool.or_eq_true, beq_iff_eq] at h ⊢
  intro x hx
  obtain ⟨h1, h2⟩ := h x hx
  refine ⟨h1, ?_⟩
  rcases h2 with h2 | h2
  · simp [h2]
  · exact Or.inr (by simpa using h2)

example : RuntimeProfile.patchAcceptsTarget [("cpu", .value)] = true :=
  patch_current_refines_target _ (by decide)

/-- The S-19 target strictly extends today's `PATCH`: clearing `memoryMb` or `runtimeConnectionId`
is refused today and accepted by the target, while clearing a required field such as `driver` or
`name` stays refused. -/
@[aw_spec (tier := T4)
  (doc := "docs/sdk/04-api-specification.md#8-server-changes-this-specification-requires")
  (doc := "docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes")
  (ts := "packages/core/src/schemas.ts#UpdateRuntimeProfileInput")]
theorem s19_target_clears_sizing_but_not_required_fields :
    RuntimeProfile.patchAcceptsCurrent [("memoryMb", .null)] = false ∧
      RuntimeProfile.patchAcceptsTarget [("memoryMb", .null)] = true ∧
      RuntimeProfile.patchAcceptsTarget [("runtimeConnectionId", .null)] = true ∧
      RuntimeProfile.requiredCreateFields.all (fun k =>
        !RuntimeProfile.patchAcceptsTarget [(k, .null)]) = true ∧
      RuntimeProfile.s19ClearableFields.all RuntimeProfile.nullableFields.contains = true := by
  decide

end AgentWorkspace.Theorems.Refinement.ConceptConfiguration
