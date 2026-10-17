import AgentWorkspace.Er.Current.Configuration

/-!
T1 — the documented sentences about model connections, runtime profiles, runtime connections and
secrets, one theorem each: the per-provider config rule table (one theorem per cell, generated),
readiness, write-only credentials and values, immutable fields, the name shape and value bounds,
the required profile fields, and what deleting a connection or a profile does to its references.
-/

namespace AgentWorkspace.Theorems.Normative.ConceptConfiguration

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Concepts
open AgentWorkspace.Er.Current.Configuration
open ModelConnection (Provider ConfigField rule configAccepted ready)

/-! ## The provider config rule table, one theorem per cell -/

/-- The provider config rule table as 04 §5.3 and `MODEL_PROVIDER_CONFIG_RULES` state it,
transcribed independently of `ModelConnection.rule`: each provider with the fields it accepts and
the fields it requires. -/
@[aw_spec (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")
  (ts := "packages/contracts/src/models.ts#MODEL_PROVIDER_CONFIG_RULES")]
def documentedConfigRules : List (Provider × List ConfigField × List ConfigField) :=
  [(.anthropic, [.baseUrl], []),
    (.anthropicCompatible, [.baseUrl], []),
    (.openai, [.baseUrl], []),
    (.azureOpenai, [.baseUrl, .apiVersion, .deployment], [.baseUrl, .apiVersion, .deployment]),
    (.openaiCompatible, [.baseUrl], [.baseUrl])]

/-- The model's provider config rule is the documented table: it lists every provider once, in
`MODEL_PROVIDERS` order, and each provider's accepted and required fields are the table's. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")
  (ts := "packages/contracts/src/models.ts#MODEL_PROVIDER_CONFIG_RULES")]
theorem rule_is_the_documented_table :
    documentedConfigRules.map (·.1) = (WireEnum.all : List Provider) ∧
      documentedConfigRules.all (fun (p, a, r) => rule p == ⟨a, r⟩) = true := by decide

section Generator

open Lean Elab Command

private def mkDocComment (text : String) : TSyntax ``Lean.Parser.Command.docComment :=
  ⟨mkNode ``Lean.Parser.Command.docComment #[mkAtom "/--", mkAtom (text ++ " -/")]⟩

private def providerCtor : Provider → Name
  | .anthropic => ``Provider.anthropic
  | .anthropicCompatible => ``Provider.anthropicCompatible
  | .openai => ``Provider.openai
  | .azureOpenai => ``Provider.azureOpenai
  | .openaiCompatible => ``Provider.openaiCompatible

private def fieldCtor : ConfigField → Name
  | .baseUrl => ``ConfigField.baseUrl
  | .deployment => ``ConfigField.deployment
  | .apiVersion => ``ConfigField.apiVersion

private def snake (s : String) : String := s.map fun c => if c == '-' then '_' else c

private def fieldSnake : ConfigField → String
  | .baseUrl => "base_url"
  | .deployment => "deployment"
  | .apiVersion => "api_version"

private def verdict (allowed required : Bool) : String :=
  if required then "requires" else if allowed then "accepts but does not require" else "refuses"

/-- One T1 theorem per (provider, config field) cell of the documented table
`documentedConfigRules`: the cell's verdict (and so the theorem's name and statement) is read from
the transcription, and the theorem checks `ModelConnection.rule` against it, so a change to either
breaks the cell. -/
elab "aw_model_rule_cells" : command => do
  for (p, allowed, required) in documentedConfigRules do
    for f in (WireEnum.all : List ConfigField) do
      let a := allowed.contains f
      let r := required.contains f
      let thm := mkIdent (Name.mkSimple s!"{snake p.toWire}_{verdict a r |>.replace " " "_"}_{fieldSnake f}")
      let doc := mkDocComment s!"The `{p.toWire}` provider {verdict a r} the `{f.toWire}` config field."
      let aT := mkIdent (if a then ``true else ``false)
      let rT := mkIdent (if r then ``true else ``false)
      elabCommand (← `(command|
        $doc:docComment
        @[aw_spec (tier := $(mkIdent `T1))
          (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")
          (ts := "packages/contracts/src/models.ts#MODEL_PROVIDER_CONFIG_RULES")]
        theorem $thm :
            ((rule $(mkIdent (providerCtor p))).allowed.contains $(mkIdent (fieldCtor f)),
              (rule $(mkIdent (providerCtor p))).required.contains $(mkIdent (fieldCtor f))) =
              ($aT, $rT) := by decide))

end Generator

aw_model_rule_cells

/-! ## Accepted configs per provider -/

/-- Every set of config fields, in `MODEL_CONNECTION_CONFIG_FIELDS` order. -/
def fieldSets : List (List ConfigField) :=
  [[], [.baseUrl], [.deployment], [.apiVersion], [.baseUrl, .deployment],
    [.baseUrl, .apiVersion], [.deployment, .apiVersion], [.baseUrl, .deployment, .apiVersion]]

/-- The Anthropic, Anthropic-compatible and OpenAI providers accept exactly no config or a lone
`baseUrl`. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")
  (ts := "apps/web/server/models/contract.ts#parseCreateModelConnection")]
theorem optional_base_url_providers_accept_nothing_or_a_base_url :
    [Provider.anthropic, .anthropicCompatible, .openai].all
      (fun p => fieldSets.filter (configAccepted p) == [[], [.baseUrl]]) = true := by decide

/-- The OpenAI-compatible provider accepts exactly a config that is a lone `baseUrl`. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")
  (ts := "apps/web/server/models/contract.ts#parseCreateModelConnection")]
theorem openai_compatible_accepts_exactly_a_base_url :
    fieldSets.filter (configAccepted .openaiCompatible) = [[.baseUrl]] := by decide

/-- The Azure OpenAI provider accepts exactly the config with all three fields. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")
  (ts := "apps/web/server/models/contract.ts#parseCreateModelConnection")]
theorem azure_accepts_exactly_all_three_fields :
    fieldSets.filter (configAccepted .azureOpenai) = [[.baseUrl, .deployment, .apiVersion]] := by
  decide

/-- An accepted config is complete: whatever the server accepts on create or update also passes
`isModelConnectionConfigComplete`, so an accepted connection with a credential is ready. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")
  (ts := "apps/web/server/models/contract.ts#isModelConnectionConfigComplete")]
theorem accepted_config_is_complete :
    (WireEnum.all : List Provider).all (fun p => fieldSets.all fun fs =>
      !configAccepted p fs || ModelConnection.isComplete p (ModelConnection.Config.ofFields fs)) =
      true := by decide

/-- On configs whose fields carry non-blank values, the server's value-level parse and the rule
table's key-level rule agree; a blank value is refused even where the field is allowed. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")
  (ts := "apps/web/server/models/contract.ts#parseCreateModelConnection")]
theorem blank_config_values_are_refused :
    (WireEnum.all : List Provider).all (fun p => fieldSets.all fun fs =>
      configAccepted p fs == ModelConnection.configValuesAccepted p (ModelConnection.Config.ofFields fs))
      = true ∧
    ModelConnection.configValuesAccepted .openaiCompatible { baseUrl := some "  " } = false ∧
    ModelConnection.configValuesAccepted .anthropic { baseUrl := some "\t" } = false := by
  decide

/-- The code points ECMAScript's `String.prototype.trim` strips, transcribed from the language
specification independently of `ModelConnection.isJsTrimmedCode`: *WhiteSpace* (TAB, VT, FF, SP,
NBSP, ZWNBSP and the `Zs` separators U+1680, U+2000–U+200A, U+202F, U+205F, U+3000) and
*LineTerminator* (LF, CR, LS, PS), in code-point order. -/
@[aw_spec (ts := "apps/web/server/models/contract.ts#isModelConnectionConfigComplete")]
def jsTrimCodePoints : List Nat :=
  [0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
    0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000,
    0xFEFF]

/-- Across the Basic Multilingual Plane, the characters the model treats as blank are exactly the
code points JavaScript's `trim` strips. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")
  (ts := "apps/web/server/models/contract.ts#isModelConnectionConfigComplete")]
theorem blank_is_the_js_trim_set :
    (List.range 0x10000).filter ModelConnection.isJsTrimmedCode = jsTrimCodePoints := by
  decide +kernel

/-- Every single JavaScript whitespace or line-terminator character, and any mix of them, is a
blank config value, while a zero-width space, NEL, the Mongolian vowel separator and a letter are
not. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")
  (ts := "apps/web/server/models/contract.ts#isModelConnectionConfigComplete")]
theorem blank_values_by_character :
    [" ", "\t", "\n", "\r", "\x0b", "\x0c", "\u00a0", "\u1680", "\u2000", "\u2005", "\u200a",
        "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff", "", " \u3000\t\n"].all
      ModelConnection.isBlank = true ∧
    ["\u200b", "\u0085", "\u180e", "a", " a ", "\u3000x"].all (!ModelConnection.isBlank ·) =
      true := by
  decide

/-! ## Readiness -/

/-- A connection without a credential is never ready, whatever its provider and config. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")
  (ts := "apps/web/server/models/contract.ts#toModelConnectionResource")]
theorem no_credential_is_never_ready (p : Provider) (c : ModelConnection.Config) :
    ready false p c = false := rfl

/-- A connection without a credential is reported as `noCredential` whatever its config, even an
incomplete one: the missing credential is reported first. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")
  (ts := "packages/contracts/src/models.ts#ModelConnectionResourceSchema")]
theorem missing_credential_is_reported_first (p : Provider) (c : ModelConnection.Config) :
    ModelConnection.readiness false p c = .noCredential := rfl

/-- A connection with a credential is `incompleteConfig` exactly when its config is incomplete for
its provider. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")
  (ts := "apps/web/server/models/contract.ts#isModelConnectionConfigComplete")]
theorem incomplete_config_with_credential (p : Provider) (c : ModelConnection.Config) :
    ModelConnection.readiness true p c = .incompleteConfig ↔
      ModelConnection.isComplete p c = false := by
  cases h : ModelConnection.isComplete p c <;> simp [ModelConnection.readiness, h]

/-- An Azure connection with no config is `noCredential` without its credential and
`incompleteConfig` with it. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")
  (ts := "apps/web/server/models/contract.ts#toModelConnectionResource")]
theorem azure_empty_readiness :
    ModelConnection.readiness false .azureOpenai {} = .noCredential ∧
      ModelConnection.readiness true .azureOpenai {} = .incompleteConfig := by decide

/-- With a credential, a provider that requires no config field is ready with any config. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")
  (ts := "apps/web/server/models/contract.ts#isModelConnectionConfigComplete")]
theorem credential_alone_readies_optional_providers (c : ModelConnection.Config) :
    ready true .anthropic c = true ∧ ready true .anthropicCompatible c = true ∧
      ready true .openai c = true := by
  simp [ready, ModelConnection.isComplete, rule]

/-- With a credential, an OpenAI-compatible connection is ready exactly when its `baseUrl` is set
and not blank. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")
  (ts := "apps/web/server/models/contract.ts#isModelConnectionConfigComplete")]
theorem openai_compatible_ready_iff_base_url (c : ModelConnection.Config) :
    ready true .openaiCompatible c = c.baseUrl.any (!ModelConnection.isBlank ·) := by
  cases h : c.baseUrl <;> simp [ready, ModelConnection.isComplete, rule, ModelConnection.Config.get, h]

/-- With a credential, an Azure OpenAI connection is not ready while any of its three fields is
missing or blank. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")
  (ts := "apps/web/server/models/contract.ts#isModelConnectionConfigComplete")]
theorem azure_ready_needs_all_three :
    ready true .azureOpenai (ModelConnection.Config.ofFields [.baseUrl, .deployment]) = false ∧
      ready true .azureOpenai ⟨some "https://a.example", some "d", some "  "⟩ = false ∧
      ready true .azureOpenai (ModelConnection.Config.ofFields [.baseUrl, .deployment, .apiVersion]) =
        true := by decide

/-! ## Write-only credentials and immutable fields -/

/-- The model-connection resource has no field that could carry the credential, and no
`workspaceId`. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/public-surface.mdx#configure-the-resources")
  (ts := "packages/contracts/src/models.ts#ModelConnectionResourceSchema")]
theorem model_connection_resource_has_no_credential_field :
    ModelConnection.resourceFields.all (fun f => !ModelConnection.credentialFields.contains f) &&
      !ModelConnection.resourceFields.contains "workspaceId" = true := by decide

/-- A model connection's provider is set once at creation: it is not a field `PATCH` accepts. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")
  (ts := "apps/web/server/models/contract.ts#parseUpdateModelConnection")]
theorem provider_is_not_patchable :
    ModelConnection.createFields.contains "provider" &&
      !ModelConnection.updateFields.contains "provider" = true := by decide

/-- The secret resource has no field that could carry the value or any part of its envelope. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#55-secrets--awsecrets")
  (ts := "packages/contracts/src/secrets.ts#SecretResourceSchema")]
theorem secret_resource_has_no_value_field :
    Secret.resourceFields.all (fun f => !Secret.valueFields.contains f) = true := by decide

/-- The runtime-connection resource carries neither the endpoint nor the credential. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes")
  (ts := "packages/contracts/src/runtimes.ts#RuntimeConnectionResourceSchema")]
theorem runtime_connection_resource_has_no_endpoint_or_credential :
    RuntimeProfile.connectionCreateFields.all (fun f =>
      RuntimeProfile.connectionResourceFields.contains f == (f == "name" || f == "driver")) =
      true := by decide

/-- There is no column a plaintext value fits: every value-bearing column of `secrets` is a
`NOT NULL` `bytea`, and the table has no `text` column besides the name, algorithm and
master-key id. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/schema/secrets.ts#secrets")
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
theorem secret_values_are_bytea :
    (Secret.valueColumns.all (fun c => (catalogue .secrets).column? c == some ⟨c, .bytea, true⟩) &&
      (((catalogue .secrets).columns.filter (·.type == .text)).map (·.name) ==
        ["name", "algorithm", "master_key_id"])) = true := by decide

/-! ## Name shape and value bounds -/

/-- The secret names spec §23 gives as examples are valid names. -/
@[aw_spec (tier := T1) (doc := "docs/spec.md#23-secrets")
  (ts := "packages/contracts/src/secrets.ts#SECRET_NAME_PATTERN")]
theorem spec_example_names_are_valid :
    ["ANTHROPIC_API_KEY", "AZURE_OPENAI_API_KEY", "GITHUB_TOKEN", "INTERNAL_DATABASE_TOKEN"].all
      Secret.isValidName = true := by decide

set_option maxRecDepth 100000 in
/-- A name that is empty, lower case, starts with a digit or underscore, contains a hyphen or
space, or exceeds 128 characters is refused; 128 characters are accepted. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#55-secrets--awsecrets")
  (ts := "packages/contracts/src/secrets.ts#SECRET_NAME_PATTERN")]
theorem secret_name_boundaries :
    ["", "anthropic_api_key", "1KEY", "_KEY", "API-KEY", "API KEY",
        String.ofList ('A' :: List.replicate 128 'B')].all (!Secret.isValidName ·) &&
      Secret.isValidName (String.ofList ('A' :: List.replicate 127 'B')) = true := by decide

/-- A value is 1 to 65 536 code units: empty and 65 537 are refused, 1 and 65 536 accepted. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#55-secrets--awsecrets")
  (ts := "apps/web/server/secrets/contract.ts#parseSecretValue")]
theorem secret_value_bounds :
    Secret.valueAccepted 0 = false ∧ Secret.valueAccepted 1 = true ∧
      Secret.valueAccepted 65536 = true ∧ Secret.valueAccepted 65537 = false := by decide

/-- Secrets can be listed, created, replaced and removed today, which is exactly the documented
target: the target is the three original operations plus removal and nothing else. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#55-secrets--awsecrets")
  (ts := "apps/web/server/secrets/store.ts#WorkspaceSecretsStore")]
theorem secret_operations_today_and_target :
    Secret.operationsTarget = [.list, .create, .replace] ++ [.remove] ∧
      Secret.operationsCurrent = Secret.operationsTarget := by decide

/-! ## Request bodies over key sets -/

/-- A closed request parser refuses any body carrying a key outside its field list, whatever else
the body carries. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")
  (ts := "apps/web/server/models/contract.ts#parseCreateModelConnection")
  (ts := "apps/web/server/secrets/contract.ts#parseCreateSecretBody")
  (ts := "packages/core/src/schemas.ts#CreateRuntimeProfileInput")]
theorem closed_body_refuses_an_unknown_key (fields required keys : List String) (k : String)
    (hk : k ∈ keys) (hf : fields.contains k = false) :
    Secret.closedBodyAccepts fields required keys = false := by
  simp only [Secret.closedBodyAccepts, Bool.and_eq_false_iff]
  right
  cases h : keys.all fields.contains
  · rfl
  · rw [List.all_eq_true] at h; rw [h k hk] at hf; contradiction

example : Secret.closedBodyAccepts ModelConnection.createFields [] ["name", "bogus"] = false :=
  closed_body_refuses_an_unknown_key _ _ _ "bogus" (by decide) (by decide)

/-- An open request parser keeps accepting a body when keys are added to it. -/
@[aw_spec (tier := T1)
  (ts := "apps/web/server/runtimes/connections.ts#parseCreateRuntimeConnectionInput")]
theorem open_body_ignores_added_keys (required keys extra : List String)
    (h : Secret.openBodyAccepts required keys = true) :
    Secret.openBodyAccepts required (keys ++ extra) = true := by
  simp only [Secret.openBodyAccepts, List.all_eq_true] at h ⊢
  intro r hr
  have := h r hr
  simp only [List.elem_eq_mem, decide_eq_true_eq] at this ⊢
  exact List.mem_append_left _ this

example : RuntimeProfile.connectionCreateAccepts
    (["name", "driver", "endpoint", "credential"] ++ ["bogus"]) = true :=
  open_body_ignores_added_keys _ _ _ (by decide)

/-- Creating a model connection requires a name, a provider and an API key and may carry a config:
the body with the three is accepted, with the config too, and dropping any of the three or adding
an unknown key is refused. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")
  (ts := "apps/web/server/models/contract.ts#parseCreateModelConnection")]
theorem model_connection_create_requires_name_provider_and_api_key :
    ModelConnection.createAccepts ["name", "provider", "apiKey"] = true ∧
      ModelConnection.createAccepts ["name", "provider", "apiKey", "config"] = true ∧
      ["name", "provider", "apiKey"].all (fun k =>
        !ModelConnection.createAccepts (["name", "provider", "apiKey", "config"].erase k)) = true ∧
      ModelConnection.createAccepts ["name", "provider", "apiKey", "workspaceId"] = false := by
  decide

/-- A model-connection update may carry any subset of `name`, `config` and `apiKey`, including
none, and a body naming the provider is refused. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")
  (ts := "apps/web/server/models/contract.ts#parseUpdateModelConnection")]
theorem model_connection_update_is_name_config_and_key :
    [[], ["name"], ["config"], ["apiKey"], ["name", "config", "apiKey"]].all
        ModelConnection.updateAccepts = true ∧
      [["provider"], ["name", "provider"]].all (!ModelConnection.updateAccepts ·) = true := by
  decide

/-- A secret's create body needs both its name and its value and its replace body exactly its value;
each refuses a missing field and an unknown key. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#55-secrets--awsecrets")
  (ts := "apps/web/server/secrets/contract.ts#parseCreateSecretBody")
  (ts := "apps/web/server/secrets/contract.ts#parseReplaceSecretBody")]
theorem secret_bodies_are_closed :
    Secret.createAccepts ["name", "value"] = true ∧ Secret.createAccepts ["name"] = false ∧
      Secret.createAccepts ["value"] = false ∧ Secret.createAccepts ["name", "value", "id"] = false ∧
      Secret.replaceAccepts ["value"] = true ∧ Secret.replaceAccepts [] = false ∧
      Secret.replaceAccepts ["value", "algorithm"] = false := by decide

/-- A secret's name is immutable: no replace body that carries a `name` is accepted. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#55-secrets--awsecrets")
  (ts := "apps/web/server/secrets/contract.ts#parseReplaceSecretBody")]
theorem secret_name_is_not_replaceable (keys : List String) (h : "name" ∈ keys) :
    Secret.replaceAccepts keys = false :=
  closed_body_refuses_an_unknown_key _ _ keys "name" h (by decide)

example : Secret.replaceAccepts ["value", "name"] = false :=
  secret_name_is_not_replaceable _ (by decide)

/-- A runtime profile is created from every member of spec §15.1's profile but the server-assigned
id; the resource adds only the id, the workspace and the two timestamps; the four required members
alone make an accepted body, and a body carrying the id is refused. -/
@[aw_spec (tier := T1) (doc := "docs/spec.md#151-profile-schema")
  (ts := "packages/core/src/schemas.ts#CreateRuntimeProfileInput")]
theorem profile_create_fields_are_the_resource_less_server_fields :
    RuntimeProfile.resourceFields.filter (!RuntimeProfile.createFields.contains ·) =
        ["id", "workspaceId", "createdAt", "updatedAt"] ∧
      RuntimeProfile.createFields.all RuntimeProfile.resourceFields.contains = true ∧
      RuntimeProfile.createAccepts ["name", "driver", "networkPolicy", "filesystem"] = true ∧
      RuntimeProfile.createAccepts RuntimeProfile.createFields = true ∧
      RuntimeProfile.createAccepts ["id", "name", "driver", "networkPolicy", "filesystem"] =
        false := by
  decide

/-- Creating a runtime connection requires all four of its name, driver, endpoint and credential:
the four are accepted and dropping any one is refused. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes")
  (ts := "apps/web/server/runtimes/connections.ts#parseCreateRuntimeConnectionInput")]
theorem runtime_connection_create_requires_every_field :
    RuntimeProfile.connectionCreateAccepts ["name", "driver", "endpoint", "credential"] = true ∧
      ["name", "driver", "endpoint", "credential"].all (fun k =>
        !RuntimeProfile.connectionCreateAccepts
          (["name", "driver", "endpoint", "credential"].erase k)) = true := by decide

/-! ## Value rules -/

/-- A model connection's name must not be blank (after JavaScript's `trim`), while its API key only
needs to be non-empty. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")
  (ts := "apps/web/server/models/contract.ts#parseCreateModelConnection")]
theorem model_connection_name_is_not_blank_and_api_key_not_empty :
    ["", " ", "\t", "\u3000", " \n "].all (!ModelConnection.nameAccepted ·) = true ∧
      ModelConnection.nameAccepted "Claude" = true ∧
      ModelConnection.apiKeyAccepted "" = false ∧ ModelConnection.apiKeyAccepted " " = true ∧
      ModelConnection.apiKeyAccepted "sk-ant" = true := by decide

/-- A runtime connection's name and endpoint must not be blank and its credential must not be
empty; a credential of spaces is accepted. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes")
  (ts := "apps/web/server/runtimes/connections.ts#parseCreateRuntimeConnectionInput")]
theorem runtime_connection_values_are_not_blank :
    ["", "  ", "\u00a0"].all (!RuntimeProfile.connectionTextAccepted ·) = true ∧
      RuntimeProfile.connectionTextAccepted "https://cluster.example" = true ∧
      RuntimeProfile.connectionCredentialAccepted "" = false ∧
      RuntimeProfile.connectionCredentialAccepted " " = true := by decide

/-! ## Runtime-profile updates -/

/-- A runtime-profile `PATCH` can change but not clear a field: a body setting any field to `null`
is refused, except a field whose `null` is itself a value (`allowedDomains`, BH061-080). -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes")
  (ts := "packages/core/src/schemas.ts#UpdateRuntimeProfileInput")]
theorem patch_cannot_clear_a_field (k : String) (b : List (String × RuntimeProfile.PatchValue))
    (hk : RuntimeProfile.nullAsValueFields.contains k = false)
    (h : (k, .null) ∈ b) : RuntimeProfile.patchAcceptsCurrent b = false := by
  simp only [RuntimeProfile.patchAcceptsCurrent, List.all_eq_false]
  have hk' : k ∉ RuntimeProfile.nullAsValueFields := by simpa using hk
  exact ⟨(k, .null), h, by simp [hk']⟩

example : RuntimeProfile.patchAcceptsCurrent [("memoryMb", .null)] = false :=
  patch_cannot_clear_a_field "memoryMb" _ (by decide) (by decide)

example : RuntimeProfile.patchAcceptsCurrent [("allowedDomains", .null)] = true := by decide

/-- A runtime-profile `PATCH` changes any subset of the creatable fields: each field with a value
is accepted alone, all of them together are accepted, an empty body is accepted, and the id or an
unknown key is refused. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes")
  (ts := "packages/core/src/schemas.ts#UpdateRuntimeProfileInput")]
theorem patch_changes_any_creatable_field :
    RuntimeProfile.createFields.all (fun k => RuntimeProfile.patchAcceptsCurrent [(k, .value)]) =
        true ∧
      RuntimeProfile.patchAcceptsCurrent (RuntimeProfile.createFields.map (·, .value)) = true ∧
      RuntimeProfile.patchAcceptsCurrent [] = true ∧
      RuntimeProfile.patchAcceptsCurrent [("id", .value)] = false ∧
      RuntimeProfile.patchAcceptsCurrent [("workspaceId", .value)] = false := by decide

/-! ## The pinned image rule on create -/

/-- The digest of the pinned image the image theorems and vectors use. -/
def sampleDigest : String := String.ofList (List.replicate 64 'a')

/-- The `sha256` pin rule: a reference with a digest of 64 lower-case hexadecimal digits at the end
is pinned; a tag, an upper-case, short or long digest, an empty reference before `@`, a line break
in the reference and a trailing newline are not. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes")
  (ts := "apps/web/server/runtimes/contract.ts#parseCreateRuntimeProfileInput")]
theorem sha256_pin_boundaries :
    RuntimeProfile.isSha256Pinned ("ghcr.io/acme/agent@sha256:" ++ sampleDigest) = true ∧
      RuntimeProfile.isSha256Pinned ("a@sha256:" ++ sampleDigest) = true ∧
      RuntimeProfile.isSha256Pinned ("x@sha256:0@sha256:" ++ sampleDigest) = true ∧
      RuntimeProfile.isSha256Pinned "ghcr.io/acme/agent:1.0" = false ∧
      RuntimeProfile.isSha256Pinned ("@sha256:" ++ sampleDigest) = false ∧
      RuntimeProfile.isSha256Pinned ("a@sha256:" ++ String.ofList (List.replicate 64 'A')) = false ∧
      RuntimeProfile.isSha256Pinned ("a@sha256:" ++ String.ofList (List.replicate 63 'a')) = false ∧
      RuntimeProfile.isSha256Pinned ("a@sha256:" ++ String.ofList (List.replicate 65 'a')) = false ∧
      RuntimeProfile.isSha256Pinned ("a\nb@sha256:" ++ sampleDigest) = false ∧
      RuntimeProfile.isSha256Pinned ("a@sha256:" ++ sampleDigest ++ "\n") = false ∧
      RuntimeProfile.isSha256Pinned ("a@sha512:" ++ sampleDigest) = false := by decide

section ImageCells

open Lean Elab Command

private def mkImageDoc (text : String) : TSyntax ``Lean.Parser.Command.docComment :=
  ⟨mkNode ``Lean.Parser.Command.docComment #[mkAtom "/--", mkAtom (text ++ " -/")]⟩

private def driverIdent : RuntimeProfile.Driver → Name
  | .local => ``RuntimeProfile.Driver.local
  | .sandboxRuntime => ``RuntimeProfile.Driver.sandboxRuntime
  | .docker => ``RuntimeProfile.Driver.docker
  | .kubernetes => ``RuntimeProfile.Driver.kubernetes
  | .gkeAgentSandbox => ``RuntimeProfile.Driver.gkeAgentSandbox
  | .acaSessions => ``RuntimeProfile.Driver.acaSessions
  | .awsAgentcore => ``RuntimeProfile.Driver.awsAgentcore
  | .awsEcs => ``RuntimeProfile.Driver.awsEcs
  | .cloudRunSandbox => ``RuntimeProfile.Driver.cloudRunSandbox
  | .cloudRunService => ``RuntimeProfile.Driver.cloudRunService
  | .external => ``RuntimeProfile.Driver.external
  | .vercelSandbox => ``RuntimeProfile.Driver.vercelSandbox
  | .cloudflareSandbox => ``RuntimeProfile.Driver.cloudflareSandbox

/-- One T1 theorem per driver: creating a profile of that driver accepts no image or a
`sha256`-pinned one and refuses a tagged image and a non-string image. -/
elab "aw_image_pin_cells" : command => do
  for d in (WireEnum.all : List RuntimeProfile.Driver) do
    let snake := d.toWire.map fun c => if c == '-' then '_' else c
    let thm := mkIdent (Name.mkSimple s!"{snake}_profile_create_requires_a_pinned_image")
    let doc := mkImageDoc s!"Creating a `{d.toWire}` runtime profile accepts no image or a sha256-pinned image and refuses a tagged or non-string image."
    let dI := mkIdent (driverIdent d)
    elabCommand (← `(command|
      $doc:docComment
      @[aw_spec (tier := $(mkIdent `T1))
        (doc := "docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes")
        (ts := "apps/web/server/runtimes/contract.ts#parseCreateRuntimeProfileInput")]
      theorem $thm :
          RuntimeProfile.createImageAccepted $dI .absent = true ∧
            RuntimeProfile.createImageAccepted $dI
              (.text ("ghcr.io/acme/agent@sha256:" ++ sampleDigest)) = true ∧
            RuntimeProfile.createImageAccepted $dI (.text "ghcr.io/acme/agent:1.0") = false ∧
            RuntimeProfile.createImageAccepted $dI .nonText = false := by decide))

end ImageCells

aw_image_pin_cells

/-! ## Runtime profiles -/

/-- `cpu` must be greater than zero and may be a fraction: 0 and -1 are refused, 0.5 and 1 are
accepted. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes")
  (ts := "packages/contracts/src/runtimes.ts#RUNTIME_PROFILE_BOUNDS")]
theorem cpu_must_be_positive :
    RuntimeProfile.cpuAccepted ⟨0, 0⟩ = false ∧ RuntimeProfile.cpuAccepted ⟨-1, 0⟩ = false ∧
      RuntimeProfile.cpuAccepted ⟨5, 1⟩ = true ∧ RuntimeProfile.cpuAccepted ⟨1, 0⟩ = true := by
  decide

/-- `memoryMb`, `diskMb`, `timeoutSeconds` and `idleTimeoutSeconds` are positive safe integers:
0, -1, 0.5 and `MAX_SAFE_INTEGER + 1` are refused, 1 and `MAX_SAFE_INTEGER` accepted. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes")
  (ts := "packages/contracts/src/runtimes.ts#RUNTIME_PROFILE_BOUNDS")]
theorem profile_sizes_are_positive_safe_integers :
    RuntimeProfile.sizeAccepted ⟨0, 0⟩ = false ∧ RuntimeProfile.sizeAccepted ⟨-1, 0⟩ = false ∧
      RuntimeProfile.sizeAccepted ⟨5, 1⟩ = false ∧ RuntimeProfile.sizeAccepted ⟨1, 0⟩ = true ∧
      RuntimeProfile.sizeAccepted ⟨9007199254740991, 0⟩ = true ∧
      RuntimeProfile.sizeAccepted ⟨9007199254740992, 0⟩ = false := by decide

/-- A profile's driver, network policy and filesystem mode are required, explicit choices: the
columns are `NOT NULL` and the create body must name them. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/site/concepts/data-plane.mdx#what-never-changes")
  (doc := "docs/spec.md#151-profile-schema")
  (ts := "packages/core/src/schemas.ts#CreateRuntimeProfileInput")]
theorem driver_network_policy_and_filesystem_are_required :
    ["name", "driver", "network_policy", "filesystem"].all (catalogue .runtimeProfiles).isNotNull &&
      ["name", "driver", "networkPolicy", "filesystem"].all
        RuntimeProfile.requiredCreateFields.contains = true := by decide

/-- Every other profile field is optional: the sizing, timeout, allowlist, persistence,
connection and driver-config columns are nullable. -/
@[aw_spec (tier := T1) (doc := "docs/spec.md#151-profile-schema")
  (ts := "packages/core/src/db/schema/runtime-profiles.ts#runtimeProfiles")]
theorem other_profile_fields_are_optional :
    ["runtime_connection_id", "cpu", "memory_mb", "disk_mb", "allowed_domains", "persist_paths",
        "timeout_seconds", "idle_timeout_seconds", "driver_config"].all
      (fun c => (catalogue .runtimeProfiles).hasColumn c &&
        !(catalogue .runtimeProfiles).isNotNull c) = true := by decide

/-- A runtime connection is stored under its encoded name: `docker` and `primary` store
`RUNTIME_CONNECTION__DOCKER__PRIMARY`. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes")
  (ts := "apps/web/server/runtimes/connections.ts#encodeSecretName")]
theorem connection_name_is_stored_encoded :
    RuntimeProfile.encodeSecretName "docker" "primary" = some "RUNTIME_CONNECTION__DOCKER__PRIMARY" ∧
      RuntimeProfile.encodeSecretName "cloud-run-sandbox" "Primary Docker host" =
        some "RUNTIME_CONNECTION__CLOUD_RUN_SANDBOX__PRIMARY_DOCKER_HOST" := by decide

/-- A runtime profile's connection is a `secrets` row: both keys over `runtime_connection_id`
reference `secrets`, one of them paired with the workspace. -/
@[aw_spec (tier := T1) (doc := "docs/spec.md#149-switching-the-runtime")
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")
  (ts := "packages/core/src/db/schema/runtime-profiles.ts#runtimeProfiles")]
theorem runtime_connection_is_a_secret_reference :
    ((catalogue .runtimeProfiles).foreignKeys.filter (·.columns.contains "runtime_connection_id")).map
        (fun fk => (fk.refTable, fk.onDelete)) = [(.secrets, .setNull), (.secrets, .noAction)] := by
  decide

/-! ## Deleting connections and profiles -/

/-- Deleting a model connection is never refused by a reference: every agent, project, run and
workspace key into `model_connections` clears itself (`ON DELETE SET NULL`, directly or through its
sibling), and every such `SET NULL` is executable. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")
  (ts := "packages/core/src/db/schema/agents.ts#agents")]
theorem deleting_a_model_connection_is_never_blocked :
    deleteNeverBlocked catalogue .modelConnections = true := by decide

/-- Deleting a runtime profile is never refused by a reference: the agents' reference is cleared
(`ON DELETE SET NULL`). -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes")
  (ts := "packages/core/src/db/schema/agents.ts#agents")]
theorem deleting_a_runtime_profile_is_never_blocked :
    deleteNeverBlocked catalogue .runtimeProfiles = true := by decide

/-- The references into `model_connections` are exactly the agent, project, run and workspace
pointers, each a `SET NULL` key with a `NO ACTION` tenant-paired sibling. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")
  (ts := "packages/core/src/db/schema/model-connections.ts#modelConnections")]
theorem model_connection_references :
    (inbound catalogue .modelConnections).map (fun (t, fk) => (t, fk.onDelete)) =
      [(.agents, .setNull), (.agents, .noAction), (.projects, .setNull), (.projects, .noAction),
        (.runs, .setNull), (.runs, .noAction), (.workspaces, .setNull),
        (.workspaces, .noAction)] := by decide

/-! ## Uniqueness and ownership -/

/-- Model connections, runtime profiles and secrets are each named uniquely within a workspace (a
total `(workspace_id, name)` unique index), and identified by `(id, workspace_id)` for composite
references. -/
@[aw_spec (tier := T1)
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")
  (ts := "packages/core/src/db/schema/runtime-profiles.ts#runtimeProfiles")
  (ts := "packages/core/src/db/schema/model-connections.ts#modelConnections")
  (ts := "packages/core/src/db/schema/secrets.ts#secrets")]
theorem names_are_unique_per_workspace :
    clusterTables.all (fun t => (catalogue t).isKey ["workspace_id", "name"] &&
      (catalogue t).isKey ["id", "workspace_id"]) = true := by decide

/-- The configuration tables carry no owning principal: they are workspace-level configuration,
not rows that can be "own" or "other". -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#2-resource-model")
  (ts := "packages/core/src/db/schema/model-connections.ts#modelConnections")]
theorem configuration_rows_have_no_owner :
    clusterTables.all (fun t =>
      !(catalogue t).hasColumn "owner_principal_id" && !(catalogue t).hasColumn "created_by") =
      true := by decide

end AgentWorkspace.Theorems.Normative.ConceptConfiguration
