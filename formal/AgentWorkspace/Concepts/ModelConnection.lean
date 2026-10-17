import AgentWorkspace.Concepts.Secret

/-!
# The model-connection concept

A **model connection** is one configured way for a workspace to reach a model provider: a
provider, a display name unique in the workspace, the non-secret settings that provider needs
(`config`), and a write-only credential. The database knows it as a row of `model_connections`
(`packages/core/src/db/schema/model-connections.ts`), which holds the non-secret half only; the
credential is a `secrets` row found by name (`Concepts/Secret.lean`, `modelConnectionSecretName`),
not by a foreign key. The wire knows it as `ModelConnectionResourceSchema`
(`packages/contracts/src/models.ts`), which says whether a credential exists (`hasCredential`) and
whether the connection is usable (`ready`), never what the credential is.

A model connection is not a *provider* (the provider is one attribute of it, and one provider can
back many connections) and not a *model* (a model is discovered through a ready connection, and a
model choice is always the pair `(connection, provider model id)`).

**States.** A connection has no stored status. Its readiness is derived on every read:
`ready`, `noCredential` or `incompleteConfig`. Transitions (create, update, rotate, delete) belong
to the behaviour phase.
-/

namespace AgentWorkspace.Concepts.ModelConnection

open AgentWorkspace

/-! ## Providers and config fields -/

/-- The model providers (`modelProviders` in the schema, `MODEL_PROVIDERS` on the wire), in the
`as const` order. -/
@[aw_spec (ts := "packages/core/src/db/schema/model-connections.ts#modelProviders")
  (ts := "packages/contracts/src/runs.ts#MODEL_PROVIDERS")
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")]
inductive Provider where
  | anthropic
  | anthropicCompatible
  | openai
  | azureOpenai
  | openaiCompatible
  deriving DecidableEq, Repr, Inhabited

/-- The wire and column spelling of a provider. -/
def Provider.toWire : Provider → String
  | .anthropic => "anthropic"
  | .anthropicCompatible => "anthropic-compatible"
  | .openai => "openai"
  | .azureOpenai => "azure-openai"
  | .openaiCompatible => "openai-compatible"

instance : WireEnum Provider where
  all := [.anthropic, .anthropicCompatible, .openai, .azureOpenai, .openaiCompatible]
  toWire := Provider.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by intro a b; cases a <;> cases b <;> decide

/-- The non-credential settings a connection can carry (`MODEL_CONNECTION_CONFIG_FIELDS`). -/
@[aw_spec (ts := "packages/contracts/src/models.ts#MODEL_CONNECTION_CONFIG_FIELDS")]
inductive ConfigField where
  | baseUrl
  | deployment
  | apiVersion
  deriving DecidableEq, Repr, Inhabited

/-- The wire spelling of a config field. -/
def ConfigField.toWire : ConfigField → String
  | .baseUrl => "baseUrl"
  | .deployment => "deployment"
  | .apiVersion => "apiVersion"

instance : WireEnum ConfigField where
  all := [.baseUrl, .deployment, .apiVersion]
  toWire := ConfigField.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by intro a b; cases a <;> cases b <;> decide

/-- One provider's config rule: the fields it accepts and the fields it requires. -/
structure ConfigRule where
  allowed : List ConfigField
  required : List ConfigField
  deriving DecidableEq, Repr

/-- `MODEL_PROVIDER_CONFIG_RULES` (and the server's `PROVIDER_CONFIG_SPEC`): the Anthropic
providers and OpenAI take an optional `baseUrl`, OpenAI-compatible requires it, and Azure OpenAI
requires all three fields. -/
@[aw_spec (ts := "packages/contracts/src/models.ts#MODEL_PROVIDER_CONFIG_RULES")
  (ts := "apps/web/server/models/contract.ts#PROVIDER_CONFIG_SPEC")
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")]
def rule : Provider → ConfigRule
  | .anthropic => ⟨[.baseUrl], []⟩
  | .anthropicCompatible => ⟨[.baseUrl], []⟩
  | .openai => ⟨[.baseUrl], []⟩
  | .openaiCompatible => ⟨[.baseUrl], [.baseUrl]⟩
  | .azureOpenai => ⟨[.baseUrl, .apiVersion, .deployment], [.baseUrl, .apiVersion, .deployment]⟩

/-! ## Config values -/

/-- A stored config: each field absent or a string. -/
@[aw_spec (ts := "packages/contracts/src/models.ts#ModelConnectionConfigSchema")
  (ts := "packages/core/src/db/schema/model-connections.ts#ModelConnectionConfig")]
structure Config where
  baseUrl : Option String := none
  deployment : Option String := none
  apiVersion : Option String := none
  deriving DecidableEq, Repr, Inhabited

/-- The value of one field. -/
def Config.get (c : Config) : ConfigField → Option String
  | .baseUrl => c.baseUrl
  | .deployment => c.deployment
  | .apiVersion => c.apiVersion

/-- The fields a config carries, in `MODEL_CONNECTION_CONFIG_FIELDS` order. -/
def Config.present (c : Config) : List ConfigField :=
  (WireEnum.all : List ConfigField).filter fun f => (c.get f).isSome

/-- A config with exactly the given fields, each set to a fixed non-empty value. -/
def Config.ofFields (fs : List ConfigField) : Config :=
  { baseUrl := if fs.contains .baseUrl then some "https://models.example.com" else none,
    deployment := if fs.contains .deployment then some "prod" else none,
    apiVersion := if fs.contains .apiVersion then some "2024-10-21" else none }

/-- A code point `String.prototype.trim` strips: ECMAScript's *WhiteSpace* (TAB, VT, FF, ZWNBSP and
every `Zs` space separator: SP, NBSP, U+1680, U+2000–U+200A, U+202F, U+205F, U+3000) and
*LineTerminator* (LF, CR, LS, PS). -/
def isJsTrimmedCode (n : Nat) : Bool :=
  n == 0x09 || n == 0x0A || n == 0x0B || n == 0x0C || n == 0x0D || n == 0x20 || n == 0xA0 ||
    n == 0x1680 || (0x2000 ≤ n && n ≤ 0x200A) || n == 0x2028 || n == 0x2029 || n == 0x202F ||
    n == 0x205F || n == 0x3000 || n == 0xFEFF

/-- A character `String.prototype.trim` strips (`isJsTrimmedCode` on its code point). -/
def isJsTrimmed (c : Char) : Bool := isJsTrimmedCode c.toNat

/-- JavaScript's `value.trim() === ''`: every character is one `trim` strips. -/
def isBlank (s : String) : Bool := s.toList.all isJsTrimmed

/-- `isModelConnectionConfigComplete`: every field the provider requires is present and not
blank. -/
@[aw_spec (ts := "apps/web/server/models/contract.ts#isModelConnectionConfigComplete")
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")]
def isComplete (p : Provider) (c : Config) : Bool :=
  (rule p).required.all fun f => match c.get f with
    | some v => !isBlank v
    | none => false

/-- `parseProviderConfig`'s key rule, for a config whose present fields all carry a non-empty,
reachable absolute URL or string: accepted exactly when every present field is allowed for the
provider and every required field is present. -/
@[aw_spec (ts := "apps/web/server/models/contract.ts#parseCreateModelConnection")
  (ts := "packages/contracts/src/models.ts#MODEL_PROVIDER_CONFIG_RULES")]
def configAccepted (p : Provider) (fields : List ConfigField) : Bool :=
  fields.all (rule p).allowed.contains && (rule p).required.all fields.contains

/-- `parseProviderConfig` on a stored-shape config: every present field is allowed for the
provider and not blank, and every required field is present. A present `baseUrl` is assumed to be
an absolute URL the egress policy allows (the model does not model URLs or egress). -/
@[aw_spec (ts := "apps/web/server/models/contract.ts#parseCreateModelConnection")
  (ts := "apps/web/server/models/contract.ts#parseUpdateModelConnection")]
def configValuesAccepted (p : Provider) (c : Config) : Bool :=
  c.present.all (rule p).allowed.contains &&
    c.present.all (fun f => (c.get f).any (!isBlank ·)) &&
    (rule p).required.all c.present.contains

/-! ## Readiness -/

/-- The derived readiness of a connection. -/
@[aw_spec (ts := "packages/contracts/src/models.ts#ModelConnectionResourceSchema")
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")]
inductive Readiness where
  | ready
  | noCredential
  | incompleteConfig
  deriving DecidableEq, Repr, Inhabited

/-- `ready = hasCredential && isModelConnectionConfigComplete(provider, config)`. -/
@[aw_spec (ts := "apps/web/server/models/contract.ts#toModelConnectionResource")
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")]
def ready (hasCredential : Bool) (p : Provider) (c : Config) : Bool :=
  hasCredential && isComplete p c

/-- The readiness state; a missing credential is reported before an incomplete config. -/
def readiness (hasCredential : Bool) (p : Provider) (c : Config) : Readiness :=
  if !hasCredential then .noCredential
  else if isComplete p c then .ready
  else .incompleteConfig

/-! ## The stored row and the wire resource -/

/-- One `model_connections` row as the concept knows it. -/
@[aw_spec (ts := "packages/core/src/db/schema/model-connections.ts#modelConnections")
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
structure ModelConnection where
  id : ModelConnectionId
  workspace : WorkspaceId
  name : String
  provider : Provider
  config : Config
  createdAt : String
  updatedAt : String
  deriving DecidableEq, Repr, Inhabited

/-- The secret name that holds this connection's credential. -/
@[aw_spec (ts := "apps/web/server/models/store.ts#modelConnectionSecretName")]
def ModelConnection.credentialSecretName (m : ModelConnection) : String :=
  Secret.modelConnectionSecretName m.id.val

/-- `ModelConnectionResourceSchema`. -/
@[aw_spec (ts := "packages/contracts/src/models.ts#ModelConnectionResourceSchema")]
structure Resource where
  id : String
  name : String
  provider : String
  config : Config
  hasCredential : Bool
  ready : Bool
  createdAt : String
  updatedAt : String
  deriving DecidableEq, Repr, Inhabited

/-- `toModelConnectionResource`, given the stored credential if there is one: only whether it
exists reaches the resource. -/
@[aw_spec (ts := "apps/web/server/models/contract.ts#toModelConnectionResource")]
def ModelConnection.toResource (m : ModelConnection) (credential : Option String) : Resource :=
  { id := m.id.val, name := m.name, provider := m.provider.toWire, config := m.config,
    hasCredential := credential.isSome, ready := ready credential.isSome m.provider m.config,
    createdAt := m.createdAt, updatedAt := m.updatedAt }

/-- The field names of `ModelConnectionResourceSchema`. -/
@[aw_spec (ts := "packages/contracts/src/models.ts#ModelConnectionResourceSchema")]
def resourceFields : List String :=
  ["id", "name", "provider", "config", "hasCredential", "ready", "createdAt", "updatedAt"]

/-- The names under which a credential could appear on the wire. -/
def credentialFields : List String := ["apiKey", "credential", "secret", "value"]

/-- The fields `POST /api/model-connections` accepts. -/
@[aw_spec (ts := "apps/web/server/models/contract.ts#parseCreateModelConnection")
  (ts := "packages/contracts/src/models.ts#CreateModelConnectionInput")]
def createFields : List String := ["name", "provider", "apiKey", "config"]

/-- The fields `POST /api/model-connections` requires; `config` may be omitted. -/
@[aw_spec (ts := "apps/web/server/models/contract.ts#parseCreateModelConnection")
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")]
def createRequiredFields : List String := ["name", "provider", "apiKey"]


/-- The fields `PATCH /api/model-connections/:id` accepts: the provider is write-once, and an
`apiKey` replaces the saved key (a changed `config.baseUrl` needs one, so the saved key never
follows the connection to a new destination). -/
@[aw_spec (ts := "apps/web/server/models/contract.ts#parseUpdateModelConnection")
  (ts := "packages/contracts/src/models.ts#UpdateModelConnectionPatch")
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")]
def updateFields : List String := ["name", "config", "apiKey"]

/-- `parseCreateModelConnection` over the keys of a body (each present value valid): closed, with
`name`, `provider` and `apiKey` required. -/
@[aw_spec (ts := "apps/web/server/models/contract.ts#parseCreateModelConnection")
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")]
def createAccepts (keys : List String) : Bool :=
  Secret.closedBodyAccepts createFields createRequiredFields keys

/-- `parseUpdateModelConnection` over the keys of a body (each present value valid): closed, and
nothing is required, so an empty body is a no-op update. -/
@[aw_spec (ts := "apps/web/server/models/contract.ts#parseUpdateModelConnection")
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")]
def updateAccepts (keys : List String) : Bool := Secret.closedBodyAccepts updateFields [] keys

/-- The value rule for a connection's `name` on create and update: a string that is not blank after
JavaScript's `trim`. -/
@[aw_spec (ts := "apps/web/server/models/contract.ts#parseCreateModelConnection")
  (ts := "apps/web/server/models/contract.ts#parseUpdateModelConnection")]
def nameAccepted (s : String) : Bool := !isBlank s

/-- The value rule for `apiKey` on create: any non-empty string; a key made of spaces is accepted. -/
@[aw_spec (ts := "apps/web/server/models/contract.ts#parseCreateModelConnection")]
def apiKeyAccepted (s : String) : Bool := !s.isEmpty

/-- A model choice: always a connection and a provider-side model id together. -/
@[aw_spec (ts := "packages/contracts/src/models.ts#DiscoveredModelSchema")
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")]
structure ModelChoice where
  connection : ModelConnectionId
  model : String
  deriving DecidableEq, Repr, Inhabited

end AgentWorkspace.Concepts.ModelConnection
