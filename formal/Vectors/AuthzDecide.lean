import AgentWorkspace.Authz.Decide
import Vectors.Common

/-!
Vectors for the authorisation decision function (`authz-decide`), replayed against the real
`decide()`, `classifyPath`, `grantsFor`, `parseRole` and the exported lists by
`apps/web/formal/authz-decide.test.ts`:

- `enumerations.json`: `RESOURCES`, `ROLES`, `OWNERSHIPS`, `METHODS`, `TOKEN_SCOPE_KINDS`,
  `SUB_RESOURCES`;
- `policy.json`: every (role, resource) cell of `POLICY` (300 grants);
- `decide-shapes.json`: exhaustive role × every accepted path shape (25 collections, 25 rows, 17
  sub-resources) × every method plus `TRACE` × every ownership, unscoped;
- `decide-routes.json`: every declared route × role × ownership, and `route-set.json`, the
  route union and its derived facts, compared with the live declarations both ways;
- `scope.json`: every shape × method × {run, session} × {matching id, other id} × ownership for
  Owner, and the run and agent shapes for the three other roles;
- `path-grammar.json`, `methods.json`, `roles.json`, `classify-path.json`: named edge cases;
- `apply-grant.json`: the twenty `applyGrant` cells through representative queries;
- `divergences.json`: the concrete queries behind suspicious points 10, 11, 12 and 14.
-/

namespace Vectors.AuthzDecide

open Lean AgentWorkspace AgentWorkspace.Concepts.Membership AgentWorkspace.Concepts.BrowserToken
  AgentWorkspace.Authz.Roles AgentWorkspace.Authz.Resources AgentWorkspace.Authz.Permissions
  AgentWorkspace.Authz.TokenScope AgentWorkspace.Authz.Surface AgentWorkspace.Authz.Decide

private def wf (n : String) : String := s!"AgentWorkspace.Theorems.WellFormed.AuthzDecide.{n}"
private def nm (n : String) : String := s!"AgentWorkspace.Theorems.Normative.AuthzDecide.{n}"
private def iv (n : String) : String := s!"AgentWorkspace.Theorems.Invariants.AuthzDecide.{n}"
private def ad (n : String) : String := s!"AgentWorkspace.Theorems.Adversarial.AuthzDecide.{n}"
private def mt (n : String) : String := s!"AgentWorkspace.Theorems.Meta.AuthzDecide.{n}"

private def strs (xs : List String) : Json := Json.arr (xs.map Json.str).toArray

private def opt (o : Option String) : Json := match o with
  | some s => Json.str s
  | none => Json.null

/-- The constructor name of a closed value (`apiKeys` for `Resource.apiKeys`). -/
private def ctorName {α : Type} [Repr α] (a : α) : String :=
  ((reprStr a).splitOn ".").getLastD ""

/-! ## Rendering a decision -/

/-- A substring of the TypeScript `because` for each refusal reason. -/
def refuseKeyword : RefuseReason → String
  | .unknownRole => "four roles"
  | .pageSurface => "is a browser page"
  | .path .notApiShape => "does not begin /api/<resource>"
  | .path (.unknownResource _) => "is not a resource"
  | .path (.unclassifiedSub _ _) => "is not a sub-resource"
  | .path .tooDeep => "is deeper than"
  | .path (.ok _ _ _) => ""
  | .method .options => "OPTIONS is not an operation"
  | .method .unknownMethod => "is not an HTTP method"

/-- A substring of the TypeScript `because` for each scope denial. -/
def scopeKeyword : ScopeDenial → String
  | .notInGrammar => "may only reach"
  | .collectionRead => "may read one run by id"
  | .runIdMismatch => "names a different row"
  | .sessionIdMismatch => "names a different row"
  | .revoke => "does not reach revoking run tokens"

def factsJson : Option RouteFacts → Json
  | none => Json.null
  | some f => Json.mkObj [("resource", Resource.toWire f.resource),
      ("operation", RouteOperation.toWire f.operation), ("grant", Grant.toWire f.grant)]

def decisionJson (d : Decision) : Json :=
  match d with
  | .allow f => Json.mkObj [("effect", "allow"), ("facts", factsJson f), ("code", Json.null),
      ("because", Json.null)]
  | .deny f s => Json.mkObj [("effect", "deny"), ("facts", factsJson f),
      ("code", opt (s.map fun _ => "token_out_of_scope")),
      ("because", opt (s.map scopeKeyword))]
  | .revokeDeny f => Json.mkObj [("effect", "deny"), ("facts", factsJson (some f)),
      ("code", "run_token_revoke_forbidden"), ("because", "only a workspace owner or admin")]
  | .refuse r => Json.mkObj [("effect", "refuse"), ("facts", Json.null), ("code", Json.null),
      ("because", Json.str (refuseKeyword r))]

def scopeJson : Option Scope → Json
  | none => Json.null
  | some s => Json.mkObj [("kind", ScopeKind.toWire s.kind), ("id", s.id)]

/-- The effect of `decide()` for every ownership answer, keyed by its wire spelling. -/
def effectsByOwnership (role method path : String) (scope : Option Scope) : Json :=
  Json.mkObj ((WireEnum.all : List Ownership).map fun o =>
    (Ownership.toWire o, Json.str (match (decideAuth ⟨role, method, path, o, scope⟩).effect with
      | .allow => "allow" | .deny => "deny" | .refuse => "refuse")))

/-- The decision over the five ownership answers: the effect of each, and the facts, code and
reason keyword, which do not depend on the ownership answer (the ownership is consulted only by
`applyGrant`, after the facts are fixed). -/
def byOwnership (role method path : String) (scope : Option Scope) : Json :=
  let d := decisionJson (decideAuth ⟨role, method, path, .own, scope⟩)
  Json.mkObj [("effects", effectsByOwnership role method path scope),
    ("facts", d.getObjValD "facts"), ("code", d.getObjValD "code"),
    ("because", d.getObjValD "because")]

def queryInput (role method path : String) (scope : Option Scope) : Json :=
  Json.mkObj [("role", role), ("method", method), ("path", path), ("scope", scopeJson scope)]

/-- Witnesses of one decision: the role-table cell theorem when the table was consulted, and the
rule that produced any other answer. -/
def witnessesFor (role method path : String) (scope : Option Scope) : List String :=
  let d := decideAuth ⟨role, method, path, .own, scope⟩
  let base := [wf "decide_decides_every_classified_query", nm "decide_evaluation_order"]
  match d with
  | .refuse .unknownRole => [nm "unknown_role_is_refused", wf "every_refusal_names_the_failed_step"]
  | .refuse .pageSurface => [nm "public_allowed_page_refused", wf "every_refusal_names_the_failed_step"]
  | .refuse (.path (.unclassifiedSub _ _)) =>
    [nm "unclassified_sub_is_refused_not_inherited", wf "every_refusal_names_the_failed_step"]
  | .refuse (.path .tooDeep) => [nm "path_deeper_than_sub_is_refused", wf "every_refusal_names_the_failed_step"]
  | .refuse (.path (.unknownResource _)) =>
    [nm "unknown_resource_is_refused_first", wf "every_refusal_names_the_failed_step"]
  | .refuse (.path _) => [wf "every_refusal_names_the_failed_step"]
  | .refuse (.method .unknownMethod) => [nm "unknown_method_is_refused", wf "every_refusal_names_the_failed_step"]
  | .refuse (.method .options) => [nm "method_maps_to_operation", wf "every_refusal_names_the_failed_step"]
  | .allow none => [nm "public_allowed_page_refused"]
  | .deny none (some .notInGrammar) => [nm "out_of_grammar_is_token_out_of_scope", iv "scope_only_narrows",
      nm "deny_code_is_token_out_of_scope_exactly_on_a_scope_objection"]
  | .deny none (some .collectionRead) => [nm "scoped_collection_read_is_out_of_scope", iv "scope_only_narrows",
      nm "deny_code_is_token_out_of_scope_exactly_on_a_scope_objection"]
  | .deny none (some .runIdMismatch) => [nm "run_scope_needs_the_exact_run_id", iv "scope_only_narrows",
      nm "deny_code_is_token_out_of_scope_exactly_on_a_scope_objection"]
  | .deny none (some .sessionIdMismatch) => [nm "session_scope_needs_its_own_session_id", iv "scope_only_narrows",
      nm "deny_code_is_token_out_of_scope_exactly_on_a_scope_objection"]
  | .deny none (some .revoke) => [nm "revoke_capability_matches_roles"]
  | .revokeDeny _ => [nm "revoke_capability_matches_roles"]
  | .allow (some f) | .deny (some f) _ =>
    if f.operation == .revoke then [nm "revoke_capability_matches_roles"] else
    match parseRoleInput role with
    | some r => base ++ [nm s!"role_table_{ctorName r}_{ctorName f.resource}", nm "apply_grant_table",
        nm "method_maps_to_operation", iv "every_allow_is_backed_by_the_table"] ++
        (if scope.isSome then [iv "scope_only_narrows"] else [])
    | none => base
  | .deny none none => base

def decideVector (idPrefix role method path : String) (scope : Option Scope) : Vector :=
  { id := s!"{idPrefix}/{role}/{method} {path}" ++
      (match scope with | none => "" | some s => s!" [{ScopeKind.toWire s.kind}:{s.id}]"),
    input := queryInput role method path scope,
    expected := Json.mkObj [("outcomes", byOwnership role method path scope)],
    witnesses := witnessesFor role method path scope }

/-! ## Enumerations and the policy table -/

def enumerationVectors : List Vector :=
  [ { id := "enum/resources", input := Json.mkObj [("enum", "RESOURCES")],
      expected := Json.mkObj [("members", strs (WireEnum.wires Resource))],
      witnesses := [wf "resource_wires_are_the_thirty_resources"] },
    { id := "enum/roles", input := Json.mkObj [("enum", "ROLES")],
      expected := Json.mkObj [("members", strs (roles.map WireEnum.toWire))],
      witnesses := [wf "decision_vocabularies_match_typescript"] },
    { id := "enum/ownerships", input := Json.mkObj [("enum", "OWNERSHIPS")],
      expected := Json.mkObj [("members", strs (WireEnum.wires Ownership))],
      witnesses := [wf "decision_vocabularies_match_typescript"] },
    { id := "enum/methods", input := Json.mkObj [("enum", "METHODS")],
      expected := Json.mkObj [("members", strs methods)],
      witnesses := [wf "decision_vocabularies_match_typescript"] },
    { id := "enum/token-scope-kinds", input := Json.mkObj [("enum", "TOKEN_SCOPE_KINDS")],
      expected := Json.mkObj [("members", strs (WireEnum.wires ScopeKind))],
      witnesses := [nm "scope_grammar_is_the_documented_route_table"] },
    { id := "enum/sub-resources", input := Json.mkObj [("enum", "SUB_RESOURCES")],
      expected := Json.mkObj (Resource.all.map fun r => (Resource.toWire r, strs (subResources r))),
      witnesses := [wf "sub_resource_composition_yields_forty_four_pairs"] } ]

def policyVectors : List Vector :=
  roles.flatMap fun role => Resource.all.map fun res =>
    let g := grantsFor role res
    { id := s!"policy/{role.toWire}/{res.toWire}",
      input := Json.mkObj [("role", role.toWire), ("resource", res.toWire)],
      expected := Json.mkObj [("read", Grant.toWire g.read), ("write", Grant.toWire g.write),
        ("run", Grant.toWire g.run)],
      witnesses := [nm s!"role_table_{ctorName role}_{ctorName res}",
        wf "every_role_policy_names_each_resource_once", mt "owner_dominates_every_role"] }

/-! ## Exhaustive shapes -/

/-- Every accepted path shape, with `row-a` for the `:id` segment. -/
def shapePaths : List String :=
  Resource.all.map (fun r => s!"/api/{r.toWire}") ++
    Resource.all.map (fun r => s!"/api/{r.toWire}/row-a") ++
    (pairsOf subResources).map fun (r, s) => s!"/api/{r.toWire}/row-a/{s}"

def shapeMethods : List String := methods ++ ["TRACE"]

def roleWires : List String := roles.map WireEnum.toWire

def shapeVectors : List Vector :=
  roleWires.flatMap fun role => shapePaths.flatMap fun path =>
    shapeMethods.map fun m => decideVector "shape" role m path none

/-! ## Declared routes -/

def routeVectors : List Vector :=
  declaredRoutes.flatMap fun r => roleWires.map fun role =>
    let v := decideVector "route" role r.method r.path none
    { id := v.id, expected := v.expected,
      input := Json.mkObj [("role", role), ("method", r.method), ("path", r.path),
        ("owner", r.owner), ("scope", Json.null)],
      witnesses := v.witnesses ++ [wf "every_matrix_route_is_decided"] }

def routeSetVectors : List Vector :=
  let keys := declaredRoutes.map fun r => s!"{r.method} {r.path}"
  let refused := (declaredRoutes.filter fun r =>
    (decideAuth ⟨"owner", r.method, r.path, .own, none⟩).effect == .refuse).map
      fun r => s!"{r.method} {r.path}"
  let unrouted := ((pairsOf subResources).filter fun (res, sub) => !declaredRoutes.any fun r =>
      match parsePath r.path with
      | .ok res' (some s) _ => res' == res && s == sub
      | _ => false).map fun (res, sub) => s!"{res.toWire}/{sub}"
  [ { id := "route-set", input := Json.mkObj [("directory", "tests/route-declarations")],
      expected := Json.mkObj [("routes", strs keys), ("count", (declaredRoutes.length : Nat)),
        ("matrixCount", (matrixRoutes.length : Nat)),
        ("matrixPublic", strs (matrixPublicRoutes.map fun (m, p) => s!"{m} {p}")),
        ("matrixIdentityOnly", strs (matrixIdentityOnlyRoutes.map fun (m, p) => s!"{m} {p}")),
        ("refused", strs refused), ("classifiedSubsWithoutRoute", strs unrouted)],
      witnesses := [wf "every_matrix_route_is_decided",
        mt "refused_declared_routes_are_the_auth_routes_and_accept",
        mt "classified_sub_without_a_declared_route"] } ]

/-! ## Scope -/

def scopes : List Scope :=
  [.run ⟨"row-a"⟩, .run ⟨"row-b"⟩, .session ⟨"row-a"⟩, .session ⟨"row-b"⟩]

def scopeVectors : List Vector :=
  let owner := shapePaths.flatMap fun path => methods.flatMap fun m =>
    scopes.map fun s => decideVector "scope" "owner" m path (some s)
  let runAndAgentShapes := shapePaths.filter fun p =>
    p.startsWith "/api/runs" || p.startsWith "/api/agents"
  let others := ["admin", "builder", "viewer"].flatMap fun role => runAndAgentShapes.flatMap fun path =>
    methods.flatMap fun m => scopes.map fun s => decideVector "scope" role m path (some s)
  let ordinary := (owner ++ others).map fun v => { v with witnesses := v.witnesses ++
    [if (v.id.splitOn "[run:").length > 1 then ad "run_scoped_token_reaches_only_reads_of_its_run"
      else ad "session_scoped_token_reaches_only_run_reads_and_agent_runs"] }
  let uppercase := decideVector "scope" "owner" "GET"
    "/api/runs/123E4567-E89B-42D3-A456-426614174000/events"
    (some (.run ⟨"123e4567-e89b-42d3-a456-426614174000"⟩))
  ordinary ++ [{ uppercase with witnesses := uppercase.witnesses ++
    [nm "uppercase_run_uuid_keeps_scope"] }]

/-! ## Named edge cases -/

def grammarPaths : List String :=
  [ "/api", "/api/", "/api/runs/", "/api//runs", "/API/runs", "/Api/runs/x", "/api/Runs",
    "/api/runs/x/events/y", "/api/runs/x/events/", "/api/agents/:id/runs/:runId/events",
    "/api/agents/x/secrets", "/api/agents/x/Runs", "/api/widgets", "/api/widgets/x/y/z",
    "/api/runs/../agents", "/api/agents/../runs", "/api/%72uns", "/api/runs%2Fx",
    "/api\\runs", "/api/runs/x\\events", "/p/x", "/p/", "/P/x", "/p/../api/runs",
    "/p/%2e%2e/api/runs", "/agents", "/apiary", "/", "", "api/runs", "/api/me", "/api/me/x",
    "/api/me/x/y", "/api/tokens/x", "/api/setup/runtime-detect", "/api/auth/login",
    "/api/invitations/x/accept", "/api/runs/x/revoke-tokens", "/api/runs/%zz" ]

def grammarVectors : List Vector :=
  ["owner", "viewer"].flatMap fun role => grammarPaths.flatMap fun path =>
    ["GET", "POST"].map fun m => decideVector "grammar" role m path none

def methodCases : List String :=
  ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT", "get", "Post",
    "", " GET", "GET "]

def methodVectors : List Vector :=
  ["/api/runs/row-a", "/api/runs/row-a/interrupt", "/api/agents/row-a/runs",
      "/api/sessions/row-a/messages", "/api/projects/row-a/sessions"].flatMap fun path =>
    methodCases.map fun m => decideVector "method" "owner" m path none

def roleCases : List String :=
  ["owner", "admin", "builder", "viewer", "Owner", "ADMIN", "", " owner", "owner ", "superuser",
    "member", "viewer\u0000"]

def roleVectors : List Vector :=
  roleCases.map fun s =>
    { id := s!"role/{(Json.str s).compress}",
      input := Json.mkObj [("role", s)],
      expected := Json.mkObj [("parsed", opt ((parseRoleInput s).map WireEnum.toWire)),
        ("outcomes", byOwnership s "GET" "/api/users" none)],
      witnesses := [nm "unknown_role_is_refused"] }

def classifyCases : List String :=
  [ "/api/runs", "/api", "/apiary", "/API/runs", "/Api/Runs", "/api\\runs", "//api/runs",
    "/p/x", "/p", "/p/", "/P/x", "/pp", "/p/../api/runs", "/p/./../api", "/p/%2e%2e/api/runs",
    "/p/%2E%2E/api/runs", "/p/%252e%252e/api/runs", "/p/..%2fapi/runs", "/p%2f..%2fapi/runs",
    "/%61pi/runs", "/%2561pi/runs", "/%252561pi", "/%25252561pi", "/p/%C0%AE%C0%AE/api",
    "/p/%zz", "/p/%E0%80%AE", "/p/%ED%A0%80", "/p/%F4%90%80%80", "/p/%C3%A9", "/p/é",
    "/p/%F0%9F%98%80", "/p\\..\\api\\runs", "api/runs", "", "/agents", "/", "/p/%", "/p/%4",
    "/APİ/x", "/p/x?y", "/p/%2F", "/p/%5C..%5Capi", "/p/%C0%AFx", "/p%C0%AFapi", "/p/%C1%BF",
    "/p/%E0%9F%BF", "/p/%ED%BF%BF", "/p/%F0%80%80%AF", "/p/%F0%8F%BF%BF", "/p/%C2%80",
    "/p/%DF%BF", "/p/%E0%A0%80", "/p/%ED%9F%BF", "/p/%EE%80%80", "/p/%F0%90%80%80",
    "/p/%F4%8F%BF%BF", "/p/%C2%41", "/p/%C2", "/p/%C2%C2%80", "/p/%E0%A0%41", "/p/%E0%A0",
    "/p/%F0%90%80%41", "/p/%F0%90%80", "/p/%80", "/p/%BF", "/p/%80%80", "/p/%F5%80%80%80",
    "/p/%F7%BF%BF%BF", "/p/%F8%90%80%80", "/p/%F8%80%80%80%80", "/p/%FF", "/p/%C2%BF" ]

def classifyVectors : List Vector :=
  classifyCases.map fun p =>
    { id := s!"classify/{(Json.str p).compress}", input := Json.mkObj [("path", p)],
      expected := Json.mkObj [("surface", Surface.toWire (classifyPath p))],
      witnesses := [ad "encoded_traversal_stays_protected", ad "api_variants_are_protected",
        ad "uri_decode_rejects_overlong_and_surrogate_forms",
        ad "utf8_accepts_only_shortest_scalar_values",
        ad "uri_decode_rejects_bad_lead_and_continuation_bytes", ad "decode_step_is_well_formed",
        ad "public_needs_the_raw_path_under_p", mt "path_classifier_reads_four_decodings"] }

/-- A representative query per grant: its role, method and path. -/
def grantProbe : Grant → String × String × String
  | .any => ("owner", "GET", "/api/agents/row-a")
  | .own => ("builder", "PATCH", "/api/agents/row-a")
  | .permitted => ("viewer", "POST", "/api/agents/row-a/runs")
  | .none => ("viewer", "GET", "/api/secrets/row-a")

def applyGrantVectors : List Vector :=
  (WireEnum.all : List Grant).map fun g =>
    let (role, m, p) := grantProbe g
    { id := s!"apply-grant/{g.toWire}",
      input := Json.mkObj [("grant", g.toWire), ("role", role), ("method", m), ("path", p)],
      expected := Json.mkObj [("allowed", Json.mkObj ((WireEnum.all : List Ownership).map fun o =>
          (o.toWire, Json.bool (applyGrant g o)))),
        ("outcomes", byOwnership role m p none)],
      witnesses := [nm "apply_grant_table", nm "permitted_grant_admits_own_and_permitted",
        iv "unknown_owner_is_decided_as_other"] }

def divergenceVectors : List Vector :=
  [ decideVector "point-10" "admin" "POST" "/api/runs/:id/revoke-tokens" none,
    decideVector "point-10" "admin" "POST" "/api/runs/:id" none,
    decideVector "point-10" "owner" "POST" "/api/runs/:id/revoke-tokens" none,
    decideVector "point-11" "builder" "POST" "/api/agents/:id/runs" none,
    decideVector "point-11" "viewer" "POST" "/api/agents/:id/runs" none,
    decideVector "point-12" "admin" "POST" "/api/runs/:id/interrupt" none,
    decideVector "point-14" "owner" "GET" "/api/runs/0F8FAD5B-D9CB-469F-A165-70867728950E"
      (some (.run ⟨"0f8fad5b-d9cb-469f-a165-70867728950e"⟩)),
    decideVector "point-14" "owner" "GET" "/api/runs/0f8fad5b-d9cb-469f-a165-70867728950e"
      (some (.run ⟨"0f8fad5b-d9cb-469f-a165-70867728950e"⟩)),
    decideVector "run-scope-get-shapes" "viewer" "GET" "/api/runs/r/interrupt" (some (.run ⟨"r"⟩)),
    decideVector "run-scope-get-shapes" "viewer" "HEAD" "/api/runs/r/revoke-tokens" (some (.run ⟨"r"⟩)),
    decideVector "archive-capability" "admin" "POST" "/api/projects/:id/archive" none,
    decideVector "archive-capability" "builder" "POST" "/api/projects/:id/archive" none ].map
    fun v => { v with witnesses := v.witnesses ++
      [mt "decide_and_the_revoke_gate_agree_for_every_role",
        mt "granted_builder_runs_the_agent_a_granted_viewer_can",
         mt "admin_run_verbs_adrs_disagree_at_one_cell", mt "run_scope_id_accepts_equivalent_uuid_spelling",
        mt "run_scope_passes_every_get_on_its_runs_shapes", nm "archive_capability_follows_decide"] }

def files : List (String × Json) :=
  [ ("enumerations.json", file "authz-decide"
      "RESOURCES, ROLES, OWNERSHIPS, METHODS, TOKEN_SCOPE_KINDS and SUB_RESOURCES" enumerationVectors),
    ("policy.json", file "authz-decide" "Every (role, resource) cell of POLICY" policyVectors),
    ("decide-shapes.json", file "authz-decide"
      "decide() over role x every accepted path shape x method x ownership, unscoped" shapeVectors),
    ("decide-routes.json", file "authz-decide"
      "decide() over every declared route x role x ownership" routeVectors),
    ("route-set.json", file "authz-decide"
      "The declared route union and the facts derived from it" routeSetVectors),
    ("scope.json", file "authz-decide"
      "decide() with a run or session scope, matching and non-matching ids" scopeVectors),
    ("path-grammar.json", file "authz-decide" "Path grammar edge cases" grammarVectors),
    ("methods.json", file "authz-decide" "Method edge cases" methodVectors),
    ("roles.json", file "authz-decide" "Role spellings: parseRole and decide()" roleVectors),
    ("classify-path.json", file "authz-decide" "classifyPath surfaces" classifyVectors),
    ("apply-grant.json", file "authz-decide" "applyGrant's twenty cells" applyGrantVectors),
    ("divergences.json", file "authz-decide"
      "The queries behind suspicious points 10, 11, 12 and 14" divergenceVectors) ]

end Vectors.AuthzDecide
