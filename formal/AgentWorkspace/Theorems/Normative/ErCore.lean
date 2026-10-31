import ErSnapshot
import AgentWorkspace.Er.Core

/-! T1 — documented sentences about the schema, each pinned to the catalogue. -/

namespace AgentWorkspace.Theorems.Normative.ErCore

open AgentWorkspace AgentWorkspace.Er.Core

/-- "A workspace is the tenant": `workspaces` is the tenant root, `users`, `user_identities` and
the deployment-wide `storage_migration_runs` are the only global tables, and every other table is
tenant-scoped. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#workspace-and-principal")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#TENANT_EXEMPT")]
theorem workspace_is_the_tenant_root :
    (catalogue .workspaces).tenancy = .root ∧
      allTables.filter (fun t => (catalogue t).tenancy == .global) = [.storageMigrationRuns, .userIdentities, .users] ∧
      (allTables.filter fun t => (catalogue t).tenancy == .scoped).length =
        Er.Snapshot.tableCount - 4 := by
  decide +kernel

/-- "Every tenant-owned table carries `workspace_id`": every scoped table has a `NOT NULL uuid`
`workspace_id` column, and no other table has one. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#TENANT_EXEMPT")]
theorem tenant_scoped_iff_workspace_column (t : TableName) :
    ((catalogue t).tenancy == .scoped) = (catalogue t).hasColumn "workspace_id" ∧
      ((catalogue t).tenancy == .scoped →
        (catalogue t).column? "workspace_id" = some ⟨"workspace_id", .uuid, true⟩) := by
  cases t <;> decide +kernel

/-- `REQUIRED_REFERENCES`: `sessions_member_workspace_fk` exists with exactly the columns
`(workspace_id, user_id) → memberships (workspace_id, user_id)` and is tenant-paired, so a session's
person holds a membership in the session's workspace. -/
@[aw_spec (tier := T1) (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#REQUIRED_REFERENCES")
  (ts := "packages/core/src/db/schema/sessions.ts#sessions_member_workspace_fk")]
theorem session_member_reference_is_required :
    (catalogue .sessions).foreignKey? "sessions_member_workspace_fk" =
        some { name := "sessions_member_workspace_fk", columns := ["workspace_id", "user_id"],
               refTable := .memberships, refColumns := ["workspace_id", "user_id"],
               onDelete := .noAction, inline := false } ∧
      fkVerdict catalogue .sessions "sessions_member_workspace_fk" = some (true, .tenantPaired) := by
  decide +kernel

/-- ADR-0083: a CLI sign-in names its person through their Membership —
`cli_sessions_member_workspace_fk` is `(workspace_id, user_id) → memberships (workspace_id,
user_id)`, tenant-paired and `ON DELETE CASCADE` — so a sign-in exists only while its person is a
member of its workspace, and moving it to a workspace where they are not is refused. -/
@[aw_spec (tier := T1) (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")
  (ts := "packages/core/src/db/schema/cli-sessions.ts#cli_sessions_member_workspace_fk")]
theorem cli_session_member_reference_is_required :
    (catalogue .cliSessions).foreignKey? "cli_sessions_member_workspace_fk" =
        some { name := "cli_sessions_member_workspace_fk", columns := ["workspace_id", "user_id"],
               refTable := .memberships, refColumns := ["workspace_id", "user_id"],
               onDelete := .cascade, inline := false } ∧
      fkVerdict catalogue .cliSessions "cli_sessions_member_workspace_fk" =
        some (true, .tenantPaired) := by
  decide +kernel

/-- "The source pair is tenant-paired" (the comment on `workspacePrincipals`): a principal's
membership and API-key sources are each referenced through a tenant-paired key, and the kind
check admits exactly `membership` and `api_key`. -/
@[aw_spec (tier := T1) (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")
  (ts := "packages/core/src/db/schema/workspace-principals.ts#workspacePrincipals")]
theorem principal_sources_are_tenant_paired :
    fkVerdict catalogue .workspacePrincipals "workspace_principals_membership_workspace_fk" =
        some (true, .tenantPaired) ∧
      fkVerdict catalogue .workspacePrincipals "workspace_principals_api_key_workspace_fk" =
        some (true, .tenantPaired) ∧
      (catalogue .workspacePrincipals).checks.contains
        (.oneOf "workspace_principals_kind_valid" "kind" ["membership", "api_key"]) = true := by
  decide +kernel

/-- The owner columns: `owner_principal_id` is `NOT NULL` on agents, files, connectors, projects,
sessions and skills, and each references `workspace_principals` through a tenant-paired key. -/
@[aw_spec (tier := T1) (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
theorem owned_tables_have_a_paired_owner_principal :
    [TableName.agents, .files, .mcpServers, .projects, .sessions, .skills].all (fun t =>
      (catalogue t).isNotNull "owner_principal_id" &&
        (catalogue t).foreignKeys.any fun fk =>
          fk.columns == ["workspace_id", "owner_principal_id"] &&
            fk.refTable == .workspacePrincipals && classify catalogue t fk == .tenantPaired) = true := by
  decide +kernel

/-- The owner equivalents: `shares.publisher_principal_id` and
`browser_tokens.minted_by_principal_id` are `NOT NULL`, `audit_events.actor_principal_id` is
nullable, and all three reference `workspace_principals` through a tenant-paired key. -/
@[aw_spec (tier := T1) (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")
  (ts := "packages/core/src/db/schema/shares.ts#shares_publisher_principal_workspace_fk")
  (ts := "packages/core/src/db/schema/browser-tokens.ts#browser_tokens_minter_workspace_fk")
  (ts := "packages/core/src/db/schema/audit-events.ts#audit_events_actor_principal_workspace_fk")]
theorem owner_equivalents_are_paired :
    (catalogue .shares).isNotNull "publisher_principal_id" = true ∧
      (catalogue .browserTokens).isNotNull "minted_by_principal_id" = true ∧
      (catalogue .auditEvents).isNotNull "actor_principal_id" = false ∧
      (catalogue .auditEvents).hasColumn "actor_principal_id" = true ∧
      fkVerdict catalogue .shares "shares_publisher_principal_workspace_fk" = some (true, .tenantPaired) ∧
      fkVerdict catalogue .browserTokens "browser_tokens_minter_workspace_fk" =
        some (true, .tenantPaired) ∧
      fkVerdict catalogue .auditEvents "audit_events_actor_principal_workspace_fk" =
        some (true, .tenantPaired) := by
  decide +kernel

/-- "`agent_grants` stores the membership's `user_id`": a grant row has a `user_id`, no principal
column, and its person is pinned to a membership of the grant's workspace. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")
  (ts := "packages/core/src/db/schema/agent-grants.ts#agent_grants_member_workspace_fk")]
theorem agent_grants_store_the_membership_user :
    (catalogue .agentGrants).isNotNull "user_id" = true ∧
      (catalogue .agentGrants).columnNames.any (fun c => c == "principal_id") = false ∧
      fkVerdict catalogue .agentGrants "agent_grants_member_workspace_fk" =
        some (true, .tenantPaired) := by
  decide +kernel

/-- "A named `CHECK (<column> IN (...))` constraint over a closed set of string values": the
closed-set check `agent_files_access_valid` accepts rows whose `access` is `read` or
`read-write`, refuses a row with any other value (including a differently cased one), and, as
SQL's `NULL IN (…)` is not false, passes a row whose `access` is `NULL`. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/schema/one-of.ts#oneOf")
  (ts := "packages/core/src/db/schema/agent-files.ts#agentFiles")]
theorem closed_set_check_admits_only_its_values :
    let ck := Check.oneOf "agent_files_access_valid" "access" ["read", "read-write"]
    (catalogue .agentFiles).check? "agent_files_access_valid" = some ck ∧
      checkHolds [⟨[("access", "read")]⟩, ⟨[("access", "read-write")]⟩] ck = true ∧
      checkHolds [⟨[("access", "read")]⟩, ⟨[("access", "write")]⟩] ck = false ∧
      checkHolds [⟨[("access", "READ")]⟩] ck = false ∧
      checkHolds [⟨[("id", "af1")]⟩] ck = true := by
  decide +kernel

/-- The composite unique targets: exactly these 19 tables declare a unique key over
`{id, workspace_id}`, the target of every tenant-paired reference into them. -/
@[aw_spec (tier := T1) (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
theorem composite_unique_targets :
    allTables.filter (fun t => (catalogue t).uniques.any fun u =>
        sameColumns u.columns ["id", "workspace_id"] && u.partialNullColumns.isEmpty &&
          u.partialNotNullColumns.isEmpty) =
      [.agentVersions, .agents, .apiKeys, .endpointClients, .files, .mcpServers, .memberships, .modelConnections, .projects, .runs,
        .runtimeProfiles, .secrets, .sessions, .storageConnections, .shares, .skills, .triggers, .workspacePrincipals,
        .webhooks] := by
  decide +kernel

/-- The five partial unique keys: at most one built-in agent per workspace and key (ordinary agents
carry no key and are outside the index), at most one file row per workspace and object id (rows
without one are outside the index), at most one pending (neither accepted nor revoked) invitation
per workspace and address, at most one run per workspace and start idempotency key (runs without a key
are outside the index), and at most one continuation per paused run (runs that continue nothing are
outside the index). -/
@[aw_spec (tier := T1) (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")
  (ts := "packages/core/src/db/schema/agents.ts#agents")
  (ts := "packages/core/src/db/schema/files.ts#files")
  (ts := "packages/core/src/db/schema/invitations.ts#invitations")
  (ts := "packages/core/src/db/schema/runs.ts#runs")]
theorem the_partial_unique_keys_are_builtin_agents_file_objects_pending_invitations_run_keys_and_continuations :
    (allTables.flatMap fun t => ((catalogue t).uniques.filter fun u =>
        !u.partialNullColumns.isEmpty || !u.partialNotNullColumns.isEmpty)) =
      [{ name := "agents_workspace_builtin_key", columns := ["workspace_id", "builtin_key"],
         kind := .index, partialNullColumns := [], partialNotNullColumns := ["builtin_key"] },
       { name := "files_workspace_object_key", columns := ["workspace_id", "object_id"],
         kind := .index, partialNullColumns := [], partialNotNullColumns := ["object_id"] },
       { name := "invitations_workspace_email_pending_key", columns := ["workspace_id", "email"],
         kind := .index, partialNullColumns := ["accepted_at", "revoked_at"] },
       { name := "runs_workspace_idempotency_key_unique", columns := ["workspace_id", "idempotency_key"],
         kind := .index, partialNullColumns := [], partialNotNullColumns := ["idempotency_key"] },
       { name := "runs_continues_run_id_unique", columns := ["continues_run_id"],
         kind := .index, partialNullColumns := [], partialNotNullColumns := ["continues_run_id"] }] := by
  decide +kernel

/-- Runs carry no `agent_id`: a run's agent is its session's (the only run parent is the session,
through `runs_session_workspace_fk`, which cascades). -/
@[aw_spec (tier := T1) (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")
  (ts := "packages/core/src/db/schema/runs.ts#runs_session_workspace_fk")]
theorem runs_reach_their_agent_through_the_session :
    (catalogue .runs).hasColumn "agent_id" = false ∧
      (catalogue .runs).foreignKey? "runs_session_workspace_fk" =
        some { name := "runs_session_workspace_fk", columns := ["session_id", "workspace_id"],
               refTable := .sessions, refColumns := ["id", "workspace_id"],
               onDelete := .cascade, inline := false } := by
  decide +kernel

/-- "A principal has one source: a human Membership or a machine API key": the
`workspace_principals_source_xor` check accepts a membership principal with only a membership, and
an API-key principal with only a key, and refuses a principal with both sources, with none, or
with the source that does not match its kind. -/
@[aw_spec (tier := T1) (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")
  (ts := "packages/core/src/db/schema/workspace-principals.ts#workspacePrincipals")]
theorem principal_has_the_source_its_kind_names :
    (catalogue .workspacePrincipals).check? "workspace_principals_source_xor" =
        some (.other "workspace_principals_source_xor") ∧
      checkHolds [⟨[("kind", "membership"), ("membership_id", "m1")]⟩,
          ⟨[("kind", "api_key"), ("api_key_id", "k1")]⟩]
        (.other "workspace_principals_source_xor") = true ∧
      checkHolds [⟨[("kind", "membership"), ("membership_id", "m1"), ("api_key_id", "k1")]⟩]
        (.other "workspace_principals_source_xor") = false ∧
      checkHolds [⟨[("kind", "membership")]⟩] (.other "workspace_principals_source_xor") = false ∧
      checkHolds [⟨[("kind", "membership"), ("api_key_id", "k1")]⟩]
        (.other "workspace_principals_source_xor") = false ∧
      checkHolds [⟨[("kind", "api_key"), ("membership_id", "m1")]⟩]
        (.other "workspace_principals_source_xor") = false := by
  decide +kernel

/-- The partial unique key `invitations_workspace_email_pending_key`: two pending invitations to
one address in one workspace violate it, while an accepted or revoked invitation does not count,
so it may coexist with a pending one to the same address. -/
@[aw_spec (tier := T1) (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")
  (ts := "packages/core/src/db/schema/invitations.ts#invitations_workspace_email_pending_key")]
theorem pending_invitations_are_unique_per_address :
    let key := (catalogue .invitations).unique? "invitations_workspace_email_pending_key"
    let holds := fun rows => key.map fun u => keyHolds rows u.columns u.partialNullColumns
    let pending := fun i : String => (⟨[("id", i), ("workspace_id", "w1"),
      ("email", "a@example.com")]⟩ : Row)
    let accepted : Row := ⟨[("id", "i3"), ("workspace_id", "w1"), ("email", "a@example.com"),
      ("accepted_at", "t1")]⟩
    let revoked : Row := ⟨[("id", "i4"), ("workspace_id", "w1"), ("email", "a@example.com"),
      ("revoked_at", "t1")]⟩
    let elsewhere : Row := ⟨[("id", "i5"), ("workspace_id", "w2"), ("email", "a@example.com")]⟩
    holds [pending "i1", pending "i2"] = some false ∧
      holds [pending "i1", accepted, revoked] = some true ∧
      holds [pending "i1", elsewhere] = some true := by
  decide +kernel

end AgentWorkspace.Theorems.Normative.ErCore
