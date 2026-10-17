import AgentWorkspace.Theorems.Adversarial.AdversarialRunsAccess
import Vectors.Common

namespace Vectors.AdversarialRunsAccess

open Lean AgentWorkspace.Behaviour.Runs

structure Scenario where
  id : String
  route : Route
  target : String := "run-a"
  role : String := "owner"
  scope : String := "none"
  condition : String := "own"

def routeName : Route → String
  | .start => "start" | .list => "list" | .read => "read"
  | .revokeAlias => "revoke-alias" | .revoke => "revoke"
  | .stream => "stream" | .interrupt => "interrupt"

def principal (c : Scenario) : Principal :=
  let scope := match c.scope with
    | "run" => some (AgentWorkspace.Concepts.BrowserToken.Scope.run ⟨"run-a"⟩)
    | "session" => some (AgentWorkspace.Concepts.BrowserToken.Scope.session ⟨"session-a"⟩)
    | _ => none
  { id := "member-a", workspaceId := "workspace-a", role := c.role, scope }

def state (c : Scenario) : State :=
  let own : RunRow :=
    { id := "run-a", workspaceId := "workspace-a", ownerId := "member-a",
      sessionId := "session-a" }
  let target : RunRow :=
    { id := "run-b",
      workspaceId := if c.condition == "foreign" then "workspace-b" else "workspace-a",
      ownerId := if c.condition == "other-owner" then "member-b" else "member-a",
      sessionId := "session-b" }
  { runs := [own, target] }

def request (c : Scenario) : Request :=
  let r : Request :=
    { route := c.route,
      id := if c.route == .start then "agent-a" else c.target,
      ownership := if c.condition == "other-owner" then .other else .own,
      newRunId := "new-run", newSessionId := "session-a",
      sessionId := if c.condition == "foreign-session" then some "session-b"
        else if c.scope == "session" then some "session-a" else none }
  match c.condition with
  | "foreign-agent" => { r with agentFound := false }
  | "foreign-session" => { r with sessionUsable := false }
  | _ => r

def witness (c : Scenario) : String :=
  if c.scope == "session" && c.route == .start && c.condition == "foreign-session" then
    "AgentWorkspace.Theorems.Adversarial.AdversarialRunsAccess.session_browser_scope_rejects_other_session"
  else if c.scope == "session" && c.route == .start then
    "AgentWorkspace.Theorems.Adversarial.AdversarialRunsAccess.session_browser_scope_grammar"
  else if c.condition == "foreign-agent" || c.condition == "foreign-session" then
    "AgentWorkspace.Theorems.Normative.BehaviourRuns.start_problem_codes"
  else if c.route == .revoke && (c.role == "builder" || c.role == "viewer") then
    "AgentWorkspace.Theorems.Adversarial.AdversarialRunsAccess.builder_viewer_revoke_denied"
  else if c.route == .list && c.condition == "foreign" then
    "AgentWorkspace.Theorems.Adversarial.AdversarialRunsAccess.foreign_row_fails_list_postcondition"
  else if c.route == .list && c.condition == "other-owner" then
    "AgentWorkspace.Theorems.Normative.BehaviourRuns.list_forces_owner"
  else if c.condition == "foreign" then
    "AgentWorkspace.Theorems.Adversarial.AdversarialRunsAccess.foreign_named_route_search_has_no_success"
  else if c.condition == "other-owner" then
    "AgentWorkspace.Theorems.Normative.BehaviourRuns.read_problem_codes"
  else
    "AgentWorkspace.Theorems.Normative.BehaviourRuns.scoped_problem_codes"

def vector (c : Scenario) : Vectors.Vector :=
  let out := step (state c) (principal c) (request c)
  { id := c.id,
    input := Json.mkObj [("route", toJson (routeName c.route)),
      ("target", toJson c.target), ("role", toJson c.role),
      ("scope", toJson c.scope), ("condition", toJson c.condition)],
    expected := Json.mkObj [("status", toJson out.reply.status),
      ("code", toJson out.reply.code),
      ("ownerFilter", toJson out.reply.ownerFilter)],
    witnesses := [witness c] }

def scenarios : List Scenario :=
  [ ⟨"foreign-read", .read, "run-b", "owner", "none", "foreign"⟩,
    ⟨"foreign-stream", .stream, "run-b", "owner", "none", "foreign"⟩,
    ⟨"foreign-interrupt", .interrupt, "run-b", "owner", "none", "foreign"⟩,
    ⟨"foreign-revoke", .revoke, "run-b", "owner", "none", "foreign"⟩,
    ⟨"foreign-revoke-alias", .revokeAlias, "run-b", "owner", "none", "foreign"⟩,
    ⟨"foreign-agent-start", .start, "run-a", "owner", "none", "foreign-agent"⟩,
    ⟨"foreign-session-start", .start, "run-a", "owner", "none", "foreign-session"⟩,
    ⟨"foreign-list", .list, "run-b", "owner", "none", "foreign"⟩,
    ⟨"builder-other-read", .read, "run-b", "builder", "none", "other-owner"⟩,
    ⟨"viewer-other-stream", .stream, "run-b", "viewer", "none", "other-owner"⟩,
    ⟨"builder-other-interrupt", .interrupt, "run-b", "builder", "none", "other-owner"⟩,
    ⟨"viewer-other-revoke", .revoke, "run-b", "viewer", "none", "other-owner"⟩,
    ⟨"builder-own-revoke", .revoke, "run-a", "builder", "none", "own"⟩,
    ⟨"viewer-own-revoke", .revoke, "run-a", "viewer", "none", "own"⟩,
    ⟨"builder-list", .list, "run-b", "builder", "none", "other-owner"⟩,
    ⟨"viewer-list", .list, "run-b", "viewer", "none", "other-owner"⟩,
    ⟨"run-scope-own-read", .read, "run-a", "owner", "run", "own"⟩,
    ⟨"run-scope-other-read", .read, "run-b", "owner", "run", "own"⟩,
    ⟨"run-scope-list", .list, "run-a", "owner", "run", "own"⟩,
    ⟨"run-scope-revoke", .revoke, "run-a", "owner", "run", "own"⟩,
    ⟨"session-scope-own-read", .read, "run-a", "owner", "session", "own"⟩,
    ⟨"session-scope-start", .start, "run-a", "owner", "session", "own"⟩,
    ⟨"session-scope-foreign-start", .start, "run-a", "owner", "session", "foreign-session"⟩,
    ⟨"session-scope-other-read", .read, "run-b", "owner", "session", "own"⟩,
    ⟨"session-scope-list", .list, "run-a", "owner", "session", "own"⟩ ]

def files : List (String × Json) :=
  [("access.json", Vectors.file "adversarial-runs-access"
    "Run access attacks against the real handlers" (scenarios.map vector))]

end Vectors.AdversarialRunsAccess
