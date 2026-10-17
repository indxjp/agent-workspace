import AgentWorkspace.Theorems.Normative.ConceptWork

/-!
T5 — properties of the specification itself: where the documents, the concepts and today's
schema disagree, pinned so that fixing either side breaks a theorem by name. Each is a finding of
`docs/formal/units/concept-work.md`.

* `runs_carry_no_owner_principal` — the API specification's §2 lists runs among the rows that
  carry `ownerPrincipalId`; `runs` has no such column (ownership is reached through the session).
* `database_admits_a_foreign_sdk_session_id` — today the SDK session id is the platform id or
  nothing, but only the application keeps that; the database accepts any text.
* `sdk_session_key_is_redundant_under_the_identity` — under that same invariant the unique index
  `sessions_workspace_engine_session_key` adds nothing to the primary key.
* `transcript_store_is_keyed_by_the_platform_id` — the transcript rows reference `sessions.id`,
  while the transcript routes are addressed by `:engineSessionId`; the two only meet through the
  identity invariant.
* `database_admits_a_transcript_under_another_key` — `project_key` is the workspace id by
  construction, but the database lets it differ from `workspace_id`.
* `usage_record_provider_is_open_text` — `runs.provider` is a closed set, the ledger's
  `run_usage_records.provider` is free text.
* `blank_checks_trim_spaces_only` — the "not blank" checks strip spaces only, so a tab-only name
  passes the database although the routes refuse it.
* `audit_actor_key_is_recorded_as_no_action` — the catalogue (and the 0025 snapshot) record
  `NO ACTION` for `audit_events_actor_principal_workspace_fk`, while migration 0020 deploys
  `ON DELETE SET NULL (actor_principal_id)`.
-/

namespace AgentWorkspace.Theorems.Meta.ConceptWork

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Er.Current.Work AgentWorkspace.Contracts
open AgentWorkspace.Concepts.Project AgentWorkspace.Concepts.Session AgentWorkspace.Concepts.Run
open AgentWorkspace.Concepts.RunEvent AgentWorkspace.Concepts.Usage
open AgentWorkspace.Theorems.WellFormed.ConceptWork

/-- Of the rows the API specification says carry `ownerPrincipalId` ("agents, skills, files,
connectors, projects, sessions, runs, shares"), `runs` has no owner column: a run is owned through
its session. -/
@[aw_spec (tier := T5) (doc := "docs/sdk/04-api-specification.md#2-resource-model")
  (ts := "packages/core/src/db/schema/runs.ts#runs")]
theorem runs_carry_no_owner_principal :
    (catalogue .runs).hasColumn "owner_principal_id" = false ∧
      ([TableName.agents, .skills, .files, .mcpServers, .projects, .sessions].all fun t =>
        (catalogue t).isNotNull "owner_principal_id") = true ∧
      (catalogue .shares).isNotNull "publisher_principal_id" = true := by
  decide

/-- The session with a foreign SDK id: its `engine_session_id` is not its platform id. -/
def foreignSdkSession : Session := { Witness.session with engineSessionId := some "sdk-7" }

/-- The witness state with that session in place of the witness session. -/
def foreignSdkState : State := fun t =>
  if t = .sessions then [ofCells (sessionCells foreignSdkSession)] else Witness.state t

/-- The database admits a session whose SDK session id is not its platform id, although today's
application only ever records the platform id there (`recordReportedSessionIdentity`): the
identity invariant is not a database constraint. -/
@[aw_spec (tier := T5)
  (ts := "apps/web/server/composition/session-launch.ts#recordReportedSessionIdentity")
  (ts := "packages/core/src/db/schema/sessions.ts#engineSessionId")]
theorem database_admits_a_foreign_sdk_session_id :
    workConsistent foreignSdkState = true ∧ foreignSdkSession.identityCurrent = false := by
  decide +kernel

private theorem keyHolds_elim {rows : List Row} {k : List String} (h : keyHolds rows k [] = true)
    {r1 r2 : Row} (h1 : r1 ∈ rows) (h2 : r2 ∈ rows) (hpres : r1.present k = true)
    (hp : r1.project k = r2.project k) : r1 = r2 := by
  simp only [keyHolds, List.all_nil] at h
  rw [List.filter_eq_self.mpr (fun _ _ => rfl), List.all_eq_true] at h
  have h' := h r1 h1
  simp only [hpres, Bool.not_true, Bool.false_or, List.all_eq_true] at h'
  have := h' r2 h2
  simpa [hp] using this

/-- A session row keeps the identity invariant: its SDK id, when set, is its platform id. -/
def rowIdentity (r : Row) : Bool := (r.get "engine_session_id").all fun v => r.get "id" == some v

/-- Under today's identity invariant the unique index `(workspace_id, engine_session_id)` adds
nothing: any set of session rows with a unique `id` in which every SDK id is the platform id
already satisfies it. -/
@[aw_spec (tier := T5)
  (ts := "packages/core/src/db/schema/sessions.ts#sessions_workspace_engine_session_key")
  (ts := "apps/web/server/composition/session-launch.ts#recordReportedSessionIdentity")]
theorem sdk_session_key_is_redundant_under_the_identity (rows : List Row)
    (hid : rows.all rowIdentity = true) (hpk : keyHolds rows ["id"] [] = true) :
    keyHolds rows ["workspace_id", "engine_session_id"] [] = true := by
  simp only [keyHolds, List.all_nil]
  rw [List.filter_eq_self.mpr (fun _ _ => rfl), List.all_eq_true]
  intro r1 h1
  simp only [Bool.or_eq_true, Bool.not_eq_true', List.all_eq_true]
  by_cases hp : r1.present ["workspace_id", "engine_session_id"] = true
  · refine Or.inr fun r2 h2 => ?_
    by_cases hproj : r1.project ["workspace_id", "engine_session_id"] =
        r2.project ["workspace_id", "engine_session_id"]
    · have hc1 : (r1.get "engine_session_id").isSome = true := by
        simp [Row.present] at hp; exact hp.2
      obtain ⟨v, hv⟩ := Option.isSome_iff_exists.mp hc1
      have hv2 : r2.get "engine_session_id" = some v := by
        simp only [Row.project, List.map_cons, List.map_nil, List.cons.injEq] at hproj
        rw [← hproj.2.1, hv]
      have i1 := List.all_eq_true.mp hid r1 h1
      have i2 := List.all_eq_true.mp hid r2 h2
      simp only [rowIdentity, hv, hv2, Option.all_some, beq_iff_eq] at i1 i2
      have heq : r1 = r2 := keyHolds_elim hpk h1 h2 (by simp [Row.present, i1])
        (by simp [Row.project, i1, i2])
      simp [heq]
    · simp [hproj]
  · exact Or.inl (by simpa using hp)

/-- The transcript rows reference the platform id (`session_transcripts_session_workspace_fk`
targets `sessions (id, workspace_id)`), while the transcript routes are keyed by the SDK's session
id (`:engineSessionId`): only the identity invariant makes the two the same value. -/
@[aw_spec (tier := T5)
  (doc := "docs/sdk/04-api-specification.md#511-sessions-and-transcripts--awsessions")
  (ts := "packages/core/src/db/schema/session-transcripts.ts#session_transcripts_session_workspace_fk")
  (ts := "apps/web/server/sessions/api.ts#engineSessionId")]
theorem transcript_store_is_keyed_by_the_platform_id :
    (catalogue .sessionTranscripts).foreignKeySignature? "session_transcripts_session_workspace_fk" =
      some (["session_id", "workspace_id"], .sessions, ["id", "workspace_id"], .cascade) ∧
      (catalogue .sessions).isSingleKey "engine_session_id" = false := by
  decide

/-- The witness transcript, stored under a key that is not its workspace id. -/
def foreignKeyTranscript : Transcript :=
  { Witness.transcript with key := { Witness.transcript.key with projectKey := "shared-cwd" } }

/-- The witness state with that transcript and no messages. -/
def foreignKeyState : State := fun t =>
  if t = .sessionTranscripts then [ofCells (transcriptCells foreignKeyTranscript)]
  else if t = .sessionMessages then [] else Witness.state t

/-- The database admits a transcript whose `project_key` is not its `workspace_id`, although the
contract says the key "is the caller's workspace id by construction" and the repository refuses
any other: the invariant lives only in the repository. -/
@[aw_spec (tier := T5) (ts := "packages/contracts/src/sessions.ts#PROJECT_KEY_PATTERN")
  (ts := "packages/core/src/db/schema/session-transcripts.ts#sessionTranscripts")]
theorem database_admits_a_transcript_under_another_key :
    workConsistent foreignKeyState = true ∧ foreignKeyTranscript.projectKeyIsWorkspace = false := by
  decide +kernel

/-- A ledger row naming a provider no model connection can have. -/
def unknownProviderUsage : UsageRecord := { Witness.usage with provider := "made-up" }

/-- The witness state with that ledger row. -/
def unknownProviderState : State := fun t =>
  if t = .runUsageRecords then [ofCells (usageCells unknownProviderUsage)] else Witness.state t

/-- `runs.provider` is the closed set `MODEL_PROVIDERS`, but `run_usage_records.provider`, the
authoritative ledger, is free text: the database accepts a ledger row for a provider that does not
exist. -/
@[aw_spec (tier := T5)
  (ts := "packages/core/src/db/schema/run-usage-records.ts#runUsageRecords")
  (ts := "packages/core/src/db/schema/runs.ts#runs_provider_valid")]
theorem usage_record_provider_is_open_text :
    (catalogue .runs).oneOfCheck? "runs_provider_valid" =
        some ("provider", WireEnum.wires ModelProvider) ∧
      ((catalogue .runUsageRecords).checks.all fun
        | .oneOf _ c _ => c != "provider"
        | .other _ => true) = true ∧
      workConsistent unknownProviderState = true := by
  decide +kernel

/-- The catalogue, like `drizzle-kit`'s 0025 snapshot, records `NO ACTION` for the audit trail's
actor-principal key, while migration 0020 deploys `ON DELETE SET NULL (actor_principal_id)`
(Drizzle's DSL cannot express a column-list `SET NULL`). -/
@[aw_spec (tier := T5)
  (ts := "packages/core/src/db/schema/audit-events.ts#audit_events_actor_principal_workspace_fk")
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")]
theorem audit_actor_key_is_recorded_as_no_action :
    (catalogue .auditEvents).foreignKeySignature? "audit_events_actor_principal_workspace_fk" =
      some (["workspace_id", "actor_principal_id"], .workspacePrincipals, ["workspace_id", "id"],
        .noAction) := by
  decide

/-- The "not blank" checks use one-argument `btrim`, which strips spaces only: a name or label of
tabs or line breaks passes the database, although the project routes refuse it (they test
`name.trim()`, which strips all white space). The database is weaker than the route. -/
@[aw_spec (tier := T5) (ts := "packages/core/src/db/schema/projects.ts#projects_name_not_blank")
  (ts := "packages/core/src/db/schema/audit-events.ts#audit_events_actor_label_not_blank")
  (ts := "apps/web/server/projects/http.ts#parseProject")]
theorem blank_checks_trim_spaces_only :
    workCheckHolds "projects_name_not_blank" ⟨[("name", "	
")]⟩ = true ∧
      workCheckHolds "projects_name_not_blank" ⟨[("name", "   ")]⟩ = false ∧
      workCheckHolds "audit_events_actor_label_not_blank" ⟨[("actor_label", "	")]⟩ = true := by
  decide

/-- The ledger's "recorded, at `cost_usd = '0'`" rule for unpriced responses is kept by the
repository only: a ledger row with no price table version and a nonzero cost passes every
`run_usage_records` check while breaking the rule. -/
@[aw_spec (tier := T5) (ts := "packages/core/src/db/schema/run-usage-records.ts#runUsageRecords")
  (ts := "packages/core/src/db/schema/run-usage-records.ts#run_usage_records_counters_non_negative")]
theorem ledger_admits_an_unpriced_charge :
    let u : UsageRecord := { Witness.usage with priceTableVersion := none }
    u.wellFormed = true ∧ u.isPriced = false ∧ u.unpricedIsZero = false := by
  decide

/-! ## Witnesses -/

/-- The witness sessions keep the identity invariant and a unique id, so the redundancy theorem
applies to them. -/
example : keyHolds (Witness.state .sessions) ["workspace_id", "engine_session_id"] [] = true :=
  sdk_session_key_is_redundant_under_the_identity _ (by decide +kernel) (by decide +kernel)

end AgentWorkspace.Theorems.Meta.ConceptWork
