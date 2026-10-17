import AgentWorkspace.Er.Current.Configuration

/-!
T0 — the configuration cluster's definitions are coherent: the closed sets have the spellings and
order of their TypeScript `as const` arrays and are the value lists of the database checks, the
runtime-connection name encoding round-trips its driver and always yields a storable secret name,
the model-connection credential name is recognised as one, and the concept rows satisfy the
checks of their tables.
-/

namespace AgentWorkspace.Theorems.WellFormed.ConceptConfiguration

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Concepts
open AgentWorkspace.Er.Current.Configuration

/-! ## Wire spellings -/

/-- The model providers are spelled and ordered as `modelProviders` lists them. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/model-connections.ts#modelProviders")
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")]
theorem provider_wires :
    WireEnum.wires ModelConnection.Provider =
      ["anthropic", "anthropic-compatible", "openai", "azure-openai", "openai-compatible"] := by
  decide

/-- The model-connection config fields are spelled and ordered as `MODEL_CONNECTION_CONFIG_FIELDS`
lists them. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/models.ts#MODEL_CONNECTION_CONFIG_FIELDS")]
theorem config_field_wires :
    WireEnum.wires ModelConnection.ConfigField = ["baseUrl", "deployment", "apiVersion"] := by
  decide

/-- The runtime drivers are spelled and ordered as `runtimeProfileDrivers` lists them. -/
@[aw_spec (tier := T0)
  (ts := "packages/core/src/db/schema/runtime-profiles.ts#runtimeProfileDrivers")
  (doc := "docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes")]
theorem driver_wires :
    WireEnum.wires RuntimeProfile.Driver =
      ["local", "sandbox-runtime", "docker", "kubernetes", "gke-agent-sandbox", "aca-sessions",
        "aws-agentcore", "aws-ecs", "cloud-run-sandbox", "cloud-run-service", "external",
        "vercel-sandbox", "cloudflare-sandbox"] := by
  decide

/-- The network policies are spelled and ordered as `runtimeProfileNetworkPolicies` lists them. -/
@[aw_spec (tier := T0)
  (ts := "packages/core/src/db/schema/runtime-profiles.ts#runtimeProfileNetworkPolicies")]
theorem network_policy_wires :
    WireEnum.wires RuntimeProfile.NetworkPolicy = ["none", "restricted", "open"] := by decide

/-- The filesystem modes are spelled and ordered as `runtimeProfileFilesystems` lists them. -/
@[aw_spec (tier := T0)
  (ts := "packages/core/src/db/schema/runtime-profiles.ts#runtimeProfileFilesystems")]
theorem filesystem_wires :
    WireEnum.wires RuntimeProfile.Filesystem = ["read-only", "read-write"] := by decide

/-- The one envelope algorithm is spelled as `secretAlgorithms` lists it. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/secrets.ts#secretAlgorithms")]
theorem algorithm_wires : WireEnum.wires Secret.Algorithm = ["aes-256-gcm"] := by decide

/-! ## The database checks carry the concept enumerations -/

/-- `model_connections_provider_valid` constrains `provider` to exactly the provider enumeration. -/
@[aw_spec (tier := T0)
  (ts := "packages/core/src/db/schema/model-connections.ts#modelConnections")
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")]
theorem provider_check_is_the_provider_enum :
    (catalogue .modelConnections).oneOfCheck? "model_connections_provider_valid" =
      some ("provider", WireEnum.wires ModelConnection.Provider) := by decide

/-- `runtime_profiles_driver_valid` constrains `driver` to exactly the driver enumeration. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/runtime-profiles.ts#runtimeProfiles")
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")]
theorem driver_check_is_the_driver_enum :
    (catalogue .runtimeProfiles).oneOfCheck? "runtime_profiles_driver_valid" =
      some ("driver", WireEnum.wires RuntimeProfile.Driver) := by decide

/-- `runtime_profiles_network_policy_valid` constrains `network_policy` to exactly the network
policy enumeration. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/runtime-profiles.ts#runtimeProfiles")]
theorem network_policy_check_is_the_network_policy_enum :
    (catalogue .runtimeProfiles).oneOfCheck? "runtime_profiles_network_policy_valid" =
      some ("network_policy", WireEnum.wires RuntimeProfile.NetworkPolicy) := by decide

/-- `runtime_profiles_filesystem_valid` constrains `filesystem` to exactly the filesystem
enumeration. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/runtime-profiles.ts#runtimeProfiles")]
theorem filesystem_check_is_the_filesystem_enum :
    (catalogue .runtimeProfiles).oneOfCheck? "runtime_profiles_filesystem_valid" =
      some ("filesystem", WireEnum.wires RuntimeProfile.Filesystem) := by decide

/-- `secrets_algorithm_valid` constrains `algorithm` to exactly the algorithm enumeration. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/secrets.ts#secrets")]
theorem algorithm_check_is_the_algorithm_enum :
    (catalogue .secrets).oneOfCheck? "secrets_algorithm_valid" =
      some ("algorithm", WireEnum.wires Secret.Algorithm) := by decide

/-- Every closed set of the cluster passes the `oneOf` DDL value gate, so it can be inlined into its
`CHECK` constraint. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/one-of.ts#renderValueList")]
theorem cluster_value_lists_pass_the_ddl_gate :
    [WireEnum.wires ModelConnection.Provider, WireEnum.wires RuntimeProfile.Driver,
      WireEnum.wires RuntimeProfile.NetworkPolicy, WireEnum.wires RuntimeProfile.Filesystem,
      WireEnum.wires Secret.Algorithm].all (fun vs => (renderValueList? vs).isSome) = true := by
  decide

/-- The cluster's list of foreign keys is exact: each listed key exists with its target, and every
key of today's schema that starts or ends in a cluster table is listed. -/
@[aw_spec (tier := T0)
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")]
theorem cluster_foreign_keys_are_complete : clusterForeignKeysComplete = true := by decide

/-- Every foreign key that touches the cluster is classified: a root reference, tenant-paired, or
covered by a tenant-paired sibling; none is unpaired or global. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#referenceIdentityOf")]
theorem cluster_foreign_keys_are_paired :
    clusterForeignKeys.map (fun (t, n, _) => classify catalogue t (fkOf t n)) =
      [.rootReference, .rootReference, .siblingPaired, .tenantPaired, .rootReference,
        .siblingPaired, .tenantPaired, .siblingPaired, .tenantPaired, .siblingPaired,
        .tenantPaired, .siblingPaired, .tenantPaired, .siblingPaired, .tenantPaired,
        .tenantPaired] := by decide

/-! ## The runtime-connection name encoding -/

private theorem isPrefixOf_append (l m : List Char) : l.isPrefixOf (l ++ m) = true :=
  List.isPrefixOf_iff_prefix.mpr (List.prefix_append l m)

private theorem split_isSome : ∀ (a b : List Char),
    (Secret.splitAtDoubleUnderscore (a ++ '_' :: '_' :: b)).isSome = true
  | [], _ => rfl
  | c :: a, b => by
    rw [List.cons_append]
    exact Secret.splitAtDoubleUnderscore_cons_isSome c _ (split_isSome a b)

private theorem encodeSegment_tail (cs : List Char) :
    (RuntimeProfile.encodeSegment cs).all Secret.isNameTail = true := by
  simp only [RuntimeProfile.encodeSegment, List.all_map, List.all_eq_true, Function.comp]
  intro c _
  split
  · rename_i h
    simp only [RuntimeProfile.isUpperAlnum, Bool.or_eq_true] at h
    simp only [Secret.isNameTail, Secret.isNameHead, Bool.or_eq_true]
    rcases h with h | h
    · exact Or.inl (Or.inl h)
    · exact Or.inl (Or.inr h)
  · decide

private theorem label_tail {l : List Char} (h : RuntimeProfile.isLabel l = true) :
    l.all Secret.isNameTail = true := by
  match l, h with
  | c :: rest, h =>
    simp only [RuntimeProfile.isLabel, Bool.and_eq_true] at h
    simp only [List.all_cons, Bool.and_eq_true]
    exact ⟨by simp [Secret.isNameTail, h.1], h.2⟩

/-- A name `encodeSecretName` produces is a storable secret name (it passes `secrets_name_shape`)
and is recognised as a runtime connection, for any driver and label. -/
@[aw_spec (tier := T0) (ts := "apps/web/server/runtimes/connections.ts#encodeSecretName")
  (ts := "packages/contracts/src/secrets.ts#SECRET_NAME_PATTERN")]
theorem encoded_connection_name_is_a_runtime_connection_secret (driver label n : String)
    (h : RuntimeProfile.encodeSecretName driver label = some n) :
    Secret.isValidName n = true ∧ Secret.purposeOf n = .runtimeConnection := by
  simp only [RuntimeProfile.encodeSecretName] at h
  split at h
  · cases h
  · rename_i hl
    have hl : RuntimeProfile.isLabel (RuntimeProfile.encodeSegment label.toList) = true := by
      simpa using hl
    split at h
    · rename_i hlen
      cases h
      have e : Secret.runtimeConnectionPrefix.toList = 'R' :: "UNTIME_CONNECTION__".toList := by
        decide
      have hu : "UNTIME_CONNECTION__".toList.all Secret.isNameTail = true := by decide
      have hlu : "UNTIME_CONNECTION__".toList.length = 19 := by decide
      rw [e] at hlen
      constructor
      · simp only [Secret.isValidName, String.toList_ofList, e, List.cons_append,
          Secret.isValidNameChars, Secret.nameMaxLength, Bool.and_eq_true, List.all_append]
        simp only [List.length_append, List.length_cons, List.length_nil, hlu] at hlen
        refine ⟨⟨by decide, ⟨⟨hu, encodeSegment_tail _⟩, by decide⟩, label_tail hl⟩, ?_⟩
        simp only [List.length_append, List.length_cons, List.length_nil, hlu, decide_eq_true_eq]
        omega
      · simp only [Secret.purposeOf, String.toList_ofList, List.append_assoc]
        have hpl : Secret.runtimeConnectionPrefix.length =
            Secret.runtimeConnectionPrefix.toList.length := by decide
        rw [hpl, isPrefixOf_append, List.drop_left, List.cons_append, List.cons_append,
          List.nil_append, split_isSome]
        rfl
    · cases h

private theorem split_driver (d : RuntimeProfile.Driver) (l : List Char) :
    Secret.splitAtDoubleUnderscore
        (RuntimeProfile.encodeSegment d.toWire.toList ++ '_' :: '_' :: l) =
      some (RuntimeProfile.encodeSegment d.toWire.toList, l) := by
  cases d <;> rfl

/-- Decoding an encoded runtime-connection name gives back the driver it was created for, for
every driver and every label (`decodeDriver` inverts `encodeSecretName`'s driver half). -/
@[aw_spec (tier := T0) (ts := "apps/web/server/runtimes/connections.ts#decodeDriver")
  (ts := "apps/web/server/runtimes/connections.ts#encodeSecretName")]
theorem decode_inverts_encode (d : RuntimeProfile.Driver) (label n : String)
    (h : RuntimeProfile.encodeSecretName d.toWire label = some n) :
    RuntimeProfile.decodeDriver n = some d.toWire ∧ RuntimeProfile.decodeKnownDriver n = some d := by
  simp only [RuntimeProfile.encodeSecretName] at h
  split at h
  · cases h
  · split at h
    · cases h
      have hd : RuntimeProfile.decodeDriver
          (String.ofList (Secret.runtimeConnectionPrefix.toList ++
            RuntimeProfile.encodeSegment d.toWire.toList ++ ['_', '_'] ++
              RuntimeProfile.encodeSegment label.toList)) = some d.toWire := by
        simp only [RuntimeProfile.decodeDriver, RuntimeProfile.decodeDriverChars,
          String.toList_ofList, List.append_assoc, isPrefixOf_append, List.drop_left,
          ite_true, List.cons_append, List.nil_append, split_driver, Option.map_some]
        cases d <;> decide
      refine ⟨hd, ?_⟩
      simp only [RuntimeProfile.decodeKnownDriver, hd, Option.bind_some]
      exact WireEnum.ofWire?_toWire d
    · cases h

/-- The credential name of a model connection is recognised as a model-connection credential,
whatever the id. -/
@[aw_spec (tier := T0) (ts := "apps/web/server/models/store.ts#modelConnectionSecretName")
  (ts := "apps/web/server/models/store.ts#MODEL_CONNECTION_SECRET_PREFIX")]
theorem credential_name_has_the_model_connection_purpose (id : String) :
    Secret.purposeOf (Secret.modelConnectionSecretName id) = .modelConnectionCredential := by
  have e1 : "MODEL_CONNECTION_".toList = 'M' :: "ODEL_CONNECTION_".toList := by decide
  have e2 : "RUNTIME_CONNECTION__".toList = 'R' :: "UNTIME_CONNECTION__".toList := by decide
  simp only [Secret.purposeOf, Secret.modelConnectionSecretName, String.toList_append,
    Secret.modelConnectionPrefix, Secret.runtimeConnectionPrefix]
  have hRM : ('R' == 'M') = false := by decide
  simp only [e1, e2, List.isPrefixOf_cons_cons, isPrefixOf_append, hRM, Bool.false_and,
    Bool.and_true, List.cons_append]
  rfl

/-! ## Concept rows satisfy their tables' checks -/

private theorem octet_bytesCell (n : Nat) : octetLength (bytesCell n) = n := by
  simp [octetLength, bytesCell]

/-- A secret the concept calls valid is a row every check of `secrets` accepts: the closed-set
algorithm check and the six name and envelope checks. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/secrets.ts#secrets")
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
theorem valid_secret_satisfies_the_secret_checks (s : Secret.Secret) (h : s.valid = true) :
    (catalogue .secrets).checks.all (checkHolds [secretRow s]) = true ∧
      (refinedChecks.filter (·.1 == .secrets)).all
        (fun (_, n) => configCheckHolds n (secretRow s)) = true := by
  simp only [Secret.Secret.valid, Secret.Envelope.wellFormed, Bool.and_eq_true, beq_iff_eq,
    decide_eq_true_eq] at h
  obtain ⟨hname, ⟨⟨⟨⟨⟨⟨hmk, hw⟩, hwn⟩, hcn⟩, hwt⟩, hct⟩, hc⟩⟩ := h
  constructor
  · cases halg : s.algorithm
    simp +decide [catalogue, checkHolds, secretRow, Row.get, otherCheckHolds,
      Secret.Algorithm.toWire, List.lookup_cons]
  · simp +decide [List.lookup_cons, refinedChecks, configCheckHolds, cellOk, secretRow, Row.get, octet_bytesCell, hname, hmk,
      hw, hwn, hcn, hwt, hct, hc]

/-- A runtime profile with a non-blank name is a row every check of `runtime_profiles` accepts,
its default mark included (`true` or `NULL`, never `false`). -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/runtime-profiles.ts#runtimeProfiles")]
theorem valid_profile_satisfies_the_profile_checks (p : RuntimeProfile.RuntimeProfile)
    (h : p.valid = true) :
    (catalogue .runtimeProfiles).checks.all (checkHolds [runtimeProfileRow p]) = true ∧
      configCheckHolds "runtime_profiles_name_not_blank" (runtimeProfileRow p) = true ∧
      configCheckHolds "runtime_profiles_workspace_default_true_or_null" (runtimeProfileRow p) =
        true := by
  simp only [RuntimeProfile.RuntimeProfile.valid] at h
  refine ⟨?_, ?_, ?_⟩
  · cases hd : p.driver <;> cases hn : p.networkPolicy <;> cases hf : p.filesystem <;>
      simp +decide [catalogue, checkHolds, runtimeProfileRow, Row.get, otherCheckHolds, hd, hn, hf,
        List.lookup_cons,
        RuntimeProfile.Driver.toWire, RuntimeProfile.NetworkPolicy.toWire,
        RuntimeProfile.Filesystem.toWire]
  · simp +decide [configCheckHolds, cellOk, runtimeProfileRow, Row.get, h, List.lookup_cons]
  · cases hw : p.workspaceDefault <;>
      simp [configCheckHolds, cellOk, runtimeProfileRow, Row.get, hw, List.lookup_cons,
        lookup_optCells_cons_ne, lookup_optCells_single]

/-- Every model connection is a row the `model_connections_provider_valid` check accepts. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/model-connections.ts#modelConnections")]
theorem model_connection_satisfies_the_provider_check (m : ModelConnection.ModelConnection) :
    (catalogue .modelConnections).checks.all (checkHolds [modelConnectionRow m]) = true := by
  cases hp : m.provider <;>
    simp +decide [catalogue, checkHolds, modelConnectionRow, Row.get, hp,
      ModelConnection.Provider.toWire, List.lookup_cons]

/-- The readiness state is `ready` exactly when `ready` is true. -/
@[aw_spec (tier := T0) (ts := "apps/web/server/models/contract.ts#toModelConnectionResource")]
theorem readiness_agrees_with_ready (h : Bool) (p : ModelConnection.Provider)
    (c : ModelConnection.Config) :
    (ModelConnection.readiness h p c = .ready) ↔ ModelConnection.ready h p c = true := by
  cases h <;> simp [ModelConnection.readiness, ModelConnection.ready] <;> split <;> simp_all

/-! ## Witnesses -/

example : Secret.isValidName "RUNTIME_CONNECTION__DOCKER__PRIMARY" = true ∧
    Secret.purposeOf "RUNTIME_CONNECTION__DOCKER__PRIMARY" = .runtimeConnection :=
  encoded_connection_name_is_a_runtime_connection_secret "docker" "primary" _ (by decide)

example : RuntimeProfile.decodeDriver "RUNTIME_CONNECTION__AWS_AGENTCORE__POOL" =
      some "aws-agentcore" ∧
    RuntimeProfile.decodeKnownDriver "RUNTIME_CONNECTION__AWS_AGENTCORE__POOL" = some .awsAgentcore :=
  decode_inverts_encode .awsAgentcore "pool" _ (by decide)

/-- A valid secret: an environment-variable name and a correctly sized envelope. -/
private def validSecret : Secret.Secret :=
  { id := ⟨"s1"⟩, workspace := ⟨"w1"⟩, name := "GITHUB_TOKEN", algorithm := .aes256Gcm,
    envelope := ⟨"local-v1", 32, 12, 16, 5, 12, 16⟩, createdAt := "t0", updatedAt := "t0" }

example := valid_secret_satisfies_the_secret_checks validSecret (by decide)

example := valid_profile_satisfies_the_profile_checks
  { id := ⟨"rp1"⟩, workspace := ⟨"w1"⟩, name := "default", driver := .docker,
    runtimeConnection := none, networkPolicy := .none, filesystem := .readOnly,
    createdAt := "t0", updatedAt := "t0" } (by decide)

end AgentWorkspace.Theorems.WellFormed.ConceptConfiguration
