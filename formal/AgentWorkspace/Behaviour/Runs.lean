import AgentWorkspace.Authz.Decide
import AgentWorkspace.Behaviour.RunCompose
import AgentWorkspace.Lifecycle.Run
import AgentWorkspace.Er.Current

/-! HTTP run-route transitions. The request carries validated boundary facts so each check is
evaluated in the same order as `api.ts`. The run rows are a projection of Er/Current's `runs`
table; `er` carries the surrounding database, which these handler checks do not alter. -/

namespace AgentWorkspace.Behaviour.Runs

open AgentWorkspace AgentWorkspace.Authz.Decide AgentWorkspace.Authz.TokenScope
  AgentWorkspace.Behaviour.RunCompose AgentWorkspace.Lifecycle
  AgentWorkspace.Contracts.Runs

inductive Route where
  | start | list | read | revokeAlias | revoke | stream | interrupt
  deriving DecidableEq, Repr

def Route.method : Route → String
  | .start | .revokeAlias | .revoke | .interrupt => "POST"
  | _ => "GET"

def Route.path : Route → String
  | .start => "/api/agents/:id/runs"
  | .list => "/api/runs"
  | .read | .revokeAlias => "/api/runs/:id"
  | .revoke => "/api/runs/:id/revoke-tokens"
  | .stream => "/api/runs/:id/events"
  | .interrupt => "/api/runs/:id/interrupt"

def Route.actualPath (route : Route) (id : String) : String :=
  match route with
  | .start => "/api/agents/" ++ id ++ "/runs"
  | .list => "/api/runs"
  | .read | .revokeAlias => "/api/runs/" ++ id
  | .revoke => "/api/runs/" ++ id ++ "/revoke-tokens"
  | .stream => "/api/runs/" ++ id ++ "/events"
  | .interrupt => "/api/runs/" ++ id ++ "/interrupt"

structure Principal where
  id : String
  workspaceId : String
  role : String
  scope : Option AgentWorkspace.Concepts.BrowserToken.Scope := none
  deriving Repr

structure RunRow where
  id : String
  workspaceId : String
  ownerId : String
  sessionId : String
  lifecycle : RunState := {}
  deriving DecidableEq, Repr

/-- The ER row corresponding to a handler-visible run. The surrounding fixture supplies the
session/workspace parents and any other run rows. -/
def RunRow.toErRow (row : RunRow) : AgentWorkspace.Er.Core.Row :=
  ⟨[("id", row.id), ("workspace_id", row.workspaceId), ("session_id", row.sessionId),
    ("status", row.lifecycle.status.toWire), ("input_tokens", "0"), ("output_tokens", "0"),
    ("cache_read_input_tokens", "0"), ("cache_creation_input_tokens", "0"),
    ("cost_usd", "0"), ("cost_currency", "USD"), ("tool_calls", "0"),
    ("accounting_state", "pending"), ("tool_connector_ids", "{}"), ("file_grants", "{}"), ("approved_tool_calls", "[]"), ("consumed_tool_calls", "[]"), ("created_at", "1000"),
    ("updated_at", "1000")] ++
    (if row.lifecycle.status.isTerminal then
      [("started_at", "1000"), ("ended_at", "1001")] else [])⟩

structure State where
  erBase : AgentWorkspace.Er.Core.State := AgentWorkspace.Er.Current.Witness.state
  runs : List RunRow := []
  deriving Inhabited

/-- The run list is an ER projection, joined to the surrounding current-schema tables. -/
def State.er (s : State) : AgentWorkspace.Er.Core.State := fun table =>
  if table == AgentWorkspace.Er.Core.TableName.runs then
    s.erBase table ++ s.runs.map RunRow.toErRow
  else s.erBase table

/-- The handler's projection of runs in every workspace other than the caller's. -/
def State.foreignRuns (s : State) (workspaceId : String) : List RunRow :=
  s.runs.filter (fun row => row.workspaceId != workspaceId)

/-- Boundary facts preserve the distinction between a malformed path, a missing row, and a
row in another workspace. List filter checks are separate so their priority can be proved. -/
structure Request where
  route : Route
  id : String := ""
  configured : Bool := true
  authenticated : Bool := true
  pathValid : Bool := true
  ownership : Ownership := .own
  bodyValid : Bool := true
  sessionId : Option String := none
  agentFound : Bool := true
  sessionUsable : Bool := true
  cursorValid : Bool := true
  limitValid : Bool := true
  listCursorValid : Bool := true
  statusValid : Bool := true
  agentValid : Bool := true
  projectValid : Bool := true
  providerValid : Bool := true
  modelValid : Bool := true
  fromValid : Bool := true
  toValid : Bool := true
  dateRangeValid : Bool := true
  userFilter : Bool := false
  userValid : Bool := true
  tokenIdValid : Bool := true
  revokeCount : Nat := 1
  tokenFound : Bool := true
  streamOpens : Bool := true
  effectFails : Bool := false
  newRunId : String := "new-run"
  newSessionId : String := "se1"
  deriving Repr

structure Reply where
  status : Nat
  code : Option String := none
  bodyKind : String := "problem"
  ownerFilter : Option String := none
  revokeOutcome : Option String := none
  revoked : Nat := 0
  deriving DecidableEq, Repr

structure Result where
  state : State
  reply : Reply

def problem (status : Nat) (code : String) : Reply :=
  { status, code := some code }

def found (s : State) (p : Principal) (id : String) : Option RunRow :=
  s.runs.find? (fun r => r.id == id && r.workspaceId == p.workspaceId)

def scopeMatches (p : Principal) (sessionId : Option String) : Bool :=
  match p.scope with
  | some (.session id) => sessionId == some id.val
  | _ => true

def permission (r : Request) (p : Principal) : Option Reply :=
  if (AgentWorkspace.Authz.Roles.parseRoleInput p.role).isNone then
    some (problem 403 "forbidden")
  else
    let q : Query :=
      { role := p.role, method := Route.method r.route, path := Route.actualPath r.route r.id,
        ownership := r.ownership, scope := p.scope }
    match decideAuth q with
    | .allow _ => none
    | .deny _ denial => some (problem 403 (if denial.isSome then "token_out_of_scope" else "forbidden"))
    | .revokeDeny _ => some (problem 403 "run_token_revoke_forbidden")
    | .refuse _ => some (problem 500 "authorisation_undecidable")

def listPermission (r : Request) (p : Principal) : Option Reply :=
  if (AgentWorkspace.Authz.Roles.parseRoleInput p.role).isNone then
    some (problem 403 "forbidden")
  else if p.scope.isSome then some (problem 403 "token_out_of_scope")
  else permission { r with ownership := .notApplicable } p

def listGrantAny (p : Principal) : Bool := p.role == "owner" || p.role == "admin"

/-- The list parser's first error wins; user-filter permission follows all ordinary filters. -/
def listQueryError (r : Request) (p : Principal) : Option Reply :=
  if !r.limitValid then some (problem 400 "invalid_limit")
  else if !r.listCursorValid then some (problem 400 "invalid_cursor")
  else if !r.statusValid then some (problem 400 "invalid_status")
  else if !r.agentValid then some (problem 400 "invalid_agent")
  else if !r.projectValid then some (problem 400 "invalid_project")
  else if !r.providerValid then some (problem 400 "invalid_provider")
  else if !r.modelValid then some (problem 400 "invalid_model")
  else if !r.fromValid then some (problem 400 "invalid_from")
  else if !r.toValid then some (problem 400 "invalid_to")
  else if !r.dateRangeValid then some (problem 400 "invalid_date_range")
  else if r.userFilter && !listGrantAny p then some (problem 403 "user_filter_forbidden")
  else if r.userFilter && !r.userValid then some (problem 400 "invalid_user")
  else none

def revokeOutcome (r : Request) : String :=
  if !r.tokenFound then "not-found"
  else if r.revokeCount == 0 then "already-revoked"
  else "revoked"

def finishReply (s : State) (reply : Reply) : Result := ⟨s, reply⟩

def startState (s : State) (p : Principal) (r : Request) : State :=
  let row : RunRow :=
    { id := r.newRunId, workspaceId := p.workspaceId,
      ownerId := p.id, sessionId := r.newSessionId }
  { s with runs := row :: s.runs }

def interruptState (s : State) (p : Principal) (row : RunRow) : State :=
  let changed := { row with lifecycle := runActions row.lifecycle (interruptActions 1) }
  { s with runs := s.runs.map (fun x =>
    if x.id == row.id && x.workspaceId == p.workspaceId then changed else x) }

/-- One handler step, including the deprecated revoke alias. Unexpected effect failures are
represented as `500 internal_error`; successful stream events after 200 belong to Events/Sse. -/
@[aw_spec (ts := "apps/web/server/runs/api.ts#startRun")
  (ts := "apps/web/server/runs/api.ts#listRuns")
  (ts := "apps/web/server/runs/api.ts#readRun")
  (ts := "apps/web/server/runs/api.ts#revokeRunTokens")
  (ts := "apps/web/server/runs/api.ts#streamRunEvents")
  (ts := "apps/web/server/runs/api.ts#interruptRun")]
def step (s : State) (p : Principal) (r : Request) : Result := Id.run do
  let done := finishReply s
  if !r.configured then return done (problem 503 "run_api_not_configured")
  if !r.authenticated then return done (problem 401 "unauthenticated")
  match r.route with
  | .start =>
    if !r.pathValid then return done (problem 400 "invalid_agent_id")
    if let some denial := permission r p then return done denial
    if !r.bodyValid then return done (problem 400 "invalid_body")
    if !scopeMatches p r.sessionId then return done (problem 403 "token_out_of_scope")
    if !r.agentFound then return done (problem 404 "agent_not_found")
    if !r.sessionUsable then return done (problem 409 "session_not_usable")
    if r.effectFails then return done (problem 500 "internal_error")
    return ⟨startState s p r, { status := 202, bodyKind := "start" }⟩
  | .list =>
    if let some denial := listPermission r p then return done denial
    if let some denial := listQueryError r p then return done denial
    if r.effectFails then return done (problem 500 "internal_error")
    return done
      { status := 200, bodyKind := "list",
        ownerFilter := if listGrantAny p || r.userFilter then none else some p.id }
  | .revokeAlias | .revoke =>
    if (AgentWorkspace.Authz.Roles.parseRoleInput p.role).isNone then
      return done (problem 403 "forbidden")
    if p.scope.isSome then return done (problem 403 "token_out_of_scope")
    if !revokeTokensRoleGate p.role then return done (problem 403 "run_token_revoke_forbidden")
    if !r.pathValid then return done (problem 400 "invalid_run_id")
    if (found s p r.id).isNone then return done (problem 404 "run_not_found")
    if !r.bodyValid then return done (problem 400 "invalid_body")
    if !r.tokenIdValid then return done (problem 400 "invalid_token_id")
    if r.effectFails then return done (problem 500 "internal_error")
    return done
      { status := 200, bodyKind := "revoke", revoked := r.revokeCount,
        revokeOutcome := some (revokeOutcome r) }
  | .read | .stream | .interrupt =>
    if !r.pathValid then return done (problem 400 "invalid_run_id")
    if r.route == .stream && !r.cursorValid then
      return done (problem 400 "invalid_resume_cursor")
    let some row := found s p r.id | return done (problem 404 "run_not_found")
    if r.route != .interrupt && !scopeMatches p (some row.sessionId) then
      return done (problem 403 "token_out_of_scope")
    if let some denial := permission r p then return done denial
    if r.route == .interrupt then
      if row.lifecycle.status.isTerminal then return done (problem 409 "run_not_interruptible")
      if r.effectFails then return done (problem 500 "internal_error")
      return ⟨interruptState s p row, { status := 200, bodyKind := "run" }⟩
    if r.route == .stream then
      if !r.streamOpens then return done (problem 404 "run_not_found")
      if r.effectFails then return done (problem 500 "internal_error")
      return done { status := 200, bodyKind := "stream" }
    return done { status := 200, bodyKind := "run" }

/-- Keys the handler may render on a response envelope. Nested run resources are the proven
Contracts.Runs representation and contain no token credential material. -/
def Reply.publicKeys (reply : Reply) : List String :=
  match reply.bodyKind with
  | "start" => ["run", "events"]
  | "list" => ["runs", "nextCursor"]
  | "revoke" => ["revoked", "outcome"]
  | "run" => ["run"]
  | "stream" => []
  | _ => ["error"]

/-- Fields of `renderRun` that may appear inside `run` or each listed run. -/
def runResourceKeys : List String :=
  ["id", "workspaceId", "agentId", "projectId", "initiatingUserId", "sessionId",
   "status", "createdAt", "startedAt", "endedAt", "durationMs", "model", "provider",
   "modelConnectionId", "usage", "cost", "error", "output", "accountingState", "accountingError"]

def Reply.allKeys (reply : Reply) : List String :=
  reply.publicKeys ++ (if ["start", "list", "run"].contains reply.bodyKind then
    runResourceKeys else [])

end AgentWorkspace.Behaviour.Runs
