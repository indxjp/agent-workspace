import AgentWorkspace.Authz.Surface
import AgentWorkspace.Authz.TokenScope

/-!
# `decide()` — the authorisation decision function

`apps/web/server/rbac/decide.ts`, whole. A query is a role (as an untyped string), an HTTP method
(any string), a path in the specification's notation, an ownership fact the handler established
and an optional browser-token scope. The answer is `allow` or `deny` (decisions, with the route
facts when §21's table was consulted) or `refuse` (no decision could be made; the handler answers
`500 authorisation_undecidable`). The evaluation order is observable and modelled exactly:

1. `parseRole` — an unrecognised role is refused (ADR-0015), never downgraded;
2. `classifyPath` — `public` is allowed with no facts, `page` is refused;
3. `parsePath` — `/api/<resource>[/:id[/<sub>]]` (ADR-0026 decision 3); an unknown resource, an
   unclassified sub-resource or a deeper path is refused, never given the parent's grant;
4. `POST` on a named run or its `revoke-tokens` subroute uses the dedicated revoke capability;
5. otherwise, `parseOperation` maps the method to read, run or write;
6. `checkTokenScope` denies a scoped query outside its grammar;
7. `grantsFor(role, resource)[operation]` and `applyGrant` handle ordinary routes.

`decideOrdinary` isolates the unchanged three-operation policy branch for its table theorems.
The revoke branch is proved separately and linked to the handler's observable role gate.
-/

namespace AgentWorkspace.Authz.Decide

open AgentWorkspace AgentWorkspace.Concepts.Membership AgentWorkspace.Concepts.BrowserToken
  AgentWorkspace.Authz.Roles AgentWorkspace.Authz.Resources AgentWorkspace.Authz.Permissions
  AgentWorkspace.Authz.TokenScope AgentWorkspace.Authz.Surface

/-- `Ownership`: whose row is being acted on, as far as the handler could tell. -/
@[aw_spec (ts := "apps/web/server/rbac/decide.ts#OWNERSHIPS")
  (doc := "docs/adr/W9-AUTH-117-viewer-permitted-agent-grants.md#decision")]
inductive Ownership where
  | own | other | unknown | notApplicable | permitted
  deriving DecidableEq, Repr, Inhabited

/-- The TypeScript spelling of an ownership answer. -/
def Ownership.toWire : Ownership → String
  | .own => "own" | .other => "other" | .unknown => "unknown"
  | .notApplicable => "not-applicable" | .permitted => "permitted"

instance : WireEnum Ownership where
  all := [.own, .other, .unknown, .notApplicable, .permitted]
  toWire := Ownership.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by
    intro a b h
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-- `METHODS`: the methods a Next.js route handler may export, in `decide.ts` order. -/
@[aw_spec (ts := "apps/web/server/rbac/decide.ts#METHODS")]
def methods : List String := ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]

/-! ## The path grammar -/

/-- `ParsedPath`: a path parsed against §34's shape, or which clause rejected it. -/
inductive ParsedPath where
  | ok (resource : Resource) (sub : Option String) (id : Option String)
  /-- It does not begin `/api/<resource>`. -/
  | notApiShape
  /-- The resource segment is not one of `RESOURCES`. -/
  | unknownResource (segment : String)
  /-- The sub segment is not classified under the resource. -/
  | unclassifiedSub (resource : Resource) (segment : String)
  /-- Deeper than `/api/<resource>/:id/<sub>`. -/
  | tooDeep
  deriving DecidableEq, Repr

/-- `parsePath` over the `split('/')` segments. -/
def parseSegments : List String → ParsedPath
  | "" :: "api" :: seg :: rest =>
    match parseResource seg with
    | none => .unknownResource seg
    | some r =>
      match rest with
      | [] => .ok r none none
      | [id] => .ok r none (some id)
      | [id, subSeg] =>
        match parseSub r subSeg with
        | none => .unclassifiedSub r subSeg
        | some sub => .ok r (some sub) (some id)
      | _ :: _ :: _ :: _ => .tooDeep
  | _ => .notApiShape

/-- The `split('/')` segments of a path. -/
def segmentsOf (path : String) : List String := (splitSlash path.toList).map String.ofList

/-- `parsePath`: `/api/<resource>`, `/api/<resource>/:id`, `/api/<resource>/:id/<sub>`. -/
@[aw_spec (ts := "apps/web/server/rbac/decide.ts#parsePath")
  (doc := "docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md#decision")]
def parsePath (path : String) : ParsedPath := parseSegments (segmentsOf path)

/-! ## The method -/

/-- Why no operation could be derived from a method. -/
inductive MethodRefusal where
  | options
  | unknownMethod
  deriving DecidableEq, Repr, Inhabited

/-- `ParsedOperation`: an operation, or why the method yields none. -/
inductive ParsedOperation where
  | ok (op : Operation)
  | refused (m : MethodRefusal)
  deriving DecidableEq, Repr

/-- The sub-resources whose `POST` is §21's `run` verb. -/
def runSubs : List String := ["runs", "messages", "interrupt", "feedback"]

/-- `parseOperation`: a method and a sub-resource, as an operation. -/
@[aw_spec (ts := "apps/web/server/rbac/decide.ts#parseOperation")
  (doc := "docs/adr/SDK-03-RUN-235-an-interrupt-is-a-control-plane-transition.md#decision")]
def parseOperation (method : String) (sub : Option String) : ParsedOperation :=
  if method = "POST" ∧ (sub.map runSubs.contains).getD false = true then .ok .run
  else if method = "GET" ∨ method = "HEAD" then .ok .read
  else if method = "POST" ∨ method = "PUT" ∨ method = "PATCH" ∨ method = "DELETE" then .ok .write
  else if method = "OPTIONS" then .refused .options
  else .refused .unknownMethod

/-- Whether any path can reach `op` on `resource`: `read` and `write` always (`GET`, `POST`, …),
`run` only through a `POST` on one of the resource's run sub-resources. -/
def opReachable (resource : Resource) : Operation → Bool
  | .run => (subResources resource).any runSubs.contains
  | _ => true

/-- Two grant triples agree on every operation a path can reach for `resource`. -/
def agreeOnReachable (resource : Resource) (a b : Grants) : Bool :=
  [Operation.read, .write, .run].all fun op => !opReachable resource op || a.get op == b.get op

/-! ## Grants against ownership -/

/-- `applyGrant`: whether a grant of this width admits a row of this ownership. -/
@[aw_spec (ts := "apps/web/server/rbac/decide.ts#applyGrant")
  (doc := "docs/adr/W9-AUTH-117-viewer-permitted-agent-grants.md#decision")
  (doc := "docs/adr/0031-a-static-gate-cannot-be-complete-so-undecidable-must-mean-refused.md#decision")]
def applyGrant : Grant → Ownership → Bool
  | .any, _ => true
  | .own, .own => true
  | .own, .notApplicable => true
  | .own, _ => false
  | .permitted, .permitted => true
  | .permitted, _ => false
  | .none, _ => false

/-! ## The decision -/

/-- `AuthorisationQuery`. The role is the raw runtime value; `scope` is `null` for every
credential but a browser token. -/
@[aw_spec (ts := "apps/web/server/rbac/decide.ts#AuthorisationQuery")]
structure Query where
  role : RoleInput
  method : String
  path : String
  ownership : Ownership
  scope : Option Scope

/-- The revoke capability is local to `decide()` and is not a cell of the shared policy table. -/
inductive RouteOperation where
  | read | write | run | revoke
  deriving DecidableEq, Repr

def RouteOperation.ofOperation : Operation → RouteOperation
  | .read => .read | .write => .write | .run => .run

def RouteOperation.toWire : RouteOperation → String
  | .read => "read" | .write => "write" | .run => "run" | .revoke => "revoke"

/-- `RouteFacts`: what the route turned out to be. -/
structure RouteFacts where
  resource : Resource
  operation : RouteOperation
  grant : Grant
  deriving DecidableEq, Repr

/-- Why `decide()` refused: the step at which no decision could be made. -/
inductive RefuseReason where
  | unknownRole
  | pageSurface
  | path (p : ParsedPath)
  | method (m : MethodRefusal)
  deriving DecidableEq, Repr

/-- `Decision`: `allow` and `deny` are decisions; `refuse` is the absence of one. A `deny` whose
`scopeDenial` is set carries the code `token_out_of_scope`; otherwise the renderer's default
`forbidden`. -/
@[aw_spec (ts := "apps/web/server/rbac/decide.ts#Decision")]
inductive Decision where
  | allow (facts : Option RouteFacts)
  | deny (facts : Option RouteFacts) (scopeDenial : Option ScopeDenial)
  | revokeDeny (facts : RouteFacts)
  | refuse (reason : RefuseReason)
  deriving DecidableEq, Repr

/-- The three effects. -/
inductive Effect where
  | allow | deny | refuse
  deriving DecidableEq, Repr, Inhabited

/-- The effect of a decision. -/
def Decision.effect : Decision → Effect
  | .allow _ => .allow
  | .deny _ _ => .deny
  | .revokeDeny _ => .deny
  | .refuse _ => .refuse

/-- The code a deny carries (`decision.code`), if any. -/
def Decision.code : Decision → Option String
  | .deny _ (some _) => some "token_out_of_scope"
  | .revokeDeny _ => some "run_token_revoke_forbidden"
  | _ => none

/-- The facts a decision carries (`refuse` carries none). -/
def Decision.facts : Decision → Option RouteFacts
  | .allow f => f
  | .deny f _ => f
  | .revokeDeny f => some f
  | .refuse _ => none

/-- The decision once the route is classified: scope first, then the grant. -/
def decideClassified (role : Role) (q : Query) (resource : Resource) (sub : Option String)
    (id : Option String) (op : Operation) : Decision :=
  match q.scope.bind (fun s => checkTokenScope s resource op sub id) with
  | some denial => .deny none (some denial)
  | none =>
    let grant := grantFor role resource op
    let facts : RouteFacts := ⟨resource, RouteOperation.ofOperation op, grant⟩
    if applyGrant grant q.ownership then .allow (some facts) else .deny (some facts) none

/-- The shared three-operation policy path used for ordinary routes. -/
def decideOrdinary (q : Query) : Decision :=
  match parseRoleInput q.role with
  | none => .refuse .unknownRole
  | some role =>
    match classifyPath q.path with
    | .«public» => .allow none
    | .page => .refuse .pageSurface
    | .api =>
      match parsePath q.path with
      | .ok resource sub id =>
        match parseOperation q.method sub with
        | .refused m => .refuse (.method m)
        | .ok op => decideClassified role q resource sub id op
      | p => .refuse (.path p)

/-- `decide`: a dedicated revoke capability precedes the ordinary operation table. -/
@[aw_spec (ts := "apps/web/server/rbac/decide.ts#decide") (doc := "docs/sdk/04-api-specification.md#33-roles")]
def decideAuth (q : Query) : Decision :=
  match parseRoleInput q.role with
  | none => .refuse .unknownRole
  | some role =>
    match classifyPath q.path with
    | .api =>
      match parsePath q.path with
      | .ok .runs sub (some _) =>
        if q.method == "POST" && (sub.isNone || sub == some "revoke-tokens") then
          if q.scope.isSome then .deny none (some .revoke)
          else
            let grant := if role == .owner || role == .admin then Grant.any else Grant.none
            let facts : RouteFacts := ⟨.runs, .revoke, grant⟩
            if grant == .any then .allow (some facts) else .revokeDeny facts
        else decideOrdinary q
      | _ => decideOrdinary q
    | _ => decideOrdinary q

/-! ## The reduced revoke role predicate -/

/-- The role predicate of the dedicated revoke decision: after the scope refusal, only `owner`
and `admin` pass (`403 run_token_revoke_forbidden` otherwise). -/
@[aw_spec (ts := "apps/web/server/runs/api.ts#revokeRunTokens")
  (doc := "docs/sdk/04-api-specification.md#512-runs-and-the-event-stream--awruns")]
def revokeTokensRoleGate (role : RoleInput) : Bool := role == "owner" || role == "admin"

/-! ## The declared route inventory

`tests/route-declarations/*.ts` is the union every route handler must be declared in
(ADR-0025); `authorisation-matrix.test.ts` crosses it with the four roles and the five ownership
answers and fails on any `refuse`, except for the fourteen pre-authentication routes and the nine
identity-only routes it exempts by name. The union is transcribed here, file by file in
`git ls-files` order; the conformance suite checks the transcription against the live union in
both directions. -/

/-- One declared route: the declaring task, the method and the path in specification notation. -/
structure DeclaredRoute where
  owner : String
  method : String
  path : String
  deriving DecidableEq, Repr

/-- The declared route union (155 routes). -/
@[aw_spec (ts := "tests/inventory-support.ts#readDeclarationFiles")
  (ts := "apps/web/server/rbac/authorisation-matrix.test.ts#declaredRoutes")]
def declaredRoutes : List DeclaredRoute :=
  [ ⟨"DJ-80-08-PROMOTE-ROLLBACK-615", "POST", "/api/agents/:id/promote"⟩,
    ⟨"DJ-80-08-PROMOTE-ROLLBACK-615", "POST", "/api/agents/:id/rollback"⟩,
    ⟨"DJ-80-11-EVALUATIONS-618", "POST", "/api/agents/:id/evaluations"⟩,
    ⟨"DJ-80-11-EVALUATIONS-618", "GET", "/api/agents/:id/evaluation-runs"⟩,
    ⟨"DJ-80-11-EVALUATIONS-618", "POST", "/api/agents/:id/evaluation-runs"⟩,
    ⟨"DJ-80-11-EVALUATIONS-618", "POST", "/api/agents/:id/evaluation-advance"⟩,
    ⟨"DJ-80-13-FEEDBACK-LIST-620", "GET", "/api/agents/:id/feedback"⟩,
    ⟨"DJ-B2B-TOOL-BUNDLES-790", "POST", "/api/tool-bundles"⟩,
    ⟨"DJ-B2B-TOOL-BUNDLES-790", "GET", "/api/tool-bundles/:digest"⟩,
    ⟨"DJ-S1-05-AGENT-VERSIONS-443", "GET", "/api/agents/:id/versions"⟩,
    ⟨"DJ-S1-05-AGENT-VERSIONS-443", "POST", "/api/agents/:id/versions"⟩,
    ⟨"DJ-S1-06-AGENT-POINTERS-444", "PUT", "/api/agents/:id/pointers"⟩,
    ⟨"DJ-S1-17-SURFACE-PAGE-455", "GET", "/p/s/:name"⟩,
    ⟨"DJ-S1-17-SURFACE-PAGE-455", "POST", "/p/s/:name/sessions"⟩,
    ⟨"DJ-S1-18-WIDGET-LOADER-456", "GET", "/p/s/:name/widget.js"⟩,
    ⟨"DJ-S1-18-WIDGET-LOADER-456", "GET", "/p/s/:name/try"⟩,
    ⟨"DJ-S2-05C-RUN-FEEDBACK-539", "POST", "/api/runs/:id/feedback"⟩,
    ⟨"E5-VERCEL-CRON-830", "GET", "/api/cron/retention"⟩,
    ⟨"ENG-02C-ENGINES-319", "GET", "/api/engines"⟩,
    ⟨"ENG-06-SESSION-STATE-305", "GET", "/api/sessions/:engineSessionId/state-entries"⟩,
    ⟨"ENG-06-SESSION-STATE-305", "POST", "/api/sessions/:engineSessionId/state-entries"⟩,
    ⟨"ENG-06-SESSION-STATE-305", "PUT", "/api/sessions/:engineSessionId/state-entries"⟩,
    ⟨"ENG-06-SESSION-STATE-305", "DELETE", "/api/sessions/:engineSessionId/state-entries"⟩,
    ⟨"ENG-06-SESSION-STATE-305", "GET", "/api/sessions/:engineSessionId/state-streams"⟩,
    ⟨"ENG-06-SESSION-STATE-305", "GET", "/api/sessions/:engineSessionId/state-blobs"⟩,
    ⟨"ENG-06-SESSION-STATE-305", "PUT", "/api/sessions/:engineSessionId/state-blobs"⟩,
    ⟨"PT-T1A-ENDPOINT-CLIENTS", "GET", "/api/endpoint-clients"⟩,
    ⟨"PT-T1A-ENDPOINT-CLIENTS", "POST", "/api/endpoint-clients"⟩,
    ⟨"PT-T1A-ENDPOINT-CLIENTS", "GET", "/api/endpoint-clients/:id"⟩,
    ⟨"PT-T1A-ENDPOINT-CLIENTS", "PATCH", "/api/endpoint-clients/:id"⟩,
    ⟨"PT-T1A-ENDPOINT-CLIENTS", "DELETE", "/api/endpoint-clients/:id"⟩,
    ⟨"PT-T1A-ENDPOINT-CLIENTS", "POST", "/api/endpoint-clients/:id/keys"⟩,
    ⟨"PT-G1-A2A", "POST", "/api/a2a/agents/:agentName"⟩,
    ⟨"PT-G1-A2A", "GET", "/api/a2a/agents/:agentName/.well-known/agent-card.json"⟩,
    ⟨"PT-T1B-TOOL-ENDPOINT", "POST", "/mcp/projects/:name"⟩,
    ⟨"PT-T1C-OAUTH", "POST", "/api/endpoint-clients/:id/secret"⟩,
    ⟨"PT-T1C-OAUTH", "GET", "/.well-known/oauth-authorization-server"⟩,
    ⟨"PT-T1C-OAUTH", "GET", "/.well-known/oauth-protected-resource/mcp/projects/:name"⟩,
    ⟨"PT-T1C-OAUTH", "GET", "/.well-known/oauth-protected-resource/api/a2a/agents/:agentName"⟩,
    ⟨"PT-T1C-OAUTH", "GET", "/oauth/authorize"⟩,
    ⟨"PT-T1C-OAUTH", "POST", "/oauth/authorize"⟩,
    ⟨"PT-T1C-OAUTH", "POST", "/oauth/token"⟩,
    ⟨"PT-T1C-OAUTH", "POST", "/oauth/revoke"⟩,
    ⟨"PT-U5-PLATFORMS-968", "GET", "/api/platforms"⟩,
    ⟨"PT-U5-PLATFORMS-968", "POST", "/api/agents/:id/platform-exports"⟩,
    ⟨"PT-U5-PLATFORMS-968", "POST", "/api/agents/:id/platform-archives"⟩,
    ⟨"SDK-01-ME-233", "GET", "/api/me"⟩,
    ⟨"SDK-02-AGENT-POLICY-234", "GET", "/api/agents/:id/policy"⟩,
    ⟨"SDK-02-AGENT-POLICY-234", "PUT", "/api/agents/:id/policy"⟩,
    ⟨"SDK-03-RUN-CONTROL-235", "POST", "/api/runs/:id/interrupt"⟩,
    ⟨"SDK-03-RUN-CONTROL-235", "POST", "/api/runs/:id/revoke-tokens"⟩,
    ⟨"SDK-04-TOKENS-236", "POST", "/api/tokens"⟩,
    ⟨"SDK-05-AUTH-237", "GET", "/api/agents/:id/grants"⟩,
    ⟨"SDK-05-AUTH-237", "PUT", "/api/agents/:id/grants"⟩,
    ⟨"SDK-08-RESOURCES-240", "DELETE", "/api/skills/:name"⟩,
    ⟨"SDK-10-CLI-AUTH-242", "POST", "/api/auth/cli-device"⟩,
    ⟨"SDK-10-CLI-AUTH-242", "GET", "/api/auth/cli-verify"⟩,
    ⟨"SDK-10-CLI-AUTH-242", "POST", "/api/auth/cli-verify"⟩,
    ⟨"SDK-10-CLI-AUTH-242", "POST", "/api/auth/cli-token"⟩,
    ⟨"SDK-10-CLI-AUTH-242", "DELETE", "/api/auth/cli-token"⟩,
    ⟨"SDK-10-CLI-AUTH-242", "POST", "/api/auth/cli-workspace"⟩,
    ⟨"W1-CP-04", "POST", "/api/agents/:id/runs"⟩,
    ⟨"W1-CP-04", "GET", "/api/runs/:id"⟩,
    ⟨"W1-CP-04", "POST", "/api/runs/:id"⟩,
    ⟨"W1-CP-04", "GET", "/api/runs/:id/events"⟩,
    ⟨"W1-CP-05", "POST", "/api/agents"⟩,
    ⟨"W1-CP-05", "GET", "/api/agents"⟩,
    ⟨"W1-CP-05", "GET", "/api/agents/:id"⟩,
    ⟨"W1-CP-05", "PATCH", "/api/agents/:id"⟩,
    ⟨"W1-CP-05", "DELETE", "/api/agents/:id"⟩,
    ⟨"W1-CP-05", "GET", "/api/agents/:id/resources"⟩,
    ⟨"W1-CP-05", "PUT", "/api/agents/:id/resources"⟩,
    ⟨"W2-CP-02", "POST", "/api/secrets"⟩,
    ⟨"W2-CP-02", "GET", "/api/secrets"⟩,
    ⟨"W2-CP-02", "PUT", "/api/secrets/:id"⟩,
    ⟨"W2-CP-02", "DELETE", "/api/secrets/:id"⟩,
    ⟨"W2-CP-03", "GET", "/api/files"⟩,
    ⟨"W2-CP-03", "POST", "/api/files"⟩,
    ⟨"W2-CP-03", "GET", "/api/files/:id"⟩,
    ⟨"W2-CP-03", "DELETE", "/api/files/:id"⟩,
    ⟨"W2-CP-03", "PATCH", "/api/files/:id"⟩,
    ⟨"W2-CP-04", "GET", "/api/skills"⟩,
    ⟨"W2-CP-04", "POST", "/api/skills"⟩,
    ⟨"W2-CP-04", "GET", "/api/skills/:name"⟩,
    ⟨"W2-CP-04", "PATCH", "/api/skills/:name"⟩,
    ⟨"W2-CP-05", "GET", "/api/connectors"⟩,
    ⟨"W2-CP-05", "POST", "/api/connectors"⟩,
    ⟨"W2-CP-05", "GET", "/api/connectors/:id"⟩,
    ⟨"W2-CP-05", "DELETE", "/api/connectors/:id"⟩,
    ⟨"W2-CP-05", "PATCH", "/api/connectors/:id"⟩,
    ⟨"W2-CP-05", "POST", "/api/connectors/:id/test-connection"⟩,
    ⟨"W2-CP-06", "GET", "/api/users"⟩,
    ⟨"W2-CP-06", "POST", "/api/users"⟩,
    ⟨"W2-CP-06", "GET", "/api/memberships"⟩,
    ⟨"W2-CP-06", "POST", "/api/memberships"⟩,
    ⟨"W2-CP-06", "PATCH", "/api/memberships/:id"⟩,
    ⟨"W2-CP-06", "DELETE", "/api/memberships/:id"⟩,
    ⟨"W2-CP-06", "GET", "/api/api-keys"⟩,
    ⟨"W2-CP-06", "POST", "/api/api-keys"⟩,
    ⟨"W2-CP-06", "DELETE", "/api/api-keys/:id"⟩,
    ⟨"W2-CP-07", "GET", "/api/sessions"⟩,
    ⟨"W2-CP-07", "GET", "/api/sessions/:engineSessionId"⟩,
    ⟨"W2-CP-07", "PATCH", "/api/sessions/:engineSessionId"⟩,
    ⟨"W2-CP-07", "GET", "/api/sessions/:engineSessionId/transcript"⟩,
    ⟨"W2-CP-07", "POST", "/api/sessions/:engineSessionId/transcript"⟩,
    ⟨"W2-CP-07", "DELETE", "/api/sessions/:engineSessionId/transcript"⟩,
    ⟨"W2-CP-07", "GET", "/api/sessions/:engineSessionId/subkeys"⟩,
    ⟨"W3-CP-06", "GET", "/api/runtime-profiles"⟩,
    ⟨"W3-CP-06", "POST", "/api/runtime-profiles"⟩,
    ⟨"W3-CP-06", "GET", "/api/runtime-profiles/:id"⟩,
    ⟨"W3-CP-06", "PATCH", "/api/runtime-profiles/:id"⟩,
    ⟨"W3-CP-06", "DELETE", "/api/runtime-profiles/:id"⟩,
    ⟨"W3-CP-06", "GET", "/api/runtime-connections"⟩,
    ⟨"W3-CP-06", "POST", "/api/runtime-connections"⟩,
    ⟨"W3-RT-10a", "POST", "/api/runtimes/:id"⟩,
    ⟨"W4-CP-08", "GET", "/api/models"⟩,
    ⟨"W4-CP-08", "POST", "/api/model-connections"⟩,
    ⟨"W4-CP-08", "GET", "/api/model-connections/:id"⟩,
    ⟨"W4-CP-08", "PATCH", "/api/model-connections/:id"⟩,
    ⟨"W4-CP-08", "DELETE", "/api/model-connections/:id"⟩,
    ⟨"W4-CP-08", "POST", "/api/model-connections/:id/test"⟩,
    ⟨"W5-CP-02", "GET", "/api/projects"⟩,
    ⟨"W5-CP-02", "POST", "/api/projects"⟩,
    ⟨"W5-CP-02", "GET", "/api/projects/:id"⟩,
    ⟨"W5-CP-02", "PATCH", "/api/projects/:id"⟩,
    ⟨"W5-CP-02", "POST", "/api/projects/:id/sessions"⟩,
    ⟨"W5-CP-06", "POST", "/api/shares"⟩,
    ⟨"W5-CP-06", "GET", "/api/shares"⟩,
    ⟨"W5-CP-06", "DELETE", "/api/shares/:id"⟩,
    ⟨"W5-CP-06", "GET", "/p/:token"⟩,
    ⟨"W5-CP-06", "POST", "/p/:token/messages"⟩,
    ⟨"W5-CP-07", "GET", "/api/sharing-policies"⟩,
    ⟨"W5-CP-07", "PATCH", "/api/sharing-policies"⟩,
    ⟨"W6-CP-05", "GET", "/api/audit-events"⟩,
    ⟨"W6-CP-06", "GET", "/api/metrics"⟩,
    ⟨"W7-UI-04", "POST", "/api/setup"⟩,
    ⟨"W7-UI-04", "GET", "/api/setup/runtime-detect"⟩,
    ⟨"W9-AUTH-118", "GET", "/api/auth/login"⟩,
    ⟨"W9-AUTH-118", "POST", "/api/auth/callback"⟩,
    ⟨"W9-AUTH-118", "GET", "/api/auth/workspace"⟩,
    ⟨"W9-AUTH-118", "POST", "/api/auth/workspace"⟩,
    ⟨"W9-MODEL-130", "GET", "/api/model-connections"⟩,
    ⟨"W9-PROJ-183", "POST", "/api/projects/:id/archive"⟩,
    ⟨"W9-PROJ-183", "POST", "/api/projects/:id/restore"⟩,
    ⟨"W9-PROV-126", "POST", "/api/model-connections/:id/credential"⟩,
    ⟨"W9-RUNS-135", "GET", "/api/runs"⟩,
    ⟨"W9-TEAM-121", "GET", "/api/invitations"⟩,
    ⟨"W9-TEAM-121", "POST", "/api/invitations"⟩,
    ⟨"W9-TEAM-121", "POST", "/api/invitations/:id/resend"⟩,
    ⟨"W9-TEAM-121", "DELETE", "/api/invitations/:id"⟩,
    ⟨"W9-TEAM-121", "POST", "/api/invitations/:id/accept"⟩,
    ⟨"W9-WS-119", "GET", "/api/workspaces"⟩,
    ⟨"W9-WS-119", "POST", "/api/workspaces"⟩,
    ⟨"W9-WS-119", "GET", "/api/workspaces/:id"⟩,
    ⟨"W9-WS-119", "PATCH", "/api/workspaces/:id"⟩ ]

/-- `PUBLIC_ROUTES`: the pre-authentication routes the matrix exempts. -/
@[aw_spec (ts := "apps/web/server/rbac/authorisation-matrix.test.ts#PUBLIC_ROUTES")]
def matrixPublicRoutes : List (String × String) :=
  [("GET", "/api/setup/runtime-detect"), ("GET", "/api/auth/login"), ("POST", "/api/auth/callback"),
    ("GET", "/api/auth/workspace"), ("POST", "/api/auth/workspace"),
    ("POST", "/api/auth/cli-device"), ("GET", "/api/auth/cli-verify"), ("POST", "/api/auth/cli-token"),
    ("GET", "/api/cron/retention"), ("GET", "/.well-known/oauth-authorization-server"),
    ("GET", "/.well-known/oauth-protected-resource/mcp/projects/:name"),
    ("GET", "/.well-known/oauth-protected-resource/api/a2a/agents/:agentName"),
    ("POST", "/oauth/token"), ("POST", "/oauth/revoke")]

/-- `IDENTITY_ONLY_ROUTES`: the identity-proof route the matrix exempts. -/
@[aw_spec (ts := "apps/web/server/rbac/authorisation-matrix.test.ts#IDENTITY_ONLY_ROUTES")]
def matrixIdentityOnlyRoutes : List (String × String) :=
  [("POST", "/api/invitations/:id/accept"), ("POST", "/api/auth/cli-verify"),
    ("DELETE", "/api/auth/cli-token"), ("POST", "/api/auth/cli-workspace"),
    ("POST", "/api/a2a/agents/:agentName"),
    ("GET", "/api/a2a/agents/:agentName/.well-known/agent-card.json"),
    ("POST", "/mcp/projects/:name"), ("GET", "/oauth/authorize"), ("POST", "/oauth/authorize")]

/-- The routes the matrix decides: the union minus the exempt ones. -/
def matrixRoutes : List DeclaredRoute :=
  declaredRoutes.filter fun r =>
    !(matrixPublicRoutes.contains (r.method, r.path) || matrixIdentityOnlyRoutes.contains (r.method, r.path))

end AgentWorkspace.Authz.Decide
