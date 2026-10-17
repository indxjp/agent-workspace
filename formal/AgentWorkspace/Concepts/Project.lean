import AgentWorkspace.Prelude.Json
import AgentWorkspace.Prelude.Ids

/-!
# Project

A **project** groups sessions, carries instructions and defaults (an agent, a model connection
and model), selects files and connectors, and can be archived. The API specification's resource
model gives it as
`Project(name, instructions, defaults: Agent?, ModelConnection?+model?, visibility, files,
connectors, archive state)` (`docs/sdk/04-api-specification.md` §2).

As the database knows it: `projects` (`packages/core/src/db/schema/projects.ts`), plus the two
join tables `project_files` and `project_mcp_servers` that the wire flattens into `fileIds` and
`mcpServerIds`. As the wire knows it: `ProjectResourceSchema` (`packages/contracts/src/projects.ts`).

* Lifecycle: `active` or `archived`, and nothing else; the state is `archived_at IS NOT NULL`
  (issue #182). The transitions `archive`/`restore` belong to the behaviour layer.
* Relationships: exactly one workspace, exactly one owning principal, at most one default agent,
  at most one default model connection (always together with a model id), and at most one
  legacy human creator (`created_by`). A session belongs to at most one project.
-/

namespace AgentWorkspace.Concepts.Project

open AgentWorkspace

/-- `PROJECT_VISIBILITIES` (`projectVisibilities` in the schema). -/
@[aw_spec (ts := "packages/contracts/src/projects.ts#PROJECT_VISIBILITIES")
  (ts := "packages/core/src/db/schema/projects.ts#projectVisibilities")]
inductive ProjectVisibility where
  | «private»
  | workspace
  | «public»
  deriving DecidableEq, Repr, Inhabited

namespace ProjectVisibility

/-- The wire spelling. -/
def toWire : ProjectVisibility → String
  | «private» => "private"
  | workspace => "workspace"
  | «public» => "public"

instance : WireEnum ProjectVisibility where
  all := [«private», workspace, «public»]
  toWire := toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by intro a b; cases a <;> cases b <;> decide

end ProjectVisibility

/-- `PROJECT_LIST_FILTERS`: the `?archived=` filter of `GET /api/projects`. -/
@[aw_spec (ts := "packages/contracts/src/projects.ts#PROJECT_LIST_FILTERS")
  (doc := "docs/sdk/04-api-specification.md#510-projects--awprojects")]
inductive ProjectListFilter where
  | active
  | archived
  | all
  deriving DecidableEq, Repr, Inhabited

namespace ProjectListFilter

/-- The wire spelling. -/
def toWire : ProjectListFilter → String
  | active => "active"
  | archived => "archived"
  | all => "all"

instance : WireEnum ProjectListFilter where
  all := [active, archived, all]
  toWire := toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by intro a b; cases a <;> cases b <;> decide

end ProjectListFilter

/-- The project's lifecycle state. -/
@[aw_spec (ts := "packages/core/src/db/repositories/projects.ts#isProjectArchived")
  (doc := "docs/sdk/04-api-specification.md#510-projects--awprojects")]
inductive ProjectState where
  | active
  | archived
  deriving DecidableEq, Repr, Inhabited

/-- One project, with the fields `projects` stores (timestamps as instants, which are inputs). -/
@[aw_spec (ts := "packages/core/src/db/schema/projects.ts#projects")
  (ts := "packages/contracts/src/projects.ts#ProjectResourceSchema")
  (doc := "docs/sdk/04-api-specification.md#2-resource-model")]
structure Project where
  id : ProjectId
  workspace : WorkspaceId
  name : String
  instructions : Option String
  defaultAgent : Option AgentId
  visibility : ProjectVisibility
  defaultModelConnection : Option ModelConnectionId
  defaultModel : Option String
  createdBy : Option UserId
  ownerPrincipal : PrincipalId
  archivedAt : Option Nat
  createdAt : Nat
  updatedAt : Nat
  deriving DecidableEq, Repr, Inhabited

/-- PostgreSQL's `length(btrim(s)) > 0`: one-argument `btrim` strips spaces only, so the text
has a character other than a space (a tab-only name passes). -/
@[aw_spec (ts := "packages/core/src/db/schema/projects.ts#projects_name_not_blank")
  (ts := "packages/core/src/db/schema/audit-events.ts#audit_events_actor_label_not_blank")]
def hasNonSpace (s : String) : Bool := s.toList.any (· != ' ')

namespace Project

/-- `projects_name_not_blank`. -/
@[aw_spec (ts := "packages/core/src/db/schema/projects.ts#projects_name_not_blank")]
def nameNotBlank (p : Project) : Bool := hasNonSpace p.name

/-- `projects_default_model_pair` ("#129, mirroring `workspaces_default_model_pair`"): the default
connection and the default model are set together or not at all (the model is "the provider-side
model id paired with `defaultModelConnectionId`. NULL together"). This is the project rung of the
same rule `StartRunRequestSchema` states for a run's own override: "no layer of the
model-resolution ladder may mix a connection from one level with a model from another". -/
@[aw_spec (ts := "packages/core/src/db/schema/projects.ts#projects_default_model_pair")
  (ts := "packages/core/src/db/schema/projects.ts#defaultModel")
  (ts := "packages/contracts/src/runs.ts#StartRunRequestSchema")
  (doc := "docs/sdk/04-api-specification.md#2-resource-model")]
def defaultModelPair (p : Project) : Bool :=
  p.defaultModelConnection.isNone == p.defaultModel.isNone

/-- Every invariant of a project row. -/
def wellFormed (p : Project) : Bool := p.nameNotBlank && p.defaultModelPair

/-- `isProjectArchived`: `archivedAt !== null`. -/
@[aw_spec (ts := "packages/core/src/db/repositories/projects.ts#isProjectArchived")]
def state (p : Project) : ProjectState := if p.archivedAt.isSome then .archived else .active

/-- Whether a listing with filter `f` includes the project (`archivedPredicate`). -/
@[aw_spec (ts := "packages/core/src/db/repositories/projects.ts#archivedPredicate")
  (doc := "docs/sdk/04-api-specification.md#510-projects--awprojects")]
def listedBy (f : ProjectListFilter) (p : Project) : Bool :=
  match f with
  | .active => p.archivedAt.isNone
  | .archived => p.archivedAt.isSome
  | .all => true

end Project

end AgentWorkspace.Concepts.Project
