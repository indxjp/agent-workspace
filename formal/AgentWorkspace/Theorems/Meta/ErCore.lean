import AgentWorkspace.Er.Core

/-!
T5 — properties of the ER specification itself, including the places where it contradicts
itself or a document (the findings of the `er-core` unit, `docs/20-design/formal/units/er-core.md`).
-/

namespace AgentWorkspace.Theorems.Meta.ErCore

open AgentWorkspace AgentWorkspace.Er.Core

/-- `ON DELETE SET NULL` nulls every column of the key. Exactly two keys of today's schema are
composite `SET NULL` keys that include the `NOT NULL` `workspace_id`, so the action they declare
cannot execute: deleting the parent fails with a `NOT NULL` violation instead (finding: see
`docs/20-design/formal/units/er-core.md`). Every other `SET NULL` key is executable. -/
@[aw_spec (tier := T5) (ts := "packages/core/src/db/tenancy-readers.test-support.ts#referenceIdentityOf")
  (ts := "packages/core/src/db/schema/projects.ts#projects_default_agent_workspace_fk")
  (ts := "packages/core/src/db/schema/sessions.ts#sessions_project_workspace_fk")]
theorem unexecutable_set_null_keys :
    allTables.flatMap (fun t => ((catalogue t).foreignKeys.filter
        fun fk => !setNullSound catalogue t fk).map (·.name)) =
      ["projects_default_agent_workspace_fk", "sessions_project_workspace_fk"] := by
  decide +kernel

private theorem lookup_filtered (c : String) (cs : List String) (hc : c ∈ cs) :
    ∀ l : List (String × String), (l.filter fun p => !cs.contains p.1).lookup c = none
  | [] => rfl
  | (k, b) :: ps => by
    by_cases h : cs.contains k = true
    · rw [List.filter_cons_of_neg (by simpa using h)]
      exact lookup_filtered c cs hc ps
    · rw [List.filter_cons_of_pos (by simpa using h)]
      have hne : c ≠ k := by
        rintro rfl
        simp_all
      have hb : (c == k) = false := by simpa using hne
      simp only [List.lookup_cons, hb]
      exact lookup_filtered c cs hc ps

/-- `projects_default_agent_workspace_fk` is `ON DELETE SET NULL`, and for any project row,
clearing that key's columns (what the action does when the default agent is deleted) leaves the
row violating the catalogue's `NOT NULL` on `projects.workspace_id`. -/
@[aw_spec (tier := T5) (ts := "packages/core/src/db/tenancy-readers.test-support.ts#referenceIdentityOf")
  (ts := "packages/core/src/db/schema/projects.ts#projects_default_agent_workspace_fk")]
theorem project_default_agent_set_null_violates_not_null :
    ∃ fk c, (catalogue .projects).foreignKey? "projects_default_agent_workspace_fk" = some fk ∧
      (catalogue .projects).column? "workspace_id" = some c ∧ fk.onDelete = .setNull ∧
      ∀ r : Row, notNullHolds [r.nullify fk.columns] c = false := by
  refine
    ⟨{ name := "projects_default_agent_workspace_fk",
       columns := ["default_agent_id", "workspace_id"], refTable := .agents,
       refColumns := ["id", "workspace_id"], onDelete := .setNull, inline := false },
      ⟨"workspace_id", .uuid, true⟩, by decide +kernel, by decide +kernel, rfl, ?_⟩
  intro r
  simp only [notNullHolds, Bool.not_true, Bool.false_or, List.all_cons, List.all_nil,
    Bool.and_true, Row.get, Row.nullify]
  rw [lookup_filtered "workspace_id" _ (by decide +kernel) r.cells]
  rfl

/-- The structure map says "`created_at` and `updated_at` are present on every table"; in today's
schema six tables have neither and twenty more have no `updated_at` (finding). -/
@[aw_spec (tier := T5) (doc := "docs/10-product/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
theorem timestamps_are_not_on_every_table :
    allTables.filter (fun t => !(catalogue t).hasColumn "created_at") =
        [.agentPointerMoves, .demoDailyCosts, .demoEntryStates, .endpointClientAgents, .endpointClientApiKeys, .projectFiles,
          .projectMcpServers, .runtimeVerifications, .storageMigrationRuns,
          .agentTeamVersionMembers] ∧
      allTables.filter (fun t => !(catalogue t).hasColumn "updated_at") =
        [.agentGrants, .agentMcpServers, .agentSkills, .agentStorageGrants,
          .agentVersionStorageGrants, .agentPointerMoves, .agentVersionEvaluations, .agentVersions,
          .auditEvents,
          .browserTokens, .builderToolCalls, .cliSessions, .demoRunAdmissions, .endpointClientAgents, .endpointClientApiKeys, .fileTexts, .loginTokens, .oauthTokens, .projectFiles, .projectMcpServers, .runEvents,
          .runFeedback, .runUsageRecords, .runTokens, .runtimeVerifications, .sessionMessages, .sessionStateEntries, .storageMigrationRuns, .storeLeads, .shareViews,
          .shares, .skillRevisions, .surfaceSessionKeys, .triggerDeliveries, .workspacePrincipals,
          .workspaceFeatures, .webhooks, .webhookDeliveries, .agentTeamVersions,
          .agentTeamVersionMembers] := by
  decide +kernel

/-- The structure map says "every cross-table foreign key is composite on `(id, workspace_id)`";
in today's schema the single-column keys other than the root references are the eight
references to `users` and the seven `SET NULL` siblings, and neither kind can cross a tenant
(finding: the sentence should say "tenant-paired, by itself or by a sibling"). -/
@[aw_spec (tier := T5) (doc := "docs/10-product/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")
  (ts := "packages/core/src/db/tenancy-readers.test-support.ts#referenceIdentityOf")]
theorem single_column_references_are_global_or_siblings :
    (allTables.flatMap fun t => ((catalogue t).foreignKeys.filter fun fk =>
        fk.columns.length == 1 && classify catalogue t fk != .rootReference).map
          fun fk => classify catalogue t fk) =
      [.siblingPaired, .siblingPaired, .siblingPaired, .globalReference, .globalReference,
        .globalReference, .globalReference, .siblingPaired, .globalReference, .siblingPaired, .siblingPaired,
        .globalReference, .globalReference, .globalReference, .siblingPaired] := by
  decide +kernel

/-- The closed-set values of every `CHECK … IN (…)` would pass the `oneOf` gate, except
`workspace_principals_kind_valid`, whose `api_key` is not a kebab-case slug; that check is
written by hand, which is why the wire spells the kind `api-key` (finding, naming).
`runs_status_valid` passes the gate in its snake shape (`renderOneOf?`, ADR-0145 D1). -/
@[aw_spec (tier := T5) (ts := "packages/core/src/db/schema/one-of.ts#renderValueList")
  (ts := "packages/core/src/db/schema/workspace-principals.ts#workspace_principals_kind_valid")
  (ts := "packages/contracts/src/team.ts#PRINCIPAL_KINDS")]
theorem only_principal_kind_escapes_the_value_gate :
    (allTables.flatMap fun t => (catalogue t).checks.filterMap fun
        | .oneOf n _ vs => if (renderOneOf? n vs).isNone then some n else none
        | .other _ => none) = ["workspace_principals_kind_valid"] := by
  decide +kernel

/-- The header of `workspaces.ts` says it is "one of exactly two tables … that carry no
`workspace_id`"; today there are nine (finding): the two identity tables, the tenant root, the
deployment-wide `storage_migration_runs` and the Agent Store's `login_tokens`, `demo_run_admissions`,
`demo_daily_costs`, `demo_entry_states` and `store_leads`. -/
@[aw_spec (tier := T5) (ts := "packages/core/src/db/schema/workspaces.ts#workspaces")
  (ts := "packages/core/src/db/tenancy-readers.test-support.ts#TENANT_EXEMPT")]
theorem three_tables_carry_no_workspace_id :
    allTables.filter (fun t => !(catalogue t).hasColumn "workspace_id") =
      [.demoDailyCosts, .demoEntryStates, .demoRunAdmissions, .loginTokens, .storageMigrationRuns,
        .storeLeads, .userIdentities, .users, .workspaces] := by
  decide +kernel

/-- The `columns.ts` comment says "Every table's primary key is a database-generated UUID"; sixteen
tables are keyed otherwise (finding 4): the agent-version pointers (one per agent and
environment), the endpoint client's agents and its bound API keys (one binding per key), the two
project join tables, the run-event and transcript tables, the three ENG-06 session-state tables,
the per-run share charge, the per-session surface key, an agent-team version's members (one per
version and agent), the per-UTC-day demo cost (`demo_daily_costs`, keyed by `day`) and the
verdict on each live store entry (`demo_entry_states`, keyed by `entry`). -/
@[aw_spec (tier := T5) (doc := "docs/20-design/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")
  (ts := "packages/core/src/db/schema/columns.ts#primaryKeyId")]
theorem primary_keys_other_than_id :
    allTables.filterMap (fun t =>
        if (catalogue t).primaryKey == ["id"] then none else some (t, (catalogue t).primaryKey)) =
      [(.agentVersionPointers, ["agent_id", "environment"]),
        (.demoDailyCosts, ["day"]),
        (.demoEntryStates, ["entry"]),
        (.endpointClientAgents, ["client_id", "agent_id"]),
        (.endpointClientApiKeys, ["api_key_id"]),
        (.projectFiles, ["project_id", "file_id"]),
        (.projectMcpServers, ["project_id", "mcp_server_id"]),
        (.runEvents, ["run_id", "sequence"]),
        (.sessionMessages, ["workspace_id", "project_key", "session_id", "subpath", "sequence"]),
        (.sessionStateBlobs, ["workspace_id", "session_id", "engine", "blob_key"]),
        (.sessionStateEntries,
          ["workspace_id", "session_id", "engine", "stream_key", "sequence"]),
        (.sessionStateStreams, ["workspace_id", "session_id", "engine", "stream_key"]),
        (.sessionTranscripts, ["workspace_id", "project_key", "session_id", "subpath"]),
        (.shareRunCharges, ["run_id"]),
        (.surfaceSessionKeys, ["session_id"]),
        (.agentTeamVersionMembers, ["team_version_id", "agent_id"])] := by
  decide +kernel


/-- `docs/architecture.md` says the two-file Drizzle cycle "expresses the tenant-scoped composite
foreign keys in both directions"; only one direction is composite (finding 6): `workspaces`
references its default connection through the composite key paired on its own `id` (with a
single-column `SET NULL` sibling), while `model_connections` references `workspaces` through the
single-column `workspace_id` root reference, which no composite key accompanies. -/
@[aw_spec (tier := T5) (doc := "docs/architecture.md#dependency-rules")
  (ts := "packages/core/src/db/schema/workspaces.ts#workspaces_default_model_connection_workspace_fk")
  (ts := "packages/core/src/db/schema/model-connections.ts#modelConnections")]
theorem drizzle_cycle_is_composite_in_one_direction_only :
    fkVerdict catalogue .workspaces "workspaces_default_model_connection_workspace_fk" =
        some (true, .tenantPaired) ∧
      ((catalogue .workspaces).foreignKey?
          "workspaces_default_model_connection_workspace_fk").map (·.columns.length) = some 2 ∧
      fkVerdict catalogue .workspaces
          "workspaces_default_model_connection_id_model_connections_id_fk" =
        some (true, .siblingPaired) ∧
      (catalogue .modelConnections).foreignKeys.filter (·.refTable == .workspaces) =
        [{ name := "model_connections_workspace_id_workspaces_id_fk", columns := ["workspace_id"],
           refTable := .workspaces, refColumns := ["id"], onDelete := .cascade,
           inline := true }] ∧
      fkVerdict catalogue .modelConnections "model_connections_workspace_id_workspaces_id_fk" =
        some (true, .rootReference) := by
  decide +kernel

end AgentWorkspace.Theorems.Meta.ErCore
