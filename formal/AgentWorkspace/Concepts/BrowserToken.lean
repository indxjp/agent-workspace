import AgentWorkspace.Concepts.ApiKey

/-!
# The browser-token concept

A **browser token** is a short-lived bearer a customer's backend mints for its own frontend. It
is **attenuation, not a fourth identity**: it resolves to the principal that minted it, narrowed
to exactly one run or one session (`docs/sdk/04-api-specification.md` §3.1.1). The database knows
it as a row of `browser_tokens` (`packages/core/src/db/schema/browser-tokens.ts`): the minting
principal, one scope (`browser_tokens_scope_xor`), a SHA-256 of the secret half, an expiry and a
revocation stamp. It carries no role: the minter's role is re-read on every request.

**Scope.** `TokenScope = { kind: 'run' | 'session'; id }` on the wire. The model makes the scope
one sum type, so "exactly one of `run_id` / `session_id`" is its shape, and the row's XOR check is
a theorem about `toRow`.

**States.** `active`, `revoked`, `expired` at an instant (revoked wins). The TTL is bounded
`60 ≤ ttlSeconds ≤ 3600`, default `300`.
-/

namespace AgentWorkspace.Concepts.BrowserToken

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Concepts.Workspace

/-- `TOKEN_SCOPE_KINDS`: the two shapes a browser token may be scoped to. -/
@[aw_spec (ts := "packages/contracts/src/tokens.ts#TOKEN_SCOPE_KINDS")
  (ts := "apps/web/server/rbac/token-scope.ts#TOKEN_SCOPE_KINDS")
  (ts := "packages/core/src/db/schema/browser-tokens.ts#browserTokenScopeKinds")
  (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")]
inductive ScopeKind where
  | run
  | session
  deriving DecidableEq, Repr, Inhabited

/-- The wire (and storage) spelling of a scope kind. -/
def ScopeKind.toWire : ScopeKind → String
  | .run => "run"
  | .session => "session"

instance : WireEnum ScopeKind where
  all := [.run, .session]
  toWire := ScopeKind.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by
    intro a b h
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-- What a browser token may act on: one run or one session, never both, never neither. -/
@[aw_spec (ts := "packages/contracts/src/tokens.ts#TokenScopeSchema")
  (ts := "apps/web/server/rbac/token-scope.ts#TokenScope")]
inductive Scope where
  | run (id : RunId)
  | session (id : SessionId)
  deriving DecidableEq, Repr

/-- The kind of a scope. -/
def Scope.kind : Scope → ScopeKind
  | .run _ => .run
  | .session _ => .session

/-- The scoped row's id, as text. -/
def Scope.id : Scope → String
  | .run r => r.val
  | .session s => s.val

/-- `BROWSER_TOKEN_MIN_TTL_SECONDS`. -/
@[aw_spec (ts := "packages/contracts/src/tokens.ts#BROWSER_TOKEN_MIN_TTL_SECONDS")]
def minTtlSeconds : Nat := 60

/-- `BROWSER_TOKEN_MAX_TTL_SECONDS`. -/
@[aw_spec (ts := "packages/contracts/src/tokens.ts#BROWSER_TOKEN_MAX_TTL_SECONDS")]
def maxTtlSeconds : Nat := 3600

/-- `BROWSER_TOKEN_DEFAULT_TTL_SECONDS`. -/
@[aw_spec (ts := "packages/contracts/src/tokens.ts#BROWSER_TOKEN_DEFAULT_TTL_SECONDS")]
def defaultTtlSeconds : Nat := 300

/-- A requested TTL the mint request admits: an integer within the bounds. -/
@[aw_spec (ts := "packages/contracts/src/tokens.ts#MintTokenRequestSchema")
  (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")]
def ttlAccepted (ttl : Nat) : Bool := minTtlSeconds ≤ ttl && ttl ≤ maxTtlSeconds

/-- `BROWSER_TOKEN_PREFIX`. -/
@[aw_spec (ts := "packages/contracts/src/tokens.ts#BROWSER_TOKEN_PREFIX")
  (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")]
def prefix_ : String := "awt_live_"

/-- `BROWSER_TOKEN_ID_LENGTH`: base64url characters of the public half. -/
@[aw_spec (ts := "packages/contracts/src/tokens.ts#BROWSER_TOKEN_ID_LENGTH")]
def idLength : Nat := 22

/-- `BROWSER_TOKEN_SECRET_LENGTH`: base64url characters of the secret half. -/
@[aw_spec (ts := "packages/contracts/src/tokens.ts#BROWSER_TOKEN_SECRET_LENGTH")]
def secretLength : Nat := 43

/-- `BROWSER_TOKEN_PATTERN` (and `parsePresentedBrowserToken`): a whole presented token,
`awt_live_<22>_<43>`. -/
@[aw_spec (ts := "packages/contracts/src/tokens.ts#BROWSER_TOKEN_PATTERN")
  (ts := "apps/web/server/rbac/browser-token.ts#parsePresentedBrowserToken")
  (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")]
def presentedShaped (s : String) : Bool :=
  Concepts.ApiKey.bearerShaped prefix_ idLength secretLength s

/-- A browser token, with every column of `browser_tokens`. -/
@[aw_spec (ts := "packages/core/src/db/schema/browser-tokens.ts#browserTokens")
  (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")]
structure BrowserToken where
  id : BrowserTokenId
  workspace : WorkspaceId
  mintedBy : PrincipalId
  scope : Scope
  tokenHash : String
  expiresAt : Instant
  revokedAt : Option Instant
  createdAt : Instant
  deriving DecidableEq, Repr

/-- The checks of `browser_tokens` that are not the scope shape: expiry after creation, and a
revocation not before creation. (The hash has no not-blank check, unlike `api_keys`.) -/
@[aw_spec (ts := "packages/core/src/db/schema/browser-tokens.ts#browserTokens")]
def BrowserToken.valid (t : BrowserToken) : Bool :=
  t.createdAt < t.expiresAt && t.revokedAt.all (t.createdAt ≤ ·)

/-- The states of a token at an instant. -/
@[aw_spec (doc := "docs/formal/inventory.md#2-state-machines")]
inductive TokenState where
  | active
  | revoked
  | expired
  deriving DecidableEq, Repr

/-- The state at `now`: revoked wins; an expiry that has arrived is expired. -/
def BrowserToken.stateAt (t : BrowserToken) (now : Instant) : TokenState :=
  if t.revokedAt.isSome then .revoked else if t.expiresAt ≤ now then .expired else .active

/-- `findActiveBrowserTokenByHash`'s row half: not revoked and not yet expired. This is only the
token row's own half of admission; spec §3.1.1's "Revocation" (the scoped run or session reaching
a terminal state, the minting principal revoked) is `Principal.browserTokenAdmitted`. -/
@[aw_spec (ts := "packages/core/src/db/repositories/browser-tokens.ts#findActiveBrowserTokenByHash")]
def BrowserToken.live (t : BrowserToken) (now : Instant) : Bool :=
  t.revokedAt.isNone && now < t.expiresAt

/-- The `run_id` / `session_id` cells of a scope: exactly one is set. -/
def Scope.cells : Scope → List (String × String)
  | .run r => [("run_id", r.val)]
  | .session s => [("session_id", s.val)]

/-- The `browser_tokens` row of a token. -/
def BrowserToken.toRow (t : BrowserToken) : Row :=
  ⟨[("id", t.id.val), ("workspace_id", t.workspace.val),
     ("minted_by_principal_id", t.mintedBy.val), ("scope_kind", t.scope.kind.toWire)] ++
    t.scope.cells ++
    [("token_hash", t.tokenHash), ("expires_at", instantText t.expiresAt)] ++
    cell? "revoked_at" (t.revokedAt.map instantText) ++
    [("created_at", instantText t.createdAt)]⟩

/-- Read the scope of a `browser_tokens` row: the kind names which id column is set, and the other
must be `NULL`. `none` for any row the XOR check refuses. -/
@[aw_spec (ts := "packages/core/src/db/schema/browser-tokens.ts#browser_tokens_scope_xor")]
def scopeOfRow? (r : Row) : Option Scope :=
  match r.get "scope_kind", r.get "run_id", r.get "session_id" with
  | some "run", some id, none => some (.run ⟨id⟩)
  | some "session", none, some id => some (.session ⟨id⟩)
  | _, _, _ => none

end AgentWorkspace.Concepts.BrowserToken
