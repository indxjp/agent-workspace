import AgentWorkspace.Authz.TokenScope

/-!
# An anonymous visitor's session token (issue #622)

`POST /p/s/<name>/sessions` hands an anonymous visitor a session-scoped browser token, with no
sign-in, when `mayOpenSession` (`apps/web/server/surfaces/public/conditions.ts`) admits the request.
The token's scope names one session, and the session row names its workspace and its surface, so
"reaches only its session" is the whole of "reaches only its own workspace and surface".

Two halves refuse a visitor's request, both with `403 token_out_of_scope`:

1. `decide()`'s scope grammar (`TokenScope.checkTokenScope`) admits only the route *shapes* of a
   session scope: reading a run by id (and its events), running an agent, and a run's `feedback`.
2. `requireSessionScopeMatch` (`apps/web/server/runs/api.ts`) compares the session the run row or
   the turn's body names with the scope's, because on none of those shapes does the path carry it.

`visitorDecision` composes them. `.proceed` means neither half objects and the route's own checks
(§21's table, the visitor limits) decide as usual.

`openVerdict` is `mayOpenSession` with ADR-0105's loopback conditions folded into one input
(`loopback`: the flag, the listener and the request host all hold) and `sameOrigin` as the shared
CSRF check's verdict. The condition that refused is not modelled, only that it refused.
-/

namespace AgentWorkspace.Authz.VisitorSession

open AgentWorkspace AgentWorkspace.Authz.Resources AgentWorkspace.Authz.Permissions
  AgentWorkspace.Authz.TokenScope AgentWorkspace.Concepts.BrowserToken

/-- `requireSessionScopeMatch`: `true` when the request may go on. Any principal without a session
scope passes; a session scope passes only for the session it names (`none`: a turn's body named no
session, which is refused like a different one). -/
@[aw_spec (ts := "apps/web/server/runs/api.ts#requireSessionScopeMatch")]
def sessionScopeMatch (scope : Option Scope) (sessionId : Option String) : Bool :=
  match scope with
  | some (.session id) => sessionId == some id.val
  | _ => true

/-- A request a visitor's token presents, as the two halves read it. -/
structure Request where
  resource : Resource
  op : Operation
  sub : Option String
  /-- The path's `:id`: a run on the `runs` routes, an agent on `agents/:id/runs`. -/
  pathId : Option String
  /-- The session the run row (read, events, feedback) or the turn's body names. -/
  sessionId : Option String
  deriving DecidableEq, Repr

/-- What the two halves decide: refuse with a status and code, or let the route go on. -/
inductive Decision where
  | proceed
  | deny (status : Nat) (code : String)
  deriving DecidableEq, Repr

/-- The scope grammar, then the session match: either refusal is `403 token_out_of_scope`. -/
@[aw_spec (ts := "apps/web/server/rbac/decide.ts#checkTokenScope")
  (ts := "apps/web/server/runs/api.ts#requireSessionScopeMatch")]
def visitorDecision (scope : Scope) (req : Request) : Decision :=
  if (checkTokenScope scope req.resource req.op req.sub req.pathId).isSome then
    .deny 403 "token_out_of_scope"
  else if !sessionScopeMatch (some scope) req.sessionId then .deny 403 "token_out_of_scope"
  else .proceed

/-- `mayOpenSession`'s verdict: which branch admitted the request (with the `Origin` echoed in
`Access-Control-Allow-Origin` for a cross-origin one), or a refusal. -/
inductive OpenVerdict where
  | loopback
  | allowedOrigin (corsOrigin : Option String)
  | refused
  deriving DecidableEq, Repr

/-- `SurfaceOpenMode`: the page and its loader, or the session bootstrap. -/
inductive OpenMode where
  | page
  | session
  deriving DecidableEq, Repr

/-- `mayOpenSession`: the loopback branch first (its same-origin condition only for `session`),
then the allowed-origin branch, where a cross-origin `Origin` must equal a listed one exactly. -/
@[aw_spec (ts := "apps/web/server/surfaces/public/conditions.ts#mayOpenSession")]
def openVerdict (loopback sameOrigin : Bool) (allowed : List String) (origin : Option String)
    (mode : OpenMode) : OpenVerdict :=
  if loopback && (mode == .page || sameOrigin) then .loopback
  else if allowed.isEmpty then .refused
  else if mode == .page || sameOrigin then .allowedOrigin none
  else match origin with
    | some o => if allowed.contains o then .allowedOrigin (some o) else .refused
    | none => .refused

/-- `createSurfaceSession`'s open → mint step: `mayOpenSession` first, then the route's other
refusals (`admitted`: the mode it serves and the rate limit), then `runtime.open`, which names the
session it opened or none (gone, not offered, not resumable, refused). A token is minted, scoped to
that one session, only when every step lets it through. -/
@[aw_spec (ts := "apps/web/server/surfaces/public/handlers.ts#createSurfaceSession")]
def mintAfterOpen (verdict : OpenVerdict) (admitted : Bool) (opened : Option SessionId) :
    Option Scope :=
  match verdict with
  | .refused => none
  | _ => if admitted then opened.map .session else none

end AgentWorkspace.Authz.VisitorSession
