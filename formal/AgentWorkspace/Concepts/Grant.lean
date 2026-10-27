import AgentWorkspace.Concepts.Agent

/-!
# Assignment and grant — how a catalogued resource reaches an agent, and an agent a person

The docs' vocabulary ("reach is explicit: catalog → assignment → grant", ownership-and-sharing)
has three verbs, and the schema has one table per edge:

* **Catalog** — a file, skill or connector *exists* in the workspace (`Concepts/{File,Skill,
  Connector}.lean`).
* **Assignment** — an agent may load or call a catalogued resource: `agent_files` (with an
  `access` of `read` or `read-write`), `agent_skills`, `agent_mcp_servers`. A project's own
  contribution is the two project link tables `project_files` and `project_mcp_servers`.
* **Grant** — a person may run an agent: `agent_grants`, one row per (agent, user). It stores the
  membership's `user_id`; the wire speaks the membership *principal*'s id.

The word "grant" is overloaded in today's code and docs: an `agent_files` row is also called a
"file grant" (its `access` is a "read-only grant" in the data-plane page). This model keeps
**assignment** for the three agent-resource tables and **grant** for `agent_grants` only; the
glossary in `docs/formal/units/concept-catalog.md` records the aliases.

Also here: the two repository operations that define what an assignment and a grant *mean*
observably: `replace` (`AgentResourceRepository.replace`) and `grantsRead` / `grantsReplace`
(`AgentGrantRepository.listPrincipalIds` / `replacePrincipalIds`), and the wire schema of the
grants body.
-/

namespace AgentWorkspace.Concepts.Grant

open AgentWorkspace

/-! ## File access -/

/-- `fileAccessModes`: §16's "read-only or read-write access". -/
@[aw_spec (ts := "packages/core/src/db/schema/agent-files.ts#fileAccessModes")
  (ts := "packages/contracts/src/agents.ts#AgentResourceAssignmentsSchema")
  (doc := "docs/sdk/04-api-specification.md#59-agents--awagents")]
inductive FileAccess where
  | read
  | readWrite
  deriving DecidableEq, Repr, Inhabited

/-- The wire and database spelling of an access mode. -/
def FileAccess.toWire : FileAccess → String
  | .read => "read"
  | .readWrite => "read-write"

instance : WireEnum FileAccess where
  all := [.read, .readWrite]
  toWire := FileAccess.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by
    intro a b h
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-- The breadth order: `read` is narrower than `read-write`. -/
def FileAccess.le : FileAccess → FileAccess → Bool
  | .read, _ => true
  | .readWrite, .readWrite => true
  | .readWrite, .read => false

/-- The ceiling an agent's own `writeFiles` permission puts on a file assignment, applied both
when an assignment is written and whenever it is read (issue #133): without `writeFiles`, a
`read-write` assignment is effectively `read`. -/
@[aw_spec (ts := "packages/core/src/db/repositories/agent-resources.ts#createDatabaseAgentResourceRepositoryProvider")
  (doc := "docs/adr/W9-UI-133-permission-cap-narrows-at-read-and-write.md#decision")]
def narrow (writeFiles : Bool) (a : FileAccess) : FileAccess := if writeFiles then a else .read

/-! ## The assignment and grant rows -/

/-- One `agent_files` row: agent `agent` may see file or folder `file` with `access`. -/
@[aw_spec (ts := "packages/core/src/db/schema/agent-files.ts#agentFiles")]
structure FileAssignment where
  id : AgentFileId
  workspace : WorkspaceId
  agent : AgentId
  file : FileId
  access : FileAccess
  deriving DecidableEq, Repr

/-- One `agent_skills` row. Its nullable `revision` pin (SDK-19) is not modelled here: the
assignment concept is the same whether the skill follows its current content or a revision. -/
@[aw_spec (ts := "packages/core/src/db/schema/agent-skills.ts#agentSkills")]
structure SkillAssignment where
  id : AgentSkillId
  workspace : WorkspaceId
  agent : AgentId
  skill : SkillId
  deriving DecidableEq, Repr

/-- One `agent_mcp_servers` row. -/
@[aw_spec (ts := "packages/core/src/db/schema/agent-mcp-servers.ts#agentMcpServers")]
structure ConnectorAssignment where
  id : AgentConnectorId
  workspace : WorkspaceId
  agent : AgentId
  connector : ConnectorId
  deriving DecidableEq, Repr

/-- One `agent_grants` row: user `user` (through their membership of `workspace`) may run agent
`agent`. There is no `access` column: "permitted" is binary. -/
@[aw_spec (ts := "packages/core/src/db/schema/agent-grants.ts#agentGrants")
  (doc := "docs/adr/W9-AUTH-117-viewer-permitted-agent-grants.md#decision")]
structure AgentGrant where
  id : AgentGrantId
  workspace : WorkspaceId
  agent : AgentId
  user : UserId
  deriving DecidableEq, Repr

/-- One `project_files` row, keyed by `(project_id, file_id)`. -/
@[aw_spec (ts := "packages/core/src/db/schema/project-files.ts#projectFiles")]
structure ProjectFileLink where
  workspace : WorkspaceId
  key : ProjectFileKey
  deriving DecidableEq, Repr

/-- One `project_mcp_servers` row, keyed by `(project_id, mcp_server_id)`. -/
@[aw_spec (ts := "packages/core/src/db/schema/project-mcp-servers.ts#projectMcpServers")]
structure ProjectConnectorLink where
  workspace : WorkspaceId
  key : ProjectConnectorKey
  deriving DecidableEq, Repr

/-- The columns of each assignment and grant table, in declaration order. -/
def dbColumns : List (String × List String) :=
  [("agent_files", ["id", "workspace_id", "agent_id", "file_id", "access", "created_at",
      "updated_at"]),
    ("agent_skills", ["id", "workspace_id", "agent_id", "skill_id", "revision", "created_at"]),
    ("agent_mcp_servers", ["id", "workspace_id", "agent_id", "mcp_server_id", "created_at"]),
    ("agent_grants", ["id", "workspace_id", "agent_id", "user_id", "created_at"]),
    ("project_files", ["workspace_id", "project_id", "file_id"]),
    ("project_mcp_servers", ["workspace_id", "project_id", "mcp_server_id"])]

/-! ## Replacing an agent's assignments (`AgentResourceRepository.replace`) -/

/-- One file entry of `AgentResourceAssignments`. -/
structure FileEntry where
  file : String
  access : FileAccess
  deriving DecidableEq, Repr

/-- `AgentResourceAssignments`: what `PUT /api/agents/:id/resources` sends and answers. -/
@[aw_spec (ts := "packages/contracts/src/agents.ts#AgentResourceAssignmentsSchema")
  (doc := "docs/sdk/04-api-specification.md#59-agents--awagents")]
structure Assignments where
  files : List FileEntry
  skills : List String
  connectors : List String
  deriving DecidableEq, Repr

/-- `[...new Set(xs)]`: the distinct elements, first occurrences first. -/
def dedup : List String → List String
  | [] => []
  | x :: xs => x :: (dedup xs).filter (· != x)

/-- The first element that repeats an earlier one (what `replace` reports for a duplicated file
id), if any. -/
def firstRepeat (xs : List String) : Option String :=
  go [] xs
where
  go (seen : List String) : List String → Option String
    | [] => none
    | x :: rest => if seen.contains x then some x else go (x :: seen) rest

/-- The ids of this workspace's catalog, as the three existence queries see them. -/
structure CatalogIds where
  files : List String
  skills : List String
  connectors : List String
  deriving DecidableEq, Repr

/-- The outcomes of `replace`, `ReplaceAgentResourcesOutcome`. -/
@[aw_spec (ts := "packages/core/src/db/repositories/agent-resources.ts#ReplaceAgentResourcesOutcome")]
inductive ReplaceOutcome where
  | updated (a : Assignments)
  | notFound
  | unknownFile (id : String)
  | unknownSkill (id : String)
  | unknownConnector (id : String)
  deriving DecidableEq, Repr

/-- Insert `x` into a list sorted by `key`, before the first element whose key is not below
`x`'s. -/
def insertByKey {α : Type} (key : α → String) (x : α) : List α → List α
  | [] => [x]
  | y :: ys => if key x ≤ key y then x :: y :: ys else y :: insertByKey key x ys

/-- Sort by `key` in ascending order (insertion sort): the `ORDER BY … ASC` of the read-back. -/
def sortByKey {α : Type} (key : α → String) : List α → List α
  | [] => []
  | x :: xs => insertByKey key x (sortByKey key xs)

/-- What `read(agentId)` returns for the rows just written: files ordered by `file_id`, skills by
`skill_id`, connectors by `mcp_server_id`, each ascending (`orderBy(asc(...))`). A UUID's
canonical lower-case text orders as its bytes, which is PostgreSQL's `uuid` order. -/
@[aw_spec (ts := "packages/core/src/db/repositories/agent-resources.ts#createDatabaseAgentResourceRepositoryProvider")]
def readBack (a : Assignments) : Assignments :=
  { files := sortByKey (·.file) a.files, skills := sortByKey id a.skills,
    connectors := sortByKey id a.connectors }

/-- `replace(agentId, requested)` on one workspace: `agent?` is the agent's permissions when the
agent exists in this workspace. File entries are narrowed by `writeFiles`; a repeated file id is
refused (as `unknown-file`, naming the repeat); skill and connector ids are de-duplicated; each
id must name a row of this workspace's catalog, checked files first, then skills, then
connectors; the answer is `read(agentId)` of the rows written, which orders each list by id. -/
@[aw_spec (ts := "packages/core/src/db/repositories/agent-resources.ts#createDatabaseAgentResourceRepositoryProvider")
  (doc := "docs/sdk/site/concepts/ownership-and-sharing.mdx#catalog-assignment-grant")]
def replace (agent? : Option Agent.Permissions) (cat : CatalogIds) (req : Assignments) :
    ReplaceOutcome :=
  match agent? with
  | none => .notFound
  | some p =>
    let files := req.files.map fun g => { g with access := narrow p.writeFiles g.access }
    let fileIds := files.map (·.file)
    match firstRepeat fileIds with
    | some id => .unknownFile id
    | none =>
      match fileIds.find? (fun i => !cat.files.contains i) with
      | some id => .unknownFile id
      | none =>
        let skills := dedup req.skills
        match skills.find? (fun i => !cat.skills.contains i) with
        | some id => .unknownSkill id
        | none =>
          let connectors := dedup req.connectors
          match connectors.find? (fun i => !cat.connectors.contains i) with
          | some id => .unknownConnector id
          | none => .updated (readBack { files, skills, connectors })

/-- The read side (`get`): stored file rows re-narrowed by the agent's *current* `writeFiles`. -/
@[aw_spec (ts := "packages/core/src/db/repositories/agent-resources.ts#createDatabaseAgentResourceRepositoryProvider")]
def effective (p : Agent.Permissions) (stored : Assignments) : Assignments :=
  { stored with files := stored.files.map fun g => { g with access := narrow p.writeFiles g.access } }

/-! ## Grants: principals on the wire, users in the table -/

/-- What the grants repository reads of a principal: its id, the user behind it when it is a
membership principal (`none` for an API-key principal), and whether it is revoked. This is a
view of `workspace_principals` joined to `memberships`, not a second definition of a principal. -/
structure PrincipalView where
  id : PrincipalId
  user : Option UserId
  revoked : Bool
  deriving DecidableEq, Repr

/-- A principal a grant can name: an active membership principal. -/
def PrincipalView.grantable (p : PrincipalView) : Bool := p.user.isSome && !p.revoked

/-- `listPrincipalIds`: the active membership principals whose user holds a grant row. -/
@[aw_spec (ts := "packages/core/src/db/repositories/agent-grants.ts#createDatabaseAgentGrantRepositoryProvider")
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
def grantsRead (ps : List PrincipalView) (users : List UserId) : List PrincipalId :=
  (ps.filter fun p => p.grantable && p.user.any users.contains).map (·.id)

/-- The outcomes of `replacePrincipalIds`. -/
inductive GrantsOutcome where
  | updated (users : List UserId)
  | agentNotFound
  | principalNotFound (id : PrincipalId)
  deriving DecidableEq, Repr

/-- The grantable principal with id `r`, if any. -/
def lookupGrantable (ps : List PrincipalView) (r : PrincipalId) : Option PrincipalView :=
  ps.find? fun p => p.id == r && p.grantable

/-- `replacePrincipalIds`: every requested id must be an active membership principal of this
workspace (else the first that is not is reported); the grant rows are replaced by one row per
requested principal's *user*. -/
@[aw_spec (ts := "packages/core/src/db/repositories/agent-grants.ts#createDatabaseAgentGrantRepositoryProvider")
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#membership-roles")]
def grantsReplace (agentExists : Bool) (ps : List PrincipalView) (req : List PrincipalId) :
    GrantsOutcome :=
  if !agentExists then .agentNotFound
  else
    match req.find? (fun r => (lookupGrantable ps r).isNone) with
    | some r => .principalNotFound r
    | none => .updated (req.filterMap fun r => (lookupGrantable ps r).bind (·.user))

/-- `hasGrant(agentId, userId)`: the run-permission check reads the table by user id. -/
@[aw_spec (ts := "packages/core/src/db/repositories/agent-grants.ts#AgentGrantRepository")
  (ts := "apps/web/server/agents/run-ownership.ts#resolveAgentRunOwnership")]
def hasGrant (users : List UserId) (u : UserId) : Bool := users.contains u

/-- The answers `resolveAgentRunOwnership` gives (a subset of `decide()`'s `Ownership`; it never
answers `not-applicable`). -/
@[aw_spec (ts := "apps/web/server/agents/run-ownership.ts#resolveAgentRunOwnership")
  (ts := "apps/web/server/rbac/decide.ts#Ownership")]
inductive RunOwnership where
  | own
  | permitted
  | other
  | unknown
  deriving DecidableEq, Repr, Inhabited

/-- The `Ownership` spelling of an answer. -/
def RunOwnership.toWire : RunOwnership → String
  | .own => "own"
  | .permitted => "permitted"
  | .other => "other"
  | .unknown => "unknown"

/-- What the run-ownership resolver reads: whether the agents runtime is configured, the agent's
owner when the agent exists in the caller's workspace, whether the grants store is wired, and the
`agent_grants` user ids of the agent. -/
structure RunOwnershipInput where
  configured : Bool
  agentOwner : Option PrincipalId
  grantsWired : Bool
  callerPrincipal : PrincipalId
  callerUser : Option UserId
  grantUsers : List UserId
  deriving DecidableEq, Repr

/-- `resolveAgentRunOwnership`: `unknown` when the runtime is not configured or the agent cannot
be read, `own` when the caller's principal owns it, `permitted` when an `agent_grants` row names
the caller's user, and `other` otherwise (also when the grants store is not wired or the caller
has no user, as an API-key principal has none). -/
@[aw_spec (ts := "apps/web/server/agents/run-ownership.ts#resolveAgentRunOwnership")
  (doc := "docs/adr/W9-AUTH-117-viewer-permitted-agent-grants.md#decision")]
def runOwnership (i : RunOwnershipInput) : RunOwnership :=
  if !i.configured then .unknown
  else
    match i.agentOwner with
    | none => .unknown
    | some o =>
      if o == i.callerPrincipal then .own
      else if !i.grantsWired then .other
      else
        match i.callerUser with
        | none => .other
        | some u => if hasGrant i.grantUsers u then .permitted else .other

/-! ## The assignment body (`AgentResourceAssignmentsSchema`) -/

/-- One raw file entry of a `PUT /api/agents/:id/resources` body: the two strings as sent. -/
structure RawFileEntry where
  fileId : String
  access : String
  deriving DecidableEq, Repr

/-- One raw storage grant of a body: the three strings as sent (the storage design, §05). -/
structure RawStorageGrant where
  connectionId : String
  pathPrefix : String
  access : String
  deriving DecidableEq, Repr

/-- A raw assignment body whose members already have the JSON types the schema asks for:
`extra` lists any keys besides the four (`.strict()`); an empty `storageGrants` is the key left
out, which the schema reads as `[]`. -/
structure RawAssignments where
  files : List RawFileEntry
  skillIds : List String
  connectorIds : List String
  extra : List String
  storageGrants : List RawStorageGrant
  deriving DecidableEq, Repr

/-- One folder of a storage connection an agent may reach, as the schema reads it: the agent's
current grants (`agent_storage_grants`; written only by a materialised version, never by a `PUT`)
and each version's own (`agent_version_storage_grants`, #1694; written once with the version). -/
@[aw_spec (ts := "packages/contracts/src/agents.ts#AgentResourceAssignmentsSchema")
  (ts := "packages/core/src/db/schema/agent-storage-grants.ts#agentStorageGrants")
  (ts := "packages/core/src/db/schema/agent-version-storage-grants.ts#agentVersionStorageGrants")]
structure StorageGrant where
  connection : String
  pathPrefix : String
  access : FileAccess
  deriving DecidableEq, Repr

/-- One storage grant as the schema reads it: a UUID connection id, a non-empty prefix and an
`access` of the closed set. -/
def storageGrant? (g : RawStorageGrant) : Option StorageGrant :=
  if Uuid.isCanonical g.connectionId && !g.pathPrefix.isEmpty then
    (WireEnum.ofWire? g.access : Option FileAccess).map (StorageGrant.mk g.connectionId g.pathPrefix)
  else none

/-- The `storageGrants` member of `AgentResourceAssignmentsSchema.safeParse`: every entry in body
order, or `none` when the schema refuses one. -/
@[aw_spec (ts := "packages/contracts/src/agents.ts#AgentResourceAssignmentsSchema")]
def storageGrantsBody (b : RawAssignments) : Option (List StorageGrant) :=
  if b.storageGrants.all fun g => (storageGrant? g).isSome then
    some (b.storageGrants.filterMap storageGrant?)
  else none

/-- One file entry as the schema reads it: a non-empty `fileId` and an `access` of the closed
set. -/
def fileEntry? (e : RawFileEntry) : Option FileEntry :=
  if e.fileId.isEmpty then none
  else (WireEnum.ofWire? e.access : Option FileAccess).map (FileEntry.mk e.fileId)

/-- `AgentResourceAssignmentsSchema.safeParse`: every id non-empty, every access a member of the
closed set, no unknown key; duplicates are *not* refused here (the repository decides them). -/
@[aw_spec (ts := "packages/contracts/src/agents.ts#AgentResourceAssignmentsSchema")
  (doc := "docs/sdk/04-api-specification.md#59-agents--awagents")]
def assignmentsBody (b : RawAssignments) : Option Assignments :=
  if b.extra.isEmpty && b.files.all (fun e => (fileEntry? e).isSome) &&
      b.skillIds.all (!·.isEmpty) && b.connectorIds.all (!·.isEmpty) then
    some { files := b.files.filterMap fileEntry?, skills := b.skillIds,
           connectors := b.connectorIds }
  else none

/-- ASCII lower case (a UUID has only hexadecimal letters). -/
def lowerAscii (s : String) : String := String.ofList (s.toList.map Char.toLower)

/-- `AgentGrantsSchema`: every id a canonical UUID, lower-cased, and no two equal after
lower-casing; the parsed ids, or `none` when the schema refuses the body. -/
@[aw_spec (ts := "packages/contracts/src/agents.ts#AgentGrantsSchema")
  (doc := "docs/sdk/04-api-specification.md#59-agents--awagents")]
def grantsBody (ids : List String) : Option (List String) :=
  if ids.all Uuid.isCanonical then
    let l := ids.map lowerAscii
    if decide l.Nodup then some l else none
  else none

/-! Equation lemmas of the recursive definitions above, generated here (in the defining module)
rather than in whichever theorem module first unfolds them. -/

private theorem dedup_equations (x : String) (xs : List String) :
    dedup [] = [] ∧ dedup (x :: xs) = x :: (dedup xs).filter (· != x) := by
  constructor <;> simp only [dedup]

private theorem sort_equations {α : Type} (key : α → String) (x y : α) (ys : List α) :
    insertByKey key x [] = [x] ∧
      insertByKey key x (y :: ys) =
        (if key x ≤ key y then x :: y :: ys else y :: insertByKey key x ys) ∧
      sortByKey key ([] : List α) = [] ∧
      sortByKey key (x :: ys) = insertByKey key x (sortByKey key ys) := by
  refine ⟨?_, ?_, ?_, ?_⟩ <;> simp only [insertByKey, sortByKey]

private theorem firstRepeat_go_equations (seen : List String) (x : String) (xs : List String) :
    firstRepeat.go seen [] = none ∧
      firstRepeat.go seen (x :: xs) =
        if seen.contains x then some x else firstRepeat.go (x :: seen) xs := by
  constructor <;> simp only [firstRepeat.go]

end AgentWorkspace.Concepts.Grant
