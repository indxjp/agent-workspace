import AgentWorkspace.Theorems.Refinement.BehaviourRuns
import Vectors.Common

namespace Vectors.BehaviourRuns

open Lean AgentWorkspace.Behaviour.Runs

structure Scenario where
  id : String
  route : Route
  fault : String := "none"
  role : String := "owner"
  scope : String := "none"
  ownership : String := "own"

def routeName : Route → String
  | .start => "start" | .list => "list" | .read => "read"
  | .revokeAlias => "revoke-alias" | .revoke => "revoke"
  | .stream => "stream" | .interrupt => "interrupt"

def principal (c : Scenario) : Principal :=
  let scope := match c.scope with
    | "run" => some (AgentWorkspace.Concepts.BrowserToken.Scope.run ⟨"run"⟩)
    | "run-other" => some (AgentWorkspace.Concepts.BrowserToken.Scope.run ⟨"other"⟩)
    | "session" => some (AgentWorkspace.Concepts.BrowserToken.Scope.session ⟨"se1"⟩)
    | "session-other" => some (AgentWorkspace.Concepts.BrowserToken.Scope.session ⟨"other"⟩)
    | _ => none
  { id := "owner", workspaceId := if c.fault == "foreign" then "w2" else "w1",
    role := c.role, scope }

def ownership (c : Scenario) : AgentWorkspace.Authz.Decide.Ownership :=
  if c.ownership == "other" then .other else .own

def request (c : Scenario) : Request :=
  let base : Request := { route := c.route, id := "run", ownership := ownership c }
  let base := if c.scope == "session" && c.route == .start then
    { base with sessionId := some "se1" } else base
  match c.fault with
  | "unconfigured" => { base with configured := false }
  | "unauthenticated" => { base with authenticated := false }
  | "bad-path" => { base with pathValid := false }
  | "bad-body" => { base with bodyValid := false }
  | "missing-agent" => { base with agentFound := false }
  | "unusable-session" => { base with sessionUsable := false }
  | "bad-cursor" => { base with cursorValid := false }
  | "stream-missing" => { base with streamOpens := false }
  | "bad-token" => { base with tokenIdValid := false }
  | "already-revoked" => { base with revokeCount := 0 }
  | "token-not-found" => { base with revokeCount := 0, tokenFound := false }
  | "invalid-limit" => { base with limitValid := false }
  | "invalid-cursor" => { base with listCursorValid := false }
  | "invalid-status" => { base with statusValid := false }
  | "invalid-agent" => { base with agentValid := false }
  | "invalid-project" => { base with projectValid := false }
  | "invalid-provider" => { base with providerValid := false }
  | "invalid-model" => { base with modelValid := false }
  | "invalid-from" => { base with fromValid := false }
  | "invalid-to" => { base with toValid := false }
  | "invalid-date-range" => { base with dateRangeValid := false }
  | "user-filter" => { base with userFilter := true }
  | "invalid-user" => { base with userFilter := true, userValid := false }
  | _ => base

def state (c : Scenario) : State :=
  let workspaceId := "w1"
  let lifecycle : AgentWorkspace.Lifecycle.RunState :=
    if c.fault == "terminal" then { status := .completed } else {}
  let row : RunRow :=
    { id := "run", workspaceId, ownerId := "owner", sessionId := "se1", lifecycle }
  let foreign : RunRow :=
    { id := "foreign-run", workspaceId := "w2", ownerId := "other", sessionId := "se2" }
  if c.fault == "missing" then {}
  else if c.fault == "with-foreign" then { runs := [row, foreign] }
  else { runs := [row] }

def witness (route : Route) : String :=
  let name := match route with
    | .start => "start_accepted" | .list => "list_forces_owner"
    | .read => "read_foreign_is_not_found"
    | .revokeAlias | .revoke => "revoke_alias_agrees"
    | .stream => "stream_cursor_precedes_lookup"
    | .interrupt => "terminal_interrupt_conflicts"
  "AgentWorkspace.Theorems.Normative.BehaviourRuns." ++ name

def vector (c : Scenario) : Vectors.Vector :=
  let out := step (state c) (principal c) (request c)
  let created := if c.route == .start && out.reply.status == 202 then out.state.runs.head?
    else none
  { id := c.id,
    input := Json.mkObj [("route", toJson (routeName c.route)),
      ("fault", toJson c.fault), ("role", toJson c.role),
      ("scope", toJson c.scope), ("ownership", toJson c.ownership)],
    expected := Json.mkObj [("status", toJson out.reply.status),
      ("code", toJson out.reply.code), ("bodyKind", toJson out.reply.bodyKind),
      ("ownerFilter", toJson out.reply.ownerFilter),
      ("revokeOutcome", toJson out.reply.revokeOutcome),
      ("revoked", toJson out.reply.revoked),
      ("runCount", toJson out.state.runs.length),
      ("createdOwnerId", toJson (created.map RunRow.ownerId)),
      ("createdSessionId", toJson (created.map RunRow.sessionId))],
    witnesses := [witness c.route] }

def routes : List Route := [.start, .list, .read, .revokeAlias, .revoke, .stream, .interrupt]

def scenarios : List Scenario :=
  (routes.map fun route => ⟨routeName route ++ "-ok", route, "none", "owner", "none", "own"⟩) ++
  (routes.flatMap fun route =>
    [⟨routeName route ++ "-503", route, "unconfigured", "owner", "none", "own"⟩,
     ⟨routeName route ++ "-401", route, "unauthenticated", "owner", "none", "own"⟩]) ++
  [⟨"start-viewer-denied", .start, "none", "viewer", "none", "other"⟩,
   ⟨"start-role-missing", .start, "none", "missing", "none", "own"⟩,
   ⟨"start-run-scope", .start, "none", "owner", "run", "own"⟩,
   ⟨"start-session-scope", .start, "none", "owner", "session", "own"⟩,
   ⟨"start-session-mismatch", .start, "none", "owner", "session-other", "own"⟩,
   ⟨"start-bad-path", .start, "bad-path", "owner", "none", "own"⟩,
   ⟨"start-bad-body", .start, "bad-body", "owner", "none", "own"⟩,
   ⟨"start-agent-missing", .start, "missing-agent", "owner", "none", "own"⟩,
   ⟨"start-session-unusable", .start, "unusable-session", "owner", "none", "own"⟩,
   ⟨"start-with-foreign", .start, "with-foreign", "owner", "none", "own"⟩,
   ⟨"list-builder-own", .list, "none", "builder", "none", "own"⟩,
   ⟨"list-viewer-own", .list, "none", "viewer", "none", "own"⟩,
   ⟨"list-run-scope", .list, "none", "owner", "run", "own"⟩,
   ⟨"list-role-missing", .list, "none", "missing", "none", "own"⟩,
   ⟨"list-user-forbidden", .list, "user-filter", "builder", "none", "own"⟩,
   ⟨"list-invalid-user", .list, "invalid-user", "owner", "none", "own"⟩,
   ⟨"read-bad-path", .read, "bad-path", "owner", "none", "own"⟩,
   ⟨"read-missing", .read, "missing", "owner", "none", "own"⟩,
   ⟨"read-foreign", .read, "foreign", "owner", "none", "own"⟩,
   ⟨"read-session-mismatch", .read, "none", "owner", "session-other", "own"⟩,
   ⟨"read-run-scope", .read, "none", "owner", "run", "own"⟩,
   ⟨"read-run-scope-mismatch", .read, "none", "owner", "run-other", "own"⟩,
   ⟨"read-viewer-other", .read, "none", "viewer", "none", "other"⟩,
   ⟨"read-role-missing", .read, "none", "missing", "none", "own"⟩,
   ⟨"revoke-scope", .revoke, "none", "owner", "run", "own"⟩,
   ⟨"revoke-builder", .revoke, "none", "builder", "none", "own"⟩,
   ⟨"revoke-role-missing", .revoke, "none", "missing", "none", "own"⟩,
   ⟨"revoke-admin", .revoke, "none", "admin", "none", "own"⟩,
   ⟨"revoke-bad-path", .revoke, "bad-path", "owner", "none", "own"⟩,
   ⟨"revoke-missing", .revoke, "missing", "owner", "none", "own"⟩,
   ⟨"revoke-bad-body", .revoke, "bad-body", "owner", "none", "own"⟩,
   ⟨"revoke-bad-token", .revoke, "bad-token", "owner", "none", "own"⟩,
   ⟨"revoke-already", .revoke, "already-revoked", "owner", "none", "own"⟩,
   ⟨"revoke-token-missing", .revoke, "token-not-found", "owner", "none", "own"⟩,
   ⟨"revoke-alias-scope", .revokeAlias, "none", "owner", "run", "own"⟩,
   ⟨"revoke-alias-builder", .revokeAlias, "none", "builder", "none", "own"⟩,
   ⟨"revoke-alias-role-missing", .revokeAlias, "none", "missing", "none", "own"⟩,
   ⟨"revoke-alias-admin", .revokeAlias, "none", "admin", "none", "own"⟩,
   ⟨"revoke-alias-bad-path", .revokeAlias, "bad-path", "owner", "none", "own"⟩,
   ⟨"revoke-alias-missing", .revokeAlias, "missing", "owner", "none", "own"⟩,
   ⟨"revoke-alias-bad-body", .revokeAlias, "bad-body", "owner", "none", "own"⟩,
   ⟨"revoke-alias-bad-token", .revokeAlias, "bad-token", "owner", "none", "own"⟩,
   ⟨"revoke-alias-already", .revokeAlias, "already-revoked", "owner", "none", "own"⟩,
   ⟨"revoke-alias-token-missing", .revokeAlias, "token-not-found", "owner", "none", "own"⟩,
   ⟨"stream-bad-path", .stream, "bad-path", "owner", "none", "own"⟩,
   ⟨"stream-bad-cursor", .stream, "bad-cursor", "owner", "none", "own"⟩,
   ⟨"stream-missing", .stream, "missing", "owner", "none", "own"⟩,
   ⟨"stream-open-null", .stream, "stream-missing", "owner", "none", "own"⟩,
   ⟨"stream-foreign", .stream, "foreign", "owner", "none", "own"⟩,
   ⟨"stream-session-mismatch", .stream, "none", "owner", "session-other", "own"⟩,
   ⟨"stream-viewer-other", .stream, "none", "viewer", "none", "other"⟩,
   ⟨"stream-role-missing", .stream, "none", "missing", "none", "own"⟩,
   ⟨"stream-run-scope-mismatch", .stream, "none", "owner", "run-other", "own"⟩,
   ⟨"interrupt-bad-path", .interrupt, "bad-path", "owner", "none", "own"⟩,
   ⟨"interrupt-missing", .interrupt, "missing", "owner", "none", "own"⟩,
   ⟨"interrupt-foreign", .interrupt, "foreign", "owner", "none", "own"⟩,
   ⟨"interrupt-viewer-other", .interrupt, "none", "viewer", "none", "other"⟩,
   ⟨"interrupt-role-missing", .interrupt, "none", "missing", "none", "own"⟩,
   ⟨"interrupt-run-scope", .interrupt, "none", "owner", "run", "own"⟩,
   ⟨"interrupt-session-scope", .interrupt, "none", "owner", "session", "own"⟩,
   ⟨"interrupt-terminal", .interrupt, "terminal", "owner", "none", "own"⟩] ++
  [⟨"interrupt-with-foreign", .interrupt, "with-foreign", "owner", "none", "own"⟩] ++
  (["invalid-limit", "invalid-cursor", "invalid-status", "invalid-agent",
    "invalid-project", "invalid-provider", "invalid-model", "invalid-from",
    "invalid-to", "invalid-date-range"].map fun fault => ⟨"list-" ++ fault, .list, fault, "owner", "none", "own"⟩)

def files : List (String × Json) :=
  [("routes.json", Vectors.file "behaviour-runs"
    "Run-route evaluation order through the real HTTP handlers" (scenarios.map vector))]

end Vectors.BehaviourRuns
