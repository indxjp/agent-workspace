import AgentWorkspace.Concepts.BrowserToken
import AgentWorkspace.Contracts.Runs
import AgentWorkspace.Concepts.Session

/-!
# The principal concept

A **principal** is "the exact actor a request runs as: a membership (a user in a workspace, with a
role) or an API key (with a role). Never a bare user." (`docs/sdk/04-api-specification.md` §1.1).
It is the only identifier authorisation compares (`ownerPrincipalId`), never a user id.

The word covers two things the code keeps apart, and this module models both:

* the **durable principal** — a row of `workspace_principals`
  (`packages/core/src/db/schema/workspace-principals.ts`): a workspace, exactly one *source* (a
  membership or an API key, `workspace_principals_source_xor`), an activation stamp and a
  revocation stamp. `Source` is a sum type, so "exactly one source" is its shape;
* the **authenticated principal** — the frozen `Principal` object a verified credential yields
  (`apps/web/server/rbac/principal.ts`), here `Actor`: the durable principal's id, kind and
  workspace, the role read from the source row *at request time*, a display label, the verifier
  that produced it (`via`), and — for a browser token only — the attenuating scope.

**Two spellings of one kind.** The wire (`PRINCIPAL_KINDS` in `packages/contracts/src/team.ts`)
spells the machine kind `api-key`; the database column and the server's own `PRINCIPAL_KINDS`
spell it `api_key`. `Kind` carries the wire spelling as its `WireEnum` and `Kind.toStorage` the
column spelling.

**States.** `active` (`revoked_at IS NULL`) and `revoked`.

**Owner and actor (issue #509, S1-24).** An API-key principal may record the membership principal
it *acts for* (`workspace_principals.acts_for_principal_id`). Only the per-run local runtime key
`aw dev` mints sets it, to the bootstrap admin who issued it. The authenticated principal then has
two identifiers: `principalId`, the actor (what audit, version authorship, browser-token minting
and `GET /api/me` record), and `ownerPrincipalId`, the principal that owns what it writes and that
own/other is decided against. They differ only for an API key that acts for someone; a hosted key
acts for no one and owns what it writes. A key never outlives the principal it acts for: admission
and re-resolution both require that principal to be active with its membership present.
`reassignLocalOwnership` is the repair the local start runs before it sweeps stale local keys.
-/

namespace AgentWorkspace.Concepts.Principal

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Concepts.Workspace
  AgentWorkspace.Concepts.Membership AgentWorkspace.Concepts.BrowserToken

/-- The two principal kinds, in `PRINCIPAL_KINDS` order. -/
@[aw_spec (ts := "packages/contracts/src/team.ts#PRINCIPAL_KINDS")
  (ts := "apps/web/server/rbac/principal.ts#PRINCIPAL_KINDS")
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#workspace-and-principal")]
inductive Kind where
  | membership
  | apiKey
  deriving DecidableEq, Repr, Inhabited

/-- The wire spelling (`@indx-workspace/contracts`): kebab case. -/
def Kind.toWire : Kind → String
  | .membership => "membership"
  | .apiKey => "api-key"

instance : WireEnum Kind where
  all := [.membership, .apiKey]
  toWire := Kind.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by
    intro a b h
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-- The storage spelling: `workspace_principals.kind` and the server's `PrincipalKind`. -/
@[aw_spec (ts := "packages/core/src/db/schema/workspace-principals.ts#workspacePrincipalKinds")
  (ts := "apps/web/server/rbac/principal.ts#PRINCIPAL_KINDS")]
def Kind.toStorage : Kind → String
  | .membership => "membership"
  | .apiKey => "api_key"

/-- The kind a storage spelling denotes, if any. -/
def Kind.ofStorage? : String → Option Kind
  | "membership" => some .membership
  | "api_key" => some .apiKey
  | _ => none

/-- The storage spellings, in `workspacePrincipalKinds` order. -/
def storageSpellings : List String := (WireEnum.all : List Kind).map Kind.toStorage

/-- `wireKind`: the one place the server maps the storage spelling to the wire spelling. -/
@[aw_spec (ts := "apps/web/server/rbac/handlers.ts#wireKind")]
def wireKindOfStorage? (s : String) : Option String := (Kind.ofStorage? s).map WireEnum.toWire

/-- A principal's source: exactly one membership or exactly one API key. -/
@[aw_spec (ts := "packages/core/src/db/schema/workspace-principals.ts#workspace_principals_source_xor")
  (doc := "docs/sdk/04-api-specification.md#2-resource-model")]
inductive Source where
  | membership (id : MembershipId)
  | apiKey (id : ApiKeyId)
  deriving DecidableEq, Repr

/-- The kind a source names. -/
def Source.kind : Source → Kind
  | .membership _ => .membership
  | .apiKey _ => .apiKey

/-- A durable principal: a row of `workspace_principals`. -/
@[aw_spec (ts := "packages/core/src/db/schema/workspace-principals.ts#workspacePrincipals")
  (doc := "docs/architecture/refactoring/claude-agent-workspace-refactoring-plan.md#rf-101--introduce-workspaceprincipal-and-split-identity-ownership-and-attribution")]
structure Principal where
  id : PrincipalId
  workspace : WorkspaceId
  source : Source
  activatedAt : Instant
  revokedAt : Option Instant
  createdAt : Instant
  /-- `acts_for_principal_id`: the membership principal an API-key principal acts for (S1-24). -/
  actsFor : Option PrincipalId
  deriving DecidableEq, Repr

/-- The principal's kind: its source's. -/
def Principal.kind (p : Principal) : Kind := p.source.kind

/-- `workspace_principals_acts_for_api_key_only` and `workspace_principals_acts_for_not_self`: only
an API-key principal acts for someone, and never for itself. -/
@[aw_spec (ts := "packages/core/src/db/schema/workspace-principals.ts#workspace_principals_acts_for_api_key_only")
  (ts := "packages/core/src/db/schema/workspace-principals.ts#workspace_principals_acts_for_not_self")]
def Principal.actsForValid (p : Principal) : Bool :=
  p.actsFor.all fun a => p.kind == .apiKey && a != p.id

/-- `workspace_principals_revoked_after_activation`, and the two acts-for checks. -/
def Principal.valid (p : Principal) : Bool := p.revokedAt.all (p.activatedAt ≤ ·) && p.actsForValid

/-- The two states of a principal. -/
@[aw_spec (doc := "docs/formal/inventory.md#2-state-machines")]
inductive PrincipalState where
  | active
  | revoked
  deriving DecidableEq, Repr

/-- `revoked_at IS NULL` is active. -/
def Principal.state (p : Principal) : PrincipalState := if p.revokedAt.isSome then .revoked else .active

/-- `revoked_at IS NULL`: the filter `authenticateApiKeyHash`, `resolveMembership` and
`principalById` all apply to the `workspace_principals` row. -/
@[aw_spec (ts := "packages/core/src/db/repositories/directory.ts#principalById")]
def Principal.active (p : Principal) : Bool := p.revokedAt.isNone

/-! ## Admission: a credential's row half and its principal half -/

/-- What the directory re-reads for the principal a key acts for: that principal's row and whether
its membership row is still present. -/
@[aw_spec (ts := "packages/core/src/db/repositories/directory.ts#authenticateApiKeyHash")
  (ts := "packages/core/src/db/repositories/directory.ts#principalById")]
structure ActsForRow where
  principal : Principal
  membershipPresent : Bool
  deriving DecidableEq, Repr

/-- The acts-for conjunct of admission and resolution: a principal that acts for no one passes; one
that acts for someone passes only while that principal — the one named, in the same workspace, a
membership — is active and its membership is present ("a key never outlives the person it acts
for"). -/
@[aw_spec (ts := "packages/core/src/db/repositories/directory.ts#authenticateApiKeyHash")
  (ts := "packages/core/src/db/repositories/directory.ts#principalById")
  (doc := "docs/adr/0109-the-local-runtime-publishes-as-one-bundled-package-that-aw-dev-runs-from-the-project.md#amendment--what-s1-21-settled-issue-500-2026-10-02")]
def actsForStands (p : Principal) (target : Option ActsForRow) : Bool :=
  match p.actsFor with
  | none => true
  | some a => target.any fun t =>
      t.principal.id == a && t.principal.workspace == p.workspace &&
        t.principal.kind == .membership && t.principal.active && t.membershipPresent

/-- `authenticateApiKeyHash`'s whole admission: the key row is live (`ApiKey.live`), the
`workspace_principals` row it joins — same workspace, source this key — is not revoked, and the
principal it acts for, if any, still stands (`actsForStands`). `target` is that principal as the
directory re-reads it; left out, it is absent, so a key that acts for someone is refused. -/
@[aw_spec (ts := "packages/core/src/db/repositories/directory.ts#authenticateApiKeyHash")
  (doc := "docs/sdk/04-api-specification.md#31-credentials")]
def apiKeyAdmitted (k : Concepts.ApiKey.ApiKey) (p : Principal) (now : Instant)
    (target : Option ActsForRow := none) : Bool :=
  p.workspace == k.workspace && p.source == .apiKey k.id && k.live now && p.active &&
    actsForStands p target

/-- The source row `principalById` re-reads for a principal: the membership (present or since
deleted), or the API key row (if any). -/
@[aw_spec (ts := "packages/core/src/db/repositories/directory.ts#principalById")]
inductive SourceRow where
  | membership (present : Bool)
  | apiKey (key : Option Concepts.ApiKey.ApiKey)
  deriving DecidableEq, Repr

/-- `principalById` answers a record: the principal row is active, its source row still stands —
the membership still exists, or the key is its own and live at `now` ("a key that has since been
revoked or has expired must stop authenticating a browser token it minted") — and the principal it
acts for, if any, still stands. -/
@[aw_spec (ts := "packages/core/src/db/repositories/directory.ts#principalById")]
def principalResolves (p : Principal) (src : SourceRow) (now : Instant)
    (target : Option ActsForRow := none) : Bool :=
  p.active &&
    (match p.source, src with
    | .membership _, .membership present => present
    | .apiKey id, .apiKey key => key.any fun k => k.id == id && k.live now
    | _, _ => false) && actsForStands p target

/-- The scoped row `resolveBrowserTokenActor` reads: a run with its status or a session with its
status (`none` when the row is gone). -/
@[aw_spec (ts := "apps/web/server/composition/session-rbac.ts#resolveBrowserTokenActor")]
inductive ScopedRow where
  | run (id : RunId) (status : Contracts.RunStatus)
  | session (id : SessionId) (status : Concepts.Session.SessionStatus)
  deriving DecidableEq, Repr

/-- The scope a scoped row answers to: the run or the session it is. -/
def ScopedRow.scope : ScopedRow → Scope
  | .run id _ => .run id
  | .session id _ => .session id

/-- The scope is still open: the scoped row exists, is the one the scope names, and has not reached
a terminal state (a run's `completed`/`failed`/`cancelled`, a session's `archived`). -/
@[aw_spec (ts := "apps/web/server/composition/session-rbac.ts#resolveBrowserTokenActor")
  (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")]
def scopeOpen : Scope → Option ScopedRow → Bool
  | .run r, some (.run r' st) => r == r' && !st.isTerminal
  | .session s, some (.session s' st) => s == s' && st == .active
  | _, _ => false

/-- `resolveBrowserTokenActor`'s admission, spec §3.1.1 "Revocation": the token row is live, its
scope is still open, and its minter — the principal the row names, in the row's workspace —
still resolves. -/
@[aw_spec (ts := "apps/web/server/composition/session-rbac.ts#resolveBrowserTokenActor")
  (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")]
def browserTokenAdmitted (t : BrowserToken) (target : Option ScopedRow) (minter : Principal)
    (src : SourceRow) (now : Instant) (actsFor : Option ActsForRow := none) : Bool :=
  t.live now && scopeOpen t.scope target && minter.id == t.mintedBy &&
    minter.workspace == t.workspace && principalResolves minter src now actsFor

/-- The source cells of a row: the id column its kind names, the other left `NULL`. -/
def Source.cells : Source → List (String × String)
  | .membership m => [("membership_id", m.val)]
  | .apiKey k => [("api_key_id", k.val)]

/-- The `workspace_principals` row of a principal. -/
def Principal.toRow (p : Principal) : Row :=
  ⟨[("id", p.id.val), ("workspace_id", p.workspace.val), ("kind", p.kind.toStorage)] ++
    p.source.cells ++ [("activated_at", instantText p.activatedAt)] ++
    cell? "revoked_at" (p.revokedAt.map instantText) ++
    cell? "acts_for_principal_id" (p.actsFor.map (·.val)) ++
    [("created_at", instantText p.createdAt)]⟩

/-- Read the source of a `workspace_principals` row: `none` for any row the XOR check refuses. -/
@[aw_spec (ts := "packages/core/src/db/schema/workspace-principals.ts#workspace_principals_source_xor")
  (ts := "packages/core/src/db/repositories/directory.ts#principalById")]
def sourceOfRow? (r : Row) : Option Source :=
  match r.get "kind", r.get "membership_id", r.get "api_key_id" with
  | some "membership", some m, none => some (.membership ⟨m⟩)
  | some "api_key", none, some k => some (.apiKey ⟨k⟩)
  | _, _, _ => none

/-- Read the principal a `workspace_principals` row acts for: `acts_for_principal_id`, or `none`. -/
@[aw_spec (ts := "packages/core/src/db/schema/workspace-principals.ts#workspacePrincipals")
  (ts := "packages/core/src/db/repositories/directory.ts#principalById")]
def actsForOfRow? (r : Row) : Option PrincipalId := (r.get "acts_for_principal_id").map (⟨·⟩)

/-! ## The authenticated principal -/

/-- `Via`: which verifier produced an authenticated principal. A browser token is not a third
identity; it is the minter's session or API-key identity with a scope attached. -/
@[aw_spec (ts := "apps/web/server/rbac/principal.ts#Via")
  (doc := "docs/sdk/04-api-specification.md#31-credentials")]
inductive Via where
  | session
  | apiKey
  | browserToken
  deriving DecidableEq, Repr, Inhabited

/-- The spelling of a verifier. -/
def Via.toWire : Via → String
  | .session => "session"
  | .apiKey => "api-key"
  | .browserToken => "browser-token"

instance : WireEnum Via where
  all := [.session, .apiKey, .browserToken]
  toWire := Via.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by
    intro a b h
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-- The frozen `Principal` object a handler is handed. Ids are the strings the TypeScript
carries. -/
@[aw_spec (ts := "apps/web/server/rbac/principal.ts#Principal")
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#workspace-and-principal")]
structure Actor where
  principalId : String
  kind : Kind
  workspaceId : String
  label : String
  userId : Option String
  actor : String
  role : Role
  via : Via
  apiKeyId : Option String
  scope : Option Scope
  /-- The principal that owns what this caller writes, and the one own/other is decided against:
  `principalId`, except for an API key that acts for a membership principal (S1-24). -/
  ownerPrincipalId : String
  deriving DecidableEq, Repr

/-- The structural half of `Principal.isPrincipal`: a scope is present exactly for a browser
token; a membership principal came from a session (or a token it minted), names a user and no
key, and owns what it writes; an API-key principal came from a key (or a token it minted), names a
key and no user, and may own through the principal it acts for. -/
@[aw_spec (ts := "apps/web/server/rbac/principal.ts#isPrincipal")]
def Actor.wellFormed (a : Actor) : Bool :=
  (a.via == .browserToken) == a.scope.isSome &&
    match a.kind with
    | .membership =>
      (a.via == .session || a.via == .browserToken) && a.userId.isSome && a.apiKeyId.isNone &&
        a.ownerPrincipalId == a.principalId
    | .apiKey =>
      (a.via == .apiKey || a.via == .browserToken) && a.userId.isNone && a.apiKeyId.isSome

/-- `DirectoryPrincipalRecord`: what the directory re-reads for a principal id. -/
@[aw_spec (ts := "packages/core/src/db/repositories/directory.ts#DirectoryPrincipalRecord")]
structure DirectoryRecord where
  principalId : String
  kind : Kind
  workspaceId : String
  role : Role
  label : String
  userId : Option String
  apiKeyId : Option String
  /-- `actsForPrincipalId`: the membership principal an API-key principal acts for, if any. -/
  actsForPrincipalId : Option String
  deriving DecidableEq, Repr

/-- Who owns what a principal writes: the principal it acts for, or itself. -/
def ownerOf (principalId : String) (actsFor : Option String) : String := actsFor.getD principalId

/-- `Principal.fromDirectoryRecord`: `via` follows the kind; no scope; an API-key record's owner is
the principal it acts for, or its own, and a membership record always owns what it writes. It
copies the record's `userId` and `apiKeyId` without checking them against the kind. -/
@[aw_spec (ts := "apps/web/server/rbac/principal.ts#fromDirectoryRecord")]
def fromDirectoryRecord (r : DirectoryRecord) : Actor :=
  { principalId := r.principalId, kind := r.kind, workspaceId := r.workspaceId, label := r.label,
    userId := r.userId, actor := r.label, role := r.role,
    via := if r.kind == .membership then .session else .apiKey, apiKeyId := r.apiKeyId,
    scope := none,
    ownerPrincipalId :=
      if r.kind == .apiKey then ownerOf r.principalId r.actsForPrincipalId else r.principalId }

/-- A directory record is coherent: a user id exactly for a membership, a key id exactly for an
API key (what `principalById` returns). -/
def DirectoryRecord.coherent (r : DirectoryRecord) : Bool :=
  match r.kind with
  | .membership => r.userId.isSome && r.apiKeyId.isNone
  | .apiKey => r.userId.isNone && r.apiKeyId.isSome

/-- `ApiKeyIdentity`: what a presented API key establishes. -/
@[aw_spec (ts := "apps/web/server/rbac/directory.ts#ApiKeyIdentity")]
structure ApiKeyIdentity where
  principalId : String
  apiKeyId : String
  workspaceId : String
  role : Role
  label : String
  /-- `actsForPrincipalId`: the membership principal the key acts for; `none` for a hosted key. -/
  actsForPrincipalId : Option String
  deriving DecidableEq, Repr

/-- `Principal.fromApiKey`: the owner is the principal the key acts for, or the key's own. -/
@[aw_spec (ts := "apps/web/server/rbac/principal.ts#fromApiKey")
  (doc := "docs/adr/0109-the-local-runtime-publishes-as-one-bundled-package-that-aw-dev-runs-from-the-project.md#amendment--what-s1-21-settled-issue-500-2026-10-02")]
def fromApiKey (i : ApiKeyIdentity) : Actor :=
  { principalId := i.principalId, kind := .apiKey, workspaceId := i.workspaceId, label := i.label,
    userId := none, actor := i.label, role := i.role, via := .apiKey, apiKeyId := some i.apiKeyId,
    scope := none, ownerPrincipalId := ownerOf i.principalId i.actsForPrincipalId }

/-- `Principal.fromBrowserToken`: the minter, with `via = browser-token` and the scope attached;
every other field is the minter's, the owner included. -/
@[aw_spec (ts := "apps/web/server/rbac/principal.ts#fromBrowserToken")
  (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")]
def fromBrowserToken (minter : Actor) (scope : Scope) : Actor :=
  { minter with via := .browserToken, scope := some scope }

/-! ## Repairing what earlier local runtime keys own -/

/-- A row an owner column names (`owner_principal_id` of agents, sessions, skills, files, MCP
servers and projects; `publisher_principal_id` of shares): its id and its owner. -/
@[aw_spec (ts := "packages/core/src/db/repositories/directory.ts#reassignLocalRuntimeKeyOwnership")]
structure OwnedRow where
  id : String
  owner : String
  deriving DecidableEq, Repr

/-- A local runtime key's principal as the repair reads it: every API-key principal whose key name
carries `LOCAL_RUNTIME_API_KEY_NAME_PREFIX`, revoked and expired ones included, with the principal
it acts for, if recorded. -/
@[aw_spec (ts := "packages/core/src/db/repositories/directory.ts#reassignLocalRuntimeKeyOwnership")
  (ts := "packages/core/src/db/repositories/directory.ts#LOCAL_RUNTIME_API_KEY_NAME_PREFIX")]
structure LocalKey where
  id : String
  actsFor : Option String
  deriving DecidableEq, Repr

/-- The owner a row has after the repair: a row a local key owns moves to the principal that key
acts for, or to `target` when it records none; any other row keeps its owner. -/
def repairedOwner (locals : List LocalKey) (target owner : String) : String :=
  match locals.find? (·.id == owner) with
  | some l => l.actsFor.getD target
  | none => owner

/-- `reassignLocalRuntimeKeyOwnership`, on the owned rows: every row a local key's principal owns
moves to `coalesce(acts_for_principal_id, target)`. Version authorship, audit actors and
browser-token minters are not owner columns and are never passed here. -/
@[aw_spec (ts := "packages/core/src/db/repositories/directory.ts#reassignLocalRuntimeKeyOwnership")
  (ts := "apps/web/server/cli-auth/local-credential.ts#issueLocalApiKey")
  (doc := "docs/adr/0109-the-local-runtime-publishes-as-one-bundled-package-that-aw-dev-runs-from-the-project.md#amendment--what-s1-21-settled-issue-500-2026-10-02")]
def reassignLocalOwnership (locals : List LocalKey) (target : String) (rows : List OwnedRow) :
    List OwnedRow :=
  rows.map fun r => { r with owner := repairedOwner locals target r.owner }

/-- The backfill half of the repair: every local key that records no principal it acts for now
acts for `target`. -/
@[aw_spec (ts := "packages/core/src/db/repositories/directory.ts#reassignLocalRuntimeKeyOwnership")]
def backfillActsFor (locals : List LocalKey) (target : String) : List LocalKey :=
  locals.map fun l => { l with actsFor := some (l.actsFor.getD target) }

/-- The whole repair, in one transaction: the backfilled local keys and the reassigned rows. -/
@[aw_spec (ts := "packages/core/src/db/repositories/directory.ts#reassignLocalRuntimeKeyOwnership")]
def repairLocalOwnership (locals : List LocalKey) (target : String) (rows : List OwnedRow) :
    List LocalKey × List OwnedRow :=
  (backfillActsFor locals target, reassignLocalOwnership locals target rows)

/-- `target`, and every principal a local key acts for, is not itself a local key's principal: they
are membership principals (`createApiKey` and the repair both require an active membership
target, and `workspace_principals_acts_for_api_key_only` keeps acts-for off a key's target). -/
def targetsOutside (locals : List LocalKey) (target : String) : Bool :=
  (locals.all fun l => l.id != target) &&
    locals.all fun l => l.actsFor.all fun a => locals.all fun l' => l'.id != a

/-- The body of `GET /api/me` for an authenticated principal: its id, wire kind, role, workspace,
user id and label, and nothing else. -/
@[aw_spec (ts := "packages/contracts/src/team.ts#MeResponseSchema")]
structure MeResponse where
  principalId : String
  kind : Kind
  role : Role
  workspaceId : String
  userId : Option String
  label : String
  deriving DecidableEq, Repr

/-- The `me` view of an authenticated principal. -/
def Actor.me (a : Actor) : MeResponse :=
  { principalId := a.principalId, kind := a.kind, role := a.role, workspaceId := a.workspaceId,
    userId := a.userId, label := a.label }

/-- What `MeResponseSchema` accepts today: every field present and non-empty, `userId` null or
non-empty — whatever the kind. -/
@[aw_spec (ts := "packages/contracts/src/team.ts#MeResponseSchema")]
def MeResponse.acceptedCurrent (m : MeResponse) : Bool :=
  !m.principalId.isEmpty && !m.workspaceId.isEmpty && !m.label.isEmpty &&
    m.userId.all (!·.isEmpty)

/-- What the schema's own comment documents: additionally, `userId` is `null` for exactly an
API-key principal. -/
@[aw_spec (ts := "packages/contracts/src/team.ts#MeResponseSchema")]
def MeResponse.acceptedTarget (m : MeResponse) : Bool :=
  m.acceptedCurrent && (m.kind == .apiKey) == m.userId.isNone

end AgentWorkspace.Concepts.Principal
