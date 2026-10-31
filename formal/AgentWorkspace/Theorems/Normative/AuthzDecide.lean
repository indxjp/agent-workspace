import AgentWorkspace.Authz.Decide

/-!
T1 — the documented authorisation rules, one theorem per rule:

- one theorem per cell of the role table (4 roles × 32 resources), each pinning the grant
  `permissions.ts` computes against this file's own transcription **and** against the independent
  transcription of `docs/sdk/04-api-specification.md` §3.3 (`documentedGrants`): the cell agrees on
  every reachable operation, disagrees, or the document is silent;
- the path grammar (ADR-0026), the method mapping (§21's `run` verb, SDK-03-RUN-235), the refusals
  of ADR-0015/0031, the evaluation order, the browser-token scope rules of §3.1.1, `applyGrant`'s
  twenty cells (W9-AUTH-117, ADR-0031), the run verbs of §5.12, and the archive capability that
  W9-UI-184 derives from `decide()`.
-/

namespace AgentWorkspace.Theorems.Normative.AuthzDecide

open AgentWorkspace AgentWorkspace.Concepts.Membership AgentWorkspace.Concepts.BrowserToken
  AgentWorkspace.Authz.Roles AgentWorkspace.Authz.Resources AgentWorkspace.Authz.Permissions
  AgentWorkspace.Authz.TokenScope AgentWorkspace.Authz.Surface AgentWorkspace.Authz.Decide

/-- Both revoke route shapes use the same dedicated capability for every ownership answer. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/rbac/decide.ts#decide")
  (ts := "apps/web/server/runs/api.ts#revokeRunTokens")]
theorem revoke_capability_matches_roles :
    ∀ path ∈ ["/api/runs/:id", "/api/runs/:id/revoke-tokens"], ∀ o : Ownership,
      (decideAuth ⟨"owner", "POST", path, o, none⟩).effect = .allow ∧
      (decideAuth ⟨"admin", "POST", path, o, none⟩).effect = .allow ∧
      (decideAuth ⟨"builder", "POST", path, o, none⟩).code =
        some "run_token_revoke_forbidden" ∧
      (decideAuth ⟨"viewer", "POST", path, o, none⟩).code =
        some "run_token_revoke_forbidden" := by
  intro path hp o
  simp only [List.mem_cons, List.not_mem_nil, or_false] at hp
  rcases hp with h | h <;> subst path <;> cases o <;> decide +kernel

/-- `GET /api/engines` (ENG-02c, #319) is read by every one of §21's four roles and written by
none of the three narrower ones, whatever ownership the handler reports.

The ownership quantifier is the point rather than a flourish. The catalogue is deployment
configuration: it names no row, so the handler always answers `not-applicable`, and a grant of
`any` is what makes that answer irrelevant — a reader gets the same decision for every ownership
the handler could conceivably produce. `write: none` for admin, builder and viewer says the other
half: an engine is installed by deploying an adapter, and no route writes one. Owner keeps §21's
`Everything.` fallback and is therefore deliberately absent from the write half. -/
@[aw_spec (tier := T1) (ts := "apps/web/app/api/engines/route.ts#GET")
  (ts := "apps/web/server/rbac/permissions.ts#POLICY")
  (doc := "docs/sdk/04-api-specification.md#33-roles")]
theorem engine_catalogue_is_read_by_every_role :
    ∀ o : Ownership,
      (decideAuth ⟨"owner", "GET", "/api/engines", o, none⟩).effect = .allow ∧
      (decideAuth ⟨"admin", "GET", "/api/engines", o, none⟩).effect = .allow ∧
      (decideAuth ⟨"builder", "GET", "/api/engines", o, none⟩).effect = .allow ∧
      (decideAuth ⟨"viewer", "GET", "/api/engines", o, none⟩).effect = .allow ∧
      (decideAuth ⟨"admin", "POST", "/api/engines", o, none⟩).effect = .deny ∧
      (decideAuth ⟨"builder", "POST", "/api/engines", o, none⟩).effect = .deny ∧
      (decideAuth ⟨"viewer", "POST", "/api/engines", o, none⟩).effect = .deny := by
  intro o
  cases o <;> decide +kernel

/-! ## The role table, cell by cell -/

section Generator

open Lean Elab Command

private def mkDocComment (text : String) : TSyntax ``Lean.Parser.Command.docComment :=
  ⟨mkNode ``Lean.Parser.Command.docComment #[mkAtom "/--", mkAtom (text ++ " -/")]⟩

/-- `aw_role_table_cell role resource read write run tag` states one (role, resource) cell:
`grantsFor` equals the literal grants, and §3.3's cell `agrees` with them on every reachable
operation, `diverges` from them, or is `silent`. -/
elab "aw_role_table_cell " role:ident res:ident g1:ident g2:ident g3:ident tag:ident : command => do
  let rs := role.getId.toString
  let xs := res.getId.toString
  let thm := mkIdent (Name.mkSimple s!"role_table_{rs}_{xs}")
  let roleE := mkIdent (`AgentWorkspace.Concepts.Membership.Role ++ role.getId)
  let resE := mkIdent (`AgentWorkspace.Authz.Resources.Resource ++ res.getId)
  let gE (g : TSyntax `ident) : Ident := mkIdent (`AgentWorkspace.Authz.Permissions.Grant ++ g.getId)
  let (a, b, c) := (gE g1, gE g2, gE g3)
  let grants := s!"read `{g1.getId}`, write `{g2.getId}`, run `{g3.getId}`"
  match tag.getId.toString with
  | "agrees" =>
    let doc := mkDocComment s!"Role table, {rs} × {xs}: `permissions.ts` grants {grants}, and \
      §3.3 prints the same grants on every operation a path can reach."
    elabCommand (← `(command|
      $doc:docComment
      @[aw_spec (tier := $(mkIdent `T1)) (doc := "docs/sdk/04-api-specification.md#33-roles")
        (ts := "apps/web/server/rbac/permissions.ts#POLICY")]
      theorem $thm : grantsFor $roleE $resE = ⟨$a, $b, $c⟩ ∧
          (documentedGrants $roleE $resE).map (agreeOnReachable $resE ⟨$a, $b, $c⟩) = some true :=
        by decide +kernel))
  | "diverges" =>
    let doc := mkDocComment s!"Role table, {rs} × {xs}: `permissions.ts` grants {grants}, and \
      §3.3 prints a different grant on a reachable operation (a documentation finding)."
    elabCommand (← `(command|
      $doc:docComment
      @[aw_spec (tier := $(mkIdent `T1)) (doc := "docs/sdk/04-api-specification.md#33-roles")
        (ts := "apps/web/server/rbac/permissions.ts#POLICY")]
      theorem $thm : grantsFor $roleE $resE = ⟨$a, $b, $c⟩ ∧
          (documentedGrants $roleE $resE).map (agreeOnReachable $resE ⟨$a, $b, $c⟩) = some false :=
        by decide +kernel))
  | "silent" =>
    let doc := mkDocComment s!"Role table, {rs} × {xs}: `permissions.ts` grants {grants}, and \
      §3.3 has no row for this resource."
    elabCommand (← `(command|
      $doc:docComment
      @[aw_spec (tier := $(mkIdent `T1)) (doc := "docs/sdk/04-api-specification.md#33-roles")
        (ts := "apps/web/server/rbac/permissions.ts#POLICY")]
      theorem $thm : grantsFor $roleE $resE = ⟨$a, $b, $c⟩ ∧ documentedGrants $roleE $resE = none :=
        by decide +kernel))
  | t => throwError "unknown tag {t}"

end Generator

aw_role_table_cell owner agents any any any agrees
aw_role_table_cell owner apiKeys any any any agrees
aw_role_table_cell owner auditEvents any any any agrees
aw_role_table_cell owner connectors any any any agrees
aw_role_table_cell owner endpointClients any any any silent
aw_role_table_cell owner engines any any any agrees
aw_role_table_cell owner files any any any agrees
aw_role_table_cell owner invitations any any any agrees
aw_role_table_cell owner me any any any silent
aw_role_table_cell owner memberships any any any agrees
aw_role_table_cell owner metrics any any any agrees
aw_role_table_cell owner modelConnections any any any agrees
aw_role_table_cell owner models any any any agrees
aw_role_table_cell owner platforms any any any agrees
aw_role_table_cell owner projects any any any agrees
aw_role_table_cell owner runs any any any agrees
aw_role_table_cell owner runtimeConnections any any any agrees
aw_role_table_cell owner runtimeProfiles any any any agrees
aw_role_table_cell owner runtimes any any any agrees
aw_role_table_cell owner secrets any any any agrees
aw_role_table_cell owner sessions any any any agrees
aw_role_table_cell owner shares any any any agrees
aw_role_table_cell owner sharingPolicies any any any agrees
aw_role_table_cell owner skills any any any agrees
aw_role_table_cell owner setup any any any silent
aw_role_table_cell owner storageConnections any any any silent
aw_role_table_cell owner toolBundles any any any silent
aw_role_table_cell owner tokens any any any agrees
aw_role_table_cell owner triggers any any any silent
aw_role_table_cell owner users any any any agrees
aw_role_table_cell owner webhooks any any any agrees
aw_role_table_cell owner workspaces own own none agrees

aw_role_table_cell admin agents any any any agrees
aw_role_table_cell admin apiKeys any any none agrees
aw_role_table_cell admin auditEvents none none none diverges
aw_role_table_cell admin connectors any any any agrees
aw_role_table_cell admin endpointClients any any any silent
aw_role_table_cell admin engines any none none agrees
aw_role_table_cell admin files any any any agrees
aw_role_table_cell admin invitations any any none agrees
aw_role_table_cell admin me any none none silent
aw_role_table_cell admin memberships any any none agrees
aw_role_table_cell admin metrics any none none agrees
aw_role_table_cell admin modelConnections any any none agrees
aw_role_table_cell admin models any any none agrees
aw_role_table_cell admin platforms any none none agrees
aw_role_table_cell admin projects any any none agrees
aw_role_table_cell admin runs any none any agrees
aw_role_table_cell admin runtimeConnections any any none agrees
aw_role_table_cell admin runtimeProfiles any any none agrees
aw_role_table_cell admin runtimes any any none agrees
aw_role_table_cell admin secrets none none none diverges
aw_role_table_cell admin sessions own own none agrees
aw_role_table_cell admin shares any any none agrees
aw_role_table_cell admin sharingPolicies any none none agrees
aw_role_table_cell admin skills any any any agrees
aw_role_table_cell admin setup none none none silent
aw_role_table_cell admin storageConnections any any none silent
aw_role_table_cell admin toolBundles any any none silent
aw_role_table_cell admin tokens none any none agrees
aw_role_table_cell admin triggers any any any silent
aw_role_table_cell admin users any any none agrees
aw_role_table_cell admin webhooks any any none agrees
aw_role_table_cell admin workspaces own own none agrees

aw_role_table_cell builder agents any own permitted agrees
aw_role_table_cell builder apiKeys none none none agrees
aw_role_table_cell builder auditEvents none none none diverges
aw_role_table_cell builder connectors any own own agrees
aw_role_table_cell builder endpointClients any own own silent
aw_role_table_cell builder engines any none none agrees
aw_role_table_cell builder files any own own agrees
aw_role_table_cell builder invitations none none none agrees
aw_role_table_cell builder me any none none silent
aw_role_table_cell builder memberships none none none agrees
aw_role_table_cell builder metrics any none none agrees
aw_role_table_cell builder modelConnections none none none agrees
aw_role_table_cell builder models none none none agrees
aw_role_table_cell builder platforms any none none agrees
aw_role_table_cell builder projects own own none agrees
aw_role_table_cell builder runs own none own agrees
aw_role_table_cell builder runtimeConnections none none none agrees
aw_role_table_cell builder runtimeProfiles any none none agrees
aw_role_table_cell builder runtimes none none none agrees
aw_role_table_cell builder secrets none none none agrees
aw_role_table_cell builder sessions own own none agrees
aw_role_table_cell builder shares own own none agrees
aw_role_table_cell builder sharingPolicies any none none agrees
aw_role_table_cell builder skills any own own agrees
aw_role_table_cell builder setup none none none silent
aw_role_table_cell builder storageConnections any none none silent
aw_role_table_cell builder toolBundles any any none silent
aw_role_table_cell builder tokens none own none agrees
aw_role_table_cell builder triggers any own own silent
aw_role_table_cell builder users none none none agrees
aw_role_table_cell builder webhooks none none none agrees
aw_role_table_cell builder workspaces own own none agrees

aw_role_table_cell viewer agents any none permitted agrees
aw_role_table_cell viewer apiKeys none none none agrees
aw_role_table_cell viewer auditEvents none none none diverges
aw_role_table_cell viewer connectors none none none agrees
aw_role_table_cell viewer endpointClients none none none silent
aw_role_table_cell viewer engines any none none agrees
aw_role_table_cell viewer files none none none agrees
aw_role_table_cell viewer invitations none none none agrees
aw_role_table_cell viewer me any none none silent
aw_role_table_cell viewer memberships none none none agrees
aw_role_table_cell viewer metrics any none none agrees
aw_role_table_cell viewer modelConnections none none none agrees
aw_role_table_cell viewer models none none none agrees
aw_role_table_cell viewer platforms any none none agrees
aw_role_table_cell viewer projects none none none agrees
aw_role_table_cell viewer runs own none own agrees
aw_role_table_cell viewer runtimeConnections none none none agrees
aw_role_table_cell viewer runtimeProfiles none none none agrees
aw_role_table_cell viewer runtimes none none none agrees
aw_role_table_cell viewer secrets none none none agrees
aw_role_table_cell viewer sessions own none none agrees
aw_role_table_cell viewer shares own own none agrees
aw_role_table_cell viewer sharingPolicies any none none agrees
aw_role_table_cell viewer skills none none none agrees
aw_role_table_cell viewer setup none none none silent
aw_role_table_cell viewer storageConnections none none none silent
aw_role_table_cell viewer toolBundles none none none silent
aw_role_table_cell viewer tokens none none none agrees
aw_role_table_cell viewer triggers none none none silent
aw_role_table_cell viewer users none none none agrees
aw_role_table_cell viewer webhooks none none none agrees
aw_role_table_cell viewer workspaces own own none agrees

/-- §21's "Owner — Everything." and the permission file's header: Owner is the only role whose
fallback grants anything; every other role falls back to `NOTHING`, so an unnamed resource is
denied. -/
@[aw_spec (tier := T1) (doc := "docs/spec.md#21-users-and-rbac")
  (ts := "apps/web/server/rbac/permissions.ts#POLICY")]
theorem only_owner_falls_back_to_everything :
    (policy .owner).fallback = EVERYTHING ∧ (policy .admin).fallback = NOTHING ∧
      (policy .builder).fallback = NOTHING ∧ (policy .viewer).fallback = NOTHING := by decide +kernel

/-! ## The path grammar (ADR-0026 decision 3) -/

/-- `/api/<resource>` is the collection, `/api/<resource>/:id` the row with any id text, and
`/api/<resource>/:id/<sub>` the sub-resource, for every resource and every classified sub. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md#decision")
  (ts := "apps/web/server/rbac/decide.ts#parsePath")]
theorem path_grammar_collection_row_and_sub (r : Resource) (id : String) :
    parseSegments ["", "api", r.toWire] = .ok r none none ∧
      parseSegments ["", "api", r.toWire, id] = .ok r none (some id) ∧
      ∀ sub ∈ subResources r, parseSegments ["", "api", r.toWire, id, sub] = .ok r (some sub) (some id) := by
  have hr : parseResource r.toWire = some r := WireEnum.ofWire?_toWire r
  refine ⟨by simp [parseSegments, hr], by simp [parseSegments, hr], fun sub hs => ?_⟩
  have : parseSub r sub = some sub := by
    unfold parseSub
    obtain ⟨x, hx, hfind⟩ : ∃ x, (subResources r).find? (· == sub) = some x ∧ x = sub := by
      cases h : (subResources r).find? (· == sub) with
      | none => exact absurd (List.find?_eq_none.mp h sub hs) (by simp)
      | some x => exact ⟨x, rfl, by simpa using List.find?_some h⟩
    rw [hx, hfind]
  simp [parseSegments, hr, this]

/-- A path deeper than `/api/<resource>/:id/<sub>` is refused whatever its segments, once the
resource is classified. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md#decision")
  (ts := "apps/web/server/rbac/decide.ts#parsePath")]
theorem path_deeper_than_sub_is_refused (r : Resource) (id sub x : String) (rest : List String) :
    parseSegments ("" :: "api" :: r.toWire :: id :: sub :: x :: rest) = .tooDeep := by
  have hr : parseResource r.toWire = some r := WireEnum.ofWire?_toWire r
  simp [parseSegments, hr]

/-- An unclassified resource segment is refused before depth or sub-resource are looked at. -/
@[aw_spec (tier := T1) (doc := "docs/adr/0015-gates-decide-on-positive-assertions.md#decision")
  (ts := "apps/web/server/rbac/decide.ts#parsePath")]
theorem unknown_resource_is_refused_first (seg : String) (rest : List String)
    (h : parseResource seg = none) :
    parseSegments ("" :: "api" :: seg :: rest) = .unknownResource seg := by
  simp [parseSegments, h]

example : parseSegments ["", "api", "widgets", "x", "y", "z"] = .unknownResource "widgets" :=
  unknown_resource_is_refused_first "widgets" _ (by decide +kernel)

/-- An unclassified sub-resource is refused, never given its parent's grant: `decide()` answers
`refuse` for it whoever asks, whatever the method, ownership or scope. -/
@[aw_spec (tier := T1) (doc := "docs/adr/0015-gates-decide-on-positive-assertions.md#decision")
  (doc := "docs/adr/W2-CP-06-an-unclassified-sub-resource-is-refused-not-inherited.md#decision-1--sub_resources-is-the-else")
  (ts := "apps/web/server/rbac/decide.ts#parsePath")]
theorem unclassified_sub_is_refused_not_inherited (q : Query) (role : Role) (r : Resource)
    (s : String) (hr : parseRoleInput q.role = some role) (hs : classifyPath q.path = .api)
    (hp : parsePath q.path = .unclassifiedSub r s) :
    decideOrdinary q = .refuse (.path (.unclassifiedSub r s)) := by
  simp [decideOrdinary, hr, hs, hp]

example : decideOrdinary ⟨"viewer", "GET", "/api/agents/:id/secrets", .own, none⟩ =
    .refuse (.path (.unclassifiedSub .agents "secrets")) :=
  unclassified_sub_is_refused_not_inherited _ .viewer _ _ (by decide +kernel) (by decide +kernel) (by decide +kernel)

/-! ## The method -/

/-- The method table: `GET`/`HEAD` read; `POST` on `runs`, `messages`, `interrupt` or `feedback`
is §21's `run` verb, `POST` on `download-urls` (minting a URL to read a file, issue #251) a read,
and any other `POST` a write; `PUT`, `PATCH`, `DELETE` write whatever the sub;
`OPTIONS` and every other string are refused. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/SDK-03-RUN-235-an-interrupt-is-a-control-plane-transition.md#decision")
  (doc := "docs/spec.md#21-users-and-rbac") (ts := "apps/web/server/rbac/decide.ts#parseOperation")]
theorem method_maps_to_operation (sub : Option String) :
    parseOperation "GET" sub = .ok .read ∧ parseOperation "HEAD" sub = .ok .read ∧
      parseOperation "PUT" sub = .ok .write ∧ parseOperation "PATCH" sub = .ok .write ∧
      parseOperation "DELETE" sub = .ok .write ∧
      parseOperation "OPTIONS" sub = .refused .options ∧
      parseOperation "POST" none = .ok .write ∧
      (∀ s, parseOperation "POST" (some s) = .ok .run ↔
        s = "runs" ∨ s = "messages" ∨ s = "interrupt" ∨ s = "feedback" ∨ s = "approval") ∧
      parseOperation "POST" (some "download-urls") = .ok .read ∧
      (∀ s, parseOperation "POST" (some s) ≠ .ok .run → s ≠ "download-urls" →
        parseOperation "POST" (some s) = .ok .write) := by
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩
  all_goals first
    | (cases sub <;> simp [parseOperation]; done)
    | (simp [parseOperation]; done)
    | decide +kernel
    | (intro s
       by_cases h1 : s = "runs" <;> by_cases h2 : s = "messages" <;>
         by_cases h3 : s = "interrupt" <;> by_cases h4 : s = "feedback" <;>
         by_cases h6 : s = "approval" <;> by_cases h5 : s = "download-urls" <;>
         simp_all [parseOperation, runSubs])

example : parseOperation "POST" (some "interrupt") = .ok .run ∧
    parseOperation "POST" (some "feedback") = .ok .run ∧
    parseOperation "POST" (some "events") = .ok .write := by decide +kernel

-- `POST` on a storage connection's `test` is a read (issue #1690); on a model connection's `test`
-- it stays a write, and any other method on the storage `test` reads the method table unchanged.
example : parseOperationFor "POST" .storageConnections (some "test") = .ok .read ∧
    parseOperationFor "POST" .modelConnections (some "test") = .ok .write ∧
    parseOperationFor "PUT" .storageConnections (some "test") = .ok .write := by decide +kernel

/-- A method outside `METHODS` (lower-case `get`, `TRACE`, the empty string, …) yields no
operation, so `decide()` refuses it. -/
@[aw_spec (tier := T1) (doc := "docs/adr/0015-gates-decide-on-positive-assertions.md#decision")
  (ts := "apps/web/server/rbac/decide.ts#parseOperation")]
theorem unknown_method_is_refused (m : String) (sub : Option String) (h : m ∉ methods) :
    parseOperation m sub = .refused .unknownMethod := by
  simp [methods] at h
  simp [parseOperation, h]

example : parseOperation "TRACE" none = .refused .unknownMethod :=
  unknown_method_is_refused _ _ (by decide +kernel)

/-! ## Refusals and the evaluation order -/

/-- An unrecognised role is refused before anything else is looked at, never downgraded to a
narrower role — even on the public surface. -/
@[aw_spec (tier := T1) (doc := "docs/adr/0015-gates-decide-on-positive-assertions.md#decision")
  (ts := "apps/web/server/rbac/roles.ts#requireRole") (ts := "apps/web/server/rbac/decide.ts#decide")]
theorem unknown_role_is_refused (q : Query) (h : parseRoleInput q.role = none) :
    decideOrdinary q = .refuse .unknownRole := by
  simp [decideOrdinary, h]

example : decideOrdinary ⟨"Viewer", "GET", "/p/x", .notApplicable, none⟩ = .refuse .unknownRole :=
  unknown_role_is_refused _ (by decide +kernel)

/-- "A role, or `null`. Positive: the value has to *be* one of the four … no default role": the
role parse accepts exactly the four lower-case spellings and refuses every variant of case,
padding or name. -/
@[aw_spec (tier := T1) (doc := "docs/adr/0015-gates-decide-on-positive-assertions.md#decision")
  (ts := "apps/web/server/rbac/roles.ts#parseRole")]
theorem role_parse_is_exact :
    (["owner", "admin", "builder", "viewer"].map parseRoleInput) =
        [some .owner, some .admin, some .builder, some .viewer] ∧
      (["Owner", "ADMIN", " owner", "owner ", "", "superuser", "member", "viewers"].all
        fun s => parseRoleInput s == none) = true := by decide +kernel

/-- Spec §34's public surface is allowed to every role with no route facts, whatever the method,
ownership or scope; the page surface is refused (this table does not decide pages). -/
@[aw_spec (tier := T1) (doc := "docs/spec.md#34-api-design") (ts := "apps/web/server/rbac/decide.ts#decide")]
theorem public_allowed_page_refused (q : Query) (role : Role) (h : parseRoleInput q.role = some role) :
    (classifyPath q.path = .«public» → decideOrdinary q = .allow none) ∧
      (classifyPath q.path = .page → decideOrdinary q = .refuse .pageSurface) := by
  constructor <;> intro hs <;> simp [decideOrdinary, h, hs]

example : decideOrdinary ⟨"viewer", "OPTIONS", "/p/:token", .unknown, some (.run ⟨"r"⟩)⟩ = .allow none :=
  (public_allowed_page_refused _ .viewer (by decide +kernel)).1 (by decide +kernel)

example : decideOrdinary ⟨"viewer", "GET", "/agents", .own, none⟩ = .refuse .pageSurface :=
  (public_allowed_page_refused _ .viewer (by decide +kernel)).2 (by decide +kernel)

/-- `decide()`'s evaluation order, witnessed by queries with two faults each, which answer the
earlier step's result: role before surface, surface before path and method, resource before depth,
path before method, method before scope, and scope before §21's grant. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/rbac/decide.ts#decide")
  (doc := "docs/formal/domains/d1-runs.md#authorisation")]
theorem decide_evaluation_order :
    decideOrdinary ⟨"root", "GET", "/agents", .own, none⟩ = .refuse .unknownRole ∧
      decideOrdinary ⟨"owner", "OPTIONS", "/agents", .own, none⟩ = .refuse .pageSurface ∧
      decideOrdinary ⟨"owner", "TRACE", "/p/x/y/z/w", .own, none⟩ = .allow none ∧
      decideOrdinary ⟨"owner", "GET", "/api/widgets/x/y/z", .own, none⟩ =
        .refuse (.path (.unknownResource "widgets")) ∧
      decideOrdinary ⟨"owner", "OPTIONS", "/api/agents/x/secrets", .own, none⟩ =
        .refuse (.path (.unclassifiedSub .agents "secrets")) ∧
      decideOrdinary ⟨"owner", "OPTIONS", "/api/runs/x", .own, some (.session ⟨"s"⟩)⟩ =
        .refuse (.method .options) ∧
      decideOrdinary ⟨"viewer", "POST", "/api/tokens", .notApplicable, some (.run ⟨"r"⟩)⟩ =
        .deny none (some .notInGrammar) := by decide +kernel

/-! ## Browser-token scope (§3.1.1) -/

/-- §3.1.1's grammar table, read route by route through `parsePath` and `parseOperationFor`, agrees
with `TOKEN_SCOPE_GRAMMAR` in both directions for each kind: every documented route lands in a cell
of its kind's grammar (`inGrammar`), and every cell is witnessed by a documented route of that kind
— same resource and operation, and, for a sub-keyed cell such as `(runs, run, "feedback")`, the
same sub-resource. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "apps/web/server/rbac/decide.ts#TOKEN_SCOPE_GRAMMAR")]
theorem scope_grammar_is_the_documented_route_table :
    ∀ k : ScopeKind,
      (documentedScopeRoutes.filter (·.1 == k)).all (fun (_, m, p) =>
          match parsePath p with
          | .ok r sub _ => match parseOperationFor m r sub with
            | .ok op => inGrammar k r op sub
            | .refused _ => false
          | _ => false) = true ∧
        (grammar k).all (fun (r, o, s) =>
          (documentedScopeRoutes.filter (·.1 == k)).any fun (_, m, p) =>
            match parsePath p with
            | .ok r' sub _ => match parseOperationFor m r' sub with
              | .ok op => r' == r && op == o && (s.isNone || s == sub)
              | .refused _ => false
            | _ => false) = true := by decide +kernel

/-- "A route inside the grammar's prefix but outside its cells reaches `decide()` and answers
`403 token_out_of_scope`": a classified query whose `(resource, operation)` is outside the scope's
grammar (`inGrammar`, sub-resource included) is denied with the scope code, whatever the role's
grant. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "apps/web/server/rbac/decide.ts#checkTokenScope")]
theorem out_of_grammar_is_token_out_of_scope (q : Query) (role : Role) (s : Scope) (r : Resource)
    (sub id : Option String) (op : Operation) (hr : parseRoleInput q.role = some role)
    (hs : classifyPath q.path = .api) (hp : parsePath q.path = .ok r sub id)
    (ho : parseOperationFor q.method r sub = .ok op) (hq : q.scope = some s)
    (hg : inGrammar s.kind r op sub = false) :
    decideOrdinary q = .deny none (some .notInGrammar) := by
  simp [decideOrdinary, hr, hs, hp, ho, decideClassified, hq, checkTokenScope, hg]

example : decideOrdinary ⟨"owner", "POST", "/api/runs/r/interrupt", .own, some (.run ⟨"r"⟩)⟩ =
    .deny none (some .notInGrammar) :=
  out_of_grammar_is_token_out_of_scope _ .owner (.run ⟨"r"⟩) .runs (some "interrupt") (some "r") .run
    (by decide +kernel) (by decide +kernel) (by decide +kernel) (by decide +kernel) rfl (by decide +kernel)

example : decideOrdinary ⟨"owner", "POST", "/api/files/x/upload-urls", .own, some (.session ⟨"s"⟩)⟩ =
    .deny none (some .notInGrammar) :=
  out_of_grammar_is_token_out_of_scope _ .owner (.session ⟨"s"⟩) .files (some "upload-urls") (some "x")
    .write (by decide +kernel) (by decide +kernel) (by decide +kernel) (by decide +kernel) rfl (by decide +kernel)

/-- "Problem codes: `token_out_of_scope` (403, the scope gate itself)": on a classified query the
decision carries the code `token_out_of_scope` exactly when the scope check objected (and is then a
deny), and otherwise no code, so every other deny renders the default `forbidden`. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "apps/web/server/rbac/decide.ts#Decision")]
theorem deny_code_is_token_out_of_scope_exactly_on_a_scope_objection (q : Query) {role : Role}
    {r : Resource} {sub id : Option String} {op : Operation} (hr : parseRoleInput q.role = some role)
    (hs : classifyPath q.path = .api) (hp : parsePath q.path = .ok r sub id)
    (ho : parseOperationFor q.method r sub = .ok op) :
    ((q.scope.bind fun s => checkTokenScope s r op sub id).isSome = true →
        (decideOrdinary q).effect = .deny ∧ (decideOrdinary q).code = some "token_out_of_scope") ∧
      ((q.scope.bind fun s => checkTokenScope s r op sub id) = none →
        (decideOrdinary q).code = none) := by
  simp only [decideOrdinary, hr, hs, hp, ho, decideClassified]
  constructor
  · intro h
    obtain ⟨d, hd⟩ := Option.isSome_iff_exists.mp h
    simp [hd, Decision.effect, Decision.code]
  · intro h
    simp only [h]
    split <;> rfl

example : (decideOrdinary ⟨"owner", "GET", "/api/runs/other", .own, some (.run ⟨"r"⟩)⟩).code =
      some "token_out_of_scope" ∧
    (decideOrdinary ⟨"viewer", "GET", "/api/runs/r", .other, some (.run ⟨"r"⟩)⟩).code = none :=
  ⟨((deny_code_is_token_out_of_scope_exactly_on_a_scope_objection
      ⟨"owner", "GET", "/api/runs/other", .own, some (.run ⟨"r"⟩)⟩ (role := .owner) (r := .runs)
      (sub := none) (id := some "other") (op := .read) (by decide +kernel) (by decide +kernel) (by decide +kernel)
      (by decide +kernel)).1 (by decide +kernel)).2,
    (deny_code_is_token_out_of_scope_exactly_on_a_scope_objection
      ⟨"viewer", "GET", "/api/runs/r", .other, some (.run ⟨"r"⟩)⟩ (role := .viewer) (r := .runs)
      (sub := none) (id := some "r") (op := .read) (by decide +kernel) (by decide +kernel) (by decide +kernel)
      (by decide +kernel)).2 (by decide +kernel)⟩

/-- "A scope reads one row, never a collection": a scoped `runs` read that names no `:id` is
denied with `token_out_of_scope`, for both kinds. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "apps/web/server/rbac/decide.ts#checkTokenScope")]
theorem scoped_collection_read_is_out_of_scope (s : Scope) (sub : Option String) :
    checkTokenScope s .runs .read sub none = some .collectionRead := by
  cases s <;> simp [checkTokenScope, inGrammar, grammar, Scope.kind]

example : checkTokenScope (.session ⟨"s"⟩) .runs .read none none = some .collectionRead :=
  scoped_collection_read_is_out_of_scope _ _

/-- A run scope admits the same row by exact spelling or equivalent valid UUID spelling. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "apps/web/server/rbac/decide.ts#checkTokenScope")]
theorem run_scope_needs_the_exact_run_id (run : RunId) (id : String) (sub : Option String) :
    checkTokenScope (.run run) .runs .read sub (some id) =
      if sameRunId (some id) run.val then none else some .runIdMismatch := by
  by_cases h : sameRunId (some id) run.val = true <;>
    simp [checkTokenScope, inGrammar, grammar, Scope.kind, Scope.id, h]

/-- A session scope reaching `POST /api/sessions/:id/attachments` (issue #1308) is admitted only for
its own session — the one shape whose path `:id` is the scope's session — by exact spelling or
equivalent valid UUID spelling, and otherwise denied as a different row. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "apps/web/server/rbac/decide.ts#checkTokenScope")]
theorem session_scope_needs_its_own_session_id (session : SessionId) (id : String) :
    checkTokenScope (.session session) .sessions .write (some "attachments") (some id) =
      if sameRunId (some id) session.val then none else some .sessionIdMismatch := by
  by_cases h : sameRunId (some id) session.val = true <;>
    simp [checkTokenScope, inGrammar, grammar, Scope.kind, Scope.id, h]

/-- "A session scope's row identity … is checked where the row is read": the scope check admits a
session scope's run read, agent run and run feedback for any path id, leaving the row check to the
handler. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "apps/web/server/rbac/decide.ts#checkTokenScope")]
theorem session_scope_defers_row_identity (session : SessionId) (id : String) (agentId : Option String)
    (sub : Option String) :
    checkTokenScope (.session session) .runs .read sub (some id) = none ∧
      checkTokenScope (.session session) .agents .run sub agentId = none ∧
      checkTokenScope (.session session) .runs .run (some "feedback") (some id) = none := by
  simp [checkTokenScope, inGrammar, grammar, Scope.kind]

/-! ## Grants against ownership (W9-AUTH-117, ADR-0031) -/

/-- `applyGrant`'s twenty cells: `any` admits every ownership; `own` admits `own` and
`not-applicable`; `permitted` admits exactly `permitted`; `none` admits nothing — an undetermined
owner denies rather than passes. -/
@[aw_spec (tier := T1) (doc := "docs/adr/W9-AUTH-117-viewer-permitted-agent-grants.md#decision")
  (doc := "docs/adr/0031-a-static-gate-cannot-be-complete-so-undecidable-must-mean-refused.md#decision")
  (ts := "apps/web/server/rbac/decide.ts#applyGrant")]
theorem apply_grant_table :
    (WireEnum.all : List Grant).map (fun g => (WireEnum.all : List Ownership).map (applyGrant g)) =
      [ [false, false, false, false, false],
        [true, false, false, true, false],
        [true, false, false, false, true],
        [true, true, true, true, true] ] := by decide +kernel

/-- "`applyGrant`'s `case 'permitted':`" allows exactly when the caller owns the agent or an
`agent_grants` row names it: `permitted` is "own or granted" (ADR-0152). -/
@[aw_spec (tier := T1) (doc := "docs/adr/W9-AUTH-117-viewer-permitted-agent-grants.md#decision")
  (doc := "docs/adr/0152-roles-are-monotonic.md#decision")
  (ts := "apps/web/server/rbac/decide.ts#applyGrant")]
theorem permitted_grant_admits_own_and_permitted (o : Ownership) :
    applyGrant .permitted o = true ↔ (o = .own ∨ o = .permitted) := by
  cases o <;> simp [applyGrant]

/-! ## Run verbs (§3.3 runs row, §5.12, SDK-03-RUN-235) -/

/-- The run row of the matrix, read through `decide()` on the real run paths: reading a run or its
events — Owner and Admin any, Builder and Viewer own; interrupting and rating (feedback, S2-05c) —
Owner and Admin any, Builder and Viewer own; for each role,
`[own, other, unknown, not-applicable, permitted]`. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#512-runs-and-the-event-stream--awruns")
  (doc := "docs/adr/SDK-03-RUN-235-an-interrupt-is-a-control-plane-transition.md#decision")
  (ts := "apps/web/server/rbac/decide.ts#decide")]
theorem run_routes_read_and_interrupt_by_role :
    ∀ path ∈ ["/api/runs/:id", "/api/runs/:id/events"],
      ["owner", "admin", "builder", "viewer"].map (fun role =>
        (WireEnum.all : List Ownership).map fun o => (decideOrdinary ⟨role, "GET", path, o, none⟩).effect) =
        [ [.allow, .allow, .allow, .allow, .allow], [.allow, .allow, .allow, .allow, .allow],
          [.allow, .deny, .deny, .allow, .deny], [.allow, .deny, .deny, .allow, .deny] ] ∧
    ["owner", "admin", "builder", "viewer"].map (fun role =>
        (WireEnum.all : List Ownership).map fun o =>
          (decideOrdinary ⟨role, "POST", "/api/runs/:id/interrupt", o, none⟩).effect) =
      [ [.allow, .allow, .allow, .allow, .allow], [.allow, .allow, .allow, .allow, .allow],
        [.allow, .deny, .deny, .allow, .deny], [.allow, .deny, .deny, .allow, .deny] ] ∧
    ["owner", "admin", "builder", "viewer"].map (fun role =>
        (WireEnum.all : List Ownership).map fun o =>
          (decideOrdinary ⟨role, "POST", "/api/runs/:id/feedback", o, none⟩).effect) =
      [ [.allow, .allow, .allow, .allow, .allow], [.allow, .allow, .allow, .allow, .allow],
        [.allow, .deny, .deny, .allow, .deny], [.allow, .deny, .deny, .allow, .deny] ] := by
  decide +kernel

/-! ## Capabilities derived from `decide()` (W9-UI-184) -/

/-- "Capability is resolved on the server by the same `decide()` the routes call": archiving a
project, own and other, per role — Owner and Admin both (ADR-0152), Builder own only, Viewer
neither. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/W9-UI-184-archive-capability-is-the-decision-table-not-a-role-table.md#decision")
  (ts := "apps/web/server/rbac/decide.ts#decide")]
theorem archive_capability_follows_decide :
    ["owner", "admin", "builder", "viewer"].map (fun role =>
      ((decideOrdinary ⟨role, "POST", "/api/projects/:id/archive", .own, none⟩).effect == .allow,
        (decideOrdinary ⟨role, "POST", "/api/projects/:id/archive", .other, none⟩).effect == .allow)) =
      [(true, true), (true, true), (true, false), (false, false)] := by decide +kernel

/-! ## Sub-resource classification (ADR-0040) -/

/-- "A duplicate throws": composing a declaration whose `(resource, sub)` pair the base table
already classifies is refused, naming that declaration, whatever follows it. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0040-sub-resource-classification-is-partitioned-by-the-task-that-ships-the-routes.md#decision")
  (ts := "apps/web/server/rbac/declared-sub-resources.ts#composeSubResources")]
theorem compose_refuses_a_duplicate_pair (base : SubTable) (d : SubDeclaration)
    (ds : List SubDeclaration) (h : (d.resource, d.sub) ∈ pairsOf base) :
    composeSubResources base (d :: ds) = .error d := by
  exact composeAux_seen _ _ _ _ h

example : composeSubResources spec34SubResources [⟨"W9-XX-99", .runs, "events"⟩] =
    .error ⟨"W9-XX-99", .runs, "events"⟩ :=
  compose_refuses_a_duplicate_pair _ _ _ (by decide +kernel)

/-- Uppercase path spelling of a valid run UUID is the same scoped row. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/rbac/decide.ts#checkTokenScope")]
theorem uppercase_run_uuid_keeps_scope :
    sameRunId (some "123E4567-E89B-42D3-A456-426614174000")
      "123e4567-e89b-42d3-a456-426614174000" = true := by
  decide +kernel

end AgentWorkspace.Theorems.Normative.AuthzDecide
