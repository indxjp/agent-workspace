import AgentWorkspace.Authz.Permissions
import AgentWorkspace.Concepts.BrowserToken
import AgentWorkspace.Contracts.Identifiers

/-!
# A browser token's scope, as `decide()` checks it

`TOKEN_SCOPE_KINDS` and `TokenScope` are the concept layer's `Concepts.BrowserToken.ScopeKind` and
`Scope` (one run or one session, never both). This module adds what `apps/web/server/rbac/decide.ts`
does with a scope:

- `TOKEN_SCOPE_GRAMMAR`: the `(resource, operation, sub-resource)` cells each kind may reach — `run`:
  reading `runs`; `session`: reading `runs`, running `agents`, and the `run` verb on a run's
  `feedback` sub-resource (`POST /api/runs/:id/feedback`, S2-05c). A cell whose sub-resource is
  `none` matches its `(resource, operation)` pair under any sub-resource; a `some s` cell matches
  only under `s`, so the feedback cell does not admit `interrupt`, which is the same `run` verb.
- `checkTokenScope`, three denials in order, each with code `token_out_of_scope`:
  1. the cell is not in the kind's grammar (`inGrammar`);
  2. a `runs` read names no `:id` (a scope reads one row, never the collection);
  3. a run scope reaching `runs` whose path `:id` names a different UUID. Valid UUID spellings
     compare without case; other identifiers retain exact comparison.
  Otherwise the scope does not object and §21's table decides as usual. It never refuses.
-/

namespace AgentWorkspace.Authz.TokenScope

open AgentWorkspace AgentWorkspace.Authz.Resources AgentWorkspace.Authz.Permissions
  AgentWorkspace.Concepts.BrowserToken

/-- `TOKEN_SCOPE_GRAMMAR`: the route shapes, as `(resource, operation, sub-resource)` cells, a kind
may reach. A `none` sub-resource matches any sub-resource (see `inGrammar`). -/
@[aw_spec (ts := "apps/web/server/rbac/decide.ts#TOKEN_SCOPE_GRAMMAR")
  (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")]
def grammar : ScopeKind → List (Resource × Operation × Option String)
  | .run => [(.runs, .read, none)]
  | .session => [(.runs, .read, none), (.agents, .run, none), (.runs, .run, some "feedback")]

/-- A cell with `none` matches the pair under any sub-resource; `some s` only under `s`. -/
def inGrammar (k : ScopeKind) (resource : Resource) (op : Operation) (sub : Option String) :
    Bool :=
  (grammar k).any fun (r, o, s) => r == resource && o == op && (s.isNone || s == sub)

/-- §3.1.1's grammar table as the document prints it, route by route: (scope, method, path).
Transcribed independently of `grammar`; `Normative.AuthzDecide` proves the two agree. -/
@[aw_spec (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")]
def documentedScopeRoutes : List (ScopeKind × String × String) :=
  [ (.run, "GET", "/api/runs/:id"),
    (.run, "GET", "/api/runs/:id/events"),
    (.session, "GET", "/api/runs/:id"),
    (.session, "GET", "/api/runs/:id/events"),
    (.session, "POST", "/api/agents/:id/runs"),
    (.session, "POST", "/api/runs/:id/feedback") ]

/-- Why a scope denied: the three clauses of `checkTokenScope`, in order. -/
inductive ScopeDenial where
  /-- The `(resource, operation, sub-resource)` cell is outside the kind's grammar. -/
  | notInGrammar
  /-- A `runs` read that names no `:id`: the collection. -/
  | collectionRead
  /-- A run scope whose path `:id` names a different row. -/
  | runIdMismatch
  /-- A browser token cannot revoke another run token. -/
  | revoke
  deriving DecidableEq, Repr, Inhabited

def sameRunId (pathId : Option String) (scopeId : String) : Bool :=
  match pathId with
  | none => false
  | some id =>
    id == scopeId ||
      (AgentWorkspace.Contracts.Identifiers.isUuidCurrent id &&
       AgentWorkspace.Contracts.Identifiers.isUuidCurrent scopeId &&
       AgentWorkspace.Contracts.Identifiers.lowerAscii id ==
         AgentWorkspace.Contracts.Identifiers.lowerAscii scopeId)

/-- `checkTokenScope`: `some d` denies with `token_out_of_scope`; `none` defers to §21's table. -/
@[aw_spec (ts := "apps/web/server/rbac/decide.ts#checkTokenScope")
  (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")]
def checkTokenScope (scope : Scope) (resource : Resource) (op : Operation)
    (sub : Option String) (pathId : Option String) : Option ScopeDenial :=
  if !inGrammar scope.kind resource op sub then some .notInGrammar
  else if resource = .runs ∧ op = .read ∧ pathId = none then some .collectionRead
  else if scope.kind = .run ∧ resource = .runs ∧ !sameRunId pathId scope.id then some .runIdMismatch
  else none

end AgentWorkspace.Authz.TokenScope
