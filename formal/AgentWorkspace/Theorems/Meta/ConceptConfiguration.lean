import AgentWorkspace.Er.Current.Configuration

/-!
T5 — properties of the specification itself: where the documents, the contracts and the schema of
the configuration cluster disagree, and where one concept is stored as another. Each theorem pins
one finding of `docs/formal/units/concept-configuration.md`.
-/

namespace AgentWorkspace.Theorems.Meta.ConceptConfiguration

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Concepts
open AgentWorkspace.Er.Current.Configuration

/-! ## Numbers the contract accepts and the columns cannot store -/

/-- The contract accepts a fractional `cpu` (`0.5`), but `runtime_profiles.cpu` is a PostgreSQL
`integer`, which cannot store it. -/
@[aw_spec (tier := T5) (ts := "packages/contracts/src/runtimes.ts#RUNTIME_PROFILE_BOUNDS")
  (ts := "packages/core/src/db/schema/runtime-profiles.ts#runtimeProfiles")
  (doc := "docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes")]
theorem contract_cpu_fraction_is_not_storable :
    RuntimeProfile.cpuAccepted ⟨5, 1⟩ = true ∧
      RuntimeProfile.integerColumnAccepts ⟨5, 1⟩ = false ∧
      (catalogue .runtimeProfiles).column? "cpu" = some ⟨"cpu", .integer, false⟩ := by decide +kernel

/-- The contract bounds the sizing and timeout fields by `MAX_SAFE_INTEGER` ("no ceiling"), but the
four columns are PostgreSQL `integer`s: `2^31` passes the contract and overflows the column. -/
@[aw_spec (tier := T5) (ts := "packages/contracts/src/runtimes.ts#RUNTIME_PROFILE_BOUNDS")
  (ts := "packages/core/src/db/schema/runtime-profiles.ts#runtimeProfiles")
  (doc := "docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes")]
theorem contract_size_bound_exceeds_the_integer_column :
    RuntimeProfile.sizeAccepted ⟨2147483648, 0⟩ = true ∧
      RuntimeProfile.integerColumnAccepts ⟨2147483648, 0⟩ = false ∧
      RuntimeProfile.integerColumnAccepts ⟨2147483647, 0⟩ = true ∧
      ["memory_mb", "disk_mb", "timeout_seconds", "idle_timeout_seconds"].all
        (fun c => ((catalogue .runtimeProfiles).column? c).map (·.type) == some .integer) = true := by
  decide +kernel

/-- The contract accepts a runtime-profile name made of spaces, which
`runtime_profiles_name_not_blank` refuses: the create route passes it to the database, and the
repository does not classify that violation. -/
@[aw_spec (tier := T5) (ts := "packages/run-protocol/src/schemas.ts#RuntimeProfile")
  (ts := "packages/core/src/db/repositories/runtime-profiles.ts#classifyWriteFailure")]
theorem blank_profile_name_passes_the_contract_but_not_the_check :
    RuntimeProfile.nameAcceptedByContract "   " = true ∧ Secret.sqlNotBlank "   " = false ∧
      RuntimeProfile.nameAcceptedByContract "\t" = true ∧ Secret.sqlNotBlank "\t" = true := by
  decide +kernel

/-! ## Runtime connections and model-connection credentials are secrets by name -/

/-- The secrets route accepts the names reserved for model-connection credentials and runtime
connections, including the forged runtime-connection name the code comment measures: the
reservation is a naming convention only. -/
@[aw_spec (tier := T5) (doc := "docs/sdk/04-api-specification.md#55-secrets--awsecrets")
  (ts := "apps/web/server/secrets/contract.ts#parseSecretName")
  (ts := "apps/web/server/runtimes/connections.ts#decodeDriver")]
theorem reserved_names_are_ordinary_secret_names :
    Secret.isValidName "RUNTIME_CONNECTION__DOCKER__FORGED" = true ∧
      Secret.purposeOf "RUNTIME_CONNECTION__DOCKER__FORGED" = .runtimeConnection ∧
      Secret.isValidName (Secret.modelConnectionSecretName "123e4567-e89b-12d3-a456-426614174000") =
        true ∧
      Secret.purposeOf "MODEL_CONNECTION_123E4567E89B12D3A456426614174000" =
        .modelConnectionCredential := by decide +kernel

/-- `decodeDriver` does not check the catalogue: a stored name with the runtime-connection prefix
and an unknown driver segment lists as a connection whose driver the contract rejects. -/
@[aw_spec (tier := T5) (ts := "apps/web/server/runtimes/connections.ts#decodeDriver")
  (ts := "packages/contracts/src/runtimes.ts#RuntimeConnectionResourceSchema")]
theorem decoded_driver_may_be_outside_the_catalogue :
    Secret.isValidName "RUNTIME_CONNECTION__FOO__X" = true ∧
      RuntimeProfile.decodeDriver "RUNTIME_CONNECTION__FOO__X" = some "foo" ∧
      RuntimeProfile.decodeKnownDriver "RUNTIME_CONNECTION__FOO__X" = none := by decide +kernel

/-- The label encoding is not injective: two different display names of one driver encode to the
same stored name, so the second is a name conflict. -/
@[aw_spec (tier := T5) (ts := "apps/web/server/runtimes/connections.ts#encodeSegment")
  (doc := "docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes")]
theorem connection_label_encoding_collides :
    RuntimeProfile.encodeSecretName "docker" "primary host" =
        RuntimeProfile.encodeSecretName "docker" "PRIMARY_HOST" ∧
      (RuntimeProfile.encodeSecretName "docker" "primary host").isSome = true := by decide +kernel

/-- A runtime connection has no table and no identifier kind of its own: it is a `secrets` row. -/
@[aw_spec (tier := T5) (doc := "docs/sdk/04-api-specification.md#2-resource-model")
  (ts := "apps/web/server/runtimes/connections.ts#createSecretsRuntimeConnectionStoreProvider")]
theorem runtime_connections_have_no_table :
    ((WireEnum.all : List TableName).all (fun t => TableName.toWire t != "runtime_connections") &&
      (WireEnum.all : List IdKind).all (fun k => IdKind.toWire k != "runtime-connection")) = true := by
  decide +kernel

/-- No foreign key joins `model_connections` and `secrets` in either direction: a connection's
credential is found by the name `MODEL_CONNECTION_<id>` alone. -/
@[aw_spec (tier := T5) (ts := "apps/web/server/models/store.ts#modelConnectionSecretName")
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
theorem model_connection_credential_has_no_foreign_key :
    (catalogue .modelConnections).foreignKeys.all (·.refTable != .secrets) &&
      (catalogue .secrets).foreignKeys.all (·.refTable != .modelConnections) = true := by decide +kernel

/-! ## Model choice as a pair -/

/-- Clearing only the connection of a workspace default (what the key's own `ON DELETE SET NULL`
does) breaks `workspaces_default_model_pair`; the repository therefore clears both columns first. -/
@[aw_spec (tier := T5)
  (ts := "packages/core/src/db/repositories/model-connections.ts#createDatabaseModelConnectionRepositoryProvider")
  (ts := "packages/core/src/db/schema/workspaces.ts#workspaces")]
theorem set_null_alone_breaks_the_default_model_pair :
    configCheckHolds "workspaces_default_model_pair" Witness.workspace1 = true ∧
      configCheckHolds "workspaces_default_model_pair"
        (Witness.workspace1.nullify ["default_model_connection_id"]) = false ∧
      configCheckHolds "workspaces_default_model_pair"
        (Witness.workspace1.nullify ["default_model_connection_id", "default_model"]) = true := by
  decide +kernel

/-- Agents have no pair check: a consistent state holds an agent with a model and no connection,
which is what deleting its connection leaves behind, although the specification says a model
choice is never one without the other. -/
@[aw_spec (tier := T5)
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")
  (ts := "packages/core/src/db/schema/agents.ts#agents")]
theorem agent_model_may_outlive_its_connection :
    let orphan := Witness.agent.nullify ["model_connection_id"]
    consistentConfig (fun t => if t = .agents then [orphan] else Witness.state t) = true ∧
      orphan.get "model" = some "claude-sonnet" ∧ orphan.get "model_connection_id" = none ∧
      (catalogue .agents).checks.map Check.name =
        ["agents_name_not_blank", "agents_created_by_agent_lineage_check"] := by
  decide +kernel

/-! ## Naming and shape asymmetries -/

/-- A runtime profile's name must not be blank and a secret's name has a shape, but a model
connection's name has no database check at all: only the route refuses a blank one. -/
@[aw_spec (tier := T5) (ts := "packages/core/src/db/schema/model-connections.ts#modelConnections")
  (ts := "apps/web/server/models/contract.ts#parseCreateModelConnection")]
theorem model_connection_name_has_no_database_check :
    (catalogue .runtimeProfiles).check? "runtime_profiles_name_not_blank" = some (.other
        "runtime_profiles_name_not_blank") ∧
      (catalogue .secrets).check? "secrets_name_shape" = some (.other "secrets_name_shape") ∧
      (catalogue .modelConnections).checks.map Check.name = ["model_connections_provider_valid"] := by
  decide +kernel

/-- Of the configuration resources, only the runtime profile carries its `workspaceId` on the wire;
the model-connection, secret and runtime-connection resources do not. -/
@[aw_spec (tier := T5) (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")
  (ts := "packages/contracts/src/runtimes.ts#RuntimeProfileResourceSchema")]
theorem only_the_profile_resource_carries_workspace_id :
    RuntimeProfile.resourceFields.contains "workspaceId" &&
      !ModelConnection.resourceFields.contains "workspaceId" &&
      !Secret.resourceFields.contains "workspaceId" &&
      !RuntimeProfile.connectionResourceFields.contains "workspaceId" = true := by decide +kernel

/-- The references into `secrets` disagree on deletion: a runtime profile's is cleared
(`SET NULL`), a connector's credential blocks it (`RESTRICT`), so deleting a secret can be
refused. -/
@[aw_spec (tier := T5) (ts := "packages/core/src/db/schema/mcp-servers.ts#mcpServers")
  (ts := "packages/core/src/db/schema/runtime-profiles.ts#runtimeProfiles")
  (doc := "docs/sdk/04-api-specification.md#55-secrets--awsecrets")]
theorem secret_references_disagree_on_delete :
    (inbound catalogue .secrets).map (fun (t, fk) => (t, fk.onDelete)) =
        [(.mcpServers, .restrict), (.runtimeProfiles, .setNull), (.runtimeProfiles, .noAction)] ∧
      deleteNeverBlocked catalogue .secrets = false := by decide +kernel

/-! ## Where the model's encoding is faithful -/

/-- The runtime-connection encoding model is faithful on ASCII labels only: on each recorded
non-ASCII label (`straße`, `ıd`, `ﬁle`) the model's name differs from the one JavaScript's
Unicode-aware `toUpperCase` makes the code store, and none of them is an ASCII label. -/
@[aw_spec (tier := T5) (ts := "apps/web/server/runtimes/connections.ts#encodeSegment")
  (doc := "docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes")]
theorem connection_encoding_model_is_ascii_only :
    RuntimeProfile.jsUpperCaseDivergences.all (fun (l, ts) =>
      !RuntimeProfile.isAsciiLabel l && RuntimeProfile.encodeSecretName "docker" l != ts) = true ∧
      RuntimeProfile.encodeSecretName "docker" "ıd" = none ∧
      RuntimeProfile.encodeSecretName "docker" "straße" =
        some "RUNTIME_CONNECTION__DOCKER__STRA_E" := by decide +kernel

/-! ## Request parsers that disagree on unknown fields -/

/-- The runtime-connection create parser accepts its full body with an unknown key added, while the
model-connection, secret and runtime-profile create parsers refuse their full bodies with the same
key. -/
@[aw_spec (tier := T5)
  (ts := "apps/web/server/runtimes/connections.ts#parseCreateRuntimeConnectionInput")
  (ts := "apps/web/server/secrets/contract.ts#parseCreateSecretBody")
  (doc := "docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes")]
theorem runtime_connection_create_ignores_unknown_fields :
    RuntimeProfile.connectionCreateAccepts
        (RuntimeProfile.connectionCreateFields ++ ["bogus"]) = true ∧
      ModelConnection.createAccepts (ModelConnection.createFields ++ ["bogus"]) = false ∧
      Secret.createAccepts (Secret.createFields ++ ["bogus"]) = false ∧
      RuntimeProfile.createAccepts (RuntimeProfile.createFields ++ ["bogus"]) = false := by
  decide +kernel

/-! ## The image rule speaks of non-local profiles but applies to every driver -/

/-- The create-time image rule does not read the driver: a `local` profile with a tagged image is
refused exactly like a `docker` one, although the error says "non-local runtime profiles". -/
@[aw_spec (tier := T5)
  (ts := "apps/web/server/runtimes/contract.ts#parseCreateRuntimeProfileInput")
  (doc := "docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes")]
theorem image_rule_ignores_the_driver (d e : RuntimeProfile.Driver) (i : RuntimeProfile.Image) :
    RuntimeProfile.createImageAccepted d i = RuntimeProfile.createImageAccepted e i := by
  cases i <;> rfl

example : RuntimeProfile.createImageAccepted .local (.text "alpine:3") =
    RuntimeProfile.createImageAccepted .docker (.text "alpine:3") :=
  image_rule_ignores_the_driver _ _ _

/-- Model connections and runtime connections refuse a blank name after JavaScript's `trim`, but
the runtime-profile contract accepts any non-empty name, so a name of one ideographic space is a
valid profile name and PostgreSQL's `btrim` check accepts it too. -/
@[aw_spec (tier := T5) (ts := "packages/run-protocol/src/schemas.ts#RuntimeProfile")
  (ts := "apps/web/server/models/contract.ts#parseCreateModelConnection")]
theorem blank_name_rules_disagree :
    ModelConnection.nameAccepted "\u3000" = false ∧
      RuntimeProfile.connectionTextAccepted "\u3000" = false ∧
      RuntimeProfile.nameAcceptedByContract "\u3000" = true ∧ Secret.sqlNotBlank "\u3000" = true := by
  decide +kernel

end AgentWorkspace.Theorems.Meta.ConceptConfiguration
