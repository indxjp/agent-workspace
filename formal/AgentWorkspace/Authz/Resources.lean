import AgentWorkspace.Prelude.WireEnum

/-!
# Resources and sub-resources

`RESOURCES` (`apps/web/server/rbac/resources.ts`) is the closed list of top-level segments that
`decide()` classifies under `/api/<resource>`. `SUB_RESOURCES` (`permissions.ts`) is the per-resource
list of `<sub>` segments `/api/<resource>/:id/<sub>` may carry: spec §34's three
(`SPEC_34_SUB_RESOURCES`) followed by every task's declaration
(`declared-sub-resources.ts` `DECLARED_SUB_RESOURCES`, composed by `composeSubResources`, which
throws on a duplicate pair).

The model keeps the two halves apart exactly as the code does, composes them with the same
duplicate refusal, and evaluates the composition, so a theorem about `subResources` is a theorem
about the composed record `decide()` reads.
-/

namespace AgentWorkspace.Authz.Resources

open AgentWorkspace

/-- A statement about every member of a closed enumeration is decided by checking its member
list, which `WireEnum.complete` proves exhaustive. This is what lets `decide` settle "for every
role", "for every resource", "for every ownership". -/
instance decidableForallWireEnum {α : Type} [WireEnum α] (p : α → Prop) [DecidablePred p] :
    Decidable (∀ a, p a) :=
  decidable_of_iff (∀ a ∈ (WireEnum.all : List α), p a)
    ⟨fun h a => h a (WireEnum.complete a), fun h a _ => h a⟩

/-- `RESOURCES`: the 31 top-level resources, in the `as const` order of `resources.ts`. -/
@[aw_spec (ts := "apps/web/server/rbac/resources.ts#RESOURCES")
  (doc := "docs/sdk/04-api-specification.md#33-roles")]
inductive Resource where
  | agents | apiKeys | auditEvents | connectors | endpointClients | engines | files | invitations
  | me | memberships | metrics | modelConnections | models | platforms | projects | runs
  | runtimeConnections | runtimeProfiles | runtimes | secrets | sessions | shares | sharingPolicies | skills | setup
  | storageConnections | toolBundles | tokens | triggers | users | workspaces
  deriving DecidableEq, Repr, Inhabited

/-- The path segment of a resource. -/
def Resource.toWire : Resource → String
  | .agents => "agents" | .apiKeys => "api-keys" | .auditEvents => "audit-events"
  | .connectors => "connectors" | .endpointClients => "endpoint-clients"
  | .engines => "engines" | .files => "files"
  | .invitations => "invitations"
  | .me => "me" | .memberships => "memberships" | .metrics => "metrics"
  | .modelConnections => "model-connections" | .models => "models" | .platforms => "platforms"
  | .projects => "projects"
  | .runs => "runs" | .runtimeConnections => "runtime-connections"
  | .runtimeProfiles => "runtime-profiles" | .runtimes => "runtimes" | .secrets => "secrets"
  | .sessions => "sessions" | .shares => "shares" | .sharingPolicies => "sharing-policies"
  | .skills => "skills" | .setup => "setup" | .storageConnections => "storage-connections"
  | .toolBundles => "tool-bundles" | .tokens => "tokens"
  | .triggers => "triggers" | .users => "users" | .workspaces => "workspaces"

/-- Every resource, in `RESOURCES` order. -/
def Resource.all : List Resource :=
  [.agents, .apiKeys, .auditEvents, .connectors, .endpointClients, .engines, .files, .invitations,
    .me, .memberships, .metrics, .modelConnections, .models, .platforms, .projects, .runs,
    .runtimeConnections, .runtimeProfiles, .runtimes, .secrets, .sessions, .shares, .sharingPolicies, .skills, .setup,
    .storageConnections, .toolBundles, .tokens, .triggers, .users, .workspaces]

instance : WireEnum Resource where
  all := Resource.all
  toWire := Resource.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by
    intro a b h
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-- `parseResource`: a resource, or `none` for any segment that is not exactly one spelling. -/
@[aw_spec (ts := "apps/web/server/rbac/resources.ts#parseResource")]
def parseResource (s : String) : Option Resource := WireEnum.ofWire? s

/-! ## Sub-resources -/

/-- A sub-resource table: the `<sub>` segments classified under each resource, in order. -/
abbrev SubTable := Resource → List String

/-- `SPEC_34_SUB_RESOURCES`: the three pairs spec §34 prints. -/
@[aw_spec (ts := "apps/web/server/rbac/permissions.ts#SPEC_34_SUB_RESOURCES")
  (doc := "docs/spec.md#34-api-design")]
def spec34SubResources : SubTable
  | .agents => ["runs"]
  | .runs => ["events"]
  | .sessions => ["messages"]
  | _ => []

/-- One task's claim that `sub` belongs to `resource` (`SubResourceDeclaration`). -/
structure SubDeclaration where
  owner : String
  resource : Resource
  sub : String
  deriving DecidableEq, Repr

/-- `DECLARED_SUB_RESOURCES`: every declaration, in the import order of
`declared-sub-resources.ts` and, within a file, the file's order. -/
@[aw_spec (ts := "apps/web/server/rbac/declared-sub-resources.ts#DECLARED_SUB_RESOURCES")
  (doc := "docs/adr/0040-sub-resource-classification-is-partitioned-by-the-task-that-ships-the-routes.md#decision")]
def declaredSubResources : List SubDeclaration :=
  [ ⟨"DJ-80-08-PROMOTE-ROLLBACK-615", .agents, "promote"⟩,
    ⟨"DJ-80-08-PROMOTE-ROLLBACK-615", .agents, "rollback"⟩,
    ⟨"DJ-80-11-EVALUATIONS-618", .agents, "evaluations"⟩,
    ⟨"DJ-80-11-EVALUATIONS-618", .agents, "evaluation-runs"⟩,
    ⟨"DJ-80-11-EVALUATIONS-618", .agents, "evaluation-advance"⟩,
    ⟨"DJ-80-13-FEEDBACK-LIST-620", .agents, "feedback"⟩,
    ⟨"DJ-S1-05-AGENT-VERSIONS-443", .agents, "versions"⟩,
    ⟨"DJ-S1-06-AGENT-POINTERS-444", .agents, "pointers"⟩,
    ⟨"DJ-S2-05C-RUN-FEEDBACK-539", .runs, "feedback"⟩,
    ⟨"ENG-06-SESSION-STATE-305", .sessions, "state-entries"⟩,
    ⟨"ENG-06-SESSION-STATE-305", .sessions, "state-streams"⟩,
    ⟨"ENG-06-SESSION-STATE-305", .sessions, "state-blobs"⟩,
    ⟨"P5-4-RUN-APPROVAL-1301", .runs, "approval"⟩,
    ⟨"P7-2-SURFACE-ATTACHMENTS-1308", .sessions, "attachments"⟩,
    ⟨"P8-4-FILE-SEARCH-1314", .sessions, "file-search"⟩,
    ⟨"PT-T1A-ENDPOINT-CLIENTS", .endpointClients, "keys"⟩,
    ⟨"PT-T1C-OAUTH", .endpointClients, "secret"⟩,
    ⟨"PT-TRIGGERS-1293", .triggers, "secret"⟩,
    ⟨"PT-U5-PLATFORM-EXPORTS-968", .agents, "platform-exports"⟩,
    ⟨"PT-U5-PLATFORM-EXPORTS-968", .agents, "platform-archives"⟩,
    ⟨"SDK-02-AGENT-POLICY-234", .agents, "policy"⟩,
    ⟨"SDK-03-RUN-CONTROL-235", .runs, "interrupt"⟩,
    ⟨"SDK-03-RUN-CONTROL-235", .runs, "revoke-tokens"⟩,
    ⟨"SDK-05-AUTH-237", .agents, "grants"⟩,
    ⟨"SDK-19-PRESIGNED-FILES-251", .files, "upload-urls"⟩,
    ⟨"SDK-19-PRESIGNED-FILES-251", .files, "upload-complete"⟩,
    ⟨"SDK-19-PRESIGNED-FILES-251", .files, "download-urls"⟩,
    ⟨"SDK-19-SKILL-REVISIONS-251", .skills, "revisions"⟩,
    ⟨"STO-503-STORAGE-CONNECTIONS-1690", .storageConnections, "credential"⟩,
    ⟨"STO-503-STORAGE-CONNECTIONS-1690", .storageConnections, "test"⟩,
    ⟨"STO-503-STORAGE-CONNECTIONS-1690", .storageConnections, "browse"⟩,
    ⟨"W1-CP-05", .agents, "resources"⟩,
    ⟨"W2-CP-05", .connectors, "test-connection"⟩,
    ⟨"W2-CP-07", .sessions, "transcript"⟩,
    ⟨"W2-CP-07", .sessions, "subkeys"⟩,
    ⟨"W4-CP-08", .modelConnections, "test"⟩,
    ⟨"W5-CP-02", .projects, "sessions"⟩,
    ⟨"W9-PROJ-183", .projects, "archive"⟩,
    ⟨"W9-PROJ-183", .projects, "restore"⟩,
    ⟨"W9-PROV-126", .modelConnections, "credential"⟩,
    ⟨"W9-TEAM-121", .invitations, "resend"⟩ ]

/-- The (resource, sub) pairs a table classifies, resource by resource in `RESOURCES` order. -/
def pairsOf (t : SubTable) : List (Resource × String) :=
  Resource.all.flatMap fun r => (t r).map fun s => (r, s)

/-- Append `sub` to `resource`'s list. -/
def SubTable.append (t : SubTable) (resource : Resource) (sub : String) : SubTable :=
  fun r => if r = resource then t r ++ [sub] else t r

/-- The fold of `composeSubResources`: each declaration is refused when its pair is already
classified (by the base or an earlier declaration), otherwise appended. -/
def composeAux (t : SubTable) (seen : List (Resource × String)) :
    List SubDeclaration → Except SubDeclaration SubTable
  | [] => .ok t
  | d :: ds =>
    if (d.resource, d.sub) ∈ seen then .error d
    else composeAux (t.append d.resource d.sub) ((d.resource, d.sub) :: seen) ds

/-- A declaration whose pair is already classified stops the composition, naming it. -/
theorem composeAux_seen (t : SubTable) (seen : List (Resource × String)) (d : SubDeclaration)
    (ds : List SubDeclaration) (h : (d.resource, d.sub) ∈ seen) :
    composeAux t seen (d :: ds) = .error d := by
  simp [composeAux, h]

/-- `composeSubResources`: the base table plus the declarations; `error d` is the throw naming
the first duplicate declaration. -/
@[aw_spec (ts := "apps/web/server/rbac/declared-sub-resources.ts#composeSubResources")
  (doc := "docs/adr/0040-sub-resource-classification-is-partitioned-by-the-task-that-ships-the-routes.md#decision")]
def composeSubResources (base : SubTable) (decls : List SubDeclaration) :
    Except SubDeclaration SubTable :=
  composeAux base (pairsOf base) decls

/-- `SUB_RESOURCES`, as `permissions.ts` composes it (the empty table if the composition threw,
which the theorems show it does not). -/
@[aw_spec (ts := "apps/web/server/rbac/permissions.ts#SUB_RESOURCES")]
def subResources : SubTable :=
  match composeSubResources spec34SubResources declaredSubResources with
  | .ok t => t
  | .error _ => fun _ => []

/-- `parseSub`: the segment, when it is one `subResources` classifies under `resource`. -/
@[aw_spec (ts := "apps/web/server/rbac/permissions.ts#parseSub")]
def parseSub (resource : Resource) (segment : String) : Option String :=
  (subResources resource).find? (· == segment)

end AgentWorkspace.Authz.Resources
