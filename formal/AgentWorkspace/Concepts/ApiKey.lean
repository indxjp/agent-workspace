import AgentWorkspace.Concepts.Membership

/-!
# The API-key concept

An **API key** is a machine credential minted inside one workspace, with one role fixed at mint
time. "An API key has no user behind it and no membership row; it *is* the principal"
(`docs/sdk/site/concepts/workspaces-and-principals.mdx`). The database knows it as a row of
`api_keys` (`packages/core/src/db/schema/api-keys.ts`); the wire knows it as
`ApiKeyResourceSchema` (`packages/contracts/src/api-keys.ts`), which has no field for the secret or
its hash.

**Credential material.** The plaintext is `ak_live_<22>_<43>` and exists only in the mint
response. The row stores `key_hash` (SHA-256 of the secret half, globally unique, because
authentication looks a key up by hash across the whole deployment) and `key_prefix`
(`ak_live_<key id>`, displayable, never enough to authenticate).

**States.** `active`, `revoked` (`revoked_at` set; revocation is a timestamp, never a delete) and
`expired` (`expires_at ≤ now`), derived at an instant with that precedence.
-/

namespace AgentWorkspace.Concepts.ApiKey

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Concepts.Workspace
  AgentWorkspace.Concepts.Membership

/-- `API_KEY_PREFIX`. -/
@[aw_spec (ts := "packages/contracts/src/api-keys.ts#API_KEY_PREFIX")
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#the-ak_live_-key-format")]
def prefix_ : String := "ak_live_"

/-- `API_KEY_ID_LENGTH`: base64url characters of the public half. -/
@[aw_spec (ts := "packages/contracts/src/api-keys.ts#API_KEY_ID_LENGTH")]
def idLength : Nat := 22

/-- `API_KEY_SECRET_LENGTH`: base64url characters of the secret half. -/
@[aw_spec (ts := "packages/contracts/src/api-keys.ts#API_KEY_SECRET_LENGTH")]
def secretLength : Nat := 43

/-- `API_KEY_NAME_MAX_LENGTH`. -/
@[aw_spec (ts := "packages/contracts/src/api-keys.ts#API_KEY_NAME_MAX_LENGTH")]
def nameMaxLength : Nat := 120

/-- A base64url character: `[A-Za-z0-9_-]`. -/
def isBase64UrlChar (c : Char) : Bool :=
  ('A' ≤ c && c ≤ 'Z') || ('a' ≤ c && c ≤ 'z') || ('0' ≤ c && c ≤ '9') || c == '_' || c == '-'

/-- The anchored fixed-length bearer grammar `^<prefix>[A-Za-z0-9_-]{idLen}_[A-Za-z0-9_-]{secLen}$`
that `API_KEY_PATTERN` and `BROWSER_TOKEN_PATTERN` both instantiate. Because `_` is itself a
base64url character, the halves are read at their fixed lengths, never split on `_`. -/
@[aw_spec (ts := "packages/contracts/src/api-keys.ts#API_KEY_PATTERN")
  (ts := "packages/contracts/src/tokens.ts#BROWSER_TOKEN_PATTERN")]
def bearerShaped (pfx : String) (idLen secLen : Nat) (s : String) : Bool :=
  let cs := s.toList
  let p := pfx.toList
  cs.length == p.length + idLen + 1 + secLen && cs.take p.length == p &&
    ((cs.drop p.length).take idLen).all isBase64UrlChar &&
    cs[p.length + idLen]? == some '_' && (cs.drop (p.length + idLen + 1)).all isBase64UrlChar

/-- `API_KEY_DISPLAY_PREFIX_PATTERN`: a key's displayable head, `ak_live_<22>` — the key id
alone, which a list may show because it "cannot authenticate". -/
@[aw_spec (ts := "packages/contracts/src/api-keys.ts#API_KEY_DISPLAY_PREFIX_PATTERN")
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#the-ak_live_-key-format")]
def displayPrefixShaped (s : String) : Bool :=
  let cs := s.toList
  let p := prefix_.toList
  cs.length == p.length + idLength && cs.take p.length == p &&
    (cs.drop p.length).all isBase64UrlChar

/-- `API_KEY_PATTERN`: a whole presented key, `ak_live_<22>_<43>`. -/
@[aw_spec (ts := "packages/contracts/src/api-keys.ts#API_KEY_PATTERN")
  (ts := "apps/web/server/rbac/api-key.ts#parsePresentedKey")
  (doc := "docs/sdk/04-api-specification.md#31-credentials")]
def presentedShaped (s : String) : Bool := bearerShaped prefix_ idLength secretLength s

/-- An API key, with every column of `api_keys`. -/
@[aw_spec (ts := "packages/core/src/db/schema/api-keys.ts#apiKeys")
  (ts := "packages/contracts/src/api-keys.ts#ApiKeyResourceSchema")
  (doc := "docs/sdk/04-api-specification.md#2-resource-model")]
structure ApiKey where
  id : ApiKeyId
  workspace : WorkspaceId
  name : String
  role : Role
  keyPrefix : String
  keyHash : String
  lastUsedAt : Option Instant
  expiresAt : Option Instant
  revokedAt : Option Instant
  createdAt : Instant
  updatedAt : Instant
  deriving DecidableEq, Repr

/-- The checks of `api_keys` as a predicate on the concept: name, prefix and hash are not blank,
an expiry is after creation, and a revocation is not before creation. -/
@[aw_spec (ts := "packages/core/src/db/schema/api-keys.ts#apiKeys")]
def ApiKey.valid (k : ApiKey) : Bool :=
  notBlank k.name && notBlank k.keyPrefix && notBlank k.keyHash &&
    k.expiresAt.all (k.createdAt < ·) && k.revokedAt.all (k.createdAt ≤ ·)

/-- The states of a key at an instant. -/
@[aw_spec (doc := "docs/formal/inventory.md#2-state-machines")
  (ts := "packages/core/src/db/schema/api-keys.ts#revokedAt")]
inductive ApiKeyState where
  | active
  | revoked
  | expired
  deriving DecidableEq, Repr

/-- The state at `now`: revoked wins over expired; an expiry that has arrived (`expires_at ≤ now`)
is expired. -/
def ApiKey.stateAt (k : ApiKey) (now : Instant) : ApiKeyState :=
  if k.revokedAt.isSome then .revoked
  else if k.expiresAt.any (· ≤ now) then .expired
  else .active

/-- The key's own half of `authenticateApiKeyHash`'s admission query:
`revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now)`. Here `now` abstracts the
query's `greatest(now(), $now)` — the later of the database clock and the caller's clock — so a
caller cannot move a key's expiry by passing an earlier instant. The other half, that the key's
`workspace_principals` row is not revoked, is `Principal.apiKeyAdmitted`. -/
@[aw_spec (ts := "packages/core/src/db/repositories/directory.ts#authenticateApiKeyHash")]
def ApiKey.live (k : ApiKey) (now : Instant) : Bool :=
  k.revokedAt.isNone && k.expiresAt.all (now < ·)

/-- The `api_keys` row of a key. -/
def ApiKey.toRow (k : ApiKey) : Row :=
  ⟨[("id", k.id.val), ("workspace_id", k.workspace.val), ("name", k.name),
     ("role", WireEnum.toWire k.role), ("key_prefix", k.keyPrefix), ("key_hash", k.keyHash)] ++
    cell? "last_used_at" (k.lastUsedAt.map instantText) ++
    cell? "expires_at" (k.expiresAt.map instantText) ++
    cell? "revoked_at" (k.revokedAt.map instantText) ++
    [("created_at", instantText k.createdAt), ("updated_at", instantText k.updatedAt)]⟩

/-- The fields of `ApiKeyResourceSchema`, in declaration order. -/
@[aw_spec (ts := "packages/contracts/src/api-keys.ts#ApiKeyResourceSchema")]
def resourceFields : List String :=
  ["id", "name", "role", "keyPrefix", "lastUsedAt", "expiresAt", "revokedAt", "createdAt"]

/-- The concept fields that are credential material: the stored hash, and the plaintext that
only the mint response carries (`key`). -/
@[aw_spec (ts := "packages/contracts/src/api-keys.ts#MintedApiKeyResponseSchema")]
def credentialFields : List String := ["keyHash", "key"]

end AgentWorkspace.Concepts.ApiKey
