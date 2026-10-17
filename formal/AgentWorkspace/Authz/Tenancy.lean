import AgentWorkspace.Er.Current
import AgentWorkspace.Contracts.Identifiers
import AgentWorkspace.Contracts.Runs
import AgentWorkspace.Concepts.Principal
import AgentWorkspace.Authz.Decide
import AgentWorkspace.Prelude.Text

/-!
# Tenant selection and isolation

The shared tenancy module every domain reuses. It is built on today's whole schema
(`Er/Current`: `State`, `Stmt`, `commit`, `consistent`) and on `Er/Core`'s `tenantOf`; nothing
here redefines a table, a row or a constraint. Seven parts, each faithful to today's code:

1. **The workspace scope** (`packages/core/src/db/repositories/scope.ts`): the two resolvers
   that mint a `WorkspaceScope` only after a `workspaces` row was found (by id, or by the slug a
   session carries), the in-memory resolver, and `requireWorkspaceScope`, which refuses every
   value the class did not mint.
2. **Workspace selection**: how a request's workspace is chosen for each credential. A session
   (`root.resolveMembership` then `Principal.fromSession`), an API key (`authenticateApiKeyHash`
   then `Principal.fromApiKey`), a browser token (`findActiveBrowserTokenByHash`, the scoped
   run/session check, `principalById` for the minter, then `Principal.fromBrowserToken`).
3. **The scoped repository**: every read is `WHERE workspace_id = scope`, every write builds its
   row's `workspace_id` from the scope and touches only rows the scoped read returned. A write is
   a transaction (`Er.Current.Stmt` list) committed under `Er.Current.consistent`.
4. **Run lookup and 404 concealment** (`apps/web/server/runs/api.ts#findRunForPrincipal`): a run
   of another workspace answers the same `404 run_not_found` an absent one does, before any
   authorisation step; and the database store's `findRunWorkspace` (ADR W2-DB-02).
5. **The scoped object store** (`packages/core/src/storage/object-store.ts`): keys are
   `workspaces/<workspaceId>/<key>`, the caller's key passes `key-safety.ts`'s guard first. Today
   the workspace id is only checked to be non-blank (`…Current`); the target also refuses `/`
   (`…Target`), without which two workspaces can name one key.
6. **The tenant session scope** (`packages/core/src/schemas.ts#validateTenantSessionScope`).
7. **The shared 404-before-decide shape** (`apps/web/server/rbac/http.ts#authorise`,
   `resources/authorise.ts#requireResourceAccess`, ADR W9-AUTH-117) and the two workspace-route
   resolvers of `apps/web/server/workspaces/access.ts`.

Plus the F-007 triage: `tenancy.test.ts`'s rule 1 transcribed (`testRule1`), with the one fact the
ER catalogue does not carry (which columns lead an index) transcribed as `leadingIndexedColumns`.
-/

namespace AgentWorkspace.Authz.Tenancy

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Concepts.BrowserToken
  AgentWorkspace.Authz.Decide

/-! ## Row helpers (SQL comparison semantics) -/

/-- `r.c = v` in SQL: the cell is non-`NULL` and equal. -/
def colIs (r : Row) (c v : String) : Bool := r.get c == some v

/-- `a.c = b.d` in SQL: both cells non-`NULL` and equal. -/
def colsEq (a : Row) (c : String) (b : Row) (d : String) : Bool :=
  match a.get c, b.get d with
  | some x, some y => x == y
  | _, _ => false

/-- The workspace a row of table `t` belongs to under today's schema (`Er.Core.tenantOf`). -/
def rowTenant (t : TableName) (r : Row) : Option String := tenantOf catalogue t r

/-- A tenant-scoped table (every table but `workspaces`, `users` and `user_identities`). -/
def isScopedTable (t : TableName) : Bool := (catalogue t).tenancy == .scoped

/-! ## 1. The workspace scope -/

/-- A `WorkspaceScope`: the `workspaces.id` every repository `where` clause is built from. -/
@[aw_spec (ts := "packages/core/src/db/repositories/scope.ts#WorkspaceScope")
  (doc := "docs/adr/W2-DB-02-the-repository-shape.md#decision")]
structure WorkspaceScope where
  workspaceId : String
  deriving DecidableEq, Repr

/-- `WorkspaceScope.databaseResolver(db).forWorkspaceId`: the first `workspaces` row with that id,
or `null`. The scope carries the row's id, never the caller's argument. -/
@[aw_spec (ts := "packages/core/src/db/repositories/scope.ts#databaseResolver")]
def forWorkspaceId (st : State) (id : String) : Option WorkspaceScope :=
  ((st .workspaces).find? (colIs · "id" id)).bind fun r => (r.get "id").map WorkspaceScope.mk

/-- `databaseResolver(db).forWorkspaceSlug`: the workspace a session token's slug names. -/
@[aw_spec (ts := "packages/core/src/db/repositories/scope.ts#databaseResolver")
  (doc := "docs/adr/W1-CP-06-session-carries-the-workspace-slug.md")]
def forWorkspaceSlug (st : State) (slug : String) : Option WorkspaceScope :=
  ((st .workspaces).find? (colIs · "slug" slug)).bind fun r => (r.get "id").map WorkspaceScope.mk

/-- `KnownWorkspace`: one workspace as the in-memory deployment knows it. -/
structure KnownWorkspace where
  id : String
  slug : String
  deriving DecidableEq, Repr

/-- `inMemoryResolver(known).forWorkspaceId`: `byId.set(row.id, row.id)`, so any known id. -/
@[aw_spec (ts := "packages/core/src/db/repositories/scope.ts#inMemoryResolver")]
def inMemoryForId (known : List KnownWorkspace) (id : String) : Option WorkspaceScope :=
  if known.any (·.id == id) then some ⟨id⟩ else none

/-- `inMemoryResolver(known).forWorkspaceSlug`: `bySlug.set(row.slug, row.id)`, where a later row
with the same slug overwrites an earlier one (`Map.set`), so the last match wins. -/
@[aw_spec (ts := "packages/core/src/db/repositories/scope.ts#inMemoryResolver")]
def inMemoryForSlug (known : List KnownWorkspace) (slug : String) : Option WorkspaceScope :=
  (known.reverse.find? (·.slug == slug)).map fun k => ⟨k.id⟩

/-- The known workspaces of a state: every `workspaces` row with an id and a slug. -/
def knownOf (st : State) : List KnownWorkspace :=
  (st .workspaces).filterMap fun r => do
    let i ← r.get "id"
    let s ← r.get "slug"
    pure ⟨i, s⟩

/-- A value handed to `requireWorkspaceScope(value: unknown)`: a scope a resolver minted, or one
of the two forgeries the compiler admits (`{ workspaceId } as WorkspaceScope`, and
`Object.create(WorkspaceScope.prototype)` with a `workspaceId`), or not an object at all. A
minted scope is frozen, so it cannot be tampered with in place (`Object.assign` throws). -/
@[aw_spec (ts := "packages/core/src/db/repositories/scope.ts#requireWorkspaceScope")
  (ts := "packages/core/src/db/repositories/scope-forgery.test.ts")]
inductive ScopeValue where
  | minted (scope : WorkspaceScope)
  | castLiteral (workspaceId : String)
  | prototypeInstance (workspaceId : String)
  | notAnObject
  deriving DecidableEq, Repr

/-- The workspace id a value carries, forged or not (`value.workspaceId`). -/
def ScopeValue.carried : ScopeValue → Option String
  | .minted s => some s.workspaceId
  | .castLiteral w => some w
  | .prototypeInstance w => some w
  | .notAnObject => none

/-- `WorkspaceScope.isWorkspaceScope`: the `#private` brand is present (only the class's own
constructor adds it) and the frozen instance is unchanged. -/
@[aw_spec (ts := "packages/core/src/db/repositories/scope.ts#isWorkspaceScope")]
def isWorkspaceScope : ScopeValue → Bool
  | .minted _ => true
  | .castLiteral _ => false
  | .prototypeInstance _ => false
  | .notAnObject => false

/-- `requireWorkspaceScope`: the scope, or `ForgedWorkspaceScopeError` (`none`) before any query. -/
@[aw_spec (ts := "packages/core/src/db/repositories/scope.ts#requireWorkspaceScope")]
def requireWorkspaceScope (v : ScopeValue) : Option WorkspaceScope :=
  if isWorkspaceScope v then v.carried.map WorkspaceScope.mk else none

/-! ## 2. Workspace selection -/

/-- How a principal was authenticated (`Via`, in `principal.ts` order). -/
@[aw_spec (ts := "apps/web/server/rbac/principal.ts#Via")
  (doc := "docs/sdk/04-api-specification.md#31-credentials")]
inductive Via where
  | session
  | apiKey
  | browserToken
  deriving DecidableEq, Repr, Inhabited

/-- The TypeScript spelling of `Via`. -/
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

/-- The request principal (`apps/web/server/rbac/principal.ts#Principal`): who acts, in which
one workspace, with which role, and the browser-token attenuation if any. -/
@[aw_spec (ts := "apps/web/server/rbac/principal.ts#Principal")
  (doc := "docs/sdk/04-api-specification.md#31-credentials")]
structure RequestPrincipal where
  principalId : String
  kind : Concepts.Principal.Kind
  workspaceId : String
  label : String
  actor : String
  role : String
  via : Via
  userId : Option String
  apiKeyId : Option String
  scope : Option Scope
  deriving DecidableEq, Repr

/-- `VerifiedSessionClaims`, the two claims selection reads: the subject (an email) and the
workspace slug the session names. -/
structure SessionClaims where
  sub : String
  ws : String
  deriving DecidableEq, Repr

/-- `SessionWorkspace`: the resolved workspace's id and slug. -/
structure SessionWorkspace where
  id : String
  slug : String
  deriving DecidableEq, Repr

/-- `SessionPrincipalIdentity`. -/
structure MemberIdentity where
  principalId : String
  userId : String
  label : String
  deriving DecidableEq, Repr

/-- Why `Principal.fromSession` refused. -/
inductive SessionRefusal where
  | workspaceMismatch
  | incompleteIdentity
  deriving DecidableEq, Repr

/-- `Principal.fromSession`: refuse a workspace whose slug is not the verified session's, refuse
a blank identity, otherwise a `session` principal of that workspace's id. -/
@[aw_spec (ts := "apps/web/server/rbac/principal.ts#fromSession")
  (doc := "docs/sdk/04-api-specification.md#31-credentials")]
def fromSession (claims : SessionClaims) (ws : SessionWorkspace) (role : String)
    (identity : MemberIdentity) : Except SessionRefusal RequestPrincipal :=
  if ws.slug != claims.ws then .error .workspaceMismatch
  else if Text.isBlank identity.principalId || Text.isBlank identity.userId ||
      Text.isBlank identity.label then .error .incompleteIdentity
  else .ok { principalId := identity.principalId, kind := .membership, workspaceId := ws.id,
             label := identity.label, actor := claims.sub, role, via := .session,
             userId := some identity.userId, apiKeyId := none, scope := none }

/-- `ApiKeyIdentity`: what the directory returns for a live presented key. -/
structure ApiKeyIdentity where
  principalId : String
  apiKeyId : String
  workspaceId : String
  label : String
  role : String
  deriving DecidableEq, Repr

/-- `Principal.fromApiKey`: the key's workspace, fixed. -/
@[aw_spec (ts := "apps/web/server/rbac/principal.ts#fromApiKey")
  (doc := "docs/sdk/04-api-specification.md#32-workspace-selection")]
def fromApiKey (i : ApiKeyIdentity) : RequestPrincipal :=
  { principalId := i.principalId, kind := .apiKey, workspaceId := i.workspaceId, label := i.label,
    actor := i.label, role := i.role, via := .apiKey, userId := none,
    apiKeyId := some i.apiKeyId, scope := none }

/-- The record `principalById` returns (`fromDirectoryRecord`'s argument). -/
structure DirectoryRecord where
  principalId : String
  kind : Concepts.Principal.Kind
  workspaceId : String
  role : String
  label : String
  userId : Option String
  apiKeyId : Option String
  deriving DecidableEq, Repr

/-- `Principal.fromDirectoryRecord`: the minter's current identity, unattenuated. -/
@[aw_spec (ts := "apps/web/server/rbac/principal.ts#fromDirectoryRecord")]
def fromDirectoryRecord (r : DirectoryRecord) : RequestPrincipal :=
  { principalId := r.principalId, kind := r.kind, workspaceId := r.workspaceId, label := r.label,
    actor := r.label, role := r.role,
    via := match r.kind with | .membership => .session | .apiKey => .apiKey,
    userId := r.userId, apiKeyId := r.apiKeyId, scope := none }

/-- `Principal.fromBrowserToken`: the minter's identity and workspace, with the token's scope. -/
@[aw_spec (ts := "apps/web/server/rbac/principal.ts#fromBrowserToken")
  (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")]
def fromBrowserToken (minter : RequestPrincipal) (s : Scope) : RequestPrincipal :=
  { minter with via := .browserToken, scope := some s }

/-- `WorkspaceMembership`: what `root.resolveMembership` returns. -/
structure WorkspaceMembership where
  principalId : String
  userId : String
  userLabel : String
  workspaceId : String
  role : String
  deriving DecidableEq, Repr

/-- `root.resolveMembership(email, workspaceSlug)`: the workspace named by the slug, the user named
by the email, their membership, and its unrevoked membership principal; `null` unless all four
rows exist. -/
@[aw_spec (ts := "packages/core/src/db/repositories/root.ts#resolveMembership")
  (doc := "docs/sdk/04-api-specification.md#31-credentials")]
def resolveMembership (st : State) (email slug : String) : Option WorkspaceMembership := do
  let w ← (st .workspaces).find? (colIs · "slug" slug)
  let wid ← w.get "id"
  let u ← (st .users).find? (colIs · "email" email)
  let uid ← u.get "id"
  let name ← u.get "name"
  let m ← (st .memberships).find? fun r => colIs r "workspace_id" wid && colIs r "user_id" uid
  let mid ← m.get "id"
  let role ← m.get "role"
  let p ← (st .workspacePrincipals).find? fun r =>
    colIs r "workspace_id" wid && colIs r "membership_id" mid && colIs r "kind" "membership" &&
      (r.get "revoked_at").isNone
  let pid ← p.get "id"
  pure ⟨pid, uid, name, wid, role⟩

/-- `PrincipalResolution`, the three answers of `resolveActor`. -/
inductive Resolution where
  | workspace (p : RequestPrincipal)
  | forbidden
  | unauthenticated
  deriving DecidableEq, Repr

/-- The session branch of `resolveActor` (`session-rbac.ts`), after the cookie verified: resolve
the membership by `(claims.sub, claims.ws)`, then build the principal with the slug **copied from
the claims** (`{ id: member.workspaceId, slug: verified.claims.ws }`). -/
@[aw_spec (ts := "apps/web/server/composition/session-rbac.ts#installRbacApi")
  (doc := "docs/sdk/04-api-specification.md#31-credentials")]
def identifySessionCurrent (st : State) (claims : SessionClaims) : Resolution :=
  match resolveMembership st claims.sub claims.ws with
  | none => .forbidden
  | some m =>
    match fromSession claims ⟨m.workspaceId, claims.ws⟩ m.role ⟨m.principalId, m.userId, m.userLabel⟩ with
    | .ok p => .workspace p
    | .error _ => .forbidden

/-- An instant cell strictly after `now` (`gt(expires_at, now)`); an unreadable cell is not. -/
def after (cell : Option String) (now : Nat) : Bool :=
  (Concepts.Workspace.instantOf? cell).any (now < ·)

/-- `authenticateApiKeyHash`: the key with that hash joined to its principal
(`workspace_principals.(workspace_id, api_key_id) = api_keys.(workspace_id, id)`), neither revoked,
the key unexpired. -/
@[aw_spec (ts := "packages/core/src/db/repositories/directory.ts#authenticateApiKeyHash")
  (doc := "docs/sdk/04-api-specification.md#31-credentials")]
def authenticateApiKey (st : State) (keyHash : String) (now : Nat) : Option ApiKeyIdentity :=
  let pairs := (st .apiKeys).flatMap fun k =>
    ((st .workspacePrincipals).filter fun p =>
      colsEq p "workspace_id" k "workspace_id" && colsEq p "api_key_id" k "id").map (k, ·)
  match pairs.find? (fun kp => colIs kp.1 "key_hash" keyHash && (kp.1.get "revoked_at").isNone &&
      (kp.2.get "revoked_at").isNone && ((kp.1.get "expires_at").isNone || after (kp.1.get "expires_at") now)) with
  | none => none
  | some (k, p) => do
    let pid ← p.get "id"
    let kid ← k.get "id"
    let ws ← k.get "workspace_id"
    let name ← k.get "name"
    let role ← k.get "role"
    pure ⟨pid, kid, ws, name, role⟩

/-- `principalById(workspaceId, principalId)`: an unrevoked principal of that workspace, with the
role and label of its membership (and user) or of its live API key. -/
@[aw_spec (ts := "packages/core/src/db/repositories/directory.ts#principalById")]
def principalById (st : State) (ws pid : String) (now : Nat) : Option DirectoryRecord := do
  let p ← (st .workspacePrincipals).find? fun r =>
    colIs r "workspace_id" ws && colIs r "id" pid && (r.get "revoked_at").isNone
  match p.get "kind" with
  | some "membership" =>
    let mid ← p.get "membership_id"
    let m ← (st .memberships).find? fun r => colIs r "workspace_id" ws && colIs r "id" mid
    let uid ← m.get "user_id"
    let role ← m.get "role"
    let u ← (st .users).find? (colIs · "id" uid)
    let name ← u.get "name"
    pure ⟨pid, .membership, ws, role, name, some uid, none⟩
  | _ =>
    let kid ← p.get "api_key_id"
    let k ← (st .apiKeys).find? fun r => colIs r "workspace_id" ws && colIs r "id" kid
    if (k.get "revoked_at").isSome then none
    else if (k.get "expires_at").isSome && !after (k.get "expires_at") now then none
    else
      let role ← k.get "role"
      let name ← k.get "name"
      pure ⟨pid, .apiKey, ws, role, name, none, some kid⟩

/-- A run row's status is terminal. -/
def runTerminal (r : Row) : Bool :=
  ((r.get "status").bind (WireEnum.ofWire? (α := Contracts.RunStatus))).any Contracts.RunStatus.isTerminal

/-! ## 3. The scoped repository -/

/-- `SELECT … WHERE workspace_id = scope.workspaceId AND p`: a repository's read. -/
@[aw_spec (ts := "packages/core/src/db/repositories/scope.ts#WorkspaceScope")
  (doc := "docs/adr/W2-DB-02-the-repository-shape.md#decision")]
def scopedSelect (st : State) (s : WorkspaceScope) (t : TableName) (p : Row → Bool) : List Row :=
  (st t).filter fun r => rowTenant t r == some s.workspaceId && p r

/-- `resolveBrowserTokenActor` (`session-rbac.ts`): the active token by hash, its workspace's
scope, the scoped run (not terminal) or session (not archived), and the minter re-read from the
directory in the token's workspace, attenuated by the token's scope. -/
@[aw_spec (ts := "apps/web/server/composition/session-rbac.ts#installRbacApi")
  (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")]
def resolveBrowserToken (st : State) (tokenHash : String) (now : Nat) : Option RequestPrincipal := do
  let row ← (st .browserTokens).find? fun b =>
    colIs b "token_hash" tokenHash && (b.get "revoked_at").isNone && after (b.get "expires_at") now
  let ws ← row.get "workspace_id"
  let scope ← forWorkspaceId st ws
  let tokenScope ← (if colIs row "scope_kind" "run" then do
      let rid ← row.get "run_id"
      let run ← (scopedSelect st scope .runs (colIs · "id" rid)).head?
      if runTerminal run then none else some (Scope.run ⟨rid⟩)
    else do
      let sid ← row.get "session_id"
      let se ← (scopedSelect st scope .sessions (colIs · "id" sid)).head?
      if colIs se "status" "archived" then none else some (Scope.session ⟨sid⟩) : Option Scope)
  let minterId ← row.get "minted_by_principal_id"
  let minter ← principalById st ws minterId now
  pure (fromBrowserToken (fromDirectoryRecord minter) tokenScope)

/-- A write statement stays inside workspace `ws`: it touches a tenant-scoped table, and every row
it inserts, deletes or replaces (old and new) belongs to `ws`. -/
@[aw_spec (ts := "packages/core/src/db/repositories/scope.ts#requireWorkspaceScope")
  (doc := "docs/adr/W2-DB-02-the-repository-shape.md#decision")]
def stmtInWorkspace (ws : String) : Er.Current.Stmt → Bool
  | .insert t r => isScopedTable t && rowTenant t r == some ws
  | .delete t r => isScopedTable t && rowTenant t r == some ws
  | .update t o n => isScopedTable t && rowTenant t o == some ws && rowTenant t n == some ws

/-- The row with its `workspace_id` set from the scope, whatever the caller's cells said: no
repository method takes a workspace id, so the tenant of a written row is the scope's. -/
def withWorkspace (ws : String) (r : Row) : Row :=
  ⟨("workspace_id", ws) :: r.cells.filter (·.1 != "workspace_id")⟩

/-- A repository write: insert a row, update the scoped rows matching `p` by `f`, or delete the
scoped rows matching `p`. -/
inductive RepoWrite where
  | insert (t : TableName) (r : Row)
  | update (t : TableName) (p : Row → Bool) (f : Row → Row)
  | delete (t : TableName) (p : Row → Bool)

/-- The table a repository write addresses. -/
def RepoWrite.table : RepoWrite → TableName
  | .insert t _ => t
  | .update t _ _ => t
  | .delete t _ => t

/-- The statements a repository bound to scope `s` issues for a write. -/
@[aw_spec (ts := "packages/core/src/db/repositories/scope.ts#WorkspaceScope")
  (doc := "docs/adr/W2-DB-02-the-repository-shape.md#decision")]
def RepoWrite.compile (st : State) (s : WorkspaceScope) : RepoWrite → List Er.Current.Stmt
  | .insert t r => [.insert t (withWorkspace s.workspaceId r)]
  | .update t p f =>
    (scopedSelect st s t p).map fun o => .update t o (withWorkspace s.workspaceId (f o))
  | .delete t p => (scopedSelect st s t p).map (.delete t)

/-- A repository write, committed: PostgreSQL applies it only if the state it leaves is
consistent. -/
def repoCommit (st : State) (s : WorkspaceScope) (w : RepoWrite) : State :=
  Er.Current.commit Er.Current.consistent st (w.compile st s)

/-! ## 4. Run lookup and 404 concealment -/

/-- `RunStore.get(runId)` (the in-memory store keys by id alone): the run row with that id. -/
@[aw_spec (ts := "apps/web/server/runs/store.ts#InMemoryRunStore")]
def storeGet (st : State) (runId : String) : Option Row := (st .runs).find? (colIs · "id" runId)

/-- `findRunForPrincipal`: the run, only if it belongs to the principal's workspace; `null` for
"no such run" and "not yours" alike. -/
@[aw_spec (ts := "apps/web/server/runs/api.ts#findRunForPrincipal")
  (doc := "docs/adr/W1-CP-04-start-run-request-shape.md#decision")]
def findRunForPrincipal (st : State) (ws runId : String) : Option Row :=
  (storeGet st runId).bind fun r => if colIs r "workspace_id" ws then some r else none

/-- `findRunWorkspace(db, runId)`: the one query keyed by run id alone; a workspace id and no row
content. -/
@[aw_spec (ts := "packages/core/src/db/repositories/runs.ts#findRunWorkspace")
  (doc := "docs/adr/W2-DB-02-the-run-port-is-not-scope-bound.md#decision")]
def findRunWorkspace (st : State) (runId : String) : Option String :=
  (storeGet st runId).bind (·.get "workspace_id")

/-- The database store's `get`: resolve the workspace, then read through the scoped repository. -/
@[aw_spec (ts := "apps/web/server/runs/store.ts#createRepositoryRunStore")
  (doc := "docs/adr/W2-DB-02-the-run-port-is-not-scope-bound.md#decision")]
def dbStoreGet (st : State) (runId : String) : Option Row :=
  (findRunWorkspace st runId).bind fun ws => (scopedSelect st ⟨ws⟩ .runs (colIs · "id" runId)).head?

/-- A run-route problem: `{ error: { code, message } }` with its status. -/
structure RunProblem where
  status : Nat
  code : String
  message : String
  deriving DecidableEq, Repr

/-- The one 404 every run route answers for a missing or foreign run. -/
@[aw_spec (ts := "apps/web/server/runs/api.ts#readRun")
  (doc := "docs/sdk/04-api-specification.md#512-runs-and-the-event-stream--awruns")]
def runNotFound (runId : String) : RunProblem :=
  ⟨404, "run_not_found", "no run " ++ runId ++ " in this workspace."⟩

/-- The run routes that look a run up by id. -/
inductive RunRoute where
  | read
  | events
  | interrupt
  | revokeTokens
  deriving DecidableEq, Repr, Inhabited

/-- The route names, for vectors. -/
def RunRoute.toWire : RunRoute → String
  | .read => "read"
  | .events => "events"
  | .interrupt => "interrupt"
  | .revokeTokens => "revoke-tokens"

instance : WireEnum RunRoute where
  all := [.read, .events, .interrupt, .revokeTokens]
  toWire := RunRoute.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by
    intro a b h
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-- The caller of a run route, as the run API's `Principal` carries it. -/
structure RunCaller where
  workspaceId : String
  role : String
  browserScoped : Bool
  deriving DecidableEq, Repr

/-- What each run route answers before it reads the store (the environment is installed and the
caller authenticated): `revokeRunTokens` refuses a scope, then a role other than owner and admin,
then a malformed id; the other three refuse a malformed id (no resume cursor is sent). -/
@[aw_spec (ts := "apps/web/server/runs/api.ts#revokeRunTokens")
  (ts := "apps/web/server/runs/api.ts#readRun")]
def runPreflight (route : RunRoute) (caller : RunCaller) (runId : String) : Option RunProblem :=
  let malformed : Option RunProblem :=
    if Uuid.isCanonical runId then none
    else some ⟨400, "invalid_run_id", "the run id in the path is not a UUID."⟩
  match route with
  | .revokeTokens =>
    if caller.browserScoped then
      some ⟨403, "token_out_of_scope", "a browser token’s scope does not reach revoking run tokens."⟩
    else if !revokeTokensRoleGate caller.role then
      some ⟨403, "run_token_revoke_forbidden",
        "only a workspace owner or admin may revoke active run tokens."⟩
    else malformed
  | _ => malformed

/-- A run route, up to and including the lookup: the preflight, then `findRunForPrincipal`'s 404,
then the rest of the handler `k`, which only ever sees a run of the caller's workspace. -/
@[aw_spec (ts := "apps/web/server/runs/api.ts#findRunForPrincipal")
  (doc := "docs/adr/W1-CP-04-start-run-request-shape.md#decision")]
def runRoute {α : Type} (route : RunRoute) (st : State) (caller : RunCaller) (runId : String)
    (k : Row → Except RunProblem α) : Except RunProblem α :=
  match runPreflight route caller runId with
  | some p => .error p
  | none =>
    match findRunForPrincipal st caller.workspaceId runId with
    | none => .error (runNotFound runId)
    | some r => k r

/-- Run ids are unique in the table (the primary key): no two rows share a non-`NULL` id. -/
def IdsDistinct (rows : List Row) : Prop :=
  rows.Pairwise fun a b => a.get "id" = none ∨ a.get "id" ≠ b.get "id"

instance (rows : List Row) : Decidable (IdsDistinct rows) := by
  unfold IdsDistinct; exact inferInstance

/-- The state with one more row in table `t` (another tenant's write, as far as a caller sees). -/
def addRow (st : State) (t : TableName) (r : Row) : State :=
  fun u => if u = t then st u ++ [r] else st u

/-- The rows of `t` that belong to workspace `ws`: all a workspace can observe of that table. -/
def workspaceView (st : State) (t : TableName) (ws : String) : List Row :=
  (st t).filter fun r => rowTenant t r == some ws

/-! ## 5. The scoped object store -/

/-- `key-safety.ts`'s named rules. `percentEncoded` stands for every rejection of a key that
contains `%`: such a key is never accepted (it either fails to decode, `malformed-encoding`, or is
not its own decoding, `non-canonical`, unless its decoded form trips an earlier rule first); the
model does not decode, so it names only that the key is refused. -/
@[aw_spec (ts := "packages/core/src/storage/key-safety.ts#ObjectKeyRejectionRule")
  (doc := "docs/adr/W2-CP-03-object-key-safety.md#decision")]
inductive KeyRule where
  | percentEncoded
  | controlCharacter
  | backslash
  | absolute
  | emptyKey
  | emptySegment
  | dotSegment
  | reservedName
  deriving DecidableEq, Repr, Inhabited

/-- The TypeScript rule name (`percentEncoded` has none of its own). -/
def KeyRule.toWire : KeyRule → String
  | .percentEncoded => "percent-encoded"
  | .controlCharacter => "control-character"
  | .backslash => "backslash"
  | .absolute => "absolute"
  | .emptyKey => "empty-key"
  | .emptySegment => "empty-segment"
  | .dotSegment => "dot-segment"
  | .reservedName => "reserved-name"

instance : WireEnum KeyRule where
  all := [.percentEncoded, .controlCharacter, .backslash, .absolute, .emptyKey, .emptySegment,
    .dotSegment, .reservedName]
  toWire := KeyRule.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by
    intro a b h
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-- `OBJECT_METADATA_MARKER`. -/
@[aw_spec (ts := "packages/core/src/storage/key-safety.ts#OBJECT_METADATA_MARKER")]
def metadataMarker : String := "__objectstore_meta__"

/-- The case fold `containsReservedMarker` computes, on the characters that can matter: ASCII
letters fold to lower case, and the three code points whose `toUpperCase` is an ASCII sequence
inside the marker (`ſ` → `S`, `ﬅ`/`ﬆ` → `ST`) fold to it. Every other character folds to itself,
and no other upper- or lower-case mapping yields a marker letter next to a marker letter. -/
def markerFold (c : Char) : List Char :=
  if Text.isAsciiUpper c then [Char.ofNat (c.toNat + 32)]
  else if c.toNat == 0x017F then ['s']
  else if c.toNat == 0xFB05 || c.toNat == 0xFB06 then ['s', 't']
  else [c]

/-- `containsReservedMarker(segment)`: the marker occurs in the folded segment. -/
@[aw_spec (ts := "packages/core/src/storage/key-safety.ts#containsReservedMarker")]
def containsReservedMarker (seg : List Char) : Bool :=
  let folded := seg.flatMap markerFold
  let m := metadataMarker.toList
  (List.range (folded.length + 1)).any fun i => (folded.drop i).take m.length == m

/-- A control character: code points 0–31 and 127 (`CONTROL_CHARACTER`). -/
def isControl (c : Char) : Bool := c.toNat < 32 || c.toNat == 127

/-- `DRIVE_LETTER = /^[A-Za-z]:/`. -/
def startsWithDriveLetter : List Char → Bool
  | c :: ':' :: _ => Text.isAsciiAlpha c
  | _ => false

/-- The first rule a segment list trips, in `evaluateRelativePath`'s per-segment order. -/
def segmentRule : List (List Char) → Option KeyRule
  | [] => none
  | seg :: rest =>
    if seg.isEmpty then some .emptySegment
    else if seg == ['.'] || seg == ['.', '.'] then some .dotSegment
    else if containsReservedMarker seg then some .reservedName
    else segmentRule rest

/-- `evaluateRelativePath(raw, allowRoot)`: the input itself (the guard filters, it never
rewrites) or the first rule it trips. Exact for keys without `%`; a key with `%` is refused. -/
@[aw_spec (ts := "packages/core/src/storage/key-safety.ts#evaluateRelativePath")
  (doc := "docs/adr/W2-CP-03-object-key-safety.md#decision")]
def keyGuard (raw : String) (allowRoot : Bool) : Except KeyRule String :=
  let cs := raw.toList
  if cs.contains '%' then .error .percentEncoded
  else if cs.any isControl then .error .controlCharacter
  else if cs.contains '\\' then .error .backslash
  else if cs.head? == some '/' then .error .absolute
  else if startsWithDriveLetter cs then .error .absolute
  else if cs.isEmpty then (if allowRoot then .ok raw else .error .emptyKey)
  else match segmentRule (Surface.splitSlash cs) with
    | some r => .error r
    | none => .ok raw

/-- `workspaceKeyPrefix(workspaceId)`. -/
@[aw_spec (ts := "packages/core/src/storage/object-store.ts#createScopedObjectStore")]
def workspaceKeyPrefix (ws : String) : String := "workspaces/" ++ ws

/-- `joinPrefixed(prefix, relative)`: the prefix alone for the root, else `prefix/relative`. -/
def joinPrefixed (pfx rel : String) : String := if rel = "" then pfx else pfx ++ "/" ++ rel

/-- The backend key or prefix for a workspace-relative one. -/
def fullKey (ws rel : String) : String := joinPrefixed (workspaceKeyPrefix ws) rel

/-- The workspace ids `createScopedObjectStore` accepts today: any non-blank string. -/
@[aw_spec (ts := "packages/core/src/storage/object-store.ts#createScopedObjectStore")]
def objectWorkspaceIdCurrent (ws : String) : Bool := !Text.isBlank ws

/-- The intended acceptance: a non-blank id that is one key segment, so the prefix names one
workspace (the module's header: "every key it sees is prefixed to one workspace"). -/
@[aw_spec (ts := "packages/core/src/storage/object-store.ts#createScopedObjectStore")
  (doc := "docs/adr/W2-CP-03-object-key-safety.md#decision")]
def objectWorkspaceIdTarget (ws : String) : Bool := !Text.isBlank ws && !ws.toList.contains '/'

/-- One `ObjectStore` call through the scoped wrapper. -/
inductive ObjectOp where
  | put (key : String)
  | get (key : String)
  | delete (key : String)
  | list (pfx : String)
  | listPrefix (pfx : String)
  | copy (src dst : String)
  deriving DecidableEq, Repr

/-- What the wrapper does: refuse the workspace id at construction, refuse a key, or call the
backend with these full keys (in call order). -/
inductive ObjectOutcome where
  | invalidWorkspaceId
  | unsafeKey (rule : KeyRule)
  | backend (keys : List String)
  deriving DecidableEq, Repr

/-- The wrapper's key check and join for one relative key or prefix. -/
def guardJoin (ws raw : String) (allowRoot : Bool) : Except KeyRule String :=
  (keyGuard raw allowRoot).map (fullKey ws ·)

/-- `createScopedObjectStore(backend, ws)` followed by one call, under a workspace-id acceptance
rule: `objectWorkspaceIdCurrent` is today's, `objectWorkspaceIdTarget` the intended one. -/
@[aw_spec (ts := "packages/core/src/storage/object-store.ts#createScopedObjectStore")
  (doc := "docs/adr/W2-CP-03-object-key-safety.md#decision")]
def scopedObjectOp (acceptWs : String → Bool) (ws : String) (op : ObjectOp) : ObjectOutcome :=
  if !acceptWs ws then .invalidWorkspaceId
  else
    let one (r : Except KeyRule String) : ObjectOutcome :=
      match r with
      | .ok k => .backend [k]
      | .error e => .unsafeKey e
    match op with
    | .put k | .get k | .delete k => one (guardJoin ws k false)
    | .list p | .listPrefix p => one (guardJoin ws p true)
    | .copy a b =>
      match guardJoin ws a false, guardJoin ws b false with
      | .error e, _ => .unsafeKey e
      | .ok _, .error e => .unsafeKey e
      | .ok x, .ok y => .backend [x, y]

/-- Today's wrapper. -/
def scopedObjectOpCurrent : String → ObjectOp → ObjectOutcome :=
  scopedObjectOp objectWorkspaceIdCurrent

/-- The intended wrapper. -/
def scopedObjectOpTarget : String → ObjectOp → ObjectOutcome :=
  scopedObjectOp objectWorkspaceIdTarget

/-! ## 6. The tenant session scope -/

/-- Why `validateTenantSessionScope` refused, in its order. -/
inductive ScopeRejection where
  | notAnObject
  | configDirNotString
  | configDirBlank
  | projectKeyNotString
  | projectKeyPattern
  | projectKeyDevice
  deriving DecidableEq, Repr

/-- `TenantSessionScopeVerdict`: the two arms. -/
inductive TenantScopeVerdict where
  | ok (projectKey configDir : String)
  | rejected (why : ScopeRejection)
  deriving DecidableEq, Repr

/-- `SDK_PROJECT_DIR_NAME = /^[A-Za-z0-9_-]{1,64}$/`. -/
@[aw_spec (ts := "packages/core/src/schemas.ts#SDK_PROJECT_DIR_NAME")]
def sdkProjectDirName (s : String) : Bool :=
  let cs := s.toList
  1 ≤ cs.length && cs.length ≤ 64 && cs.all fun c => Text.isAsciiAlnum c || c == '_' || c == '-'

/-- The ASCII lower-case form (what `/i` compares, on the ASCII strings that reach it). -/
def asciiLower (s : String) : List Char :=
  s.toList.map fun c => if Text.isAsciiUpper c then Char.ofNat (c.toNat + 32) else c

/-- `SDK_WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i`. -/
@[aw_spec (ts := "packages/core/src/schemas.ts#SDK_WINDOWS_DEVICE_NAME")]
def sdkWindowsDeviceName (s : String) : Bool :=
  match asciiLower s with
  | ['c', 'o', 'n'] | ['p', 'r', 'n'] | ['a', 'u', 'x'] | ['n', 'u', 'l'] => true
  | ['c', 'o', 'm', d] | ['l', 'p', 't', d] => Text.isAsciiDigit d
  | _ => false

/-- `validateTenantSessionScope(input)`: an object with a non-blank string `configDir` and a
string `projectKey` the SDK's own validator accepts and that names no Windows device. -/
@[aw_spec (ts := "packages/core/src/schemas.ts#validateTenantSessionScope")
  (doc := "docs/adr/W1-CORE-01-tenant-project-key-validated-before-the-run.md#decision")]
def validateTenantSessionScope : JValue → TenantScopeVerdict
  | .obj fs =>
    match JValue.lookup "configDir" fs with
    | some (.str configDir) =>
      if Text.isBlank configDir then .rejected .configDirBlank
      else match JValue.lookup "projectKey" fs with
        | some (.str projectKey) =>
          if !sdkProjectDirName projectKey then .rejected .projectKeyPattern
          else if sdkWindowsDeviceName projectKey then .rejected .projectKeyDevice
          else .ok projectKey configDir
        | _ => .rejected .projectKeyNotString
    | _ => .rejected .configDirNotString
  | _ => .rejected .notAnObject

/-! ## 7. 404 before decide, and the workspace-route resolvers -/

/-- An `OwnershipOutcome`: the ownership `decide()` should see, or a refusal to return as is. -/
@[aw_spec (ts := "apps/web/server/rbac/http.ts#OwnershipOutcome")
  (doc := "docs/adr/W9-AUTH-117-ownership-resolver-and-404-before-decide.md#decision")]
inductive ResolverOutcome where
  | ownership (o : Ownership)
  | refuse (status : Nat) (code : String)
  deriving DecidableEq, Repr

/-- `authorise`'s answer: a problem, or the handler runs with the decided request. -/
inductive AuthoriseResult where
  | problem (status : Nat) (code : String)
  | allowed (ownership : Ownership)
  deriving DecidableEq, Repr

/-- `authorise(request, ownership, run)` with a resolver: unconfigured is 503, no principal 401,
a refusing resolver's result is returned **without calling `decide()`**, then `decide()`'s allow,
deny (403, `decision.code ?? 'forbidden'`) or refuse (500). -/
@[aw_spec (ts := "apps/web/server/rbac/http.ts#authorise")
  (doc := "docs/adr/W9-AUTH-117-ownership-resolver-and-404-before-decide.md#decision")]
def authoriseFlow (configured : Bool) (principal : Option RequestPrincipal)
    (resolve : RequestPrincipal → ResolverOutcome)
    (decideFn : RequestPrincipal → Ownership → Decision) : AuthoriseResult :=
  if !configured then .problem 503 "rbac_runtime_not_configured"
  else match principal with
    | none => .problem 401 "unauthenticated"
    | some p =>
      match resolve p with
      | .refuse s c => .problem s c
      | .ownership o =>
        match decideFn p o with
        | .allow _ => .allowed o
        | d@(.deny _ _) => .problem 403 (d.code.getD "forbidden")
        | .revokeDeny _ => .problem 403 "run_token_revoke_forbidden"
        | .refuse _ => .problem 500 "authorisation_undecidable"

/-- `MembershipSummary`, the two fields the resolvers read. -/
structure MemberSummary where
  email : String
  userId : String
  deriving DecidableEq, Repr

/-- `normalise(email)`: trim and lower-case (ASCII; the vectors use ASCII addresses). -/
def normaliseEmail (s : String) : List Char := asciiLower (Text.jsTrim s)

/-- `resolveMemberUserId(memberships, actor)`: the first member whose normalised email is the
actor's, never a fallback. -/
@[aw_spec (ts := "apps/web/server/rbac/ownership.ts#resolveMemberUserId")]
def resolveMemberUserId (members : List MemberSummary) (actor : String) : Option String :=
  (members.find? fun m => normaliseEmail m.email == normaliseEmail actor).map (·.userId)

/-- One membership row as `WorkspaceRepositoryPort` sees it. -/
structure WorkspaceMember where
  workspaceId : String
  userId : String
  role : String
  deriving DecidableEq, Repr

/-- The workspace repository: the workspace ids that exist and their memberships. -/
structure WorkspaceRepo where
  workspaces : List String
  members : List WorkspaceMember
  deriving DecidableEq, Repr

/-- `getForMember(id, userId)`: the caller's role there, `null` for a missing workspace and for
one the caller does not belong to, indistinguishably. -/
@[aw_spec (ts := "packages/core/src/db/repositories/workspaces.ts#getForMember")]
def getForMember (repo : WorkspaceRepo) (id userId : String) : Option String :=
  if repo.workspaces.contains id then
    (repo.members.find? fun m => m.workspaceId == id && m.userId == userId).map (·.role)
  else none

/-- `workspaceNotFound()`: the one 404 of the workspace routes. -/
@[aw_spec (ts := "apps/web/server/workspaces/access.ts#workspaceNotFound")]
def workspaceNotFound : ResolverOutcome := .refuse 404 "workspace_not_found"

/-- `apiKeyRefusal`: `403 api_key_not_permitted`. -/
@[aw_spec (ts := "apps/web/server/workspaces/access.ts#apiKeyRefusal")
  (doc := "docs/sdk/04-api-specification.md#32-workspace-selection")]
def apiKeyNotPermitted : ResolverOutcome := .refuse 403 "api_key_not_permitted"

/-- `resolveMembershipView`: malformed id, API-key caller, vanished membership, not a member.
Returns the caller's role in workspace `id` or the outcome to return at once. -/
@[aw_spec (ts := "apps/web/server/workspaces/access.ts#resolveMembershipView")
  (doc := "docs/adr/W9-WS-119-api-key-callers-are-refused.md#decision")]
def resolveMembershipView (repo : WorkspaceRepo) (id : String) (p : RequestPrincipal)
    (directory : List MemberSummary) : Except ResolverOutcome String :=
  if !Uuid.isCanonical id then .error workspaceNotFound
  else if p.via == .apiKey then .error apiKeyNotPermitted
  else match resolveMemberUserId directory p.actor with
    | none => .error workspaceNotFound
    | some uid =>
      match getForMember repo id uid with
      | none => .error workspaceNotFound
      | some role => .ok role

/-- `memberOwnershipResolver`: `own` for any current membership, the concealed 404 otherwise. -/
@[aw_spec (ts := "apps/web/server/workspaces/access.ts#memberOwnershipResolver")]
def memberResolver (repo : WorkspaceRepo) (id : String) (p : RequestPrincipal)
    (directory : List MemberSummary) : ResolverOutcome :=
  match resolveMembershipView repo id p directory with
  | .error o => o
  | .ok _ => .ownership .own

/-- `ownerOwnershipResolver`: `own` only for an Owner, `other` for a lesser member. -/
@[aw_spec (ts := "apps/web/server/workspaces/access.ts#ownerOwnershipResolver")]
def ownerResolver (repo : WorkspaceRepo) (id : String) (p : RequestPrincipal)
    (directory : List MemberSummary) : ResolverOutcome :=
  match resolveMembershipView repo id p directory with
  | .error o => o
  | .ok role => .ownership (if role == "owner" then .own else .other)

/-! ## F-007: `tenancy.test.ts` rule 1, transcribed -/

/-- `leadingIndexedColumns(table)`: every column that leads an index (unique or not) or a unique
constraint, as a set, transcribed from the Drizzle schema (the latest snapshot, `Er.Snapshot.file`);
`tests/formal/authz-tenancy.test.ts` recomputes it from the live table objects. This is the one
fact rule 1 needs that `Er.Core.TableSpec` does not carry (it models unique keys only). -/
@[aw_spec (ts := "packages/core/src/db/schema/tenancy.test.ts#leadingIndexedColumns")]
def leadingIndexedColumns : TableName → List String
  | .agentFiles => ["file_id", "workspace_id"]
  | .agentGrants => ["agent_id", "user_id", "workspace_id"]
  | .agentMcpServers => ["mcp_server_id", "workspace_id"]
  | .agentSkills => ["skill_id", "workspace_id"]
  | .agentPointerMoves => ["workspace_id"]
  | .agentVersionEvaluations => ["workspace_id"]
  | .agentVersionPointers => ["workspace_id"]
  | .agentVersions => ["workspace_id", "id"]
  | .agents => ["workspace_id", "model_connection_id", "runtime_profile_id", "owner_principal_id", "id"]
  | .apiKeys => ["workspace_id", "key_hash"]
  | .auditEvents => ["workspace_id", "actor_user_id", "actor_principal_id"]
  | .browserTokens => ["token_hash", "workspace_id"]
  | .cliSessions => ["workspace_id", "user_code", "token_hash"]
  | .endpointClientAgents => ["workspace_id"]
  | .endpointClientApiKeys => ["workspace_id"]
  | .endpointClients => ["workspace_id"]
  | .files => ["workspace_id", "id"]
  | .invitations => ["workspace_id", "invited_by"]
  | .mcpServers => ["workspace_id", "credential_secret_id", "owner_principal_id", "id"]
  | .memberships => ["user_id", "workspace_id"]
  | .modelConnections => ["workspace_id", "id"]
  | .oauthTokens => ["token_hash", "workspace_id"]
  | .projectFiles => ["workspace_id"]
  | .projectMcpServers => ["workspace_id"]
  | .projects => ["workspace_id", "default_agent_id", "owner_principal_id", "id"]
  | .runs => ["workspace_id", "session_id", "model_connection_id", "id"]
  | .runEvents => ["workspace_id"]
  | .runFeedback => ["workspace_id"]
  | .runUsageRecords => ["run_id", "workspace_id"]
  | .runTokens => ["token_hash", "workspace_id"]
  | .runtimeProfiles => ["workspace_id", "runtime_connection_id", "id"]
  | .runtimeVerifications => ["workspace_id"]
  | .secrets => ["workspace_id", "id"]
  | .sessionMessages => ["workspace_id"]
  | .sessionStateBlobs => ["workspace_id"]
  | .sessionStateEntries => ["workspace_id"]
  | .sessionStateStreams => ["workspace_id"]
  | .sessionTranscripts => ["workspace_id", "project_key"]
  | .sessions => ["workspace_id", "agent_id", "project_id", "user_id", "owner_principal_id", "id"]
  | .shareViews => ["workspace_id"]
  | .shareRunCharges => ["workspace_id"]
  | .shares => ["workspace_id", "publisher_principal_id", "id", "token"]
  | .skills => ["workspace_id", "owner_principal_id", "id"]
  | .surfaceSessionKeys => ["workspace_id"]
  | .userIdentities => ["user_id", "issuer"]
  | .users => ["email"]
  | .workspaces => ["slug"]
  | .workspacePrincipals => ["workspace_id"]

/-- Rule 1 of `tenancy.test.ts` ("the table is scoped"), as the test states it: an exempt table
(the root or a global table, `TENANT_EXEMPT`) has no `workspace_id`; any other has a `NOT NULL`
`workspace_id`, exactly one foreign key whose whole column list is `workspace_id`, that key
references `workspaces(id)`, and `workspace_id` leads an index. -/
@[aw_spec (ts := "packages/core/src/db/schema/tenancy.test.ts#TENANT_COLUMN")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#TENANT_EXEMPT")]
def testRule1 (S : Schema) (leaders : TableName → List String) (t : TableName) : Bool :=
  let s := S t
  match s.tenancy with
  | .root | .global => !s.hasColumn "workspace_id"
  | .scoped =>
    s.isNotNull "workspace_id" &&
      (match s.foreignKeys.filter (·.columns == ["workspace_id"]) with
       | [fk] => fk.refTable == .workspaces && fk.refColumns == ["id"]
       | _ => false) &&
      (leaders t).contains "workspace_id"

end AgentWorkspace.Authz.Tenancy
