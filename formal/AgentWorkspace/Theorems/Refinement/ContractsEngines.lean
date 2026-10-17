import AgentWorkspace.Behaviour.Engines

namespace AgentWorkspace.Theorems.Refinement.ContractsEngines

open AgentWorkspace AgentWorkspace.Behaviour.Engines AgentWorkspace.Contracts.Engines

/-! # T4 — migration 0025 is a refinement

Every pre-migration row maps to exactly one post-migration row, and the map loses nothing:

* a policy discriminated by `provider` becomes the same document discriminated by `engine`, with the
  value carried across and every other key untouched;
* a session that already has an engine session id gains `engine = 'claude-agent-sdk'`, and a session
  with no identity is left unpinned rather than given a guessed engine;
* both rewrites are idempotent, which is what makes re-applying the migration set to a partially
  migrated database safe.

`Er/Core.lean` and `Er/Target.lean` carry the schema half of the same change — the renamed column,
the renamed unique index and the two new `CHECK`s — so the post-migration rows described here are
rows of the schema those modules describe.

`migratePolicy` and `migrateSession` are functions, so "exactly one post-migration row" is true by
construction: the half of a refinement a `WHERE` clause can silently break is a row matched twice,
and a function cannot match one twice. What is left to prove is that the map is the *right* one, and
that is what the statements below say.

The two session statements quantify over `sessionCases`, which is exhaustive up to the only thing
either function reads: whether each cell is present. The two policy statements quantify over
`policyCases`, which covers the legacy document, an already-migrated one, a `NULL` column and a
document that names neither key. Both lists are decidable domains, so `decide` checks the statements
rather than a tactic script standing in for them.
-/

/-! ## The domains -/

/-- Every combination of "has an identity" and "names an engine" a `sessions` row can be in. -/
private def sessionCases : List StoredSession :=
  [⟨none, none⟩, ⟨none, some migratedEngine⟩, ⟨some "se1", none⟩,
   ⟨some "se1", some migratedEngine⟩]

private def rest : List (String × String) := [("tools", "claude_code_preset")]

/-- Every shape `agents.policy` can hold when the migration runs: the legacy document, one already
rewritten, a `NULL` column, and a document this schema never wrote. -/
private def policyCases : List StoredPolicy :=
  [legacyPolicy rest, { discriminant := some ("engine", migratedEngine), rest },
   { discriminant := none, rest }, { discriminant := some ("harness", migratedEngine), rest }]

/-! ## The policy document -/

/-- A policy discriminated by `provider` comes out discriminated by `engine`, carrying the same
value, with every other key untouched. -/
@[aw_spec (tier := T4)
  (doc := "docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md#d1--vocabulary")
  (ts := "migrations/0025_name_the_engine_in_stored_rows.sql#agents")]
theorem policy_rewrite_renames_the_discriminant :
    migratePolicy (legacyPolicy rest) =
      { discriminant := some ("engine", migratedEngine), rest } := by decide

/-- No document comes out of the rewrite still naming `provider`, and none loses the rest of its
keys. -/
@[aw_spec (tier := T4) (ts := "migrations/0025_name_the_engine_in_stored_rows.sql#agents")]
theorem policy_rewrite_leaves_no_provider :
    (policyCases.all fun p =>
      ((migratePolicy p).discriminant.map Prod.fst != some "provider") &&
        ((migratePolicy p).rest == p.rest)) = true := by decide

/-- The rewrite is idempotent: a document that already states `engine` is left alone, which is what
makes re-running the migration set safe. -/
@[aw_spec (tier := T4) (ts := "migrations/0025_name_the_engine_in_stored_rows.sql#agents")]
theorem policy_rewrite_is_idempotent :
    (policyCases.all fun p => migratePolicy (migratePolicy p) == migratePolicy p) = true := by
  decide

/-- A `NULL` policy column stays `NULL`. It means "compile from the permission checkboxes", and an
invented engine there would turn an absent policy into a stored one. -/
@[aw_spec (tier := T4) (ts := "migrations/0025_name_the_engine_in_stored_rows.sql#agents")]
theorem policy_rewrite_leaves_a_null_column :
    migratePolicy { discriminant := none, rest } = { discriminant := none, rest } := by decide

/-- A document naming neither key is left for a reader to find rather than given an invented
engine. -/
@[aw_spec (tier := T4) (ts := "migrations/0025_name_the_engine_in_stored_rows.sql#agents")]
theorem policy_rewrite_invents_no_discriminant :
    migratePolicy { discriminant := some ("harness", migratedEngine), rest } =
      { discriminant := some ("harness", migratedEngine), rest } := by decide

/-! ## The session backfill -/

/-- Every session that already has an engine session id comes out naming the engine that reported
it; a session with no identity comes out unpinned. -/
@[aw_spec (tier := T4) (ts := "migrations/0025_name_the_engine_in_stored_rows.sql#sessions")]
theorem session_backfill_pins_exactly_the_identified :
    (sessionCases.all fun s =>
      (migrateSession s).engine ==
        (if s.engine.isNone && s.engineSessionId.isSome then some migratedEngine
         else s.engine)) = true := by decide

/-- The backfill never touches the identity itself: it names the engine, it does not mint an id. -/
@[aw_spec (tier := T4) (ts := "migrations/0025_name_the_engine_in_stored_rows.sql#sessions")]
theorem session_backfill_preserves_the_identity :
    (sessionCases.all fun s =>
      (migrateSession s).engineSessionId == s.engineSessionId) = true := by decide

/-- The release invariant, after the backfill: `engine IS NULL AND engine_session_id IS NOT NULL`
holds of no post-migration row. This is the acceptance criterion's `SELECT count(*) … = 0`. -/
@[aw_spec (tier := T4)
  (doc := "docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md#d8--a-session-is-pinned-to-one-engine")
  (ts := "migrations/0025_name_the_engine_in_stored_rows.sql#sessions")]
theorem session_backfill_establishes_the_pairing :
    (sessionCases.all fun s => enginePaired (migrateSession s)) = true := by decide

/-- The invariant did **not** hold before the migration: the third case is exactly the row the
backfill exists for. Without this, the theorem above would be satisfied by a migration that did
nothing at all. -/
@[aw_spec (tier := T4) (ts := "migrations/0025_name_the_engine_in_stored_rows.sql#sessions")]
theorem the_backfill_has_something_to_do :
    enginePaired ⟨some "se1", none⟩ = false ∧
    enginePaired (migrateSession ⟨some "se1", none⟩) = true := by decide

/-- The backfill is idempotent. -/
@[aw_spec (tier := T4) (ts := "migrations/0025_name_the_engine_in_stored_rows.sql#sessions")]
theorem session_backfill_is_idempotent :
    (sessionCases.all fun s => migrateSession (migrateSession s) == migrateSession s) = true := by
  decide

/-- The engine the backfill writes is the one the contracts publish, not a loose string. -/
@[aw_spec (tier := T4) (ts := "packages/contracts/src/engines.ts#ENGINE_IDS")]
theorem the_backfilled_engine_is_in_the_catalogue :
    engineIds.contains migratedEngine = true := by decide

end AgentWorkspace.Theorems.Refinement.ContractsEngines
