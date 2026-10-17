import AgentWorkspace.Er.Current.Configuration
import AgentWorkspace.Theorems.Normative.ConceptConfiguration
import Vectors.Common

/-!
Vectors for the `concept-configuration` family: the three configuration tables and every foreign
key that touches them (replayed against the live Drizzle objects), the closed sets (against the
schema and contract arrays), the refined checks (against the constants in the `0025` snapshot's
`CHECK` bodies), the provider config rule table and readiness, the secret name shape and value
bounds, the model-connection credential name, the runtime-connection name encoding and its
decoding, the wire resources' field sets and their refusal of credential fields, and the numbers
the contract accepts against what the `integer` columns store.
-/

namespace Vectors.ConceptConfiguration

open Lean AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Concepts
open AgentWorkspace.Er.Current.Configuration

private def t0 : String := "AgentWorkspace.Theorems.WellFormed.ConceptConfiguration."
private def t1 : String := "AgentWorkspace.Theorems.Normative.ConceptConfiguration."
private def t2 : String := "AgentWorkspace.Theorems.Invariants.ConceptConfiguration."
private def t3 : String := "AgentWorkspace.Theorems.Adversarial.ConceptConfiguration."
private def t4 : String := "AgentWorkspace.Theorems.Refinement.ConceptConfiguration."
private def t5 : String := "AgentWorkspace.Theorems.Meta.ConceptConfiguration."

def strs (xs : List String) : Json := Json.arr (xs.map Json.str).toArray

/-! ## Tables -/

def fkJson (t : TableName) (fk : ForeignKey) : Json :=
  Json.mkObj [("name", fk.name), ("columns", strs fk.columns),
    ("refTable", TableName.toWire fk.refTable), ("refColumns", strs fk.refColumns),
    ("onDelete", fk.onDelete.toSql), ("class", (classify catalogue t fk).toWire)]

def inboundJson (t : TableName) (fk : ForeignKey) : Json :=
  Json.mkObj [("table", TableName.toWire t), ("name", fk.name), ("onDelete", fk.onDelete.toSql),
    ("clearsOnDelete", deleteClearsReference catalogue t fk)]

def checkJson : Check → Json
  | .oneOf n c vs => Json.mkObj [("name", n), ("column", c), ("values", strs vs)]
  | .other n => Json.mkObj [("name", n), ("column", Json.null), ("values", Json.null)]

def tableVector (t : TableName) : Vector :=
  let s := catalogue t
  { id := s!"table/{TableName.toWire t}",
    input := Json.mkObj [("table", TableName.toWire t)],
    expected := Json.mkObj [
      ("columns", Json.arr (s.columns.map fun c => Json.mkObj [("name", c.name),
        ("type", c.type.toSql), ("notNull", c.notNull)]).toArray),
      ("primaryKey", strs s.primaryKey),
      ("foreignKeys", Json.arr (s.foreignKeys.map (fkJson t)).toArray),
      ("uniques", Json.arr (s.uniques.map fun u => Json.mkObj [("name", u.name),
        ("columns", strs u.columns)]).toArray),
      ("checks", Json.arr (s.checks.map checkJson).toArray),
      ("inbound", Json.arr ((inbound catalogue t).map fun (c, fk) => inboundJson c fk).toArray),
      ("deleteNeverBlocked", deleteNeverBlocked catalogue t)],
    witnesses := [t0 ++ "cluster_foreign_keys_are_complete", t0 ++ "cluster_foreign_keys_are_paired",
      t1 ++ "names_are_unique_per_workspace", t1 ++ "configuration_rows_have_no_owner",
      t1 ++ "model_connection_references", t1 ++ "deleting_a_model_connection_is_never_blocked",
      t1 ++ "deleting_a_runtime_profile_is_never_blocked", t1 ++ "secret_values_are_bytea",
      t1 ++ "driver_network_policy_and_filesystem_are_required",
      t1 ++ "other_profile_fields_are_optional", t1 ++ "runtime_connection_is_a_secret_reference",
      t5 ++ "secret_references_disagree_on_delete", t5 ++ "model_connection_name_has_no_database_check",
      t5 ++ "model_connection_credential_has_no_foreign_key",
      t5 ++ "contract_cpu_fraction_is_not_storable",
      t5 ++ "contract_size_bound_exceeds_the_integer_column"] ++
      (clusterForeignKeys.filter (·.1 == t)).map (fun (_, n, _) => t2 ++ s!"{n}_preserves_tenant") }

def tableVectors : List Vector := clusterTables.map tableVector

/-- Every foreign key that touches the cluster, from the side that declares it. -/
def foreignKeyVectors : List Vector :=
  clusterForeignKeys.map fun (t, n, target) =>
    let fk := fkOf t n
    { id := s!"fk/{n}",
      input := Json.mkObj [("table", TableName.toWire t), ("name", n)],
      expected := Json.mkObj [("refTable", TableName.toWire target), ("columns", strs fk.columns),
        ("refColumns", strs fk.refColumns), ("onDelete", fk.onDelete.toSql),
        ("class", (classify catalogue t fk).toWire)],
      witnesses := [t2 ++ s!"{n}_preserves_tenant", t0 ++ "cluster_foreign_keys_are_paired",
        t0 ++ "cluster_foreign_keys_are_complete"] }

/-! ## Closed sets -/

def enumVectors : List Vector :=
  [("provider", WireEnum.wires ModelConnection.Provider,
      [t0 ++ "provider_wires", t0 ++ "provider_check_is_the_provider_enum",
       t2 ++ "stored_provider_is_a_provider"]),
   ("config-field", WireEnum.wires ModelConnection.ConfigField, [t0 ++ "config_field_wires"]),
   ("driver", WireEnum.wires RuntimeProfile.Driver,
      [t0 ++ "driver_wires", t0 ++ "driver_check_is_the_driver_enum", t2 ++ "stored_driver_is_a_driver"]),
   ("network-policy", WireEnum.wires RuntimeProfile.NetworkPolicy,
      [t0 ++ "network_policy_wires", t0 ++ "network_policy_check_is_the_network_policy_enum",
       t2 ++ "stored_network_policy_is_a_policy"]),
   ("filesystem", WireEnum.wires RuntimeProfile.Filesystem,
      [t0 ++ "filesystem_wires", t0 ++ "filesystem_check_is_the_filesystem_enum",
       t2 ++ "stored_filesystem_is_a_mode"]),
   ("algorithm", WireEnum.wires Secret.Algorithm,
      [t0 ++ "algorithm_wires", t0 ++ "algorithm_check_is_the_algorithm_enum",
       t2 ++ "stored_algorithm_is_aes_gcm"])].map fun (n, vs, ws) =>
    { id := s!"enum/{n}", input := Json.mkObj [("enum", n)],
      expected := Json.mkObj [("values", strs vs),
        ("ddl", match renderValueList? vs with | some s => Json.str s | none => Json.null)],
      witnesses := ws ++ [t0 ++ "cluster_value_lists_pass_the_ddl_gate"] }

/-! ## Refined checks against the snapshot -/

/-- What each refined check's `CHECK` body must contain, from the model's constants. -/
def checkFragments : List (TableName × String × List String) :=
  [(.secrets, "secrets_name_shape",
      [s!"'^[A-Z][A-Z0-9_]\{0,{Secret.nameMaxLength - 1}}$'"]),
   (.secrets, "secrets_master_key_id_not_blank", ["btrim", "> 0"]),
   (.secrets, "secrets_wrapped_data_key_size", [s!"= {Secret.wrappedDataKeyBytes}"]),
   (.secrets, "secrets_nonce_sizes", [s!"\"wrapped_data_key_nonce\") = {Secret.nonceBytes}",
      s!"\"ciphertext_nonce\") = {Secret.nonceBytes}"]),
   (.secrets, "secrets_tag_sizes", [s!"\"wrapped_data_key_tag\") = {Secret.tagBytes}",
      s!"\"ciphertext_tag\") = {Secret.tagBytes}"]),
   (.secrets, "secrets_ciphertext_not_empty", ["octet_length(\"secrets\".\"ciphertext\") > 0"]),
   (.runtimeProfiles, "runtime_profiles_name_not_blank", ["btrim", "> 0"]),
   (.runtimeProfiles, "runtime_profiles_workspace_default_true_or_null",
      ["\"workspace_default\" is null or \"runtime_profiles\".\"workspace_default\""]),
   (.workspaces, "workspaces_default_model_pair",
      ["\"default_model_connection_id\" is null) = (", "\"default_model\" is null)"]),
   (.projects, "projects_default_model_pair",
      ["\"default_model_connection_id\" is null) = (", "\"default_model\" is null)"])]

def checkVectors : List Vector :=
  checkFragments.map fun (t, n, frags) =>
    { id := s!"check/{n}", input := Json.mkObj [("table", TableName.toWire t), ("name", n)],
      expected := Json.mkObj [("refined", refinedChecks.contains (t, n)), ("fragments", strs frags)],
      witnesses := [t2 ++ "stored_secret_is_well_formed", t2 ++ "default_model_is_set_with_its_connection",
        t0 ++ "valid_secret_satisfies_the_secret_checks",
        t0 ++ "valid_profile_satisfies_the_profile_checks",
        t5 ++ "set_null_alone_breaks_the_default_model_pair"] }

/-! ## Provider config rules and readiness -/

def fieldSets : List (List ModelConnection.ConfigField) :=
  [[], [.baseUrl], [.deployment], [.apiVersion], [.baseUrl, .deployment],
    [.baseUrl, .apiVersion], [.deployment, .apiVersion], [.baseUrl, .deployment, .apiVersion]]

def configJson (c : ModelConnection.Config) : Json :=
  Json.mkObj ((WireEnum.all : List ModelConnection.ConfigField).filterMap fun f =>
    (c.get f).map fun v => (f.toWire, Json.str v))

private def snake (s : String) : String := s.map fun c => if c == '-' then '_' else c

private def fieldSnake : ModelConnection.ConfigField → String
  | .baseUrl => "base_url"
  | .deployment => "deployment"
  | .apiVersion => "api_version"

private def verdict (allowed required : Bool) : String :=
  if required then "requires" else if allowed then "accepts_but_does_not_require" else "refuses"

/-- The documented row of a provider (from the independent transcription). -/
def documentedRule (p : ModelConnection.Provider) :
    List ModelConnection.ConfigField × List ModelConnection.ConfigField :=
  match AgentWorkspace.Theorems.Normative.ConceptConfiguration.documentedConfigRules.find?
      (·.1 == p) with
  | some (_, a, r) => (a, r)
  | none => ([], [])

def cellWitnesses (p : ModelConnection.Provider) : List String :=
  let (a, r) := documentedRule p
  (WireEnum.all : List ModelConnection.ConfigField).map fun f =>
    t1 ++ s!"{snake p.toWire}_{verdict (a.contains f) (r.contains f)}_{fieldSnake f}"

/-- Configs with one blank value, for each provider and each field it accepts. -/
def blankConfigs : List (ModelConnection.Provider × ModelConnection.Config) :=
  (WireEnum.all : List ModelConnection.Provider).flatMap fun p =>
    (ModelConnection.rule p).allowed.map fun f =>
      let c := ModelConnection.Config.ofFields (ModelConnection.rule p).required
      (p, match f with
        | .baseUrl => { c with baseUrl := some "  " }
        | .deployment => { c with deployment := some "\t" }
        | .apiVersion => { c with apiVersion := some " " })

/-- Values made only of characters JavaScript's `trim` strips beyond ASCII space and tab. -/
def unicodeBlanks : List (String × String) :=
  [("vt", "\x0b"), ("ff", "\x0c"), ("nbsp", "\u00a0"), ("bom", "\ufeff"), ("ls", "\u2028"),
    ("ps", "\u2029"), ("ogham", "\u1680"), ("en-quad", "\u2000"), ("hair", "\u200a"),
    ("narrow-nbsp", "\u202f"), ("math", "\u205f"), ("ideographic", "\u3000"),
    ("mixed", " \u00a0\t\u3000\n")]

/-- Configs whose required `baseUrl` (OpenAI-compatible) or `apiVersion` (Azure) is a Unicode-blank
value, and one value made of a zero-width space (which `trim` does not strip). -/
def unicodeBlankConfigs : List (String × ModelConnection.Provider × ModelConnection.Config) :=
  unicodeBlanks.flatMap (fun (tag, v) =>
    [(tag, .openaiCompatible, { baseUrl := some v }),
     (tag, .azureOpenai, { ModelConnection.Config.ofFields [.baseUrl, .deployment, .apiVersion] with
        apiVersion := some v })]) ++
  [("zwsp", .azureOpenai, { ModelConnection.Config.ofFields [.baseUrl, .deployment, .apiVersion] with
      apiVersion := some "\u200b" })]

def readinessWire : ModelConnection.Readiness → String
  | .ready => "ready"
  | .noCredential => "no-credential"
  | .incompleteConfig => "incomplete-config"

def configVector (p : ModelConnection.Provider) (c : ModelConnection.Config) (tag : String) :
    Vector :=
  { id := s!"config/{p.toWire}/{tag}",
    input := Json.mkObj [("provider", p.toWire), ("config", configJson c)],
    expected := Json.mkObj [
      ("allowed", strs ((documentedRule p).1.map (·.toWire))),
      ("required", strs ((documentedRule p).2.map (·.toWire))),
      ("accepted", ModelConnection.configValuesAccepted p c),
      ("complete", ModelConnection.isComplete p c),
      ("readyWithCredential", ModelConnection.ready true p c),
      ("readyWithoutCredential", ModelConnection.ready false p c),
      ("readiness", readinessWire (ModelConnection.readiness true p c)),
      ("readinessWithoutCredential", readinessWire (ModelConnection.readiness false p c))],
    witnesses := cellWitnesses p ++
      [t1 ++ "optional_base_url_providers_accept_nothing_or_a_base_url",
       t1 ++ "openai_compatible_accepts_exactly_a_base_url",
       t1 ++ "azure_accepts_exactly_all_three_fields", t1 ++ "accepted_config_is_complete",
       t1 ++ "blank_config_values_are_refused", t1 ++ "no_credential_is_never_ready",
       t1 ++ "credential_alone_readies_optional_providers",
       t1 ++ "openai_compatible_ready_iff_base_url", t1 ++ "azure_ready_needs_all_three",
       t0 ++ "readiness_agrees_with_ready", t1 ++ "rule_is_the_documented_table",
       t1 ++ "missing_credential_is_reported_first", t1 ++ "incomplete_config_with_credential",
       t1 ++ "azure_empty_readiness", t1 ++ "blank_values_by_character"] }

def configVectors : List Vector :=
  ((WireEnum.all : List ModelConnection.Provider).flatMap fun p => fieldSets.map fun fs =>
    configVector p (ModelConnection.Config.ofFields fs)
      (if fs.isEmpty then "none" else "+".intercalate (fs.map (·.toWire)))) ++
  (blankConfigs.map fun (p, c) =>
    configVector p c ("blank/" ++ "+".intercalate (c.present.map (·.toWire)) ++
      "/" ++ (c.present.filter (fun f => (c.get f).any ModelConnection.isBlank)).head!.toWire)) ++
  unicodeBlankConfigs.map fun (tag, p, c) => configVector p c ("unicode-blank/" ++ tag)

/-! ## Secret names, values and the credential name -/

def secretNameSamples : List String :=
  ["ANTHROPIC_API_KEY", "AZURE_OPENAI_API_KEY", "GITHUB_TOKEN", "INTERNAL_DATABASE_TOKEN", "A",
    "A1", "A_", "A__B", "Z9_Z9", "", "a", "anthropic_api_key", "Anthropic", "1KEY", "_KEY",
    "API-KEY", "API KEY", " API", "API ", "API\n", "ÄPI", "API\u0000",
    String.ofList ('A' :: List.replicate 127 'B'), String.ofList ('A' :: List.replicate 128 'B'),
    "RUNTIME_CONNECTION__DOCKER__FORGED", "RUNTIME_CONNECTION__FOO__X",
    "MODEL_CONNECTION_123E4567E89B12D3A456426614174000", "MODEL_CONNECTION_"]

def purposeWire : Secret.Purpose → String
  | .plain => "plain"
  | .modelConnectionCredential => "model-connection-credential"
  | .runtimeConnection => "runtime-connection"

def secretNameVectors : List Vector :=
  secretNameSamples.map fun (n : String) => Vectors.Vector.mk
    (id := s!"secret-name/{(Json.str n).compress}") (input := Json.str n)
    (expected := Json.mkObj [("valid", Secret.isValidName n),
        ("purpose", purposeWire (Secret.purposeOf n))])
    (witnesses := [t1 ++ "spec_example_names_are_valid", t1 ++ "secret_name_boundaries",
        t5 ++ "reserved_names_are_ordinary_secret_names"])

def secretValueVectors : List Vector :=
  ([0, 1, 2, 1024, 65535, 65536, 65537, 70000] : List Nat).map fun (n : Nat) =>
    { id := s!"secret-value/{n}", input := Json.mkObj [("length", n)],
      expected := Json.mkObj [("accepted", Secret.valueAccepted n)],
      witnesses := [t1 ++ "secret_value_bounds"] }

def connectionIds : List String :=
  ["123e4567-e89b-12d3-a456-426614174000", "00000000-0000-4000-8000-000000000000",
    "ffffffff-ffff-4fff-bfff-ffffffffffff", "ABCDEF01-2345-4678-9ABC-DEF012345678"]

def credentialNameVectors : List Vector :=
  connectionIds.map fun id =>
    let n := Secret.modelConnectionSecretName id
    { id := s!"credential-name/{id}", input := Json.str id,
      expected := Json.mkObj [("name", n), ("validSecretName", Secret.isValidName n),
        ("purpose", purposeWire (Secret.purposeOf n))],
      witnesses := [t0 ++ "credential_name_has_the_model_connection_purpose",
        t5 ++ "reserved_names_are_ordinary_secret_names",
        t5 ++ "model_connection_credential_has_no_foreign_key"] }

/-! ## Runtime-connection names -/

def labelSamples : List String :=
  ["primary", "Primary Docker host", "PRIMARY_HOST", "primary host", "a", "Z", "x1-y2", "ops team 2",
    "", "1st", "-lead", " primary", "_x", "é-cluster", "ok!", String.ofList (List.replicate 90 'a'),
    String.ofList (List.replicate 120 'a')]

def encodeVectors : List Vector :=
  (WireEnum.all : List RuntimeProfile.Driver).flatMap fun d => labelSamples.map fun l =>
    let r := RuntimeProfile.encodeSecretName d.toWire l
    { id := s!"encode/{d.toWire}/{(Json.str l).compress}",
      input := Json.mkObj [("driver", d.toWire), ("label", l)],
      expected := Json.mkObj [("name", match r with | some n => Json.str n | none => Json.null),
        ("decodedDriver", match r.bind RuntimeProfile.decodeDriver with
          | some x => Json.str x | none => Json.null)],
      witnesses := [t0 ++ "encoded_connection_name_is_a_runtime_connection_secret",
        t0 ++ "decode_inverts_encode", t1 ++ "connection_name_is_stored_encoded",
        t5 ++ "connection_label_encoding_collides", t4 ++ "encoded_connections_refine_the_typed_target"] }

def decodeSamples : List String :=
  ["RUNTIME_CONNECTION__DOCKER__PRIMARY", "RUNTIME_CONNECTION__CLOUD_RUN_SANDBOX__X",
    "RUNTIME_CONNECTION__AWS_AGENTCORE__A__B", "RUNTIME_CONNECTION__FOO__X",
    "RUNTIME_CONNECTION__DOCKER", "RUNTIME_CONNECTION____X", "RUNTIME_CONNECTION_DOCKER__X",
    "GITHUB_TOKEN", "MODEL_CONNECTION_123E4567E89B12D3A456426614174000",
    "RUNTIME_CONNECTION__LOCAL__", "RUNTIME_CONNECTION__GKE_AGENT_SANDBOX__POOL_1"]

def decodeVectors : List Vector :=
  decodeSamples.map fun n =>
    { id := s!"decode/{n}", input := Json.str n,
      expected := Json.mkObj [
        ("driver", match RuntimeProfile.decodeDriver n with | some d => Json.str d | none => Json.null),
        ("known", (RuntimeProfile.decodeKnownDriver n).isSome)],
      witnesses := [t0 ++ "decode_inverts_encode", t5 ++ "decoded_driver_may_be_outside_the_catalogue"] }

/-! ## Wire resources -/

def iso : String := "2026-09-23T00:00:00.000Z"

def resourceVectors : List Vector :=
  let secret := Json.mkObj [("id", "s1"), ("name", "GITHUB_TOKEN"), ("algorithm", "aes-256-gcm"),
    ("masterKeyId", "local-v1"), ("createdAt", iso), ("updatedAt", iso)]
  let connection := Json.mkObj [("id", "c1"), ("name", "Claude"), ("provider", "anthropic"),
    ("config", Json.mkObj []), ("hasCredential", true), ("ready", true), ("createdAt", iso),
    ("updatedAt", iso)]
  let profile := Json.mkObj [("id", "rp1"), ("workspaceId", "w1"), ("name", "default"),
    ("driver", "docker"), ("runtimeConnectionId", Json.null), ("cpu", Json.null),
    ("memoryMb", Json.null), ("diskMb", Json.null), ("networkPolicy", "none"),
    ("allowedDomains", Json.null), ("filesystem", "read-write"), ("persistPaths", Json.null),
    ("timeoutSeconds", Json.null), ("idleTimeoutSeconds", Json.null), ("driverConfig", Json.null),
    ("createdAt", iso), ("updatedAt", iso)]
  let runtimeConnection := Json.mkObj [("id", "s1"), ("name", "RUNTIME_CONNECTION__DOCKER__PRIMARY"),
    ("driver", "docker"), ("createdAt", iso)]
  let forbidden := Secret.valueFields ++ ModelConnection.credentialFields ++ ["endpoint"]
  [("secret", Secret.resourceFields, secret,
      [t1 ++ "secret_resource_has_no_value_field", t3 ++ "secret_resource_ignores_the_value"]),
   ("model-connection", ModelConnection.resourceFields, connection,
      [t1 ++ "model_connection_resource_has_no_credential_field",
       t3 ++ "model_connection_resource_ignores_the_credential"]),
   ("runtime-profile", RuntimeProfile.resourceFields, profile,
      [t5 ++ "only_the_profile_resource_carries_workspace_id"]),
   ("runtime-connection", RuntimeProfile.connectionResourceFields, runtimeConnection,
      [t1 ++ "runtime_connection_resource_has_no_endpoint_or_credential"])].map
    fun (n, fields, sample, ws) =>
      { id := s!"resource/{n}", input := Json.mkObj [("resource", n), ("sample", sample),
          ("forbidden", strs (forbidden.filter (!fields.contains ·)))],
        expected := Json.mkObj [("fields", strs fields), ("carriesWorkspaceId", fields.contains "workspaceId")],
        witnesses := ws ++ [t5 ++ "only_the_profile_resource_carries_workspace_id"] }

/-! ## Profile names -/

def profileNameVectors : List Vector :=
  ["default", "a", " default ", "   ", " ", "\t", "\t\n", "", "ä"].map fun (n : String) =>
    Vectors.Vector.mk (id := s!"profile-name/{(Json.str n).compress}") (input := Json.str n)
      (expected := Json.mkObj [("contractAccepted", RuntimeProfile.nameAcceptedByContract n),
        ("databaseAccepted", Secret.sqlNotBlank n)])
      (witnesses := [t5 ++ "blank_profile_name_passes_the_contract_but_not_the_check",
        t0 ++ "valid_profile_satisfies_the_profile_checks"])

/-! ## Numbers -/

def numberSamples : List RuntimeProfile.Decimal :=
  [⟨5, 1⟩, ⟨1, 0⟩, ⟨0, 0⟩, ⟨-1, 0⟩, ⟨25, 2⟩, ⟨2, 0⟩, ⟨20, 1⟩, ⟨512, 0⟩, ⟨2147483647, 0⟩,
    ⟨2147483648, 0⟩, ⟨9007199254740991, 0⟩, ⟨9007199254740992, 0⟩, ⟨15, 1⟩, ⟨-5, 1⟩, ⟨1, 3⟩]

def numberVectors : List Vector :=
  numberSamples.map fun d =>
    { id := s!"number/{d.mantissa}e-{d.exponent}",
      input := Json.num ⟨d.mantissa, d.exponent⟩,
      expected := Json.mkObj [("cpuAccepted", RuntimeProfile.cpuAccepted d),
        ("sizeAccepted", RuntimeProfile.sizeAccepted d),
        ("integerColumnAccepts", RuntimeProfile.integerColumnAccepts d)],
      witnesses := [t1 ++ "cpu_must_be_positive", t1 ++ "profile_sizes_are_positive_safe_integers",
        t5 ++ "contract_cpu_fraction_is_not_storable",
        t5 ++ "contract_size_bound_exceeds_the_integer_column"] }

/-! ## Request field lists -/

/-- Each configuration request body: its field list and the model's key-level parser. -/
def requestShapes : List (String × List String × (List String → Bool) × List String) :=
  [("model-connection-create", ModelConnection.createFields, ModelConnection.createAccepts,
      [t1 ++ "provider_is_not_patchable",
       t1 ++ "model_connection_create_requires_name_provider_and_api_key",
       t1 ++ "closed_body_refuses_an_unknown_key"]),
   ("model-connection-update", ModelConnection.updateFields, ModelConnection.updateAccepts,
      [t1 ++ "provider_is_not_patchable",
       t1 ++ "model_connection_update_is_name_config_and_key",
       t1 ++ "closed_body_refuses_an_unknown_key"]),
   ("secret-create", Secret.createFields, Secret.createAccepts,
      [t1 ++ "secret_bodies_are_closed", t1 ++ "closed_body_refuses_an_unknown_key"]),
   ("secret-replace", Secret.replaceFields, Secret.replaceAccepts,
      [t1 ++ "secret_name_is_not_replaceable", t1 ++ "secret_bodies_are_closed",
       t1 ++ "closed_body_refuses_an_unknown_key"]),
   ("runtime-profile-create", RuntimeProfile.createFields, RuntimeProfile.createAccepts,
      [t1 ++ "driver_network_policy_and_filesystem_are_required",
       t1 ++ "profile_create_fields_are_the_resource_less_server_fields",
       t1 ++ "closed_body_refuses_an_unknown_key"]),
   ("runtime-profile-update", RuntimeProfile.updateFields,
      (fun keys => RuntimeProfile.patchAcceptsCurrent (keys.map (·, .value))),
      [t1 ++ "patch_changes_any_creatable_field"]),
   ("runtime-connection-create", RuntimeProfile.connectionCreateFields,
      RuntimeProfile.connectionCreateAccepts,
      [t1 ++ "runtime_connection_resource_has_no_endpoint_or_credential",
       t1 ++ "runtime_connection_create_requires_every_field",
       t1 ++ "open_body_ignores_added_keys"])]

/-- Keys a caller might try to smuggle into a body: every field any of the lists names, and a few
server-assigned ones. -/
def candidateKeys : List String :=
  (["id", "workspaceId", "createdAt", "updatedAt", "hasCredential", "ready", "bogus"] ++
    requestShapes.flatMap (·.2.1)).eraseDups

def requestFieldVectors : List Vector :=
  requestShapes.map fun (n, fields, accepts, ws) =>
    let extra := candidateKeys.filter (!fields.contains ·)
    { id := s!"request/{n}", input := Json.mkObj [("request", n)],
      expected := Json.mkObj [("fields", strs fields),
        ("required", strs (fields.filter fun k => !accepts (fields.erase k))),
        ("fullBodyAccepted", accepts fields),
        ("emptyBodyAccepted", accepts []),
        ("refusesUnknown", !accepts (fields ++ ["bogus"])),
        ("refused", strs (extra.filter fun k => !accepts (fields ++ [k]))),
        ("ignored", strs (extra.filter fun k => accepts (fields ++ [k])))],
      witnesses := ws ++ [t5 ++ "runtime_connection_create_ignores_unknown_fields"] }

/-! ## Runtime-profile `PATCH` with `null` -/

def patchValueWire : RuntimeProfile.PatchValue → String
  | .null => "null"
  | .value => "value"

def patchVectors : List Vector :=
  RuntimeProfile.updateFields.flatMap fun (k : String) => [RuntimeProfile.PatchValue.null, .value].map fun v =>
    { id := s!"patch/{k}/{patchValueWire v}",
      input := Json.mkObj [("field", k), ("value", patchValueWire v)],
      expected := Json.mkObj [("acceptedToday", RuntimeProfile.patchAcceptsCurrent [(k, v)]),
        ("acceptedByTarget", RuntimeProfile.patchAcceptsTarget [(k, v)]),
        ("nullable", RuntimeProfile.nullableFields.contains k)],
      witnesses := [t1 ++ "patch_cannot_clear_a_field", t1 ++ "patch_changes_any_creatable_field",
        t4 ++ "patch_current_refines_target", t4 ++ "s19_target_clears_sizing_but_not_required_fields"] }

/-! ## The pinned image rule -/

def digest64 : String := AgentWorkspace.Theorems.Normative.ConceptConfiguration.sampleDigest

def imageSamples : List (String × RuntimeProfile.Image) :=
  [("absent", .absent), ("non-text", .nonText),
   ("pinned", .text ("ghcr.io/acme/agent@sha256:" ++ digest64)),
   ("pinned-minimal", .text ("a@sha256:" ++ digest64)),
   ("pinned-hex-mixed", .text ("r/x@sha256:0123456789abcdef" ++ String.ofList (List.replicate 48 '0'))),
   ("pinned-double-at", .text ("x@sha256:0@sha256:" ++ digest64)),
   ("tag", .text "ghcr.io/acme/agent:1.0"), ("empty", .text ""),
   ("no-reference", .text ("@sha256:" ++ digest64)),
   ("upper-hex", .text ("a@sha256:" ++ String.ofList (List.replicate 64 'A'))),
   ("short-digest", .text ("a@sha256:" ++ String.ofList (List.replicate 63 'a'))),
   ("long-digest", .text ("a@sha256:" ++ String.ofList (List.replicate 65 'a'))),
   ("newline-in-reference", .text ("a\nb@sha256:" ++ digest64)),
   ("line-separator-in-reference", .text ("a\u2028b@sha256:" ++ digest64)),
   ("trailing-newline", .text ("a@sha256:" ++ digest64 ++ "\n")),
   ("sha512", .text ("a@sha512:" ++ digest64)),
   ("non-hex", .text ("a@sha256:" ++ String.ofList (List.replicate 64 'g')))]

def imageJson : RuntimeProfile.Image → Json
  | .absent => Json.mkObj [("kind", "absent")]
  | .text t => Json.mkObj [("kind", "text"), ("value", t)]
  | .nonText => Json.mkObj [("kind", "non-text")]

private def driverSnake (d : RuntimeProfile.Driver) : String :=
  d.toWire.map fun c => if c == '-' then '_' else c

def imageVectors : List Vector :=
  (WireEnum.all : List RuntimeProfile.Driver).flatMap fun d => imageSamples.map fun (tag, i) =>
    { id := s!"image/{d.toWire}/{tag}",
      input := Json.mkObj [("driver", d.toWire), ("image", imageJson i)],
      expected := Json.mkObj [("acceptedOnCreate", RuntimeProfile.createImageAccepted d i)],
      witnesses := [t1 ++ s!"{driverSnake d}_profile_create_requires_a_pinned_image",
        t1 ++ "sha256_pin_boundaries", t5 ++ "image_rule_ignores_the_driver"] }

/-! ## Value rules and the trim set -/

def valueSamples : List (String × String) :=
  [("word", "Claude"), ("empty", ""), ("space", " "), ("spaces", "   "), ("tab", "\t"),
   ("newline", "\n"), ("nbsp", "\u00a0"), ("ideographic", "\u3000"), ("bom", "\ufeff"),
   ("zwsp", "\u200b"), ("nel", "\u0085"), ("padded", "  x  "), ("mixed-blank", " \u3000\t\n")]

def valueRuleVectors : List Vector :=
  valueSamples.map fun (tag, v) =>
    { id := s!"value/{tag}", input := Json.str v,
      expected := Json.mkObj [
        ("modelConnectionName", ModelConnection.nameAccepted v),
        ("modelConnectionApiKey", ModelConnection.apiKeyAccepted v),
        ("runtimeConnectionText", RuntimeProfile.connectionTextAccepted v),
        ("runtimeConnectionCredential", RuntimeProfile.connectionCredentialAccepted v)],
      witnesses := [t1 ++ "model_connection_name_is_not_blank_and_api_key_not_empty",
        t1 ++ "runtime_connection_values_are_not_blank", t5 ++ "blank_name_rules_disagree",
        t1 ++ "blank_values_by_character"] }

def trimVectors : List Vector :=
  [{ id := "trim/bmp", input := Json.mkObj [("from", (0 : Nat)), ("to", (0xFFFF : Nat))],
     expected := Json.mkObj [("codePoints", Json.arr (((List.range 0x10000).filter
       ModelConnection.isJsTrimmedCode).map fun (n : Nat) => (n : Json)).toArray)],
     witnesses := [t1 ++ "blank_is_the_js_trim_set", t1 ++ "blank_values_by_character"] }]

def secretOperationVectors : List Vector :=
  [{ id := "secret-operations",
     input := Json.mkObj [("store", "WorkspaceSecretsStore")],
     expected := Json.mkObj [("current", strs (Secret.operationsCurrent.map (·.toWire))),
       ("target", strs (Secret.operationsTarget.map (·.toWire)))],
     witnesses := [t1 ++ "secret_operations_today_and_target"] }]

/-! ## Non-ASCII labels: the recorded divergence -/

def unicodeLabelVectors : List Vector :=
  RuntimeProfile.jsUpperCaseDivergences.map fun (l, ts) =>
    { id := s!"unicode-label/{(Json.str l).compress}",
      input := Json.mkObj [("driver", "docker"), ("label", l)],
      expected := Json.mkObj [
        ("modelName", match RuntimeProfile.encodeSecretName "docker" l with
          | some n => Json.str n | none => Json.null),
        ("codeName", match ts with | some n => Json.str n | none => Json.null),
        ("asciiLabel", RuntimeProfile.isAsciiLabel l)],
      witnesses := [t5 ++ "connection_encoding_model_is_ascii_only"] }

def files : List (String × Json) :=
  [("tables.json", file "concept-configuration"
      "The three configuration tables: columns, keys, checks, inbound references, delete behaviour"
      tableVectors),
   ("foreign-keys.json", file "concept-configuration"
      "Every foreign key that starts or ends in the cluster, with its tenancy class" foreignKeyVectors),
   ("enums.json", file "concept-configuration"
      "The closed sets: providers, config fields, drivers, network policies, filesystems, algorithms"
      enumVectors),
   ("checks.json", file "concept-configuration"
      "The refined checks and the constants their CHECK bodies must carry" checkVectors),
   ("config-rules.json", file "concept-configuration"
      "Every provider x every config field set, and blank values: accepted, complete, ready"
      configVectors),
   ("secret-names.json", file "concept-configuration"
      "SECRET_NAME_PATTERN over examples, boundaries and reserved names" secretNameVectors),
   ("secret-values.json", file "concept-configuration"
      "parseSecretValue length bounds" secretValueVectors),
   ("credential-names.json", file "concept-configuration"
      "modelConnectionSecretName over sample ids" credentialNameVectors),
   ("runtime-connection-encode.json", file "concept-configuration"
      "encodeSecretName over every driver x sample labels" encodeVectors),
   ("runtime-connection-decode.json", file "concept-configuration"
      "decodeDriver over encoded, forged and foreign names" decodeVectors),
   ("resources.json", file "concept-configuration"
      "The wire resources' field sets and the credential fields they refuse" resourceVectors),
   ("profile-names.json", file "concept-configuration"
      "Runtime-profile names: what the contract accepts and what runtime_profiles_name_not_blank accepts"
      profileNameVectors),
   ("numbers.json", file "concept-configuration"
      "cpu and sizing numbers: what the contract accepts and what an integer column stores"
      numberVectors),
   ("request-fields.json", file "concept-configuration"
      "Each configuration request body: accepted keys, required keys, unknown keys refused or ignored"
      requestFieldVectors),
   ("profile-patch.json", file "concept-configuration"
      "Runtime-profile PATCH with null or a value per field: today and the S-19 target" patchVectors),
   ("images.json", file "concept-configuration"
      "driverConfig.image on create, every driver x pinned, tagged and malformed references"
      imageVectors),
   ("value-rules.json", file "concept-configuration"
      "Value rules: connection names non-blank after JS trim, keys and credentials non-empty"
      valueRuleVectors),
   ("trim.json", file "concept-configuration"
      "The BMP code points JavaScript's trim strips (the model's blank set)" trimVectors),
   ("secret-operations.json", file "concept-configuration"
      "The secret operations today and in the documented target" secretOperationVectors),
   ("runtime-connection-unicode.json", file "concept-configuration"
      "Non-ASCII labels where the ASCII encoding model and the Unicode-aware code disagree"
      unicodeLabelVectors)]

/-- Every witness named by a vector of this family. -/
def allWitnesses : List String :=
  (files.flatMap fun (_, j) => match j.getObjValD "vectors" with
    | .arr vs => vs.toList.flatMap fun v => match v.getObjValD "witnesses" with
      | .arr ws => ws.toList.filterMap fun w => w.getStr?.toOption
      | _ => []
    | _ => []).eraseDups

end Vectors.ConceptConfiguration
