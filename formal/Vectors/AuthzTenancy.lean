import AgentWorkspace.Authz.Tenancy
import Vectors.Common

/-!
Vectors for tenant selection and isolation (`authz-tenancy`), replayed against the real
TypeScript:

- by `tests/formal/authz-tenancy.test.ts` (package code, through the package exports):
  - `scope-resolver.json`: `createInMemoryWorkspaceScopeResolver` by id and by slug, including a
    duplicated slug (the last row wins);
  - `scope-forgery.json`: `requireWorkspaceScope` over a minted scope and every forgery shape;
  - `object-keys.json`: `createScopedObjectStore` over a recording backend: workspace ids × keys ×
    operations, the backend keys each call reaches, and the `/` collision;
  - `tenant-session-scope.json`: `validateTenantSessionScope` over project keys × config dirs ×
    input shapes;
  - `tenancy-rule.json`: `tenancy.test.ts` rule 1 per table, with the leading index columns
    recomputed from the live Drizzle tables (F-007);
- by `apps/web/formal/authz-tenancy.test.ts` (application code):
  - `run-concealment.json`: `readRun`, `streamRunEvents`, `interruptRun` and `revokeRunTokens`
    through the installed run API with an `InMemoryRunStore` holding a run of the caller's
    workspace and one of another: every route × role × scope × run id;
  - `principal-selection.json`: `Principal.fromSession`, `fromApiKey`, `fromBrowserToken`;
  - `workspace-access.json`: `memberOwnershipResolver` and `ownerOwnershipResolver`;
  - `authorise.json`: `requireResourceAccess` with those resolvers through the RBAC harness, whose
    answer after the resolver is `decide()`'s.
-/

namespace Vectors.AuthzTenancy

open Lean AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Authz.Tenancy
  AgentWorkspace.Authz.Decide AgentWorkspace.Concepts.BrowserToken

private def wf (n : String) : String := s!"AgentWorkspace.Theorems.WellFormed.AuthzTenancy.{n}"
private def nm (n : String) : String := s!"AgentWorkspace.Theorems.Normative.AuthzTenancy.{n}"
private def iv (n : String) : String := s!"AgentWorkspace.Theorems.Invariants.AuthzTenancy.{n}"
private def ad (n : String) : String := s!"AgentWorkspace.Theorems.Adversarial.AuthzTenancy.{n}"
private def rf (n : String) : String := s!"AgentWorkspace.Theorems.Refinement.AuthzTenancy.{n}"
private def mt (n : String) : String := s!"AgentWorkspace.Theorems.Meta.AuthzTenancy.{n}"

private def strs (xs : List String) : Json := Json.arr (xs.map Json.str).toArray

private def opt (o : Option String) : Json := match o with
  | some s => Json.str s
  | none => Json.null

/-- A short, stable spelling of a string for vector ids. -/
private def tag (s : String) : String := (Json.str s).compress

/-! ## scope-resolver.json -/

def knownSets : List (String × List KnownWorkspace) :=
  [("two", [⟨"w1", "one"⟩, ⟨"w2", "two"⟩]),
   ("dup-slug", [⟨"w1", "same"⟩, ⟨"w2", "same"⟩]),
   ("empty", [])]

def resolverVectors : List Vector :=
  knownSets.flatMap fun (name, known) =>
    let knownJson := Json.arr (known.map fun k => Json.mkObj [("id", k.id), ("slug", k.slug)]).toArray
    let byId := ["w1", "w2", "w3", "", "one"].map fun key =>
      ({ id := s!"resolver/{name}/id/{tag key}",
         input := Json.mkObj [("known", knownJson), ("by", "id"), ("key", key)],
         expected := Json.mkObj [("workspaceId", opt ((inMemoryForId known key).map (·.workspaceId)))],
         witnesses := [rf "in_memory_resolver_refines_database_resolver",
           nm "resolved_scope_names_an_existing_workspace"] } : Vector)
    let bySlug := ["one", "two", "same", "w1", ""].map fun key =>
      ({ id := s!"resolver/{name}/slug/{tag key}",
         input := Json.mkObj [("known", knownJson), ("by", "slug"), ("key", key)],
         expected := Json.mkObj [("workspaceId", opt ((inMemoryForSlug known key).map (·.workspaceId)))],
         witnesses := [nm "resolved_scope_names_an_existing_workspace",
           rf "in_memory_slug_resolver_refines_database_resolver"] } : Vector)
    byId ++ bySlug

/-! ## scope-forgery.json -/

def forgeries : List (String × ScopeValue) :=
  [("minted", .minted ⟨"w1"⟩), ("cast-literal", .castLiteral "w1"),
   ("prototype-instance", .prototypeInstance "w1"), ("null", .notAnObject),
   ("string", .notAnObject), ("number", .notAnObject)]

def forgeryVectors : List Vector :=
  forgeries.map fun (kind, v) =>
    { id := s!"forgery/{kind}", input := Json.mkObj [("kind", kind), ("workspaceId", "w1")],
      expected := Json.mkObj [("accepted", (requireWorkspaceScope v).isSome),
        ("workspaceId", opt ((requireWorkspaceScope v).map (·.workspaceId)))],
      witnesses := [ad "forged_scope_is_refused"] }

/-! ## object-keys.json -/

def uuidA : String := "7a2e98e6-dd85-4fef-a38e-ee176fbdb0ff"

def objectWorkspaceIds : List String :=
  [uuidA, "w1", "a", "a/b", "", " ", "\t\n", "\u00a0", "..", "a b", "ws/"]

def objectKeys : List String :=
  ["docs/a.md", "a", "b/c", "", "a//b", "/abs", "a/", "C:/x", "c:x", "a\\b", "..", ".", "a/../b",
   "x/.", "50%.txt", "a%2Fb", "%zz", "Q1 100%25.pdf", "ctrl\u0001", "del\u007f", "nul\u0000",
   "__objectstore_meta__", "x/NOTE.__OBJECTSTORE_META__.json", "__objectſtore_meta__",
   "__objectﬆore_meta__", "café/ü.txt", "a/b/c/d.txt", "1:x"]

def objectOps (k : String) : List ObjectOp :=
  [.put k, .get k, .delete k, .list k, .listPrefix k, .copy k "dest/copy.txt", .copy "src.txt" k]

def opJson : ObjectOp → Json
  | .put k => Json.mkObj [("op", "put"), ("key", k)]
  | .get k => Json.mkObj [("op", "get"), ("key", k)]
  | .delete k => Json.mkObj [("op", "delete"), ("key", k)]
  | .list p => Json.mkObj [("op", "list"), ("prefix", p)]
  | .listPrefix p => Json.mkObj [("op", "listPrefix"), ("prefix", p)]
  | .copy a b => Json.mkObj [("op", "copy"), ("src", a), ("dst", b)]

def opName : ObjectOp → String
  | .put _ => "put" | .get _ => "get" | .delete _ => "delete" | .list _ => "list"
  | .listPrefix _ => "listPrefix" | .copy _ _ => "copy"

def outcomeJson : ObjectOutcome → Json
  | .invalidWorkspaceId => Json.mkObj [("kind", "invalid-workspace-id")]
  | .unsafeKey r => Json.mkObj [("kind", "unsafe-key"), ("rule", WireEnum.toWire r),
      ("ruleExact", r != .percentEncoded)]
  | .backend ks => Json.mkObj [("kind", "backend"), ("keys", strs ks)]

/-- Every key × every operation for a real workspace id and for a `/` id; the workspace-id rule
alone (one put and one root listing) for every other id. -/
def objectCalls : List (String × ObjectOp) :=
  ([uuidA, "a/b"].flatMap fun ws => objectKeys.flatMap fun k => (objectOps k).map (ws, ·)) ++
  (objectWorkspaceIds.flatMap fun ws => [(ws, ObjectOp.put "docs/a.md"), (ws, ObjectOp.list "")])

def objectVectors : List Vector :=
  (objectCalls.zipIdx).map fun ((ws, op), i) =>
      let wit := [iv "object_keys_carry_their_workspace",
        wf "key_guard_accepts_only_its_own_safe_input",
        ad "accepted_key_cannot_escape_the_workspace_root",
        nm "key_guard_refuses_each_named_traversal",
        nm "empty_key_is_refused_except_as_the_root_listing"] ++
        (if Uuid.isCanonical ws then [rf "object_store_current_agrees_with_target_on_uuids"] else []) ++
        (if ws.toList.contains '/' then [rf "object_store_current_diverges_at_slash_workspace_id"] else [])
      { id := s!"object/{i}/{tag ws}/{(opJson op).compress}",
        input := Json.mkObj [("workspaceId", ws), ("call", opJson op)],
        expected := Json.mkObj [("current", outcomeJson (scopedObjectOpCurrent ws op)),
          ("target", outcomeJson (scopedObjectOpTarget ws op))],
        witnesses := wit }

/-- The calls of two workspaces that reach one backend key (or listing) today. -/
def collisionVectors : List Vector :=
  [("a", ObjectOp.put "b/c"), ("a/b", ObjectOp.put "c"), ("a", ObjectOp.list "b"),
   ("a", ObjectOp.list "")].map fun (ws, op) =>
    { id := s!"collision/{tag ws}/{(opJson op).compress}",
      input := Json.mkObj [("workspaceId", ws), ("call", opJson op)],
      expected := Json.mkObj [("current", outcomeJson (scopedObjectOpCurrent ws op)),
        ("target", outcomeJson (scopedObjectOpTarget ws op))],
      witnesses := [rf "object_store_current_diverges_at_slash_workspace_id"] }

/-! ## tenant-session-scope.json -/

def projectKeys : List (String × JValue) :=
  [("uuid", .str uuidA), ("w1", .str "w1"), ("empty", .str ""),
   ("64", .str (String.ofList (List.replicate 64 'a'))),
   ("65", .str (String.ofList (List.replicate 65 'a'))), ("mixed", .str "abc-DEF_09"),
   ("con", .str "con"), ("CON", .str "CON"), ("Com1", .str "Com1"), ("lpt9", .str "lpt9"),
   ("nul", .str "nul"), ("NUL", .str "NUL"), ("prn", .str "prn"), ("aux", .str "aux"),
   ("com0", .str "com0"), ("one", .str "a"),
   ("com10", .str "com10"), ("aux-1", .str "aux-1"), ("space", .str "a b"), ("slash", .str "a/b"),
   ("dot", .str "a.b"), ("umlaut", .str "ü"), ("nbsp", .str "\u00a0"), ("newline", .str "a\n"),
   ("number", .num 1 0), ("null", .null), ("bool", .bool true), ("array", .arr [.str "a"])]

def configDirs : List (String × JValue) :=
  [("path", .str "/sandbox/w/s/.claude"), ("empty", .str ""), ("space", .str " "),
   ("tab-newline", .str "\t\n"), ("nbsp", .str "\u00a0"), ("bom", .str "\ufeff"),
   ("padded", .str " x "), ("number", .num 0 0), ("null", .null)]

def rejectionName : ScopeRejection → String
  | .notAnObject => "not-an-object"
  | .configDirNotString => "config-dir-not-string"
  | .configDirBlank => "config-dir-blank"
  | .projectKeyNotString => "project-key-not-string"
  | .projectKeyPattern => "project-key-pattern"
  | .projectKeyDevice => "project-key-device"

def verdictJson : TenantScopeVerdict → Json
  | .ok pk cd => Json.mkObj [("ok", true), ("projectKey", pk), ("configDir", cd)]
  | .rejected why => Json.mkObj [("ok", false), ("rejection", rejectionName why)]

def scopeInputVectors : List Vector :=
  let grid := projectKeys.flatMap fun (pn, pk) => configDirs.map fun (cn, cd) =>
    let input : JValue := .obj [("projectKey", pk), ("configDir", cd)]
    ({ id := s!"scope/{pn}/{cn}", input := input.toJson,
       expected := verdictJson (validateTenantSessionScope input),
       witnesses := [nm "tenant_scope_verdict_has_two_arms", nm "project_key_is_one_to_sixty_four_characters",
         nm "tenant_scope_rejections_follow_the_field_order",
         nm "project_key_character_class", nm "windows_device_names_are_refused_in_any_case"] ++
         (if pn == "uuid" && cn == "path" then [nm "workspace_id_is_a_valid_project_key"] else []) } : Vector)
  let shapes : List (String × JValue) :=
    [("missing-config-dir", .obj [("projectKey", .str "w1")]),
     ("missing-project-key", .obj [("configDir", .str "/x")]),
     ("empty-object", .obj []),
     ("extra-key", .obj [("projectKey", .str "w1"), ("configDir", .str "/x"), ("extra", .num 1 0)]),
     ("array", .arr [.str "w1", .str "/x"]), ("string", .str "w1"), ("null", .null),
     ("number", .num 7 0), ("bool", .bool false)]
  grid ++ shapes.map fun (n, j) =>
    { id := s!"scope-shape/{n}", input := j.toJson,
      expected := verdictJson (validateTenantSessionScope j),
      witnesses := [nm "tenant_scope_verdict_has_two_arms",
        nm "tenant_scope_rejections_follow_the_field_order"] }

/-! ## tenancy-rule.json -/

def tenancyRuleVectors : List Vector :=
  (WireEnum.all : List TableName).map fun t =>
    { id := s!"table/{WireEnum.toWire t}",
      input := Json.mkObj [("table", WireEnum.toWire t)],
      expected := Json.mkObj [("tenancy", WireEnum.toWire (catalogue t).tenancy),
        ("leadingIndexedColumns", strs (leadingIndexedColumns t)),
        ("testRule1", testRule1 catalogue leadingIndexedColumns t),
        ("modelRule", tenancyWellFormed catalogue t)],
      witnesses := [mt "tenancy_rules_agree_on_the_catalogue"] }

/-! ## run-concealment.json -/

def wsA : String := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
def wsB : String := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
def runA : String := "a1b2c3d4-0000-4000-8000-00000000000a"
def runB : String := "b1b2c3d4-0000-4000-8000-00000000000b"
def runAbsent : String := "c1b2c3d4-0000-4000-8000-00000000000c"

/-- The run store: one run of the caller's workspace `wsA`, one of `wsB`. -/
def runState : State
  | .runs => [⟨[("id", runA), ("workspace_id", wsA)]⟩, ⟨[("id", runB), ("workspace_id", wsB)]⟩]
  | _ => []

def runIds : List (String × String) :=
  [("own", runA), ("foreign", runB), ("absent", runAbsent), ("malformed", "not-a-uuid"),
   ("own-upper", runA.toUpper)]

def routeResultJson (runId : String) : Except RunProblem Unit → Json
  | .ok () => Json.mkObj [("kind", "found")]
  | .error p =>
    if p == runNotFound runId then
      Json.mkObj [("kind", "not-found"), ("status", p.status), ("code", p.code),
        ("message", p.message)]
    else Json.mkObj [("kind", "preflight"), ("status", p.status), ("code", p.code)]

def runVectors : List Vector :=
  (WireEnum.all : List RunRoute).flatMap fun route =>
    ["owner", "admin", "builder", "viewer"].flatMap fun role =>
      [false, true].flatMap fun isScoped => runIds.map fun (idName, runId) =>
        let caller : RunCaller := ⟨wsA, role, isScoped⟩
        { id := s!"run/{WireEnum.toWire route}/{role}/{if isScoped then "scoped" else "unscoped"}/{idName}",
          input := Json.mkObj [("route", WireEnum.toWire route), ("workspaceId", wsA),
            ("role", role), ("browserScoped", isScoped), ("runId", runId),
            ("runs", Json.arr #[Json.mkObj [("id", runA), ("workspaceId", wsA)],
              Json.mkObj [("id", runB), ("workspaceId", wsB)]])],
          expected := routeResultJson runId (runRoute route runState caller runId fun _ => .ok ()),
          witnesses := [nm "run_route_answers_404_for_absent_or_foreign_runs",
            nm "run_lookup_is_scoped_to_the_caller", nm "revoke_tokens_refuses_a_browser_token_first",
            nm "revoke_tokens_requires_owner_or_admin_before_the_id_check",
            nm "run_route_checks_the_id_after_its_gates",
            ad "foreign_run_is_indistinguishable_from_absent"] }

/-! ## principal-selection.json -/

def principalJson (p : RequestPrincipal) : Json :=
  Json.mkObj [("principalId", p.principalId), ("kind", Concepts.Principal.Kind.toStorage p.kind),
    ("workspaceId", p.workspaceId), ("label", p.label), ("actor", p.actor), ("role", p.role),
    ("via", WireEnum.toWire p.via), ("userId", opt p.userId), ("apiKeyId", opt p.apiKeyId),
    ("scope", match p.scope with
      | none => Json.null
      | some s => Json.mkObj [("kind", WireEnum.toWire s.kind), ("id", s.id)])]

def sessionCases : List (String × SessionClaims × SessionWorkspace × MemberIdentity) :=
  [("match", ⟨"ada@example.com", "one"⟩, ⟨wsA, "one"⟩, ⟨"p1", "u1", "Ada"⟩),
   ("slug-mismatch", ⟨"ada@example.com", "one"⟩, ⟨wsB, "two"⟩, ⟨"p1", "u1", "Ada"⟩),
   ("slug-case", ⟨"ada@example.com", "one"⟩, ⟨wsA, "One"⟩, ⟨"p1", "u1", "Ada"⟩),
   ("id-is-not-compared", ⟨"ada@example.com", "one"⟩, ⟨"any-id", "one"⟩, ⟨"p1", "u1", "Ada"⟩),
   ("blank-principal", ⟨"ada@example.com", "one"⟩, ⟨wsA, "one"⟩, ⟨" ", "u1", "Ada"⟩),
   ("empty-user", ⟨"ada@example.com", "one"⟩, ⟨wsA, "one"⟩, ⟨"p1", "", "Ada"⟩),
   ("nbsp-label", ⟨"ada@example.com", "one"⟩, ⟨wsA, "one"⟩, ⟨"p1", "u1", "\u00a0"⟩),
   ("mismatch-and-blank", ⟨"ada@example.com", "one"⟩, ⟨wsA, "two"⟩, ⟨"", "", ""⟩)]

def apiKeyIdentity : ApiKeyIdentity := ⟨"p3", "k1", wsA, "CI", "builder"⟩

def principalVectors : List Vector :=
  let session := sessionCases.map fun (name, claims, ws, ident) =>
    ({ id := s!"from-session/{name}",
       input := Json.mkObj [("factory", "fromSession"),
         ("claims", Json.mkObj [("sub", claims.sub), ("ws", claims.ws)]),
         ("workspace", Json.mkObj [("id", ws.id), ("slug", ws.slug)]), ("role", "owner"),
         ("identity", Json.mkObj [("principalId", ident.principalId), ("userId", ident.userId),
           ("label", ident.label)])],
       expected := match fromSession claims ws "owner" ident with
         | .ok p => Json.mkObj [("ok", true), ("principal", principalJson p)]
         | .error r => Json.mkObj [("ok", false), ("refusal",
             match r with
             | .workspaceMismatch => "workspace-mismatch"
             | .incompleteIdentity => "incomplete-identity")],
       witnesses := [nm "session_principal_is_in_the_session_workspace",
         nm "session_for_another_workspace_is_refused", nm "session_with_a_blank_identity_is_refused",
         mt "session_slug_check_is_dead_at_its_call_site"] } : Vector)
  let identityJson := Json.mkObj [("principalId", apiKeyIdentity.principalId),
    ("apiKeyId", apiKeyIdentity.apiKeyId), ("workspaceId", apiKeyIdentity.workspaceId),
    ("label", apiKeyIdentity.label), ("role", apiKeyIdentity.role)]
  let apiKey : Vector :=
    { id := "from-api-key", input := Json.mkObj [("factory", "fromApiKey"), ("identity", identityJson)],
      expected := Json.mkObj [("ok", true), ("principal", principalJson (fromApiKey apiKeyIdentity))],
      witnesses := [nm "api_key_principal_is_in_the_key_workspace"] }
  let sessionMinter :=
    match fromSession ⟨"ada@example.com", "one"⟩ ⟨wsA, "one"⟩ "owner" ⟨"p1", "u1", "Ada"⟩ with
    | .ok p => p
    | .error _ => fromApiKey apiKeyIdentity
  let scopes : List (String × Scope) := [("run", .run ⟨runA⟩), ("session", .session ⟨"s1"⟩)]
  let browser := [("session-minter", sessionMinter), ("api-key-minter", fromApiKey apiKeyIdentity)].flatMap
    fun (mn, minter) => scopes.map fun (sn, s) =>
      ({ id := s!"from-browser-token/{mn}/{sn}",
         input := Json.mkObj [("factory", "fromBrowserToken"), ("minter", mn),
           ("scope", Json.mkObj [("kind", WireEnum.toWire s.kind), ("id", s.id)])],
         expected := Json.mkObj [("ok", true), ("principal", principalJson (fromBrowserToken minter s))],
         witnesses := [nm "browser_token_principal_is_in_the_token_workspace",
           nm "via_wire_spellings"] } : Vector)
  session ++ [apiKey] ++ browser

/-! ## workspace-access.json -/

def wsAccessA : String := "7a2e98e6-dd85-4fef-a38e-ee176fbdb0ff"
def wsAccessB : String := "5b1f0c9e-3a4d-4e2f-9b8a-1c2d3e4f5a6b"
def wsAccessC : String := "9c8b7a6f-5e4d-4c3b-8a29-18f7e6d5c4b3"

def accessRepo : WorkspaceRepo :=
  ⟨[wsAccessA, wsAccessB],
   [⟨wsAccessA, "u-owner", "owner"⟩, ⟨wsAccessA, "u-viewer", "viewer"⟩, ⟨wsAccessB, "u-other", "owner"⟩]⟩

def accessDirectory : List MemberSummary :=
  [⟨"owner@a.test", "u-owner"⟩, ⟨"viewer@a.test", "u-viewer"⟩]

def sessionPrincipal (actor role : String) : RequestPrincipal :=
  { principalId := "p-" ++ role, kind := .membership, workspaceId := wsAccessA, label := role,
    actor, role, via := .session, userId := some ("u-" ++ role), apiKeyId := none, scope := none }

def accessPrincipals : List (String × RequestPrincipal) :=
  [("owner", sessionPrincipal "owner@a.test" "owner"),
   ("viewer", sessionPrincipal "viewer@a.test" "viewer"),
   ("vanished", sessionPrincipal "gone@a.test" "viewer"),
   ("padded-upper-owner", sessionPrincipal " Owner@A.test " "owner"),
   ("api-key", fromApiKey ⟨"p-key", "k-1", wsAccessA, "CI", "admin"⟩)]

def accessIds : List (String × String) :=
  [("member", wsAccessA), ("foreign", wsAccessB), ("absent", wsAccessC), ("malformed", "not-a-uuid"),
   ("member-upper", wsAccessA.toUpper)]

def resolverJson : ResolverOutcome → Json
  | .ownership o => Json.mkObj [("kind", "ownership"), ("ownership", WireEnum.toWire o)]
  | .refuse s c => Json.mkObj [("kind", "refuse"), ("status", s), ("code", c)]

def accessVectors : List Vector :=
  accessPrincipals.flatMap fun (pn, p) => accessIds.flatMap fun (idn, id) =>
    [("member", memberResolver), ("owner", ownerResolver)].map fun (rn, resolver) =>
      { id := s!"access/{rn}/{pn}/{idn}",
        input := Json.mkObj [("resolver", rn), ("principal", pn), ("id", id), ("actor", p.actor)],
        expected := resolverJson (resolver accessRepo id p accessDirectory),
        witnesses := [nm "api_key_caller_is_refused_on_workspace_routes",
          nm "lesser_member_is_measured_not_concealed",
          nm "malformed_workspace_id_is_not_found_for_every_caller",
          nm "non_member_or_absent_workspace_is_not_found",
          ad "workspace_resolvers_conceal_foreign_workspaces"] }

/-! ## authorise.json -/

/-- The RBAC harness's members: one per role, in its session workspace. -/
def harnessMembers : List (String × String) :=
  [("owner", "u-owner"), ("admin", "u-admin"), ("builder", "u-builder"), ("viewer", "u-viewer")]

def harnessRepo : WorkspaceRepo :=
  ⟨[wsAccessA, wsAccessB],
   (harnessMembers.map fun (role, u) => ⟨wsAccessA, u, role⟩) ++ [⟨wsAccessB, "u-other", "owner"⟩]⟩

def harnessDirectory : List MemberSummary :=
  harnessMembers.map fun (role, u) => ⟨role ++ "@t.test", u⟩

def authoriseJson : AuthoriseResult → Json
  | .allowed o => Json.mkObj [("kind", "allowed"), ("status", (204 : Nat)),
      ("ownership", WireEnum.toWire o)]
  | .problem s c => Json.mkObj [("kind", "problem"), ("status", s), ("code", c)]

def authoriseVectors : List Vector :=
  harnessMembers.flatMap fun (role, u) => accessIds.flatMap fun (idn, id) =>
    ["GET", "PATCH"].flatMap fun method =>
      [("member", memberResolver), ("owner", ownerResolver)].map fun (rn, resolver) =>
        let p : RequestPrincipal :=
          { principalId := "p-" ++ role, kind := .membership, workspaceId := "workspace-under-test",
            label := role, actor := role ++ "@t.test", role, via := .session, userId := some u,
            apiKeyId := none, scope := none }
        let path := "/api/workspaces/" ++ id
        let result := authoriseFlow true (some p) (fun p => resolver harnessRepo id p harnessDirectory)
          (fun p o => decideAuth ⟨p.role, method, path, o, none⟩)
        { id := s!"authorise/{rn}/{role}/{method}/{idn}",
          input := Json.mkObj [("resolver", rn), ("email", role ++ "@t.test"), ("method", method),
            ("path", path), ("id", id)],
          expected := authoriseJson result,
          witnesses := [nm "resolver_refusal_bypasses_decide",
            nm "authorise_follows_decide_after_an_ownership",
            ad "workspace_resolvers_conceal_foreign_workspaces"] }

def files : List (String × Json) :=
  [("scope-resolver.json", file "authz-tenancy"
      "createInMemoryWorkspaceScopeResolver by id and by slug over three known sets" resolverVectors),
   ("scope-forgery.json", file "authz-tenancy"
      "requireWorkspaceScope over a minted scope and every forgery shape" forgeryVectors),
   ("object-keys.json", file "authz-tenancy"
      "createScopedObjectStore: workspace ids × keys × operations, today's and the intended outcome, and the `/` collision"
      (objectVectors ++ collisionVectors)),
   ("tenant-session-scope.json", file "authz-tenancy"
      "validateTenantSessionScope: project keys × config dirs, and non-object shapes" scopeInputVectors),
   ("tenancy-rule.json", file "authz-tenancy"
      "tenancy.test.ts rule 1 and the model's tenancy rule per table, with the leading index columns (F-007)"
      tenancyRuleVectors),
   ("run-concealment.json", file "authz-tenancy"
      "Run routes up to the lookup: route × role × scope × own, foreign, absent, malformed and upper-case run ids"
      runVectors),
   ("principal-selection.json", file "authz-tenancy"
      "Principal.fromSession, fromApiKey and fromBrowserToken: the workspace each credential selects"
      principalVectors),
   ("workspace-access.json", file "authz-tenancy"
      "memberOwnershipResolver and ownerOwnershipResolver: principal × workspace id" accessVectors),
   ("authorise.json", file "authz-tenancy"
      "requireResourceAccess with the workspace resolvers through the RBAC harness, then decide()"
      authoriseVectors)]

end Vectors.AuthzTenancy
