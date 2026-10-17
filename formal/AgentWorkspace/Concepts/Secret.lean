import AgentWorkspace.Prelude.Json
import AgentWorkspace.Prelude.Ids

/-!
# The secret concept

A **secret** is one envelope-encrypted value of one workspace, addressed by an upper-case,
environment-variable-shaped name (`ANTHROPIC_API_KEY`). The database knows it as a row of
`secrets` (`packages/core/src/db/schema/secrets.ts`); the wire knows only its metadata
(`SecretResourceSchema` in `packages/contracts/src/secrets.ts`). The value goes in once and never
comes out.

Two other concepts are stored as secrets rows today and are told apart only by a naming
convention, which this module states as data so the conflation is visible:

* a **model-connection credential** is the secret named `MODEL_CONNECTION_<id, hyphens removed,
  upper case>` (`apps/web/server/models/store.ts`, `modelConnectionSecretName`);
* a **runtime connection** is a secret named `RUNTIME_CONNECTION__<DRIVER>__<LABEL>` whose value
  is the JSON `{endpoint, credential}` (`apps/web/server/runtimes/connections.ts`; its encoding is
  modelled in `Concepts/RuntimeProfile.lean`).

**Model choices.** A `bytea` column is modelled by its octet length only, because every database
check on it (`secrets_wrapped_data_key_size`, `…_nonce_sizes`, `…_tag_sizes`,
`…_ciphertext_not_empty`) reads only `octet_length`. A secret has no lifecycle states: it is
created, its value may be replaced in place, and there is no delete route today (roadmap S-10).
-/

namespace AgentWorkspace.Concepts.Secret

open AgentWorkspace

/-! ## The envelope algorithm -/

/-- The envelope algorithms the schema accepts: one, deliberately (`secretAlgorithms`). -/
@[aw_spec (ts := "packages/core/src/db/schema/secrets.ts#secretAlgorithms")]
inductive Algorithm where
  | aes256Gcm
  deriving DecidableEq, Repr, Inhabited

/-- The wire and column spelling of an algorithm. -/
def Algorithm.toWire : Algorithm → String
  | .aes256Gcm => "aes-256-gcm"

instance : WireEnum Algorithm where
  all := [.aes256Gcm]
  toWire := Algorithm.toWire
  complete := by intro a; cases a; decide
  nodup := by decide
  toWire_injective := by intro a b _; cases a; cases b; rfl

/-! ## Sizes and bounds -/

/-- `SECRET_NONCE_BYTES`: an AES-GCM nonce is 12 bytes. -/
@[aw_spec (ts := "packages/core/src/db/schema/secrets.ts#SECRET_NONCE_BYTES")]
def nonceBytes : Nat := 12

/-- `SECRET_TAG_BYTES`: the full 16-byte AES-GCM tag. -/
@[aw_spec (ts := "packages/core/src/db/schema/secrets.ts#SECRET_TAG_BYTES")]
def tagBytes : Nat := 16

/-- `SECRET_WRAPPED_DATA_KEY_BYTES`: a wrapped AES-256 data key is 32 bytes. -/
@[aw_spec (ts := "packages/core/src/db/schema/secrets.ts#SECRET_WRAPPED_DATA_KEY_BYTES")]
def wrappedDataKeyBytes : Nat := 32

/-- `SECRET_NAME_MAX_LENGTH`: a name has at most 128 characters. -/
@[aw_spec (ts := "packages/contracts/src/secrets.ts#SECRET_NAME_MAX_LENGTH")]
def nameMaxLength : Nat := 128

/-- `SECRET_VALUE_MAX_LENGTH`: a value has at most 64 KiB code units. -/
@[aw_spec (ts := "packages/contracts/src/secrets.ts#SECRET_VALUE_MAX_LENGTH")
  (ts := "apps/web/server/secrets/contract.ts#SECRET_VALUE_MAX_LENGTH")]
def valueMaxLength : Nat := 64 * 1024

/-! ## The name shape -/

/-- A first character of a name: an upper-case ASCII letter. -/
def isNameHead (c : Char) : Bool := 'A' ≤ c && c ≤ 'Z'

/-- A later character of a name: an upper-case ASCII letter, a digit or `_`. -/
def isNameTail (c : Char) : Bool := isNameHead c || ('0' ≤ c && c ≤ '9') || c == '_'

/-- `SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/` over a character list. -/
def isValidNameChars : List Char → Bool
  | [] => false
  | c :: rest => isNameHead c && rest.all isNameTail && rest.length ≤ nameMaxLength - 1

/-- `SECRET_NAME_PATTERN` (and the `secrets_name_shape` CHECK it is transcribed from): an upper-case
letter, then at most 127 upper-case letters, digits and underscores. -/
@[aw_spec (ts := "packages/contracts/src/secrets.ts#SECRET_NAME_PATTERN")
  (ts := "apps/web/server/secrets/contract.ts#parseSecretName")
  (ts := "packages/core/src/db/schema/secrets.ts#secrets")
  (doc := "docs/sdk/04-api-specification.md#55-secrets--awsecrets")]
def isValidName (s : String) : Bool := isValidNameChars s.toList

/-- `parseSecretValue` on a string of `length` code units: non-empty and at most 64 KiB. -/
@[aw_spec (ts := "apps/web/server/secrets/contract.ts#parseSecretValue")
  (doc := "docs/sdk/04-api-specification.md#55-secrets--awsecrets")]
def valueAccepted (length : Nat) : Bool := 1 ≤ length && length ≤ valueMaxLength

/-! ## The stored row -/

/-- PostgreSQL's `length(btrim(s)) > 0`: `btrim` with no second argument strips spaces only, so a
string is blank to the database when every character is a space. -/
def sqlNotBlank (s : String) : Bool := s.toList.any (· != ' ')

/-- The envelope: the master key that wrapped the data key, and the octet lengths of the seven
`bytea` parts. -/
@[aw_spec (ts := "packages/core/src/db/schema/secrets.ts#secrets")
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
structure Envelope where
  masterKeyId : String
  wrappedDataKey : Nat
  wrappedDataKeyNonce : Nat
  wrappedDataKeyTag : Nat
  ciphertext : Nat
  ciphertextNonce : Nat
  ciphertextTag : Nat
  deriving DecidableEq, Repr, Inhabited

/-- The envelope checks: a named master key (`secrets_master_key_id_not_blank`), and every part at
its exact size (`…_wrapped_data_key_size`, `…_nonce_sizes`, `…_tag_sizes`), with a non-empty
ciphertext (`…_ciphertext_not_empty`). -/
@[aw_spec (ts := "packages/core/src/db/schema/secrets.ts#secrets")]
def Envelope.wellFormed (e : Envelope) : Bool :=
  sqlNotBlank e.masterKeyId && e.wrappedDataKey == wrappedDataKeyBytes &&
    e.wrappedDataKeyNonce == nonceBytes && e.ciphertextNonce == nonceBytes &&
    e.wrappedDataKeyTag == tagBytes && e.ciphertextTag == tagBytes && 0 < e.ciphertext

/-- One `secrets` row as the concept knows it. -/
@[aw_spec (ts := "packages/core/src/db/schema/secrets.ts#secrets")
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
structure Secret where
  id : SecretId
  workspace : WorkspaceId
  name : String
  algorithm : Algorithm
  envelope : Envelope
  createdAt : String
  updatedAt : String
  deriving DecidableEq, Repr, Inhabited

/-- A secret the database accepts: a well-shaped name and a well-formed envelope. -/
def Secret.valid (s : Secret) : Bool := isValidName s.name && s.envelope.wellFormed

/-! ## The wire resource -/

/-- `SecretResourceSchema`: the metadata only. -/
@[aw_spec (ts := "packages/contracts/src/secrets.ts#SecretResourceSchema")
  (ts := "apps/web/server/secrets/contract.ts#toSecretResource")]
structure Resource where
  id : String
  name : String
  algorithm : String
  masterKeyId : String
  createdAt : String
  updatedAt : String
  deriving DecidableEq, Repr, Inhabited

/-- `toSecretResource`: the resource a secret renders as. -/
@[aw_spec (ts := "apps/web/server/secrets/contract.ts#toSecretResource")]
def Secret.toResource (s : Secret) : Resource :=
  { id := s.id.val, name := s.name, algorithm := s.algorithm.toWire,
    masterKeyId := s.envelope.masterKeyId, createdAt := s.createdAt, updatedAt := s.updatedAt }

/-- The field names of `SecretResourceSchema`, in declaration order. -/
@[aw_spec (ts := "packages/contracts/src/secrets.ts#SecretResourceSchema")]
def resourceFields : List String := ["id", "name", "algorithm", "masterKeyId", "createdAt", "updatedAt"]

/-- The names under which a secret's value, or a part of its envelope, could appear on the wire. -/
def valueFields : List String :=
  ["value", "ciphertext", "ciphertextNonce", "ciphertextTag", "wrappedDataKey",
    "wrappedDataKeyNonce", "wrappedDataKeyTag", "plaintext"]

/-- The value-bearing columns of `secrets`: every `bytea` column. -/
def valueColumns : List String :=
  ["wrapped_data_key", "wrapped_data_key_nonce", "wrapped_data_key_tag", "ciphertext",
    "ciphertext_nonce", "ciphertext_tag"]

/-! ## Operations -/

/-- The operations on secrets. -/
inductive Operation where
  | list
  | create
  | replace
  | remove
  deriving DecidableEq, Repr, Inhabited

/-- Today's operations (`GET`/`POST /api/secrets`, `PUT` and `DELETE /api/secrets/:id`). Issue
#240 (S-10) added `remove`, refused while the secret is referenced. -/
@[aw_spec (doc := "docs/sdk/04-api-specification.md#55-secrets--awsecrets")
  (ts := "apps/web/server/secrets/store.ts#WorkspaceSecretsStore")]
def operationsCurrent : List Operation := [.list, .create, .replace, .remove]

/-- The documented target: the four operations, `remove` included (roadmap S-10). -/
@[aw_spec (doc := "docs/sdk/04-api-specification.md#55-secrets--awsecrets")]
def operationsTarget : List Operation := [.list, .create, .replace, .remove]

/-- The fields `POST /api/secrets` accepts. -/
@[aw_spec (ts := "apps/web/server/secrets/contract.ts#parseCreateSecretBody")]
def createFields : List String := ["name", "value"]

/-- The fields `PUT /api/secrets/:id` accepts: the name is immutable. -/
@[aw_spec (ts := "apps/web/server/secrets/contract.ts#parseReplaceSecretBody")]
def replaceFields : List String := ["value"]

/-! ## Request bodies over key sets

A configuration request parser is modelled at the level of the keys a body carries, assuming every
present value is individually valid (the value rules are separate predicates). Two parser shapes
occur today: a **closed** parser refuses any key outside its field list, and an **open** parser
reads the keys it knows and ignores every other one. -/

/-- A closed parser's key rule: every required key is present and no key lies outside `fields`. -/
def closedBodyAccepts (fields required keys : List String) : Bool :=
  required.all keys.contains && keys.all fields.contains

/-- An open parser's key rule: every required key is present; any other key is ignored. -/
def openBodyAccepts (required keys : List String) : Bool := required.all keys.contains

/-- `parseCreateSecretBody` over the keys of a body: closed, and both `name` and `value` are
required. -/
@[aw_spec (ts := "apps/web/server/secrets/contract.ts#parseCreateSecretBody")
  (doc := "docs/sdk/04-api-specification.md#55-secrets--awsecrets")]
def createAccepts (keys : List String) : Bool := closedBodyAccepts createFields createFields keys

/-- `parseReplaceSecretBody` over the keys of a body: closed, and `value` is required. -/
@[aw_spec (ts := "apps/web/server/secrets/contract.ts#parseReplaceSecretBody")
  (doc := "docs/sdk/04-api-specification.md#55-secrets--awsecrets")]
def replaceAccepts (keys : List String) : Bool := closedBodyAccepts replaceFields replaceFields keys

/-- The wire name of an operation, as the store and the SDK method name it. -/
def Operation.toWire : Operation → String
  | .list => "list"
  | .create => "create"
  | .replace => "replace"
  | .remove => "remove"

/-! ## What else is stored as a secret -/

/-- What a secrets row is for, read from its name (the only place today's code records it). -/
@[aw_spec (ts := "apps/web/server/models/store.ts#modelConnectionSecretName")
  (ts := "apps/web/server/runtimes/connections.ts#decodeDriver")
  (doc := "docs/sdk/04-api-specification.md#55-secrets--awsecrets")]
inductive Purpose where
  /-- A secret a workspace owner stored directly under `/api/secrets`. -/
  | plain
  /-- The credential of a model connection (`MODEL_CONNECTION_…`). -/
  | modelConnectionCredential
  /-- A runtime connection (`RUNTIME_CONNECTION__<DRIVER>__…`). -/
  | runtimeConnection
  deriving DecidableEq, Repr, Inhabited

/-- `MODEL_CONNECTION_SECRET_PREFIX`. -/
@[aw_spec (ts := "apps/web/server/models/store.ts#MODEL_CONNECTION_SECRET_PREFIX")]
def modelConnectionPrefix : String := "MODEL_CONNECTION_"

/-- The runtime-connection `NAME_PREFIX`. -/
@[aw_spec (ts := "apps/web/server/runtimes/connections.ts#NAME_PREFIX")]
def runtimeConnectionPrefix : String := "RUNTIME_CONNECTION__"

/-- ASCII upper case, as `String.prototype.toUpperCase` does on ASCII. -/
def upperAscii (c : Char) : Char := if 'a' ≤ c && c ≤ 'z' then Char.ofNat (c.toNat - 32) else c

/-- `modelConnectionSecretName`: `MODEL_CONNECTION_` and the id with its hyphens removed, upper
case. -/
@[aw_spec (ts := "apps/web/server/models/store.ts#modelConnectionSecretName")]
def modelConnectionSecretName (id : String) : String :=
  modelConnectionPrefix ++ String.ofList ((id.toList.filter (· != '-')).map upperAscii)

/-- The index of the first `__` in a character list, split around it. -/
def splitAtDoubleUnderscore : List Char → Option (List Char × List Char)
  | '_' :: '_' :: rest => some ([], rest)
  | c :: rest => (splitAtDoubleUnderscore rest).map fun (a, b) => (c :: a, b)
  | [] => none

/-- A `__` found in a list is still found after a character is put in front of it. -/
theorem splitAtDoubleUnderscore_cons_isSome (c : Char) (l : List Char)
    (h : (splitAtDoubleUnderscore l).isSome = true) :
    (splitAtDoubleUnderscore (c :: l)).isSome = true := by
  rw [splitAtDoubleUnderscore.eq_def]
  split
  · rfl
  · rename_i heq; simp only [List.cons.injEq] at heq; obtain ⟨rfl, rfl⟩ := heq; simpa using h
  · contradiction

/-- The purpose a name signals. A runtime connection is recognised the way `decodeDriver` does it:
the prefix and then a `__` separator. -/
def purposeOf (name : String) : Purpose :=
  if runtimeConnectionPrefix.toList.isPrefixOf name.toList &&
      (splitAtDoubleUnderscore (name.toList.drop runtimeConnectionPrefix.length)).isSome then
    .runtimeConnection
  else if modelConnectionPrefix.toList.isPrefixOf name.toList then .modelConnectionCredential
  else .plain

end AgentWorkspace.Concepts.Secret
