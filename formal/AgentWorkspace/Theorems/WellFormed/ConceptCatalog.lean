import AgentWorkspace.Er.Current.Catalog

/-!
T0 — the catalog concepts are coherent with each other, with today's table catalogue and with
their wire spellings.

The concept enumerations spell exactly the closed sets the schema's CHECKs list; each concept's
column list is exactly its table's; every non-closed-set check on the cluster's tables has a
semantics; every reference of the cluster targets an exact key; and the cluster's constraints are
jointly satisfiable.
-/

namespace AgentWorkspace.Theorems.WellFormed.ConceptCatalog

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Er.Current.Catalog
open AgentWorkspace.Concepts

/-! ## Wire spellings -/

/-- A file node is spelled `file` or `folder`, in that order. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/files.ts#FILE_KINDS")
  (ts := "packages/core/src/db/schema/files.ts#fileKinds")]
theorem file_kind_wires : WireEnum.wires File.FileKind = ["file", "folder"] := by decide

/-- File access is spelled `read` or `read-write`, in that order. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/agent-files.ts#fileAccessModes")]
theorem file_access_wires : WireEnum.wires Grant.FileAccess = ["read", "read-write"] := by decide

/-- A connector's kind is spelled `mcp`, `openapi` or `postgres`, in that order (ADR-0113 C15). -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/connectors.ts#CONNECTOR_KINDS")
  (ts := "packages/core/src/db/schema/mcp-servers.ts#connectorKinds")]
theorem connector_kind_wires : WireEnum.wires Connector.Kind = ["mcp", "openapi", "postgres"] := by
  decide

/-- A connector's transport is spelled `stdio`, `http` or `sse`, in that order. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/connectors.ts#CONNECTOR_TRANSPORTS")
  (ts := "packages/core/src/db/schema/mcp-servers.ts#mcpTransports")]
theorem transport_wires : WireEnum.wires Connector.Transport = ["stdio", "http", "sse"] := by
  decide

/-- A connector's authentication type is spelled `none`, `api-key`, `bearer` or `oauth`, in that
order. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/connectors.ts#CONNECTOR_AUTH_TYPES")
  (ts := "packages/core/src/db/schema/mcp-servers.ts#mcpAuthTypes")]
theorem auth_type_wires :
    WireEnum.wires Connector.AuthType = ["none", "api-key", "bearer", "oauth"] := by
  decide

/-- Every member of the five catalog enumerations decodes from its own JSON encoding. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/files.ts#FILE_KINDS")
  (ts := "packages/contracts/src/connectors.ts#CONNECTOR_KINDS")
  (ts := "packages/contracts/src/connectors.ts#CONNECTOR_TRANSPORTS")
  (ts := "packages/contracts/src/connectors.ts#CONNECTOR_AUTH_TYPES")
  (ts := "packages/core/src/db/schema/agent-files.ts#fileAccessModes")]
theorem catalog_enums_round_trip :
    (∀ k : File.FileKind, WireEnum.fromJsonValue? (WireEnum.toJsonValue k) = some k) ∧
    (∀ a : Grant.FileAccess, WireEnum.fromJsonValue? (WireEnum.toJsonValue a) = some a) ∧
    (∀ k : Connector.Kind, WireEnum.fromJsonValue? (WireEnum.toJsonValue k) = some k) ∧
    (∀ t : Connector.Transport, WireEnum.fromJsonValue? (WireEnum.toJsonValue t) = some t) ∧
    (∀ a : Connector.AuthType, WireEnum.fromJsonValue? (WireEnum.toJsonValue a) = some a) :=
  ⟨WireEnum.fromJsonValue?_toJsonValue, WireEnum.fromJsonValue?_toJsonValue,
    WireEnum.fromJsonValue?_toJsonValue, WireEnum.fromJsonValue?_toJsonValue,
    WireEnum.fromJsonValue?_toJsonValue⟩

/-- A spelling that differs from every member by case or a near miss decodes to nothing. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/connectors.ts#CONNECTOR_AUTH_TYPES")]
theorem catalog_enums_reject_near_misses :
    WireEnum.ofWire? (α := File.FileKind) "Folder" = none ∧
    WireEnum.ofWire? (α := Grant.FileAccess) "read_write" = none ∧
    WireEnum.ofWire? (α := Grant.FileAccess) "write" = none ∧
    WireEnum.ofWire? (α := Connector.Kind) "MCP" = none ∧
    WireEnum.ofWire? (α := Connector.Kind) "grpc" = none ∧
    WireEnum.ofWire? (α := Connector.Transport) "streamable-http" = none ∧
    WireEnum.ofWire? (α := Connector.AuthType) "api_key" = none ∧
    WireEnum.ofWire? (α := Connector.AuthType) "basic" = none := by
  decide

/-! ## The concept enumerations are the schema's closed sets -/

/-- `files_kind_valid` admits exactly the file kinds. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/files.ts#files")]
theorem files_kind_check_is_the_kinds :
    (catalogue .files).oneOfCheck? "files_kind_valid" =
      some ("kind", WireEnum.wires File.FileKind) := by
  decide

/-- `agent_files_access_valid` admits exactly the access modes. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/agent-files.ts#agentFiles")]
theorem agent_files_access_check_is_the_modes :
    (catalogue .agentFiles).oneOfCheck? "agent_files_access_valid" =
      some ("access", WireEnum.wires Grant.FileAccess) := by
  decide

/-- `mcp_servers_kind_valid` admits exactly the connector kinds, so the catalogue's value list is
the `Kind` wires. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/mcp-servers.ts#mcpServers")
  (ts := "packages/core/src/db/schema/mcp-servers.ts#connectorKinds")]
theorem mcp_servers_kind_check_is_the_kinds :
    (catalogue .mcpServers).oneOfCheck? "mcp_servers_kind_valid" =
      some ("kind", WireEnum.wires Connector.Kind) := by
  decide

/-- `mcp_servers_transport_valid` admits exactly the transports. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/mcp-servers.ts#mcpServers")]
theorem mcp_servers_transport_check_is_the_transports :
    (catalogue .mcpServers).oneOfCheck? "mcp_servers_transport_valid" =
      some ("transport", WireEnum.wires Connector.Transport) := by
  decide

/-- `mcp_servers_auth_type_valid` admits exactly the authentication types. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/mcp-servers.ts#mcpServers")]
theorem mcp_servers_auth_type_check_is_the_auth_types :
    (catalogue .mcpServers).oneOfCheck? "mcp_servers_auth_type_valid" =
      some ("auth_type", WireEnum.wires Connector.AuthType) := by
  decide

/-- The remote transports are `http` and `sse`, and the value list the `remote_has_url` check
inlines is rendered by `renderValueList` from exactly them. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/mcp-servers.ts#remoteMcpTransports")
  (ts := "packages/core/src/db/schema/one-of.ts#renderValueList")]
theorem remote_transports_are_http_and_sse :
    ((WireEnum.all : List Connector.Transport).filter Connector.Transport.isRemote).map
        WireEnum.toWire = ["http", "sse"] ∧
      renderValueList? ["http", "sse"] = some "('http', 'sse')" := by
  decide

/-- The credentialed authentication types are every one except `none`, and the value list the
`credential_required` check inlines is rendered from exactly them. -/
@[aw_spec (tier := T0)
  (ts := "packages/core/src/db/schema/mcp-servers.ts#credentialedMcpAuthTypes")
  (ts := "packages/core/src/db/schema/one-of.ts#renderValueList")]
theorem credentialed_auth_types_are_all_but_none :
    ((WireEnum.all : List Connector.AuthType).filter Connector.AuthType.needsCredential).map
        WireEnum.toWire = ["api-key", "bearer", "oauth"] ∧
      renderValueList? ["api-key", "bearer", "oauth"] = some "('api-key', 'bearer', 'oauth')" := by
  decide

/-! ## Each concept covers every column of its table -/

/-- The agent concept maps every column of `agents`, in order. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/agents.ts#agents")]
theorem agent_concept_covers_every_column : Agent.dbColumns = (catalogue .agents).columnNames := by
  decide

/-- The file concept maps every column of `files`, in order. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/files.ts#files")]
theorem file_concept_covers_every_column : File.dbColumns = (catalogue .files).columnNames := by
  decide

/-- The skill concept maps every column of `skills`, in order. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/skills.ts#skills")]
theorem skill_concept_covers_every_column : Skill.dbColumns = (catalogue .skills).columnNames := by
  decide

/-- The connector concept maps every column of `mcp_servers`, in order. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/mcp-servers.ts#mcpServers")]
theorem connector_concept_covers_every_column :
    Connector.dbColumns = (catalogue .mcpServers).columnNames := by
  decide

/-- The assignment, grant and project link concepts map every column of their six tables. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/agent-files.ts#agentFiles")
  (ts := "packages/core/src/db/schema/agent-grants.ts#agentGrants")
  (ts := "packages/core/src/db/schema/project-files.ts#projectFiles")]
theorem link_concepts_cover_every_column :
    Grant.dbColumns =
      [TableName.agentFiles, .agentSkills, .agentMcpServers, .agentGrants, .projectFiles,
        .projectMcpServers].map fun t => (TableName.toWire t, (catalogue t).columnNames) := by
  decide

/-! ## The cluster's checks and references -/

/-- Every check on the cluster's tables that is not a closed set has a modelled semantics, and
every modelled check exists on its table. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/files.ts#files")
  (ts := "packages/core/src/db/schema/mcp-servers.ts#mcpServers")]
theorem every_cluster_check_is_modelled :
    (tables.all fun t => (catalogue t).checks.all fun
      | .other n => modelledChecks.contains (t, n)
      | .oneOf .. => true) = true ∧
    (modelledChecks.all fun (t, n) => ((catalogue t).check? n).isSome) = true ∧
    (modelledChecks.map (·.2)) = checkSql.map (·.1) := by
  decide

/-- The cluster has 49 foreign keys, and each targets an exact key of its parent (the primary
key or a total unique key, column for column), so a child row can name at most one parent. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
theorem every_cluster_reference_targets_an_exact_key :
    clusterForeignKeys.length = 49 ∧
      (clusterForeignKeys.all fun (_, fk) => targetIsExactKey catalogue fk) = true := by
  decide

/-- The cluster's constraints are jointly satisfiable, non-trivially: the sample state holds a row
in every one of the fourteen tables and satisfies every constraint of the schema and every check of
the cluster. -/
@[aw_spec (tier := T0) (doc := "docs/sdk/site/concepts/ownership-and-sharing.mdx#catalog-assignment-grant")
  (ts := "packages/core/src/db/schema/index.ts")]
theorem cluster_constraints_are_satisfiable :
    consistent Sample.state = true ∧ (tables.all fun t => !(Sample.state t).isEmpty) = true := by
  decide +kernel

/-- Every foreign key of the cluster is exercised by the sample state: some row holds a non-`NULL`
key and has its parent. -/
@[aw_spec (tier := T0) (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
theorem sample_exercises_every_reference :
    (clusterForeignKeys.all fun (t, fk) => (Sample.pairOf Sample.state t fk).isSome) = true := by
  decide +kernel

end AgentWorkspace.Theorems.WellFormed.ConceptCatalog
