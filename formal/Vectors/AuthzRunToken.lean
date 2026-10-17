import AgentWorkspace.Authz.VisitorSession
import AgentWorkspace.Theorems.Refinement.AuthzRunToken
import Vectors.Common

namespace Vectors.AuthzRunToken

open Lean AgentWorkspace AgentWorkspace.Authz.RunToken

private def t (tier name : String) : String :=
  "AgentWorkspace.Theorems." ++ tier ++ ".AuthzRunToken." ++ name

private def subject : Subject :=
  { runId := "run-a", sessionId := "session", workspaceId := "workspace", agentId := "agent",
    modelConnectionId := "connection" }

private def claims (id : String := "token") (expiry : Int := 400) : Claims :=
  { toSubject := subject, version := 1, tokenId := id, issuedAt := 100, expiresAt := expiry }

private def claimsJson (c : Claims) : Json := Json.mkObj
  [("version", toJson c.version), ("tokenId", toJson c.tokenId),
   ("runId", toJson c.runId), ("sessionId", toJson c.sessionId),
   ("workspaceId", toJson c.workspaceId), ("agentId", toJson c.agentId),
   ("modelConnectionId", toJson c.modelConnectionId),
   ("issuedAt", toJson c.issuedAt), ("expiresAt", toJson c.expiresAt)]

private def claimBody : JValue := .obj
  [("version", .num 1 0), ("tokenId", .str "token"), ("runId", .str "run-a"),
   ("sessionId", .str "session"), ("workspaceId", .str "workspace"),
   ("agentId", .str "agent"), ("modelConnectionId", .str "connection"),
   ("issuedAt", .num 100 0), ("expiresAt", .num 400 0)]

private def replaceField (body : JValue) (name : String) (value : JValue) : JValue :=
  match body with
  | .obj fs => .obj (fs.filter (·.1 != name) ++ [(name, value)])
  | other => other

private def claimVector (id : String) (body : JValue) : Vector :=
  { id := "claims/" ++ id, input := body.toJson,
    expected := Json.mkObj [("accepted", toJson (claimsShape body))],
    witnesses := [t "WellFormed" "claims_codec_roundtrip",
      t "WellFormed" "claims_refuse_unknown_key",
      t "WellFormed" "claims_refuse_unsafe_issued_at"] }

def claimVectors : List Vector :=
  [claimVector "valid" claimBody,
   claimVector "unknown-key" (match claimBody with
     | .obj fs => .obj (fs ++ [("extra", .bool true)])
     | other => other),
   claimVector "equal-expiry" (replaceField claimBody "expiresAt" (.num 100 0)),
   claimVector "blank-token-id" (replaceField claimBody "tokenId" (.str " \t")),
   claimVector "wrong-version" (replaceField claimBody "version" (.num 2 0)),
   claimVector "unsafe-issued" (replaceField claimBody "issuedAt" (.num (-9007199254740992) 0)),
   claimVector "missing-run" (match claimBody with
     | .obj fs => .obj (fs.filter (·.1 != "runId"))
     | other => other)]

private def subjectJson (s : Subject) : Json := Json.mkObj
  [("runId", toJson s.runId), ("sessionId", toJson s.sessionId),
   ("workspaceId", toJson s.workspaceId), ("agentId", toJson s.agentId),
   ("modelConnectionId", toJson s.modelConnectionId)]

private def issueVector (id : String) (s : Subject) (ttl : Int) : Vector :=
  let issued := issueClaims s "token" 100 ttl
  { id := "issue/" ++ id,
    input := Json.mkObj [("subject", subjectJson s), ("now", toJson (100 : Int)),
      ("ttl", toJson ttl), ("tokenId", "token")],
    expected := Json.mkObj [("claims", issued.map claimsJson |>.getD Json.null)],
    witnesses := [t "WellFormed" "issue_uses_injected_clock", t "WellFormed" "ttl_edges"] }

private def verifyVector (id : String) (signatureValid claimsValid : Bool) (now : Int) : Vector :=
  let verdict := verifyVerdict signatureValid claimsValid (claims "token" 160) now
  let result := match verdict with
    | .invalid => "invalid"
    | .expired => "expired"
    | .valid _ => "valid"
  { id := "verify/" ++ id,
    input := Json.mkObj [("signatureValid", toJson signatureValid),
      ("claimsValid", toJson claimsValid), ("now", toJson now)],
    expected := Json.mkObj [("result", toJson result)],
    witnesses := [t "Normative" "invalid_verdict_precedes_expiry"] }

private def gatewayVector (id : String) (bearer : Bool) (verification : Verification)
    (expectedRunId : Option String) (resolution : Resolution) : Vector :=
  let decision := authenticate bearer verification expectedRunId resolution
  let (status, code) := match decision with
    | .allow => (200, "ok")
    | .deny status code => (status, code)
  let tokenState := match verification with
    | .invalid => "invalid"
    | .expired => "expired"
    | .valid _ => "valid"
  let resolved := match resolution with
    | .active => "active"
    | .revoked => "revoked"
    | .deleted => "deleted"
    | .missing => "missing"
  { id := "gateway/" ++ id,
    input := Json.mkObj [("bearer", toJson bearer), ("tokenState", toJson tokenState),
      ("expectedRunId", expectedRunId.map toJson |>.getD Json.null),
      ("resolution", toJson resolved)],
    expected := Json.mkObj [("status", toJson status), ("code", toJson code),
      ("body", if status = 200 then Json.null else (gatewayEnvelope code).toJson)],
    witnesses := [t "Normative" "gateway_error_order"] }

def issueVectors : List Vector :=
  [issueVector "default" subject 300,
   issueVector "minimum" subject 1,
   issueVector "maximum" subject 3600,
   issueVector "zero-ttl" subject 0,
   issueVector "over-ttl" subject 3601,
   issueVector "blank-run" { subject with runId := " \t" } 300]

def verifyVectors : List Vector :=
  [verifyVector "before-expiry" true true 159,
   verifyVector "at-expiry" true true 160,
   verifyVector "after-expiry" true true 161,
   verifyVector "tampered" false true 159,
   verifyVector "invalid-claims" true false 159,
   verifyVector "tampered-and-expired" false true 160,
   verifyVector "invalid-claims-and-expired" true false 160]

def gatewayVectors : List Vector :=
  [gatewayVector "missing-bearer" false (.valid claims) (some "other") .revoked,
   gatewayVector "invalid" true .invalid (some "other") .revoked,
   gatewayVector "expired" true .expired (some "other") .revoked,
   gatewayVector "revoked" true (.valid claims) (some "run-a") .revoked,
   gatewayVector "deleted" true (.valid claims) (some "run-a") .deleted,
   gatewayVector "missing-run" true (.valid claims) (some "run-a") .missing,
   gatewayVector "active" true (.valid claims) (some "run-a") .active]

private def browserVector (id : String) (input : BrowserResolutionInput) : Vector :=
  let scope := match input.scope with | .run => "run" | .session => "session"
  { id, input := Json.mkObj [("scope", toJson scope),
      ("tokenFound", toJson input.tokenFound),
      ("workspaceFound", toJson input.workspaceFound),
      ("targetFound", toJson input.targetFound),
      ("runTerminal", toJson input.runTerminal),
      ("sessionArchived", toJson input.sessionArchived),
      ("minterFound", toJson input.minterFound)],
    expected := Json.mkObj [("current", toJson (browserCurrent input)),
      ("readTarget", toJson (browserReadTarget input))],
    witnesses := [t "Refinement" "current_refines_read_target",
      t "Refinement" "terminal_run_read_diverges"] }

def browserVectors : List Vector :=
  let base : BrowserResolutionInput :=
    { scope := .run, tokenFound := true, workspaceFound := true, targetFound := true,
      runTerminal := false, sessionArchived := false, minterFound := true }
  [browserVector "live-run" base,
   browserVector "terminal-run" { base with runTerminal := true },
   browserVector "active-session" { base with scope := .session },
   browserVector "archived-session" { base with scope := .session, sessionArchived := true }]

/-! ## The tool route (ADR-0113 C16) -/

section ToolRoute

open AgentWorkspace.Behaviour.GatewayIngress

private def toolWorkspace : String := "22222222-2222-4222-8222-222222222222"
private def runConnector : String := "66666666-6666-4666-8666-666666666666"
private def otherRunConnector : String := "77777777-7777-4777-8777-777777777777"

private inductive ToolTokenCell where
  | missing | invalid | expired | valid
  deriving DecidableEq

private inductive ToolRunCell where
  | none | live | terminal
  deriving DecidableEq

private inductive ToolConnectorCell where
  | inRun | notInRun | foreign | disabled | postgres
  deriving DecidableEq

private def toolTokenWire : ToolTokenCell → String
  | .missing => "missing" | .invalid => "invalid" | .expired => "expired" | .valid => "valid"

private def toolRunWire : ToolRunCell → String
  | .none => "none" | .live => "live" | .terminal => "terminal"

private def toolConnectorWire : ToolConnectorCell → String
  | .inRun => "in-run" | .notInRun => "not-in-run" | .foreign => "foreign"
  | .disabled => "disabled" | .postgres => "postgres"

private def toolRunOf : ToolRunCell → Option ToolRun
  | .none => Option.none
  | .live => some ⟨false, [runConnector]⟩
  | .terminal => some ⟨true, [runConnector]⟩

/-- The connector id the call names, and the facts the resolver reads of it. -/
private def toolConnectorOf : ToolConnectorCell → String × ToolConnector
  | .inRun => (runConnector, ⟨toolWorkspace, .openapi, true⟩)
  | .notInRun => (otherRunConnector, ⟨toolWorkspace, .openapi, true⟩)
  | .foreign => (runConnector, ⟨"88888888-8888-4888-8888-888888888888", .openapi, true⟩)
  | .disabled => (runConnector, ⟨toolWorkspace, .openapi, false⟩)
  | .postgres => (runConnector, ⟨toolWorkspace, .postgres, true⟩)

private def toolKindWire : ToolKind → String
  | .openapi => "openapi" | .postgres => "postgres"

private def toolVector (token : ToolTokenCell) (active : Bool) (runCell : ToolRunCell)
    (connectorCell : ToolConnectorCell) : Vector :=
  let (connectorId, connector) := toolConnectorOf connectorCell
  let verification : Verification := match token with
    | .invalid => .invalid
    | .expired => .expired
    | .missing | .valid => .valid (claims "token")
  let run := toolRunOf runCell
  let decision := toolDecision (token != .missing) verification active run (some connector)
    toolWorkspace connectorId
  let (status, code) := match decision with
    | .allow => (200, "ok")
    | .deny status code => (status, code)
  { id := "tools/" ++ toolTokenWire token ++ "/" ++ (if active then "active" else "inactive") ++
      "/" ++ toolRunWire runCell ++ "/" ++ toolConnectorWire connectorCell,
    input := Json.mkObj [("tokenState", toJson (toolTokenWire token)),
      ("tokenActive", toJson active),
      ("run", match run with
        | Option.none => Json.null
        | some r => Json.mkObj [("terminal", toJson r.terminal),
            ("toolConnectorIds", toJson r.toolConnectorIds)]),
      ("connector", Json.mkObj [("workspaceId", toJson connector.workspaceId),
        ("kind", toJson (toolKindWire connector.kind)), ("enabled", toJson connector.enabled)]),
      ("workspaceId", toJson toolWorkspace), ("connectorId", toJson connectorId)],
    expected := Json.mkObj [("status", toJson status), ("code", toJson code)],
    witnesses :=
      match token with
      | .missing | .invalid | .expired =>
        [t "Adversarial" "tool_decision_matches_authenticate_before_the_registry"]
      | .valid =>
        if !active || runCell != .live then [t "Adversarial" "ended_run_token_refused"]
        else match connectorCell with
        | .inRun => [t "Adversarial" "tool_call_has_allow_witness"]
        | .notInRun => [t "Adversarial" "run_a_token_cannot_reach_run_b_connector"]
        | .foreign => [t "Adversarial" "foreign_workspace_connector_refused"]
        | .disabled => [t "Adversarial" "disabled_connector_refused"]
        | .postgres => [t "Adversarial" "postgres_connector_refused_until_its_executor"] }

def toolVectors : List Vector := Id.run do
  let mut out := []
  for token in [ToolTokenCell.missing, .invalid, .expired, .valid] do
    for active in [true, false] do
      for runCell in [ToolRunCell.none, .live, .terminal] do
        for connectorCell in [ToolConnectorCell.inRun, .notInRun, .foreign, .disabled,
            .postgres] do
          out := out ++ [toolVector token active runCell connectorCell]
  return out

end ToolRoute

/-! ## An anonymous visitor's session token (issue #622) -/

section Visitor

open AgentWorkspace.Authz.VisitorSession AgentWorkspace.Authz.Resources
  AgentWorkspace.Authz.Permissions

/-- The routes a visitor's token may present: the three of its grammar and some outside it, each
as `(id, method, path, request cell)`. `R` is a run of the target session, `A` an agent. -/
private def visitorRoutes : List (String × String × String × Request) :=
  let cell (resource : Resource) (op : Operation) (sub pathId : Option String) : Request :=
    { resource, op, sub, pathId, sessionId := none }
  [("read-run", "GET", "/api/runs/R", cell .runs .read none (some "R")),
   ("run-events", "GET", "/api/runs/R/events", cell .runs .read (some "events") (some "R")),
   ("turn", "POST", "/api/agents/A/runs", cell .agents .run (some "runs") (some "A")),
   ("feedback", "POST", "/api/runs/R/feedback", cell .runs .run (some "feedback") (some "R")),
   ("interrupt", "POST", "/api/runs/R/interrupt", cell .runs .run (some "interrupt") (some "R")),
   ("list-runs", "GET", "/api/runs", cell .runs .read none none),
   ("read-agent", "GET", "/api/agents/A", cell .agents .read none (some "A"))]

private def visitorScope : String := "session-s"

private def visitorVector (route : String × String × String × Request)
    (target : Option String) : Vector :=
  let (name, method, path, req) := route
  let req := { req with sessionId := target }
  let decision := visitorDecision (.session ⟨visitorScope⟩) req
  { id := "visitor/" ++ name ++ "/" ++ (match target with
      | Option.none => "no-session"
      | some s => if s == visitorScope then "own-session" else "other-session"),
    input := Json.mkObj [("method", toJson method), ("path", toJson path),
      ("scopeSessionId", toJson visitorScope), ("sessionId", toJson target)],
    expected := Json.mkObj [("decision", toJson (match decision with
      | .proceed => "proceed"
      | .deny _ code => code)),
      ("status", match decision with
        | .proceed => Json.null
        | .deny status _ => toJson status)],
    witnesses :=
      if target != some visitorScope then [t "Adversarial" "visitor_token_reaches_only_its_session"]
      else [t "Adversarial" "visitor_token_proceeds_only_inside_its_grammar"] }

def visitorVectors : List Vector :=
  visitorRoutes.flatMap fun route =>
    [some visitorScope, some "session-other", Option.none].map (visitorVector route)

private def openModeWire : OpenMode → String
  | .page => "page"
  | .session => "session"

/-- `sameOrigin` means the request's `Origin` is this origin's own, so the vector's `origin` is
only read when it is `false`. -/
private def openVector (loopback sameOrigin : Bool) (allowed : List String)
    (origin : Option String) (mode : OpenMode) : Vector :=
  let verdict := openVerdict loopback sameOrigin allowed origin mode
  let (name, cors) : String × Option String := match verdict with
    | .loopback => ("loopback", Option.none)
    | .allowedOrigin c => ("allowed-origin", c)
    | .refused => ("refused", Option.none)
  { id := "open/" ++ openModeWire mode ++ "/" ++ (if loopback then "loopback" else "remote") ++
      "/" ++ (if sameOrigin then "same-origin" else "cross-origin") ++ "/" ++
      (if allowed.isEmpty then "no-list" else "listed") ++ "/" ++
      (match origin with | Option.none => "no-origin" | some o => o),
    input := Json.mkObj [("loopback", toJson loopback), ("sameOrigin", toJson sameOrigin),
      ("allowedOrigins", toJson allowed), ("origin", toJson origin),
      ("mode", toJson (openModeWire mode))],
    expected := Json.mkObj [("verdict", toJson name), ("corsOrigin", toJson cors)],
    witnesses :=
      match verdict with
      | .allowedOrigin (some _) =>
        [t "Adversarial" "cross_origin_visitor_opens_only_from_an_allowed_origin"]
      | _ =>
        if !loopback && !sameOrigin && mode == .session &&
            (origin == Option.none || origin == some "null") then
          [t "Adversarial" "missing_origin_never_opens_a_session"]
        else [] }

def openVectors : List Vector := Id.run do
  let mut out := []
  for mode in [OpenMode.page, .session] do
    for loopback in [true, false] do
      for allowed in [([] : List String), ["https://host.example"]] do
        out := out ++ [openVector loopback true allowed Option.none mode]
        for origin in [Option.none, some "null", some "https://host.example",
            some "https://other.example"] do
          out := out ++ [openVector loopback false allowed origin mode]
  return out

end Visitor

def files : List (String × Json) :=
  [("claims.json", file "authz-run-token" "Strict signed run-token claims schema" claimVectors),
   ("issue.json", file "authz-run-token" "Run token issuance inputs and claims" issueVectors),
   ("verify.json", file "authz-run-token" "Signature, claims and expiry precedence" verifyVectors),
   ("gateway.json", file "authz-run-token" "Gateway authentication errors in evaluation order"
    gatewayVectors),
   ("browser.json", file "authz-run-token" "Browser token current and documented read behavior"
    browserVectors),
   ("tools.json", file "authz-run-token"
    "Tool-route authorisation (C16): token, registry, run and connector cells in evaluation order"
    toolVectors),
   ("visitor.json", file "authz-run-token"
    "A visitor's session-scoped token: the scope grammar, then the session match (issue #622)"
    visitorVectors),
   ("open.json", file "authz-run-token"
    "mayOpenSession: the loopback branch, then the allowed-origin branch (issue #622)"
    openVectors)]

end Vectors.AuthzRunToken
