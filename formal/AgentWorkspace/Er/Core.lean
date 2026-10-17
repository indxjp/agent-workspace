import AgentWorkspace.Prelude.Json
import AgentWorkspace.Prelude.Ids
import ErSnapshot

/-!
# The ER meta-model and today's table catalogue

The shared foundation every concept cluster imports. It has four parts.

1. **The catalogue.** `TableName` is the closed set of the tables, and `catalogue` gives each a
   `TableSpec`: tenancy, primary key, columns (SQL type and nullability), foreign keys (columns,
   target, `ON DELETE`, and whether Drizzle declares it inline with `.references()`), unique
   constraints and indexes (including the one partial index), and checks, with the closed-set
   `CHECK … IN (…)` constraints kept as data. It is transcribed from the Drizzle schema
   (`packages/core/src/db/schema/*.ts`) as `drizzle-kit` renders it in
   the latest snapshot (`migrations/meta/` + `Er.Snapshot.file`, which `pnpm formal:generate`
   writes with the snapshot's table names and totals); `tests/formal/er-core.test.ts` compares it with the live
   Drizzle table objects and with that snapshot, in both directions.
2. **Rows and states.** A `Row` is a finite map from column name to value (an absent column is
   SQL `NULL`); a `State` gives every table a list of rows. Values are kept as text, which is all
   the referential and uniqueness constraints look at.
3. **Constraints as decidable predicates.** `fkHolds` (PostgreSQL `MATCH SIMPLE`: a row with a
   `NULL` in the key is not checked), `keyHolds` (unique keys, `NULL`s distinct, partial indexes
   filtered by their `WHERE … IS NULL`), `notNullHolds`, `checkHolds` for the closed sets, and
   `consistent`, their conjunction over every table.
4. **Tenancy.** A table is the tenant `root` (`workspaces`), `global` (`users`,
   `user_identities`) or tenant-`scoped` (every other table). `classify` sorts every foreign key into
   the buckets of `packages/core/src/db/schema/tenancy.test.ts`: a reference to the root, to a
   global table, a tenant-paired reference (the child's tenant column and the parent's sit at the
   same position of the key, so PostgreSQL itself forces the two workspaces to be equal), a
   single-column reference covered by a tenant-paired sibling, or an unpaired one. The theorems in
   `Theorems/*/ErCore.lean` prove that the catalogue has no unpaired reference and that, in any
   consistent state, a reference never crosses a workspace.

Also here: the `oneOf` value gate (`packages/core/src/db/schema/one-of.ts`), which decides which
closed-set values may be inlined into DDL.
-/

namespace AgentWorkspace.Er.Core

open AgentWorkspace

/-! ## Column types, delete actions, tenancy -/

/-- The SQL column types the schema uses, as Drizzle's `getSQLType()` and `drizzle-kit` spell
them. -/
@[aw_spec (ts := "packages/core/src/db/schema/tenancy.test.ts#getSQLType")
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")]
inductive SqlType where
  | uuid
  | text
  | boolean
  | integer
  | bigint
  | numeric (precision scale : Nat)
  | jsonb
  | bytea
  | timestamptz
  | uuidArray
  | textArray
  deriving DecidableEq, Repr, Inhabited

/-- The type as PostgreSQL and Drizzle's `getSQLType()` render it. -/
def SqlType.toSql : SqlType → String
  | .uuid => "uuid"
  | .text => "text"
  | .boolean => "boolean"
  | .integer => "integer"
  | .bigint => "bigint"
  | .numeric p s => s!"numeric({p}, {s})"
  | .jsonb => "jsonb"
  | .bytea => "bytea"
  | .timestamptz => "timestamp with time zone"
  | .uuidArray => "uuid[]"
  | .textArray => "text[]"

/-- The column type a `getSQLType()` spelling denotes, if any (`numeric(p, s)` with its precision
and scale). -/
def SqlType.ofSql? (s : String) : Option SqlType :=
  match s with
  | "uuid" => some .uuid
  | "text" => some .text
  | "boolean" => some .boolean
  | "integer" => some .integer
  | "bigint" => some .bigint
  | "jsonb" => some .jsonb
  | "bytea" => some .bytea
  | "timestamp with time zone" => some .timestamptz
  | "uuid[]" => some .uuidArray
  | "text[]" => some .textArray
  | _ =>
    let cs := s.toList
    if cs.take 8 == "numeric(".toList && cs.getLast? == some ')' then
      match (String.ofList ((cs.drop 8).dropLast)).splitOn ", " with
      | [p, q] => do
        let p ← p.toNat?
        let q ← q.toNat?
        pure (.numeric p q)
      | _ => none
    else none

/-- A column type is encoded as its SQL spelling. -/
instance : Lean.ToJson SqlType := ⟨fun t => Lean.Json.str t.toSql⟩

/-- A column type decodes only from a SQL spelling `SqlType.ofSql?` recognises. -/
instance : Lean.FromJson SqlType where
  fromJson? j := do
    let s ← j.getStr?
    match SqlType.ofSql? s with
    | some t => pure t
    | none => throw s!"unknown SQL column type {s}"

/-- A column: its name, type, and whether it is `NOT NULL`. -/
structure Column where
  name : String
  type : SqlType
  notNull : Bool
  deriving DecidableEq, Repr, Inhabited

/-- A foreign key's `ON DELETE` action. -/
inductive OnDelete where
  | noAction
  | restrict
  | cascade
  | setNull
  deriving DecidableEq, Repr, Inhabited

/-- The action as the snapshot spells it. -/
def OnDelete.toSql : OnDelete → String
  | .noAction => "no action"
  | .restrict => "restrict"
  | .cascade => "cascade"
  | .setNull => "set null"

instance : WireEnum OnDelete where
  all := [.noAction, .restrict, .cascade, .setNull]
  toWire := OnDelete.toSql
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by
    intro a b h
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-- How a table relates to the tenant: it is the tenant root, a global identity table exempt
from tenant scoping, or scoped by a `workspace_id` column. -/
@[aw_spec (ts := "packages/core/src/db/schema/tenancy.test.ts#TENANT_EXEMPT")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
inductive Tenancy where
  | root
  | global
  | scoped
  deriving DecidableEq, Repr, Inhabited

/-- The column that carries a row's workspace: `workspaces.id` for the root (the row IS the
workspace), `workspace_id` for a scoped table, and none for a global one. -/
def Tenancy.column? : Tenancy → Option String
  | .root => some "id"
  | .scoped => some "workspace_id"
  | .global => none

/-- The wire spelling of a tenancy class, for vectors. -/
def Tenancy.toWire : Tenancy → String
  | .root => "root"
  | .global => "global"
  | .scoped => "scoped"

instance : WireEnum Tenancy where
  all := [.root, .global, .scoped]
  toWire := Tenancy.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by
    intro a b h
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-! ## The tables -/

/-- Every table of the schema, in the order the schema barrel re-exports their modules. -/
@[aw_spec (ts := "packages/core/src/db/schema/index.ts")
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")]
inductive TableName where
  | agentFiles
  | agentGrants
  | agentMcpServers
  | agentSkills
  | agentPointerMoves
  | agentVersionEvaluations
  | agentVersionPointers
  | agentVersions
  | agents
  | apiKeys
  | auditEvents
  | browserTokens
  | cliSessions
  | endpointClientAgents
  | endpointClientApiKeys
  | endpointClients
  | files
  | invitations
  | mcpServers
  | memberships
  | modelConnections
  | oauthTokens
  | projectFiles
  | projectMcpServers
  | projects
  | runs
  | runEvents
  | runFeedback
  | runUsageRecords
  | runTokens
  | runtimeProfiles
  | runtimeVerifications
  | secrets
  | sessionMessages
  | sessionStateBlobs
  | sessionStateEntries
  | sessionStateStreams
  | sessionTranscripts
  | sessions
  | shareViews
  | shareRunCharges
  | shares
  | skills
  | surfaceSessionKeys
  | userIdentities
  | users
  | workspaces
  | workspacePrincipals
  deriving DecidableEq, Repr, Inhabited

namespace TableName

/-- The SQL table name. -/
def toWire : TableName → String
  | .agentFiles => "agent_files"
  | .agentGrants => "agent_grants"
  | .agentMcpServers => "agent_mcp_servers"
  | .agentSkills => "agent_skills"
  | .agentPointerMoves => "agent_pointer_moves"
  | .agentVersionEvaluations => "agent_version_evaluations"
  | .agentVersionPointers => "agent_version_pointers"
  | .agentVersions => "agent_versions"
  | .agents => "agents"
  | .apiKeys => "api_keys"
  | .auditEvents => "audit_events"
  | .browserTokens => "browser_tokens"
  | .cliSessions => "cli_sessions"
  | .endpointClientAgents => "endpoint_client_agents"
  | .endpointClientApiKeys => "endpoint_client_api_keys"
  | .endpointClients => "endpoint_clients"
  | .files => "files"
  | .invitations => "invitations"
  | .mcpServers => "mcp_servers"
  | .memberships => "memberships"
  | .modelConnections => "model_connections"
  | .oauthTokens => "oauth_tokens"
  | .projectFiles => "project_files"
  | .projectMcpServers => "project_mcp_servers"
  | .projects => "projects"
  | .runs => "runs"
  | .runEvents => "run_events"
  | .runFeedback => "run_feedback"
  | .runUsageRecords => "run_usage_records"
  | .runTokens => "run_tokens"
  | .runtimeProfiles => "runtime_profiles"
  | .runtimeVerifications => "runtime_verifications"
  | .secrets => "secrets"
  | .sessionMessages => "session_messages"
  | .sessionStateBlobs => "session_state_blobs"
  | .sessionStateEntries => "session_state_entries"
  | .sessionStateStreams => "session_state_streams"
  | .sessionTranscripts => "session_transcripts"
  | .sessions => "sessions"
  | .shareViews => "share_views"
  | .shareRunCharges => "share_run_charges"
  | .shares => "shares"
  | .skills => "skills"
  | .surfaceSessionKeys => "surface_session_keys"
  | .userIdentities => "user_identities"
  | .users => "users"
  | .workspaces => "workspaces"
  | .workspacePrincipals => "workspace_principals"

/-- The table a SQL name denotes, if any. -/
def ofSqlName? : String → Option TableName
  | "agent_files" => some .agentFiles
  | "agent_grants" => some .agentGrants
  | "agent_mcp_servers" => some .agentMcpServers
  | "agent_skills" => some .agentSkills
  | "agent_pointer_moves" => some .agentPointerMoves
  | "agent_version_evaluations" => some .agentVersionEvaluations
  | "agent_version_pointers" => some .agentVersionPointers
  | "agent_versions" => some .agentVersions
  | "agents" => some .agents
  | "api_keys" => some .apiKeys
  | "audit_events" => some .auditEvents
  | "browser_tokens" => some .browserTokens
  | "cli_sessions" => some .cliSessions
  | "endpoint_client_agents" => some .endpointClientAgents
  | "endpoint_client_api_keys" => some .endpointClientApiKeys
  | "endpoint_clients" => some .endpointClients
  | "files" => some .files
  | "invitations" => some .invitations
  | "mcp_servers" => some .mcpServers
  | "memberships" => some .memberships
  | "model_connections" => some .modelConnections
  | "oauth_tokens" => some .oauthTokens
  | "project_files" => some .projectFiles
  | "project_mcp_servers" => some .projectMcpServers
  | "projects" => some .projects
  | "runs" => some .runs
  | "run_events" => some .runEvents
  | "run_feedback" => some .runFeedback
  | "run_usage_records" => some .runUsageRecords
  | "run_tokens" => some .runTokens
  | "runtime_profiles" => some .runtimeProfiles
  | "runtime_verifications" => some .runtimeVerifications
  | "secrets" => some .secrets
  | "session_messages" => some .sessionMessages
  | "session_state_blobs" => some .sessionStateBlobs
  | "session_state_entries" => some .sessionStateEntries
  | "session_state_streams" => some .sessionStateStreams
  | "session_transcripts" => some .sessionTranscripts
  | "sessions" => some .sessions
  | "share_views" => some .shareViews
  | "share_run_charges" => some .shareRunCharges
  | "shares" => some .shares
  | "skills" => some .skills
  | "surface_session_keys" => some .surfaceSessionKeys
  | "user_identities" => some .userIdentities
  | "users" => some .users
  | "workspaces" => some .workspaces
  | "workspace_principals" => some .workspacePrincipals
  | _ => none

private theorem ofSqlName?_toWire (t : TableName) : ofSqlName? (toWire t) = some t := by
  cases t <;> decide

instance : WireEnum TableName where
  all := [
    agentFiles, agentGrants, agentMcpServers, agentSkills, agentPointerMoves, agentVersionEvaluations,
    agentVersionPointers, agentVersions, agents, apiKeys, auditEvents, browserTokens, cliSessions,
    endpointClientAgents, endpointClientApiKeys, endpointClients, files, invitations, mcpServers, memberships, modelConnections,
    oauthTokens, projectFiles, projectMcpServers, projects, runs, runEvents, runFeedback, runUsageRecords, runTokens,
    runtimeProfiles, runtimeVerifications, secrets, sessionMessages, sessionStateBlobs, sessionStateEntries,
    sessionStateStreams, sessionTranscripts, sessions, shareViews,
    shareRunCharges, shares, skills, surfaceSessionKeys, userIdentities, users, workspaces, workspacePrincipals]
  toWire := toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by
    intro a b h
    have := congrArg ofSqlName? h
    rwa [ofSqlName?_toWire, ofSqlName?_toWire, Option.some.injEq] at this

/-- The identifier kind of a table whose primary key is a single `id` column, if it has one. -/
@[aw_spec (ts := "packages/core/src/db/schema/columns.ts#primaryKeyId")]
def idKind? : TableName → Option IdKind
  | workspaces => some .workspace
  | users => some .user
  | userIdentities => some .userIdentity
  | memberships => some .membership
  | workspacePrincipals => some .principal
  | apiKeys => some .apiKey
  | invitations => some .invitation
  | browserTokens => some .browserToken
  | cliSessions => some .cliSession
  | agents => some .agent
  | agentFiles => some .agentFile
  | agentGrants => some .agentGrant
  | agentMcpServers => some .agentConnector
  | agentSkills => some .agentSkill
  | agentVersions => some .agentVersion
  | agentVersionEvaluations => some .agentVersionEvaluation
  | agentPointerMoves => some .agentPointerMove
  | endpointClients => some .endpointClient
  | oauthTokens => some .oauthToken
  | skills => some .skill
  | files => some .file
  | mcpServers => some .connector
  | modelConnections => some .modelConnection
  | runtimeProfiles => some .runtimeProfile
  | runtimeVerifications => some .runtimeVerification
  | secrets => some .secret
  | projects => some .project
  | sessions => some .session
  | runs => some .run
  | runTokens => some .runToken
  | runUsageRecords => some .runUsageRecord
  | runFeedback => some .runFeedback
  | shares => some .share
  | shareViews => some .shareView
  | auditEvents => some .auditEvent
  | projectFiles | projectMcpServers | sessionTranscripts | sessionMessages | runEvents
  | sessionStateStreams | sessionStateEntries | sessionStateBlobs
  | shareRunCharges | agentVersionPointers | surfaceSessionKeys
  | endpointClientAgents | endpointClientApiKeys => none

end TableName

/-! ## Table specifications -/

/-- One foreign key. `inline` is true for a single-column `.references()` declared on the column,
false for a named `foreignKey({ … })` in the table's extra configuration. -/
structure ForeignKey where
  name : String
  columns : List String
  refTable : TableName
  refColumns : List String
  onDelete : OnDelete
  inline : Bool
  deriving DecidableEq, Repr, Inhabited

/-- Whether a unique key is a table constraint (`unique(…)`) or a unique index (`uniqueIndex`). -/
inductive UniqueKind where
  | constraint
  | index
  deriving DecidableEq, Repr, Inhabited

/-- The wire spelling of a unique-key kind, for vectors. -/
def UniqueKind.toWire : UniqueKind → String
  | .constraint => "constraint"
  | .index => "index"

instance : WireEnum UniqueKind where
  all := [.constraint, .index]
  toWire := UniqueKind.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by
    intro a b h
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-- A unique key. A partial unique index applies only to rows where every column of
`partialNullColumns` is `NULL`; the only partial index is `invitations_workspace_email_pending_key`
(`WHERE accepted_at IS NULL AND revoked_at IS NULL`). -/
structure UniqueKey where
  name : String
  columns : List String
  kind : UniqueKind
  partialNullColumns : List String
  deriving DecidableEq, Repr, Inhabited

/-- A check constraint. The closed-set checks (`column IN ('a', 'b', …)`, optionally guarded by
`column IS NULL OR`) keep their column and values; every other check is recorded by name and is
refined by the cluster that owns the table. -/
@[aw_spec (ts := "packages/core/src/db/schema/one-of.ts#oneOf")]
inductive Check where
  | oneOf (name column : String) (values : List String)
  | other (name : String)
  deriving DecidableEq, Repr, Inhabited

/-- The constraint name of a check. -/
def Check.name : Check → String
  | .oneOf n _ _ => n
  | .other n => n

/-- One table of the schema. `source` is the schema module that defines it (under
`packages/core/src/db/schema/`) and `tsExport` the exported table object. -/
structure TableSpec where
  table : TableName
  source : String
  tsExport : String
  tenancy : Tenancy
  primaryKey : List String
  columns : List Column
  foreignKeys : List ForeignKey
  uniques : List UniqueKey
  checks : List Check
  deriving Repr, Inhabited

/-- A schema: a specification for every table. Today's is `catalogue`; a target model supplies
another, and every predicate below is stated for any schema. -/
abbrev Schema := TableName → TableSpec

/-- Today's schema, transcribed from `packages/core/src/db/schema/*.ts` as
the latest snapshot (`Er.Snapshot.file`) renders it. -/
@[aw_spec (ts := "packages/core/src/db/schema/index.ts")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#TENANT_EXEMPT")
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")]
def catalogue : Schema
  | .agentFiles => {
    table := .agentFiles, source := "agent-files.ts", tsExport := "agentFiles", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"agent_id", .uuid, true⟩,
      ⟨"file_id", .uuid, true⟩,
      ⟨"access", .text, true⟩,
      ⟨"created_at", .timestamptz, true⟩,
      ⟨"updated_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "agent_files_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "agent_files_agent_workspace_fk", columns := ["agent_id", "workspace_id"], refTable := .agents, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false },
      { name := "agent_files_file_workspace_fk", columns := ["file_id", "workspace_id"], refTable := .files, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false }]
    uniques := [
      { name := "agent_files_workspace_agent_file_key", columns := ["workspace_id", "agent_id", "file_id"], kind := .constraint, partialNullColumns := [] }]
    checks := [
      .oneOf "agent_files_access_valid" "access" ["read", "read-write"]] }
  | .agentGrants => {
    table := .agentGrants, source := "agent-grants.ts", tsExport := "agentGrants", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"agent_id", .uuid, true⟩,
      ⟨"user_id", .uuid, true⟩,
      ⟨"created_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "agent_grants_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "agent_grants_agent_workspace_fk", columns := ["agent_id", "workspace_id"], refTable := .agents, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false },
      { name := "agent_grants_member_workspace_fk", columns := ["workspace_id", "user_id"], refTable := .memberships, refColumns := ["workspace_id", "user_id"], onDelete := .cascade, inline := false }]
    uniques := [
      { name := "agent_grants_workspace_agent_user_key", columns := ["workspace_id", "agent_id", "user_id"], kind := .constraint, partialNullColumns := [] }]
    checks := [] }
  | .agentMcpServers => {
    table := .agentMcpServers, source := "agent-mcp-servers.ts", tsExport := "agentMcpServers", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"agent_id", .uuid, true⟩,
      ⟨"mcp_server_id", .uuid, true⟩,
      ⟨"created_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "agent_mcp_servers_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "agent_mcp_servers_agent_workspace_fk", columns := ["agent_id", "workspace_id"], refTable := .agents, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false },
      { name := "agent_mcp_servers_server_workspace_fk", columns := ["mcp_server_id", "workspace_id"], refTable := .mcpServers, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false }]
    uniques := [
      { name := "agent_mcp_servers_workspace_agent_server_key", columns := ["workspace_id", "agent_id", "mcp_server_id"], kind := .constraint, partialNullColumns := [] }]
    checks := [] }
  | .agentSkills => {
    table := .agentSkills, source := "agent-skills.ts", tsExport := "agentSkills", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"agent_id", .uuid, true⟩,
      ⟨"skill_id", .uuid, true⟩,
      ⟨"created_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "agent_skills_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "agent_skills_agent_workspace_fk", columns := ["agent_id", "workspace_id"], refTable := .agents, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false },
      { name := "agent_skills_skill_workspace_fk", columns := ["skill_id", "workspace_id"], refTable := .skills, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false }]
    uniques := [
      { name := "agent_skills_workspace_agent_skill_key", columns := ["workspace_id", "agent_id", "skill_id"], kind := .constraint, partialNullColumns := [] }]
    checks := [] }
  | .agentPointerMoves => {
    table := .agentPointerMoves, source := "agent-pointer-moves.ts", tsExport := "agentPointerMoves", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"agent_id", .uuid, true⟩,
      ⟨"environment", .text, true⟩,
      ⟨"version_id", .uuid, true⟩,
      ⟨"moved_by", .uuid, false⟩,
      ⟨"moved_at", .timestamptz, true⟩,
      ⟨"reason", .text, true⟩]
    foreignKeys := [
      { name := "agent_pointer_moves_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "agent_pointer_moves_agent_workspace_fk", columns := ["agent_id", "workspace_id"], refTable := .agents, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false },
      { name := "agent_pointer_moves_version_fk", columns := ["version_id", "agent_id", "workspace_id"], refTable := .agentVersions, refColumns := ["id", "agent_id", "workspace_id"], onDelete := .cascade, inline := false },
      { name := "agent_pointer_moves_moved_by_principal_workspace_fk", columns := ["workspace_id", "moved_by"], refTable := .workspacePrincipals, refColumns := ["workspace_id", "id"], onDelete := .noAction, inline := false }]
    uniques := []
    checks := [
      .oneOf "agent_pointer_moves_environment_valid" "environment" ["local", "production"],
      .oneOf "agent_pointer_moves_reason_valid" "reason" ["set", "promote", "rollback"]] }
  | .agentVersionEvaluations => {
    table := .agentVersionEvaluations, source := "agent-version-evaluations.ts", tsExport := "agentVersionEvaluations", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"version_id", .uuid, true⟩,
      ⟨"score", .numeric 5 4, true⟩,
      ⟨"passed", .integer, true⟩,
      ⟨"total", .integer, true⟩,
      ⟨"cases_snapshot", .jsonb, true⟩,
      ⟨"results", .jsonb, true⟩,
      ⟨"created_by_principal_id", .uuid, true⟩,
      ⟨"created_at", .timestamptz, true⟩,
      ⟨"status", .text, true⟩,
      ⟨"lease_until", .timestamptz, false⟩]
    foreignKeys := [
      { name := "agent_version_evaluations_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "agent_version_evaluations_version_workspace_fk", columns := ["version_id", "workspace_id"], refTable := .agentVersions, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false },
      { name := "agent_version_evaluations_created_by_principal_workspace_fk", columns := ["workspace_id", "created_by_principal_id"], refTable := .workspacePrincipals, refColumns := ["workspace_id", "id"], onDelete := .noAction, inline := false }]
    uniques := []
    checks := [
      .other "agent_version_evaluations_counts",
      .oneOf "agent_version_evaluations_status_valid" "status" ["running", "completed"]] }
  | .agentVersionPointers => {
    table := .agentVersionPointers, source := "agent-version-pointers.ts", tsExport := "agentVersionPointers", tenancy := .scoped
    primaryKey := ["agent_id", "environment"]
    columns := [
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"agent_id", .uuid, true⟩,
      ⟨"environment", .text, true⟩,
      ⟨"version_id", .uuid, true⟩,
      ⟨"created_at", .timestamptz, true⟩,
      ⟨"updated_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "agent_version_pointers_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "agent_version_pointers_agent_workspace_fk", columns := ["agent_id", "workspace_id"], refTable := .agents, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false },
      { name := "agent_version_pointers_version_fk", columns := ["version_id", "agent_id", "workspace_id"], refTable := .agentVersions, refColumns := ["id", "agent_id", "workspace_id"], onDelete := .cascade, inline := false }]
    uniques := []
    checks := [
      .oneOf "agent_version_pointers_environment_valid" "environment" ["local", "production"]] }
  | .agentVersions => {
    table := .agentVersions, source := "agent-versions.ts", tsExport := "agentVersions", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"agent_id", .uuid, true⟩,
      ⟨"number", .integer, true⟩,
      ⟨"summary", .text, true⟩,
      ⟨"via", .text, true⟩,
      ⟨"body", .jsonb, true⟩,
      ⟨"created_by_principal_id", .uuid, true⟩,
      ⟨"created_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "agent_versions_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "agent_versions_agent_workspace_fk", columns := ["agent_id", "workspace_id"], refTable := .agents, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false },
      { name := "agent_versions_created_by_principal_workspace_fk", columns := ["workspace_id", "created_by_principal_id"], refTable := .workspacePrincipals, refColumns := ["workspace_id", "id"], onDelete := .noAction, inline := false }]
    uniques := [
      { name := "agent_versions_workspace_agent_number_key", columns := ["workspace_id", "agent_id", "number"], kind := .constraint, partialNullColumns := [] },
      { name := "agent_versions_id_workspace_key", columns := ["id", "workspace_id"], kind := .constraint, partialNullColumns := [] },
      { name := "agent_versions_id_agent_workspace_key", columns := ["id", "agent_id", "workspace_id"], kind := .constraint, partialNullColumns := [] }]
    checks := [
      .oneOf "agent_versions_via_valid" "via" ["ui", "aw-push", "api"],
      .other "agent_versions_number_positive"] }
  | .agents => {
    table := .agents, source := "agents.ts", tsExport := "agents", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"name", .text, true⟩,
      ⟨"instructions", .text, true⟩,
      ⟨"model_connection_id", .uuid, false⟩,
      ⟨"model", .text, false⟩,
      ⟨"runtime_profile_id", .uuid, false⟩,
      ⟨"permissions", .jsonb, true⟩,
      ⟨"policy", .jsonb, false⟩,
      ⟨"created_by", .uuid, false⟩,
      ⟨"owner_principal_id", .uuid, true⟩,
      ⟨"setup_configured_at", .timestamptz, false⟩,
      ⟨"materialised_version_id", .uuid, false⟩,
      ⟨"created_at", .timestamptz, true⟩,
      ⟨"updated_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "agents_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "agents_model_connection_id_model_connections_id_fk", columns := ["model_connection_id"], refTable := .modelConnections, refColumns := ["id"], onDelete := .setNull, inline := true },
      { name := "agents_runtime_profile_id_runtime_profiles_id_fk", columns := ["runtime_profile_id"], refTable := .runtimeProfiles, refColumns := ["id"], onDelete := .setNull, inline := true },
      { name := "agents_model_connection_workspace_fk", columns := ["model_connection_id", "workspace_id"], refTable := .modelConnections, refColumns := ["id", "workspace_id"], onDelete := .noAction, inline := false },
      { name := "agents_runtime_profile_workspace_fk", columns := ["runtime_profile_id", "workspace_id"], refTable := .runtimeProfiles, refColumns := ["id", "workspace_id"], onDelete := .noAction, inline := false },
      { name := "agents_created_by_workspace_fk", columns := ["workspace_id", "created_by"], refTable := .memberships, refColumns := ["workspace_id", "user_id"], onDelete := .noAction, inline := false },
      { name := "agents_owner_principal_workspace_fk", columns := ["workspace_id", "owner_principal_id"], refTable := .workspacePrincipals, refColumns := ["workspace_id", "id"], onDelete := .noAction, inline := false },
      { name := "agents_materialised_version_fk", columns := ["materialised_version_id", "id", "workspace_id"], refTable := .agentVersions, refColumns := ["id", "agent_id", "workspace_id"], onDelete := .noAction, inline := false }]
    uniques := [
      { name := "agents_id_workspace_key", columns := ["id", "workspace_id"], kind := .constraint, partialNullColumns := [] },
      { name := "agents_workspace_name_key", columns := ["workspace_id", "name"], kind := .index, partialNullColumns := [] }]
    checks := [
      .other "agents_name_not_blank"] }
  | .apiKeys => {
    table := .apiKeys, source := "api-keys.ts", tsExport := "apiKeys", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"name", .text, true⟩,
      ⟨"role", .text, true⟩,
      ⟨"key_prefix", .text, true⟩,
      ⟨"key_hash", .text, true⟩,
      ⟨"last_used_at", .timestamptz, false⟩,
      ⟨"expires_at", .timestamptz, false⟩,
      ⟨"revoked_at", .timestamptz, false⟩,
      ⟨"created_at", .timestamptz, true⟩,
      ⟨"updated_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "api_keys_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true }]
    uniques := [
      { name := "api_keys_workspace_id_key", columns := ["workspace_id", "id"], kind := .constraint, partialNullColumns := [] },
      { name := "api_keys_workspace_name_key", columns := ["workspace_id", "name"], kind := .index, partialNullColumns := [] },
      { name := "api_keys_key_hash_key", columns := ["key_hash"], kind := .index, partialNullColumns := [] }]
    checks := [
      .oneOf "api_keys_role_valid" "role" ["owner", "admin", "builder", "viewer"],
      .other "api_keys_name_not_blank",
      .other "api_keys_key_prefix_not_blank",
      .other "api_keys_key_hash_not_blank",
      .other "api_keys_expires_after_created",
      .other "api_keys_revoked_after_created"] }
  | .auditEvents => {
    table := .auditEvents, source := "audit-events.ts", tsExport := "auditEvents", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"actor_user_id", .uuid, false⟩,
      ⟨"actor_principal_id", .uuid, false⟩,
      ⟨"actor_label", .text, true⟩,
      ⟨"action", .text, true⟩,
      ⟨"subject_id", .text, false⟩,
      ⟨"subject_label", .text, true⟩,
      ⟨"created_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "audit_events_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "audit_events_actor_user_id_users_id_fk", columns := ["actor_user_id"], refTable := .users, refColumns := ["id"], onDelete := .setNull, inline := true },
      { name := "audit_events_actor_principal_workspace_fk", columns := ["workspace_id", "actor_principal_id"], refTable := .workspacePrincipals, refColumns := ["workspace_id", "id"], onDelete := .noAction, inline := false }]
    uniques := []
    checks := [
      .oneOf "audit_events_action_valid" "action" ["user-created", "user-deleted", "agent-changed", "provider-credential-changed", "api-key-created", "api-key-revoked", "connector-changed", "permission-changed", "runtime-profile-changed", "project-created", "project-deleted", "project-archived", "project-restored", "session-published", "public-link-revoked", "runnable-link-stopped", "public-sharing-policy-changed", "invitation-created", "invitation-resent", "invitation-revoked", "invitation-accepted", "endpoint-client-created", "endpoint-client-changed", "endpoint-client-revoked", "endpoint-tool-called", "oauth-client-secret-rotated", "oauth-grant-issued", "oauth-grant-revoked"],
      .other "audit_events_actor_label_not_blank",
      .other "audit_events_subject_label_not_blank",
      .other "audit_events_subject_id_shape"] }
  | .browserTokens => {
    table := .browserTokens, source := "browser-tokens.ts", tsExport := "browserTokens", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"minted_by_principal_id", .uuid, true⟩,
      ⟨"scope_kind", .text, true⟩,
      ⟨"run_id", .uuid, false⟩,
      ⟨"session_id", .uuid, false⟩,
      ⟨"token_hash", .text, true⟩,
      ⟨"expires_at", .timestamptz, true⟩,
      ⟨"revoked_at", .timestamptz, false⟩,
      ⟨"created_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "browser_tokens_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "browser_tokens_run_workspace_fk", columns := ["run_id", "workspace_id"], refTable := .runs, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false },
      { name := "browser_tokens_session_workspace_fk", columns := ["session_id", "workspace_id"], refTable := .sessions, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false },
      { name := "browser_tokens_minter_workspace_fk", columns := ["workspace_id", "minted_by_principal_id"], refTable := .workspacePrincipals, refColumns := ["workspace_id", "id"], onDelete := .cascade, inline := false }]
    uniques := [
      { name := "browser_tokens_hash_key", columns := ["token_hash"], kind := .index, partialNullColumns := [] }]
    checks := [
      .oneOf "browser_tokens_scope_kind_valid" "scope_kind" ["run", "session"],
      .other "browser_tokens_scope_xor",
      .other "browser_tokens_expiry_after_created",
      .other "browser_tokens_revoked_after_created"] }
  | .cliSessions => {
    table := .cliSessions, source := "cli-sessions.ts", tsExport := "cliSessions", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"user_id", .uuid, true⟩,
      ⟨"user_code", .text, true⟩,
      ⟨"status", .text, true⟩,
      ⟨"approval_expires_at", .timestamptz, true⟩,
      ⟨"token_hash", .text, false⟩,
      ⟨"expires_at", .timestamptz, false⟩,
      ⟨"revoked_at", .timestamptz, false⟩,
      ⟨"created_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "cli_sessions_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "cli_sessions_member_workspace_fk", columns := ["workspace_id", "user_id"], refTable := .memberships, refColumns := ["workspace_id", "user_id"], onDelete := .cascade, inline := false }]
    uniques := [
      { name := "cli_sessions_user_code_key", columns := ["user_code"], kind := .index, partialNullColumns := [] },
      { name := "cli_sessions_token_hash_key", columns := ["token_hash"], kind := .index, partialNullColumns := [] }]
    checks := [
      .oneOf "cli_sessions_status_valid" "status" ["approved", "denied", "active", "revoked"],
      .other "cli_sessions_user_code_shape",
      .other "cli_sessions_token_iff_issued",
      .other "cli_sessions_revoked_iff_status",
      .other "cli_sessions_expiry_after_created"] }
  | .endpointClientAgents => {
    table := .endpointClientAgents, source := "endpoint-client-agents.ts", tsExport := "endpointClientAgents", tenancy := .scoped
    primaryKey := ["client_id", "agent_id"]
    columns := [
      ⟨"client_id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"agent_id", .uuid, true⟩]
    foreignKeys := [
      { name := "endpoint_client_agents_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "endpoint_client_agents_client_workspace_fk", columns := ["workspace_id", "client_id"], refTable := .endpointClients, refColumns := ["workspace_id", "id"], onDelete := .cascade, inline := false },
      { name := "endpoint_client_agents_agent_workspace_fk", columns := ["agent_id", "workspace_id"], refTable := .agents, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false }]
    uniques := []
    checks := [] }
  | .endpointClientApiKeys => {
    table := .endpointClientApiKeys, source := "endpoint-client-api-keys.ts", tsExport := "endpointClientApiKeys", tenancy := .scoped
    primaryKey := ["api_key_id"]
    columns := [
      ⟨"api_key_id", .uuid, true⟩,
      ⟨"client_id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩]
    foreignKeys := [
      { name := "endpoint_client_api_keys_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "endpoint_client_api_keys_client_workspace_fk", columns := ["workspace_id", "client_id"], refTable := .endpointClients, refColumns := ["workspace_id", "id"], onDelete := .cascade, inline := false },
      { name := "endpoint_client_api_keys_api_key_workspace_fk", columns := ["workspace_id", "api_key_id"], refTable := .apiKeys, refColumns := ["workspace_id", "id"], onDelete := .cascade, inline := false }]
    uniques := []
    checks := [] }
  | .endpointClients => {
    table := .endpointClients, source := "endpoint-clients.ts", tsExport := "endpointClients", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"name", .text, true⟩,
      ⟨"kind", .text, true⟩,
      ⟨"tool_names", .textArray, false⟩,
      ⟨"acts_for_principal_id", .uuid, true⟩,
      ⟨"created_by_principal_id", .uuid, true⟩,
      ⟨"client_secret_hash", .text, false⟩,
      ⟨"redirect_uris", .textArray, true⟩,
      ⟨"client_secret_rotated_at", .timestamptz, false⟩,
      ⟨"revoked_at", .timestamptz, false⟩,
      ⟨"created_at", .timestamptz, true⟩,
      ⟨"updated_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "endpoint_clients_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "endpoint_clients_acts_for_workspace_fk", columns := ["workspace_id", "acts_for_principal_id"], refTable := .workspacePrincipals, refColumns := ["workspace_id", "id"], onDelete := .cascade, inline := false },
      { name := "endpoint_clients_created_by_workspace_fk", columns := ["workspace_id", "created_by_principal_id"], refTable := .workspacePrincipals, refColumns := ["workspace_id", "id"], onDelete := .cascade, inline := false }]
    uniques := [
      { name := "endpoint_clients_workspace_id_key", columns := ["workspace_id", "id"], kind := .constraint, partialNullColumns := [] },
      { name := "endpoint_clients_workspace_kind_name_key", columns := ["workspace_id", "kind", "name"], kind := .index, partialNullColumns := [] }]
    checks := [
      .oneOf "endpoint_clients_kind_valid" "kind" ["mcp-project", "a2a-agent"],
      .other "endpoint_clients_tool_names_mcp_only",
      .other "endpoint_clients_redirect_uris_max",
      .other "endpoint_clients_revoked_after_created"] }
  | .files => {
    table := .files, source := "files.ts", tsExport := "files", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"path", .text, true⟩,
      ⟨"kind", .text, true⟩,
      ⟨"storage_key", .text, false⟩,
      ⟨"size_bytes", .bigint, true⟩,
      ⟨"content_type", .text, false⟩,
      ⟨"created_by", .uuid, false⟩,
      ⟨"owner_principal_id", .uuid, true⟩,
      ⟨"created_at", .timestamptz, true⟩,
      ⟨"updated_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "files_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "files_created_by_workspace_fk", columns := ["workspace_id", "created_by"], refTable := .memberships, refColumns := ["workspace_id", "user_id"], onDelete := .noAction, inline := false },
      { name := "files_owner_principal_workspace_fk", columns := ["workspace_id", "owner_principal_id"], refTable := .workspacePrincipals, refColumns := ["workspace_id", "id"], onDelete := .noAction, inline := false }]
    uniques := [
      { name := "files_id_workspace_key", columns := ["id", "workspace_id"], kind := .constraint, partialNullColumns := [] },
      { name := "files_workspace_path_key", columns := ["workspace_id", "path"], kind := .index, partialNullColumns := [] }]
    checks := [
      .oneOf "files_kind_valid" "kind" ["file", "folder"],
      .other "files_path_shape",
      .other "files_path_no_dot_segments",
      .other "files_storage_key_iff_file",
      .other "files_storage_key_not_blank",
      .other "files_size_non_negative",
      .other "files_folder_has_no_content"] }
  | .invitations => {
    table := .invitations, source := "invitations.ts", tsExport := "invitations", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"email", .text, true⟩,
      ⟨"role", .text, true⟩,
      ⟨"invited_by", .uuid, false⟩,
      ⟨"token_hash", .text, true⟩,
      ⟨"expires_at", .timestamptz, true⟩,
      ⟨"accepted_at", .timestamptz, false⟩,
      ⟨"revoked_at", .timestamptz, false⟩,
      ⟨"created_at", .timestamptz, true⟩,
      ⟨"updated_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "invitations_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "invitations_invited_by_users_id_fk", columns := ["invited_by"], refTable := .users, refColumns := ["id"], onDelete := .setNull, inline := true }]
    uniques := [
      { name := "invitations_workspace_email_pending_key", columns := ["workspace_id", "email"], kind := .index, partialNullColumns := ["accepted_at", "revoked_at"] }]
    checks := [
      .oneOf "invitations_role_valid" "role" ["owner", "admin", "builder", "viewer"],
      .other "invitations_email_lowercase",
      .other "invitations_email_shape",
      .other "invitations_token_hash_not_blank",
      .other "invitations_expires_after_created",
      .other "invitations_accepted_after_created",
      .other "invitations_revoked_after_created",
      .other "invitations_not_accepted_and_revoked"] }
  | .mcpServers => {
    table := .mcpServers, source := "mcp-servers.ts", tsExport := "mcpServers", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"name", .text, true⟩,
      ⟨"kind", .text, true⟩,
      ⟨"transport", .text, false⟩,
      ⟨"command", .text, false⟩,
      ⟨"args", .jsonb, false⟩,
      ⟨"url", .text, false⟩,
      ⟨"tool_config", .jsonb, false⟩,
      ⟨"openapi_document", .text, false⟩,
      ⟨"auth_type", .text, true⟩,
      ⟨"credential_secret_id", .uuid, false⟩,
      ⟨"enabled", .boolean, true⟩,
      ⟨"created_by", .uuid, false⟩,
      ⟨"owner_principal_id", .uuid, true⟩,
      ⟨"created_at", .timestamptz, true⟩,
      ⟨"updated_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "mcp_servers_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "mcp_servers_created_by_workspace_fk", columns := ["workspace_id", "created_by"], refTable := .memberships, refColumns := ["workspace_id", "user_id"], onDelete := .noAction, inline := false },
      { name := "mcp_servers_credential_secret_workspace_fk", columns := ["credential_secret_id", "workspace_id"], refTable := .secrets, refColumns := ["id", "workspace_id"], onDelete := .restrict, inline := false },
      { name := "mcp_servers_owner_principal_workspace_fk", columns := ["workspace_id", "owner_principal_id"], refTable := .workspacePrincipals, refColumns := ["workspace_id", "id"], onDelete := .noAction, inline := false }]
    uniques := [
      { name := "mcp_servers_id_workspace_key", columns := ["id", "workspace_id"], kind := .constraint, partialNullColumns := [] },
      { name := "mcp_servers_workspace_name_key", columns := ["workspace_id", "name"], kind := .index, partialNullColumns := [] }]
    checks := [
      .oneOf "mcp_servers_kind_valid" "kind" ["mcp", "openapi", "postgres"],
      .oneOf "mcp_servers_transport_valid" "transport" ["stdio", "http", "sse"],
      .oneOf "mcp_servers_auth_type_valid" "auth_type" ["none", "api-key", "bearer", "oauth"],
      .other "mcp_servers_transport_by_kind",
      .other "mcp_servers_tool_kind_fields",
      .other "mcp_servers_tool_config_by_kind",
      .other "mcp_servers_tool_config_is_object",
      .other "mcp_servers_tool_credential",
      .other "mcp_servers_stdio_has_command",
      .other "mcp_servers_remote_has_url",
      .other "mcp_servers_args_are_stdio_only",
      .other "mcp_servers_command_not_blank",
      .other "mcp_servers_url_shape",
      .other "mcp_servers_credential_required",
      .other "mcp_servers_name_not_blank"] }
  | .memberships => {
    table := .memberships, source := "memberships.ts", tsExport := "memberships", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"user_id", .uuid, true⟩,
      ⟨"role", .text, true⟩,
      ⟨"created_at", .timestamptz, true⟩,
      ⟨"updated_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "memberships_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "memberships_user_id_users_id_fk", columns := ["user_id"], refTable := .users, refColumns := ["id"], onDelete := .cascade, inline := true }]
    uniques := [
      { name := "memberships_workspace_user_key", columns := ["workspace_id", "user_id"], kind := .constraint, partialNullColumns := [] },
      { name := "memberships_workspace_id_key", columns := ["workspace_id", "id"], kind := .constraint, partialNullColumns := [] }]
    checks := [
      .oneOf "memberships_role_valid" "role" ["owner", "admin", "builder", "viewer"]] }
  | .modelConnections => {
    table := .modelConnections, source := "model-connections.ts", tsExport := "modelConnections", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"name", .text, true⟩,
      ⟨"provider", .text, true⟩,
      ⟨"config", .jsonb, true⟩,
      ⟨"created_at", .timestamptz, true⟩,
      ⟨"updated_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "model_connections_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true }]
    uniques := [
      { name := "model_connections_id_workspace_key", columns := ["id", "workspace_id"], kind := .constraint, partialNullColumns := [] },
      { name := "model_connections_workspace_name_key", columns := ["workspace_id", "name"], kind := .index, partialNullColumns := [] }]
    checks := [
      .oneOf "model_connections_provider_valid" "provider" ["anthropic", "anthropic-compatible", "openai", "azure-openai", "openai-compatible"]] }
  | .oauthTokens => {
    table := .oauthTokens, source := "oauth-tokens.ts", tsExport := "oauthTokens", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"client_id", .uuid, true⟩,
      ⟨"kind", .text, true⟩,
      ⟨"token_hash", .text, true⟩,
      ⟨"subject_principal_id", .uuid, true⟩,
      ⟨"resource", .text, true⟩,
      ⟨"family_id", .uuid, true⟩,
      ⟨"code_challenge", .text, false⟩,
      ⟨"redirect_uri", .text, false⟩,
      ⟨"expires_at", .timestamptz, true⟩,
      ⟨"used_at", .timestamptz, false⟩,
      ⟨"revoked_at", .timestamptz, false⟩,
      ⟨"created_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "oauth_tokens_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "oauth_tokens_client_workspace_fk", columns := ["workspace_id", "client_id"], refTable := .endpointClients, refColumns := ["workspace_id", "id"], onDelete := .cascade, inline := false },
      { name := "oauth_tokens_subject_workspace_fk", columns := ["workspace_id", "subject_principal_id"], refTable := .workspacePrincipals, refColumns := ["workspace_id", "id"], onDelete := .cascade, inline := false }]
    uniques := [
      { name := "oauth_tokens_hash_key", columns := ["token_hash"], kind := .index, partialNullColumns := [] }]
    checks := [
      .oneOf "oauth_tokens_kind_valid" "kind" ["code", "access", "refresh"],
      .other "oauth_tokens_code_fields",
      .other "oauth_tokens_expiry_after_created"] }
  | .projectFiles => {
    table := .projectFiles, source := "project-files.ts", tsExport := "projectFiles", tenancy := .scoped
    primaryKey := ["project_id", "file_id"]
    columns := [
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"project_id", .uuid, true⟩,
      ⟨"file_id", .uuid, true⟩]
    foreignKeys := [
      { name := "project_files_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "project_files_project_workspace_fk", columns := ["project_id", "workspace_id"], refTable := .projects, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false },
      { name := "project_files_file_workspace_fk", columns := ["file_id", "workspace_id"], refTable := .files, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false }]
    uniques := []
    checks := [] }
  | .projectMcpServers => {
    table := .projectMcpServers, source := "project-mcp-servers.ts", tsExport := "projectMcpServers", tenancy := .scoped
    primaryKey := ["project_id", "mcp_server_id"]
    columns := [
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"project_id", .uuid, true⟩,
      ⟨"mcp_server_id", .uuid, true⟩]
    foreignKeys := [
      { name := "project_mcp_servers_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "project_mcp_servers_project_workspace_fk", columns := ["project_id", "workspace_id"], refTable := .projects, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false },
      { name := "project_mcp_servers_server_workspace_fk", columns := ["mcp_server_id", "workspace_id"], refTable := .mcpServers, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false }]
    uniques := []
    checks := [] }
  | .projects => {
    table := .projects, source := "projects.ts", tsExport := "projects", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"name", .text, true⟩,
      ⟨"instructions", .text, false⟩,
      ⟨"default_agent_id", .uuid, false⟩,
      ⟨"visibility", .text, true⟩,
      ⟨"default_model_connection_id", .uuid, false⟩,
      ⟨"default_model", .text, false⟩,
      ⟨"created_by", .uuid, false⟩,
      ⟨"owner_principal_id", .uuid, true⟩,
      ⟨"archived_at", .timestamptz, false⟩,
      ⟨"created_at", .timestamptz, true⟩,
      ⟨"updated_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "projects_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "projects_default_model_connection_id_model_connections_id_fk", columns := ["default_model_connection_id"], refTable := .modelConnections, refColumns := ["id"], onDelete := .setNull, inline := true },
      { name := "projects_created_by_users_id_fk", columns := ["created_by"], refTable := .users, refColumns := ["id"], onDelete := .restrict, inline := true },
      { name := "projects_default_agent_workspace_fk", columns := ["default_agent_id", "workspace_id"], refTable := .agents, refColumns := ["id", "workspace_id"], onDelete := .setNull, inline := false },
      { name := "projects_default_model_connection_workspace_fk", columns := ["default_model_connection_id", "workspace_id"], refTable := .modelConnections, refColumns := ["id", "workspace_id"], onDelete := .noAction, inline := false },
      { name := "projects_owner_principal_workspace_fk", columns := ["workspace_id", "owner_principal_id"], refTable := .workspacePrincipals, refColumns := ["workspace_id", "id"], onDelete := .noAction, inline := false }]
    uniques := [
      { name := "projects_id_workspace_key", columns := ["id", "workspace_id"], kind := .constraint, partialNullColumns := [] },
      { name := "projects_workspace_name_key", columns := ["workspace_id", "name"], kind := .index, partialNullColumns := [] }]
    checks := [
      .oneOf "projects_visibility_valid" "visibility" ["private", "workspace", "public"],
      .other "projects_name_not_blank",
      .other "projects_default_model_pair"] }
  | .runs => {
    table := .runs, source := "runs.ts", tsExport := "runs", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"session_id", .uuid, true⟩,
      ⟨"status", .text, true⟩,
      ⟨"model", .text, false⟩,
      ⟨"provider", .text, false⟩,
      ⟨"engine", .text, false⟩,
      ⟨"engine_version", .text, false⟩,
      ⟨"model_connection_id", .uuid, false⟩,
      ⟨"tool_connector_ids", .uuidArray, true⟩,
      ⟨"tool_sandbox_origin", .text, false⟩,
      ⟨"started_at", .timestamptz, false⟩,
      ⟨"ended_at", .timestamptz, false⟩,
      ⟨"input_tokens", .integer, true⟩,
      ⟨"output_tokens", .integer, true⟩,
      ⟨"cache_read_input_tokens", .integer, true⟩,
      ⟨"cache_creation_input_tokens", .integer, true⟩,
      ⟨"cost_usd", .numeric 14 6, true⟩,
      ⟨"cost_currency", .text, true⟩,
      ⟨"price_table_version", .text, false⟩,
      ⟨"tool_calls", .integer, true⟩,
      ⟨"error", .text, false⟩,
      ⟨"prompt", .text, false⟩,
      ⟨"accounting_state", .text, true⟩,
      ⟨"accounting_error", .text, false⟩,
      ⟨"created_at", .timestamptz, true⟩,
      ⟨"updated_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "runs_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "runs_model_connection_id_model_connections_id_fk", columns := ["model_connection_id"], refTable := .modelConnections, refColumns := ["id"], onDelete := .setNull, inline := true },
      { name := "runs_session_workspace_fk", columns := ["session_id", "workspace_id"], refTable := .sessions, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false },
      { name := "runs_model_connection_workspace_fk", columns := ["model_connection_id", "workspace_id"], refTable := .modelConnections, refColumns := ["id", "workspace_id"], onDelete := .noAction, inline := false }]
    uniques := [
      { name := "runs_id_workspace_unique", columns := ["id", "workspace_id"], kind := .index, partialNullColumns := [] }]
    checks := [
      .oneOf "runs_status_valid" "status" ["queued", "running", "completed", "failed", "cancelled"],
      .oneOf "runs_provider_valid" "provider" ["anthropic", "anthropic-compatible", "openai", "azure-openai", "openai-compatible"],
      .oneOf "runs_engine_valid" "engine" ["claude-agent-sdk", "openai-agents", "pi", "mastra"],
      .oneOf "runs_accounting_state_valid" "accounting_state" ["pending", "complete", "partial", "failed", "unavailable"],
      .other "runs_ended_at_iff_terminal",
      .other "runs_ended_after_started",
      .other "runs_counters_non_negative",
      .other "runs_cost_currency_usd",
      .other "runs_price_version_matches_accounting_state",
      .other "runs_unpriced_cost_zero"] }
  | .runEvents => {
    table := .runEvents, source := "run-events.ts", tsExport := "runEvents", tenancy := .scoped
    primaryKey := ["run_id", "sequence"]
    columns := [
      ⟨"run_id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"sequence", .bigint, true⟩,
      ⟨"type", .text, true⟩,
      ⟨"data", .jsonb, true⟩,
      ⟨"created_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "run_events_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "run_events_run_workspace_fk", columns := ["run_id", "workspace_id"], refTable := .runs, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false }]
    uniques := []
    checks := [] }
  | .runFeedback => {
    table := .runFeedback, source := "run-feedback.ts", tsExport := "runFeedback", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"run_id", .uuid, true⟩,
      ⟨"rating", .text, true⟩,
      ⟨"comment", .text, false⟩,
      ⟨"created_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "run_feedback_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "run_feedback_run_workspace_fk", columns := ["run_id", "workspace_id"], refTable := .runs, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false }]
    uniques := []
    checks := [
      .oneOf "run_feedback_rating_valid" "rating" ["up", "down"],
      .other "run_feedback_comment_length"] }
  | .runUsageRecords => {
    table := .runUsageRecords, source := "run-usage-records.ts", tsExport := "runUsageRecords", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"run_id", .uuid, true⟩,
      ⟨"provider_response_id", .text, true⟩,
      ⟨"provider", .text, true⟩,
      ⟨"model", .text, true⟩,
      ⟨"input_tokens", .integer, true⟩,
      ⟨"output_tokens", .integer, true⟩,
      ⟨"cache_read_input_tokens", .integer, true⟩,
      ⟨"cache_creation_input_tokens", .integer, true⟩,
      ⟨"tool_calls", .integer, true⟩,
      ⟨"cost_usd", .numeric 14 6, true⟩,
      ⟨"cost_currency", .text, true⟩,
      ⟨"wire_protocol", .text, true⟩,
      ⟨"price_table_version", .text, false⟩,
      ⟨"created_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "run_usage_records_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "run_usage_records_run_workspace_fk", columns := ["run_id", "workspace_id"], refTable := .runs, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false }]
    uniques := [
      { name := "run_usage_records_response_unique", columns := ["run_id", "provider_response_id"], kind := .index, partialNullColumns := [] }]
    checks := [
      .other "run_usage_records_counters_non_negative",
      .other "run_usage_records_currency_usd",
      .oneOf "run_usage_records_wire_protocol_known" "wire_protocol"
        ["anthropic-messages", "openai-responses", "openai-chat-completions"]] }
  | .runTokens => {
    table := .runTokens, source := "run-tokens.ts", tsExport := "runTokens", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"run_id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"token_hash", .text, true⟩,
      ⟨"expires_at", .timestamptz, true⟩,
      ⟨"revoked_at", .timestamptz, false⟩,
      ⟨"created_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "run_tokens_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "run_tokens_run_workspace_fk", columns := ["run_id", "workspace_id"], refTable := .runs, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false }]
    uniques := [
      { name := "run_tokens_hash_key", columns := ["token_hash"], kind := .index, partialNullColumns := [] }]
    checks := [
      .other "run_tokens_expiry_after_created",
      .other "run_tokens_revoked_after_created"] }
  | .runtimeProfiles => {
    table := .runtimeProfiles, source := "runtime-profiles.ts", tsExport := "runtimeProfiles", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"name", .text, true⟩,
      ⟨"driver", .text, true⟩,
      ⟨"runtime_connection_id", .uuid, false⟩,
      ⟨"cpu", .integer, false⟩,
      ⟨"memory_mb", .integer, false⟩,
      ⟨"disk_mb", .integer, false⟩,
      ⟨"network_policy", .text, true⟩,
      ⟨"allowed_domains", .jsonb, false⟩,
      ⟨"filesystem", .text, true⟩,
      ⟨"persist_paths", .jsonb, false⟩,
      ⟨"timeout_seconds", .integer, false⟩,
      ⟨"idle_timeout_seconds", .integer, false⟩,
      ⟨"driver_config", .jsonb, false⟩,
      ⟨"workspace_default", .boolean, false⟩,
      ⟨"created_at", .timestamptz, true⟩,
      ⟨"updated_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "runtime_profiles_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "runtime_profiles_runtime_connection_id_secrets_id_fk", columns := ["runtime_connection_id"], refTable := .secrets, refColumns := ["id"], onDelete := .setNull, inline := true },
      { name := "runtime_profiles_runtime_connection_workspace_fk", columns := ["runtime_connection_id", "workspace_id"], refTable := .secrets, refColumns := ["id", "workspace_id"], onDelete := .noAction, inline := false }]
    uniques := [
      { name := "runtime_profiles_id_workspace_key", columns := ["id", "workspace_id"], kind := .constraint, partialNullColumns := [] },
      { name := "runtime_profiles_workspace_default_key", columns := ["workspace_id", "workspace_default"], kind := .constraint, partialNullColumns := [] },
      { name := "runtime_profiles_workspace_name_key", columns := ["workspace_id", "name"], kind := .index, partialNullColumns := [] }]
    checks := [
      .other "runtime_profiles_name_not_blank",
      .other "runtime_profiles_workspace_default_true_or_null",
      .oneOf "runtime_profiles_driver_valid" "driver" ["local", "sandbox-runtime", "docker", "kubernetes", "gke-agent-sandbox", "aca-sessions", "aws-agentcore", "aws-ecs", "cloud-run-sandbox", "cloud-run-service", "external", "vercel-sandbox", "cloudflare-sandbox"],
      .oneOf "runtime_profiles_network_policy_valid" "network_policy" ["none", "restricted", "open"],
      .oneOf "runtime_profiles_filesystem_valid" "filesystem" ["read-only", "read-write"]] }
  | .runtimeVerifications => {
    table := .runtimeVerifications, source := "runtime-verifications.ts", tsExport := "runtimeVerifications", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"driver_id", .text, true⟩,
      ⟨"configuration_key", .text, true⟩,
      ⟨"fingerprint", .text, true⟩,
      ⟨"verified_at", .timestamptz, true⟩,
      ⟨"expires_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "runtime_verifications_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true }]
    uniques := [
      { name := "runtime_verifications_workspace_driver_key", columns := ["workspace_id", "driver_id"], kind := .index, partialNullColumns := [] }]
    checks := [] }
  | .secrets => {
    table := .secrets, source := "secrets.ts", tsExport := "secrets", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"name", .text, true⟩,
      ⟨"algorithm", .text, true⟩,
      ⟨"master_key_id", .text, true⟩,
      ⟨"wrapped_data_key", .bytea, true⟩,
      ⟨"wrapped_data_key_nonce", .bytea, true⟩,
      ⟨"wrapped_data_key_tag", .bytea, true⟩,
      ⟨"ciphertext", .bytea, true⟩,
      ⟨"ciphertext_nonce", .bytea, true⟩,
      ⟨"ciphertext_tag", .bytea, true⟩,
      ⟨"created_at", .timestamptz, true⟩,
      ⟨"updated_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "secrets_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true }]
    uniques := [
      { name := "secrets_id_workspace_key", columns := ["id", "workspace_id"], kind := .constraint, partialNullColumns := [] },
      { name := "secrets_workspace_name_key", columns := ["workspace_id", "name"], kind := .index, partialNullColumns := [] }]
    checks := [
      .other "secrets_name_shape",
      .other "secrets_master_key_id_not_blank",
      .oneOf "secrets_algorithm_valid" "algorithm" ["aes-256-gcm"],
      .other "secrets_wrapped_data_key_size",
      .other "secrets_nonce_sizes",
      .other "secrets_tag_sizes",
      .other "secrets_ciphertext_not_empty"] }
  | .sessionMessages => {
    table := .sessionMessages, source := "session-messages.ts", tsExport := "sessionMessages", tenancy := .scoped
    primaryKey := ["workspace_id", "project_key", "session_id", "subpath", "sequence"]
    columns := [
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"project_key", .text, true⟩,
      ⟨"session_id", .uuid, true⟩,
      ⟨"subpath", .text, true⟩,
      ⟨"sequence", .bigint, true⟩,
      ⟨"position", .bigint, true⟩,
      ⟨"entry_uuid", .text, false⟩,
      ⟨"entry", .jsonb, true⟩,
      ⟨"created_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "session_messages_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "session_messages_transcript_fk", columns := ["workspace_id", "project_key", "session_id", "subpath"], refTable := .sessionTranscripts, refColumns := ["workspace_id", "project_key", "session_id", "subpath"], onDelete := .cascade, inline := false }]
    uniques := []
    checks := [] }
  | .sessionStateStreams => {
    table := .sessionStateStreams, source := "session-state-streams.ts", tsExport := "sessionStateStreams", tenancy := .scoped
    primaryKey := ["workspace_id", "session_id", "engine", "stream_key"]
    columns := [
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"session_id", .uuid, true⟩,
      ⟨"engine", .text, true⟩,
      ⟨"stream_key", .text, true⟩,
      ⟨"created_at", .timestamptz, true⟩,
      ⟨"updated_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "session_state_streams_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "session_state_streams_session_workspace_fk", columns := ["session_id", "workspace_id"], refTable := .sessions, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false }]
    uniques := []
    checks := [
      .oneOf "session_state_streams_engine_valid" "engine" ["claude-agent-sdk", "openai-agents", "pi", "mastra"]] }
  | .sessionStateEntries => {
    table := .sessionStateEntries, source := "session-state-entries.ts", tsExport := "sessionStateEntries", tenancy := .scoped
    primaryKey := ["workspace_id", "session_id", "engine", "stream_key", "sequence"]
    columns := [
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"session_id", .uuid, true⟩,
      ⟨"engine", .text, true⟩,
      ⟨"stream_key", .text, true⟩,
      ⟨"sequence", .bigint, true⟩,
      ⟨"entry_key", .text, false⟩,
      ⟨"entry", .jsonb, true⟩,
      ⟨"created_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "session_state_entries_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "session_state_entries_stream_fk", columns := ["workspace_id", "session_id", "engine", "stream_key"], refTable := .sessionStateStreams, refColumns := ["workspace_id", "session_id", "engine", "stream_key"], onDelete := .cascade, inline := false }]
    uniques := [
      { name := "session_state_entries_key_unique", columns := ["workspace_id", "session_id", "engine", "stream_key", "entry_key"], kind := .index, partialNullColumns := [] }]
    checks := [
      .oneOf "session_state_entries_engine_valid" "engine" ["claude-agent-sdk", "openai-agents", "pi", "mastra"]] }
  | .sessionStateBlobs => {
    table := .sessionStateBlobs, source := "session-state-blobs.ts", tsExport := "sessionStateBlobs", tenancy := .scoped
    primaryKey := ["workspace_id", "session_id", "engine", "blob_key"]
    columns := [
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"session_id", .uuid, true⟩,
      ⟨"engine", .text, true⟩,
      ⟨"blob_key", .text, true⟩,
      ⟨"storage_key", .text, true⟩,
      ⟨"size_bytes", .bigint, true⟩,
      ⟨"sha256", .text, true⟩,
      ⟨"created_at", .timestamptz, true⟩,
      ⟨"updated_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "session_state_blobs_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "session_state_blobs_session_workspace_fk", columns := ["session_id", "workspace_id"], refTable := .sessions, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false }]
    uniques := []
    checks := [
      .oneOf "session_state_blobs_engine_valid" "engine" ["claude-agent-sdk", "openai-agents", "pi", "mastra"]] }
  | .sessionTranscripts => {
    table := .sessionTranscripts, source := "session-transcripts.ts", tsExport := "sessionTranscripts", tenancy := .scoped
    primaryKey := ["workspace_id", "project_key", "session_id", "subpath"]
    columns := [
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"project_key", .text, true⟩,
      ⟨"session_id", .uuid, true⟩,
      ⟨"subpath", .text, true⟩,
      ⟨"created_at", .timestamptz, true⟩,
      ⟨"updated_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "session_transcripts_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "session_transcripts_session_workspace_fk", columns := ["session_id", "workspace_id"], refTable := .sessions, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false }]
    uniques := []
    checks := [] }
  | .sessions => {
    table := .sessions, source := "sessions.ts", tsExport := "sessions", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"user_id", .uuid, false⟩,
      ⟨"owner_principal_id", .uuid, true⟩,
      ⟨"agent_id", .uuid, true⟩,
      ⟨"project_id", .uuid, false⟩,
      ⟨"engine_session_id", .text, false⟩,
      ⟨"engine", .text, false⟩,
      ⟨"agent_version_id", .uuid, false⟩,
      ⟨"title", .text, false⟩,
      ⟨"status", .text, true⟩,
      ⟨"created_at", .timestamptz, true⟩,
      ⟨"updated_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "sessions_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "sessions_user_id_users_id_fk", columns := ["user_id"], refTable := .users, refColumns := ["id"], onDelete := .restrict, inline := true },
      { name := "sessions_agent_workspace_fk", columns := ["agent_id", "workspace_id"], refTable := .agents, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false },
      { name := "sessions_agent_version_fk", columns := ["agent_version_id", "agent_id", "workspace_id"], refTable := .agentVersions, refColumns := ["id", "agent_id", "workspace_id"], onDelete := .noAction, inline := false },
      { name := "sessions_project_workspace_fk", columns := ["project_id", "workspace_id"], refTable := .projects, refColumns := ["id", "workspace_id"], onDelete := .setNull, inline := false },
      { name := "sessions_member_workspace_fk", columns := ["workspace_id", "user_id"], refTable := .memberships, refColumns := ["workspace_id", "user_id"], onDelete := .noAction, inline := false },
      { name := "sessions_owner_principal_workspace_fk", columns := ["workspace_id", "owner_principal_id"], refTable := .workspacePrincipals, refColumns := ["workspace_id", "id"], onDelete := .noAction, inline := false }]
    uniques := [
      { name := "sessions_id_workspace_key", columns := ["id", "workspace_id"], kind := .constraint, partialNullColumns := [] },
      { name := "sessions_workspace_engine_session_key", columns := ["workspace_id", "engine_session_id"], kind := .index, partialNullColumns := [] }]
    checks := [
      .oneOf "sessions_status_valid" "status" ["active", "archived"],
      .oneOf "sessions_engine_valid" "engine" ["claude-agent-sdk", "openai-agents", "pi", "mastra"]] }
  | .shareViews => {
    table := .shareViews, source := "share-views.ts", tsExport := "shareViews", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"share_id", .uuid, true⟩,
      ⟨"visitor_key", .text, false⟩,
      ⟨"created_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "share_views_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "share_views_share_workspace_fk", columns := ["share_id", "workspace_id"], refTable := .shares, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false }]
    uniques := []
    checks := [] }
  | .shareRunCharges => {
    table := .shareRunCharges, source := "share-run-charges.ts", tsExport := "shareRunCharges", tenancy := .scoped
    primaryKey := ["run_id"]
    columns := [
      ⟨"run_id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"share_id", .uuid, true⟩,
      ⟨"charged_usd", .numeric 14 6, true⟩,
      ⟨"created_at", .timestamptz, true⟩,
      ⟨"updated_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "share_run_charges_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "share_run_charges_share_workspace_fk", columns := ["share_id", "workspace_id"], refTable := .shares, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false },
      { name := "share_run_charges_run_workspace_fk", columns := ["run_id", "workspace_id"], refTable := .runs, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false }]
    uniques := []
    checks := [
      .other "share_run_charges_nonnegative"] }
  | .shares => {
    table := .shares, source := "shares.ts", tsExport := "shares", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"token", .text, true⟩,
      ⟨"subject_type", .text, true⟩,
      ⟨"subject_id", .text, true⟩,
      ⟨"subject_label", .text, true⟩,
      ⟨"visibility", .text, true⟩,
      ⟨"mode", .text, false⟩,
      ⟨"snapshot", .jsonb, false⟩,
      ⟨"include", .jsonb, true⟩,
      ⟨"budget_cap_usd", .numeric 12 4, false⟩,
      ⟨"spent_usd", .numeric 14 6, true⟩,
      ⟨"stopped", .boolean, true⟩,
      ⟨"expires_at", .timestamptz, false⟩,
      ⟨"passphrase_hash", .text, false⟩,
      ⟨"created_by", .uuid, false⟩,
      ⟨"publisher_principal_id", .uuid, true⟩,
      ⟨"revoked_at", .timestamptz, false⟩,
      ⟨"suspended_at", .timestamptz, false⟩,
      ⟨"created_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "shares_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "shares_created_by_users_id_fk", columns := ["created_by"], refTable := .users, refColumns := ["id"], onDelete := .restrict, inline := true },
      { name := "shares_creator_workspace_fk", columns := ["workspace_id", "created_by"], refTable := .memberships, refColumns := ["workspace_id", "user_id"], onDelete := .noAction, inline := false },
      { name := "shares_publisher_principal_workspace_fk", columns := ["workspace_id", "publisher_principal_id"], refTable := .workspacePrincipals, refColumns := ["workspace_id", "id"], onDelete := .noAction, inline := false }]
    uniques := [
      { name := "shares_id_workspace_key", columns := ["id", "workspace_id"], kind := .constraint, partialNullColumns := [] },
      { name := "shares_token_key", columns := ["token"], kind := .constraint, partialNullColumns := [] }]
    checks := [
      .oneOf "shares_subject_type_valid" "subject_type" ["agent", "session", "project", "skill"],
      .oneOf "shares_visibility_valid" "visibility" ["private", "workspace", "public"],
      .oneOf "shares_mode_valid" "mode" ["definition", "runnable"],
      .other "shares_agent_mode_only",
      .other "shares_budget_nonnegative",
      .other "shares_spend_nonnegative",
      .other "shares_subject_id_not_blank"] }
  | .skills => {
    table := .skills, source := "skills.ts", tsExport := "skills", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"name", .text, true⟩,
      ⟨"skill_md", .text, true⟩,
      ⟨"enabled", .boolean, true⟩,
      ⟨"created_by", .uuid, false⟩,
      ⟨"owner_principal_id", .uuid, true⟩,
      ⟨"created_at", .timestamptz, true⟩,
      ⟨"updated_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "skills_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "skills_created_by_workspace_fk", columns := ["workspace_id", "created_by"], refTable := .memberships, refColumns := ["workspace_id", "user_id"], onDelete := .noAction, inline := false },
      { name := "skills_owner_principal_workspace_fk", columns := ["workspace_id", "owner_principal_id"], refTable := .workspacePrincipals, refColumns := ["workspace_id", "id"], onDelete := .noAction, inline := false }]
    uniques := [
      { name := "skills_id_workspace_key", columns := ["id", "workspace_id"], kind := .constraint, partialNullColumns := [] },
      { name := "skills_workspace_name_key", columns := ["workspace_id", "name"], kind := .index, partialNullColumns := [] }]
    checks := [
      .other "skills_name_shape",
      .other "skills_skill_md_not_blank"] }
  | .surfaceSessionKeys => {
    table := .surfaceSessionKeys, source := "surface-session-keys.ts", tsExport := "surfaceSessionKeys", tenancy := .scoped
    primaryKey := ["session_id"]
    columns := [
      ⟨"session_id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"surface_name", .text, true⟩,
      ⟨"agent_id", .uuid, true⟩,
      ⟨"key_hash", .text, true⟩,
      ⟨"created_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "surface_session_keys_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "surface_session_keys_session_workspace_fk", columns := ["session_id", "workspace_id"], refTable := .sessions, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false },
      { name := "surface_session_keys_agent_workspace_fk", columns := ["agent_id", "workspace_id"], refTable := .agents, refColumns := ["id", "workspace_id"], onDelete := .cascade, inline := false }]
    uniques := []
    checks := [] }
  | .userIdentities => {
    table := .userIdentities, source := "user-identities.ts", tsExport := "userIdentities", tenancy := .global
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"issuer", .text, true⟩,
      ⟨"subject", .text, true⟩,
      ⟨"user_id", .uuid, true⟩,
      ⟨"created_at", .timestamptz, true⟩,
      ⟨"updated_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "user_identities_user_id_users_id_fk", columns := ["user_id"], refTable := .users, refColumns := ["id"], onDelete := .cascade, inline := true }]
    uniques := [
      { name := "user_identities_issuer_subject_key", columns := ["issuer", "subject"], kind := .constraint, partialNullColumns := [] }]
    checks := [
      .other "user_identities_issuer_not_blank",
      .other "user_identities_subject_not_blank"] }
  | .users => {
    table := .users, source := "users.ts", tsExport := "users", tenancy := .global
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"email", .text, true⟩,
      ⟨"name", .text, true⟩,
      ⟨"created_at", .timestamptz, true⟩,
      ⟨"updated_at", .timestamptz, true⟩]
    foreignKeys := []
    uniques := [
      { name := "users_email_key", columns := ["email"], kind := .index, partialNullColumns := [] }]
    checks := [
      .other "users_email_lowercase",
      .other "users_email_shape",
      .other "users_name_not_blank"] }
  | .workspaces => {
    table := .workspaces, source := "workspaces.ts", tsExport := "workspaces", tenancy := .root
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"slug", .text, true⟩,
      ⟨"name", .text, true⟩,
      ⟨"public_sharing_enabled", .boolean, true⟩,
      ⟨"default_model_connection_id", .uuid, false⟩,
      ⟨"default_model", .text, false⟩,
      ⟨"archived_at", .timestamptz, false⟩,
      ⟨"created_at", .timestamptz, true⟩,
      ⟨"updated_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "workspaces_default_model_connection_id_model_connections_id_fk", columns := ["default_model_connection_id"], refTable := .modelConnections, refColumns := ["id"], onDelete := .setNull, inline := true },
      { name := "workspaces_default_model_connection_workspace_fk", columns := ["default_model_connection_id", "id"], refTable := .modelConnections, refColumns := ["id", "workspace_id"], onDelete := .noAction, inline := false }]
    uniques := [
      { name := "workspaces_slug_key", columns := ["slug"], kind := .index, partialNullColumns := [] }]
    checks := [
      .other "workspaces_slug_format",
      .other "workspaces_name_not_blank",
      .other "workspaces_default_model_pair"] }
  | .workspacePrincipals => {
    table := .workspacePrincipals, source := "workspace-principals.ts", tsExport := "workspacePrincipals", tenancy := .scoped
    primaryKey := ["id"]
    columns := [
      ⟨"id", .uuid, true⟩,
      ⟨"workspace_id", .uuid, true⟩,
      ⟨"kind", .text, true⟩,
      ⟨"membership_id", .uuid, false⟩,
      ⟨"api_key_id", .uuid, false⟩,
      ⟨"activated_at", .timestamptz, true⟩,
      ⟨"revoked_at", .timestamptz, false⟩,
      ⟨"acts_for_principal_id", .uuid, false⟩,
      ⟨"created_at", .timestamptz, true⟩]
    foreignKeys := [
      { name := "workspace_principals_workspace_id_workspaces_id_fk", columns := ["workspace_id"], refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true },
      { name := "workspace_principals_membership_workspace_fk", columns := ["workspace_id", "membership_id"], refTable := .memberships, refColumns := ["workspace_id", "id"], onDelete := .cascade, inline := false },
      { name := "workspace_principals_api_key_workspace_fk", columns := ["workspace_id", "api_key_id"], refTable := .apiKeys, refColumns := ["workspace_id", "id"], onDelete := .cascade, inline := false },
      { name := "workspace_principals_acts_for_workspace_fk", columns := ["workspace_id", "acts_for_principal_id"], refTable := .workspacePrincipals, refColumns := ["workspace_id", "id"], onDelete := .noAction, inline := false }]
    uniques := [
      { name := "workspace_principals_workspace_id_key", columns := ["workspace_id", "id"], kind := .constraint, partialNullColumns := [] },
      { name := "workspace_principals_workspace_membership_key", columns := ["workspace_id", "membership_id"], kind := .constraint, partialNullColumns := [] },
      { name := "workspace_principals_workspace_api_key_key", columns := ["workspace_id", "api_key_id"], kind := .constraint, partialNullColumns := [] }]
    checks := [
      .oneOf "workspace_principals_kind_valid" "kind" ["membership", "api_key"],
      .other "workspace_principals_source_xor",
      .other "workspace_principals_revoked_after_activation",
      .other "workspace_principals_acts_for_api_key_only",
      .other "workspace_principals_acts_for_not_self"] }

/-! ## Looking things up in a table specification -/

namespace TableSpec

variable (s : TableSpec)

/-- The column called `c`, if the table has one. -/
def column? (c : String) : Option Column := s.columns.find? (·.name == c)

/-- Whether the table has a column called `c`. -/
def hasColumn (c : String) : Bool := s.columns.any (·.name == c)

/-- Whether the table has a `NOT NULL` column called `c`. -/
def isNotNull (c : String) : Bool := s.columns.any fun col => col.name == c && col.notNull

/-- The column names, in declaration order. -/
def columnNames : List String := s.columns.map (·.name)

/-- Every constraint name the table declares: foreign keys, unique keys and checks. -/
def constraintNames : List String :=
  s.foreignKeys.map (·.name) ++ s.uniques.map (·.name) ++ s.checks.map (·.name)

/-- The table's tenant column (`workspace_id`, or `id` for `workspaces`), if it is not global. -/
def tenantColumn? : Option String := s.tenancy.column?

/-- The foreign key called `n`, if the table declares one. -/
def foreignKey? (n : String) : Option ForeignKey := s.foreignKeys.find? (·.name == n)

/-- The unique key named `n`, if the table declares one. -/
def unique? (n : String) : Option UniqueKey := s.uniques.find? (·.name == n)

/-- The check named `n`, if the table declares one. -/
def check? (n : String) : Option Check := s.checks.find? (·.name == n)

/-- The column and value list of the closed-set check named `n`, if it is one. -/
def oneOfCheck? (n : String) : Option (String × List String) :=
  match s.check? n with
  | some (.oneOf _ c vs) => some (c, vs)
  | _ => none

/-- What `drizzle-kit` records of the foreign key named `n`: columns, target table, target
columns and `ON DELETE` action. -/
def foreignKeySignature? (n : String) : Option (List String × TableName × List String × OnDelete) :=
  (s.foreignKey? n).map fun fk => (fk.columns, fk.refTable, fk.refColumns, fk.onDelete)

/-- What `drizzle-kit` records of the unique key named `n`: columns, whether it is an index, and
the columns of its `WHERE … IS NULL` filter. -/
def uniqueSignature? (n : String) : Option (List String × UniqueKind × List String) :=
  (s.unique? n).map fun u => (u.columns, u.kind, u.partialNullColumns)

end TableSpec

/-- Two column lists name the same set of columns. -/
def sameColumns (a b : List String) : Bool :=
  a.length == b.length && a.all b.contains && b.all a.contains

/-- `cols` is a key of the table that PostgreSQL accepts as a foreign-key target: its primary key
or a unique constraint or index that is not partial. -/
def TableSpec.isKey (s : TableSpec) (cols : List String) : Bool :=
  sameColumns s.primaryKey cols ||
    s.uniques.any fun u => u.partialNullColumns.isEmpty && sameColumns u.columns cols

/-- The single column `k` is, by itself, the primary key or a total unique key of the table. -/
def TableSpec.isSingleKey (s : TableSpec) (k : String) : Bool :=
  s.primaryKey == [k] || s.uniques.any fun u => u.partialNullColumns.isEmpty && u.columns == [k]

/-! ## Classifying references by tenancy -/

/-- The column pairs of a foreign key: child column and the parent column it must equal. -/
def ForeignKey.pairs (fk : ForeignKey) : List (String × String) := fk.columns.zip fk.refColumns

/-- The buckets `tenancy.test.ts` sorts every foreign key into. -/
@[aw_spec (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#referenceIdentityOf")]
inductive FkClass where
  /-- `workspace_id → workspaces.id`: the reference to the tenant root itself. -/
  | rootReference
  /-- A reference to a global identity table (`users`), which cannot be tenant-paired. -/
  | globalReference
  /-- Both tenant columns sit at the same position of the key, so the database forces the two
  rows into one workspace. -/
  | tenantPaired
  /-- A single-column reference whose target a tenant-paired sibling constraint also pins; it
  exists to carry an `ON DELETE SET NULL` that a composite key cannot express. -/
  | siblingPaired
  /-- A reference between tenant-carrying tables that nothing pairs: a cross-tenant hole. -/
  | unpaired
  deriving DecidableEq, Repr, Inhabited

/-- The wire spelling of a class, for vectors. -/
def FkClass.toWire : FkClass → String
  | .rootReference => "root-reference"
  | .globalReference => "global-reference"
  | .tenantPaired => "tenant-paired"
  | .siblingPaired => "sibling-paired"
  | .unpaired => "unpaired"

instance : WireEnum FkClass where
  all := [.rootReference, .globalReference, .tenantPaired, .siblingPaired, .unpaired]
  toWire := FkClass.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by
    intro a b h
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-- The foreign key pairs the child's tenant column with the parent's tenant column. -/
def isPaired (S : Schema) (t : TableName) (fk : ForeignKey) : Bool :=
  match (S t).tenantColumn?, (S fk.refTable).tenantColumn? with
  | some c, some rc => fk.pairs.contains (c, rc)
  | _, _ => false

/-- A single-column reference `c → k` is covered by a tenant-paired sibling: another foreign key
of the same table, to the same target, pairs the tenant columns and maps `c` to `k`, uses no
column other than `c` and the tenant column, the tenant column is `NOT NULL`, and `k` alone is a
key of the target (so both constraints reach the same parent row). -/
def siblingCovers (S : Schema) (t : TableName) (fk : ForeignKey) : Bool :=
  match fk.columns, fk.refColumns, (S t).tenantColumn? with
  | [c], [k], some tc =>
    (S t).isNotNull tc && (S fk.refTable).isSingleKey k &&
      (S t).foreignKeys.any fun g =>
        g.refTable == fk.refTable && isPaired S t g && g.pairs.contains (c, k) &&
          g.columns.all fun x => x == c || x == tc
  | _, _, _ => false

/-- The tenancy bucket of a foreign key of table `t`. -/
@[aw_spec (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#workspaceSelfPairingFault")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
def classify (S : Schema) (t : TableName) (fk : ForeignKey) : FkClass :=
  match (S fk.refTable).tenancy with
  | .global => if fk.columns.contains "workspace_id" then .unpaired else .globalReference
  | .root => if isPaired S t fk && fk.columns.length == 1 then .rootReference else .unpaired
  | .scoped =>
    if isPaired S t fk then .tenantPaired
    else if siblingCovers S t fk then .siblingPaired
    else .unpaired

/-! ## Well-formedness of a specification -/

/-- A foreign key PostgreSQL would accept: a non-empty, duplicate-free column list as long as its
target list, every child column and parent column exists with the same type, the parent columns
form a key of the parent, and an inline key has one column. -/
def fkWellFormed (S : Schema) (t : TableName) (fk : ForeignKey) : Bool :=
  !fk.columns.isEmpty && fk.columns.length == fk.refColumns.length && decide fk.columns.Nodup &&
    fk.pairs.all (fun p =>
      match (S t).column? p.1, (S fk.refTable).column? p.2 with
      | some a, some b => a.type == b.type
      | _, _ => false) &&
    (S fk.refTable).isKey fk.refColumns &&
    (!fk.inline || fk.columns.length == 1)

/-- `ON DELETE SET NULL` sets every column of the key to `NULL`, so it is only executable when
none of them is `NOT NULL`. -/
def setNullSound (S : Schema) (t : TableName) (fk : ForeignKey) : Bool :=
  fk.onDelete != .setNull || fk.columns.all fun c => !(S t).isNotNull c

/-- A check names an existing column and a non-empty, duplicate-free value list. -/
def checkWellFormed (s : TableSpec) : Check → Bool
  | .oneOf _ c vs => s.hasColumn c && !vs.isEmpty && decide vs.Nodup
  | .other _ => true

/-- The model's tenancy rule for one table. `Authz.Tenancy.testRule1` separately transcribes
rule 1 of `tenancy.test.ts`; the two predicates agree on the current catalogue but differ on
other schemas. Like the test: a scoped table has a `NOT NULL`
`workspace_id` and exactly one single-column reference to `workspaces.id`, and an exempt table
(the root or a global table) has no `workspace_id`. Stricter than the test: the scoped column is
`uuid` (the test leaves that to the foreign key's type agreement) and the root is keyed by `id`.
Weaker than the test: the test also requires `workspace_id` to lead an index. The
`ON DELETE CASCADE` of every root
reference is a separate schema fact (`every_root_reference_cascades`), not part of the rule. -/
@[aw_spec (ts := "packages/core/src/db/schema/tenancy.test.ts#TENANT_EXEMPT")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#TENANT_COLUMN")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
def tenancyWellFormed (S : Schema) (t : TableName) : Bool :=
  let s := S t
  match s.tenancy with
  | .scoped =>
    s.isNotNull "workspace_id" && (s.column? "workspace_id").map (·.type) == some .uuid &&
      (s.foreignKeys.filter (fun fk => classify S t fk == .rootReference)).length == 1
  | .root => !s.hasColumn "workspace_id" && s.primaryKey == ["id"]
  | .global => !s.hasColumn "workspace_id"

/-- A table specification is well formed: it describes its own table, its column and constraint
names are unique, its primary key is a non-empty list of `NOT NULL` columns, every foreign key,
unique key and check is well formed, and it obeys the tenancy rule. -/
def tableWellFormed (S : Schema) (t : TableName) : Bool :=
  let s := S t
  s.table == t && decide s.columnNames.Nodup && decide s.constraintNames.Nodup &&
    !s.primaryKey.isEmpty && s.primaryKey.all s.isNotNull &&
    s.foreignKeys.all (fkWellFormed S t) &&
    s.uniques.all (fun u =>
      !u.columns.isEmpty && u.columns.all s.hasColumn && u.partialNullColumns.all s.hasColumn) &&
    s.checks.all (checkWellFormed s) &&
    tenancyWellFormed S t

/-- The foreign key `n` of table `t`: whether it is well formed, and its tenancy class. -/
def fkVerdict (S : Schema) (t : TableName) (n : String) : Option (Bool × FkClass) :=
  ((S t).foreignKey? n).map fun fk => (fkWellFormed S t fk, classify S t fk)

/-- Every table, in barrel order. -/
def allTables : List TableName := WireEnum.all

/-! ## Editing a schema

Target models and the negative well-formedness theorems build schemas from `catalogue` by
editing one table. -/

/-- The schema with table `t`'s specification replaced by `f` of it. -/
def Schema.update (S : Schema) (t : TableName) (f : TableSpec → TableSpec) : Schema :=
  fun u => if u = t then f (S u) else S u

/-- The specification with column `n` replaced by `f` of it. -/
def TableSpec.mapColumn (s : TableSpec) (n : String) (f : Column → Column) : TableSpec :=
  { s with columns := s.columns.map fun c => if c.name == n then f c else c }

/-- The specification with foreign key `n` replaced by `f` of it. -/
def TableSpec.mapForeignKey (s : TableSpec) (n : String) (f : ForeignKey → ForeignKey) :
    TableSpec :=
  { s with foreignKeys := s.foreignKeys.map fun fk => if fk.name == n then f fk else fk }

/-- No foreign key of the schema is `unpaired`: every reference between two tenant-carrying tables
is tenant-paired by itself or by a sibling (the rule `tenancy.test.ts` enforces). -/
@[aw_spec (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
def pairingComplete (S : Schema) : Bool :=
  allTables.all fun t => (S t).foreignKeys.all fun fk => classify S t fk != .unpaired

/-- A column named like a reference: its name ends in `_id` (`REFERENCE_SUFFIX`). -/
@[aw_spec (ts := "packages/core/src/db/schema/tenancy.test.ts#REFERENCE_SUFFIX")]
def isIdColumn (c : String) : Bool := "_id".toList.isSuffixOf c.toList

/-- `NON_REFERENCE_ID_COLUMNS`: the `*_id` columns that refer to nothing in this schema, each with
the SQL type the declaration pins. -/
@[aw_spec (ts := "packages/core/src/db/schema/tenancy.test.ts#NON_REFERENCE_ID_COLUMNS")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
def nonReferenceIdColumns : List (TableName × String × SqlType) :=
  [(.runUsageRecords, "provider_response_id", .text), (.auditEvents, "subject_id", .text),
    (.secrets, "master_key_id", .text), (.sessions, "engine_session_id", .text),
    (.runtimeVerifications, "driver_id", .text), (.oauthTokens, "family_id", .uuid),
    (.shares, "subject_id", .text)]

/-- Rule 3 of `tenancy.test.ts` ("every reference is declared") for one column: a `*_id` column is
either covered by a foreign key and not declared, or covered by none and declared with its type. -/
def idColumnCovered (S : Schema) (decl : List (TableName × String × SqlType)) (t : TableName)
    (c : Column) : Bool :=
  !isIdColumn c.name ||
    if (S t).foreignKeys.any (·.columns.contains c.name) then
      !decl.any fun d => d.1 == t && d.2.1 == c.name
    else decl.contains (t, c.name, c.type)

/-- Every `*_id` column of the schema is a foreign-key column or a declared non-reference of the
declared type, and every declaration names an existing column. Without this, `pairingComplete`
could be satisfied by deleting a foreign key. -/
@[aw_spec (ts := "packages/core/src/db/schema/tenancy.test.ts#NON_REFERENCE_ID_COLUMNS")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
def idColumnsCovered (S : Schema) (decl : List (TableName × String × SqlType)) : Bool :=
  (allTables.all fun t => (S t).columns.all (idColumnCovered S decl t)) &&
    decl.all fun d => (S d.1).hasColumn d.2.1

/-- Every constraint name in the schema, table by table. -/
def allConstraintNames (S : Schema) : List String := allTables.flatMap fun t => (S t).constraintNames

/-! ## Rows, states and the constraints on them -/

/-- A row: the non-`NULL` cells, as column name and value. A column with no cell is `NULL`. -/
structure Row where
  cells : List (String × String)
  deriving DecidableEq, Repr, Inhabited

namespace Row

/-- The value of column `c`, or `none` for `NULL`. -/
def get (r : Row) (c : String) : Option String := r.cells.lookup c

/-- The values of a list of columns. -/
def project (r : Row) (cs : List String) : List (Option String) := cs.map r.get

/-- Every column of `cs` is non-`NULL`. -/
def present (r : Row) (cs : List String) : Bool := cs.all fun c => (r.get c).isSome

/-- The row's primary `id`, typed by the kind of row it is. -/
def id? {k : IdKind} (r : Row) : Option (Id k) := (r.get "id").map Id.mk

/-- The owning workspace of a row of a tenant-scoped table. -/
def workspaceId? (r : Row) : Option WorkspaceId := (r.get "workspace_id").map Id.mk

/-- The row with the columns `cs` set to `NULL`. -/
def nullify (r : Row) (cs : List String) : Row := ⟨r.cells.filter fun p => !cs.contains p.1⟩

end Row

/-- A database state: the rows of every table. -/
abbrev State := TableName → List Row

/-- The state with no rows at all. -/
def State.empty : State := fun _ => []

/-- The workspace a row of table `t` belongs to: `workspace_id`, the row's own `id` for
`workspaces`, and none for a global table. -/
def tenantOf (S : Schema) (t : TableName) (r : Row) : Option String :=
  (S t).tenantColumn?.bind r.get

/-- A foreign key holds (PostgreSQL's default `MATCH SIMPLE`): every row whose key columns are all
non-`NULL` has a parent row whose referenced columns carry the same values. -/
def fkHolds (st : State) (t : TableName) (fk : ForeignKey) : Bool :=
  (st t).all fun r =>
    !r.present fk.columns ||
      (st fk.refTable).any fun r' => r'.project fk.refColumns == r.project fk.columns

/-- A unique key holds: among the rows the key applies to (all `partialNull` columns `NULL`), two
rows whose key columns are non-`NULL` and equal are the same row. `NULL`s are distinct. -/
def keyHolds (rows : List Row) (cols partialNull : List String) : Bool :=
  let rs := rows.filter fun r => partialNull.all fun c => (r.get c).isNone
  rs.all fun r1 => !r1.present cols || rs.all fun r2 => r1.project cols != r2.project cols || r1 == r2

/-- A `NOT NULL` column has a value in every row. -/
def notNullHolds (rows : List Row) (c : Column) : Bool :=
  !c.notNull || rows.all fun r => (r.get c.name).isSome

/-- `workspace_principals_source_xor`: `(kind = 'membership' and membership_id is not null and
api_key_id is null) or (kind = 'api_key' and api_key_id is not null and membership_id is null)`.
Under SQL's three-valued logic the expression is `NULL`, so the check passes, only when `kind` is
`NULL` (which `kind NOT NULL` forbids separately). -/
@[aw_spec (ts := "packages/core/src/db/schema/workspace-principals.ts#workspacePrincipals")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
def principalSourceXor (r : Row) : Bool :=
  match r.get "kind" with
  | none => true
  | some k =>
    (k == "membership" && (r.get "membership_id").isSome && (r.get "api_key_id").isNone) ||
      (k == "api_key" && (r.get "api_key_id").isSome && (r.get "membership_id").isNone)

/-- The semantics of the checks that are not closed sets, by name. Only
`workspace_principals_source_xor` (a tenant-isolation predicate) is given one here; the others
hold until the cluster that owns the table refines them. -/
def otherCheckHolds (n : String) (r : Row) : Bool :=
  if n == "workspace_principals_source_xor" then principalSourceXor r else true

/-- A check holds on every row: a closed-set column is `NULL` or one of the values; any other
check holds by `otherCheckHolds`. -/
def checkHolds (rows : List Row) : Check → Bool
  | .oneOf _ c vs => rows.all fun r => (r.get c).all vs.contains
  | .other n => rows.all (otherCheckHolds n)

/-- Every constraint of table `t` holds in the state. -/
def tableConsistent (S : Schema) (st : State) (t : TableName) : Bool :=
  let s := S t
  let rows := st t
  s.columns.all (notNullHolds rows) && keyHolds rows s.primaryKey [] &&
    s.uniques.all (fun u => keyHolds rows u.columns u.partialNullColumns) &&
    s.foreignKeys.all (fkHolds st t) && s.checks.all (checkHolds rows)

/-- Every constraint of every table holds: the states PostgreSQL can hold under schema `S`. -/
def consistent (S : Schema) (st : State) : Bool := allTables.all (tableConsistent S st)

/-- Row `r` of table `t` references row `r'` through foreign key `fk`: the key is non-`NULL` in
`r` and `r'` carries the same values in the referenced columns. -/
def References (S : Schema) (st : State) (t : TableName) (fk : ForeignKey) (r r' : Row) : Prop :=
  fk ∈ (S t).foreignKeys ∧ r ∈ st t ∧ r' ∈ st fk.refTable ∧ r.present fk.columns = true ∧
    r'.project fk.refColumns = r.project fk.columns

/-- A chain of references from row `r` of table `t` to row `r'` of table `t'`, every hop into a
table that carries a tenant (so the chain never passes through a global identity table). -/
inductive TenantPath (S : Schema) (st : State) : TableName → Row → TableName → Row → Prop where
  | refl (t : TableName) (r : Row) : TenantPath S st t r t r
  | step {t t' t'' : TableName} {r r' r'' : Row} (fk : ForeignKey) :
      References S st t fk r r' → fk.refTable = t' → (S t').tenantColumn?.isSome →
      TenantPath S st t' r' t'' r'' → TenantPath S st t r t'' r''

/-! ## The `oneOf` value gate (`packages/core/src/db/schema/one-of.ts`) -/

/-- A character of `SAFE_VALUE`'s alphabet: a lower-case letter, a digit or a hyphen. -/
def isSafeValueChar (c : Char) : Bool := ('a' ≤ c && c ≤ 'z') || ('0' ≤ c && c ≤ '9') || c == '-'

/-- No two hyphens in a row. -/
def noDoubleHyphen : List Char → Bool
  | a :: b :: rest => !(a == '-' && b == '-') && noDoubleHyphen (b :: rest)
  | _ => true

/-- `SAFE_VALUE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/` with `MAX_VALUE_LENGTH = 64`: a lower-case
slug that starts with a letter, has single hyphens between runs of letters and digits, and is at
most 64 characters. -/
@[aw_spec (ts := "packages/core/src/db/schema/one-of.ts#SAFE_VALUE")
  (ts := "packages/core/src/db/schema/one-of.ts#MAX_VALUE_LENGTH")]
def isSafeValue (v : String) : Bool :=
  match v.toList with
  | [] => false
  | c :: rest =>
    ('a' ≤ c && c ≤ 'z') && rest.all isSafeValueChar && noDoubleHyphen (c :: rest) &&
      (c :: rest).getLast? != some '-' && v.length ≤ 64

/-- `renderValueList`: `('a', 'b', …)` for DDL inlining, or `none` where the TypeScript throws
(an empty list, a duplicate, or a value that is not a safe slug). -/
@[aw_spec (ts := "packages/core/src/db/schema/one-of.ts#renderValueList")]
def renderValueList? (vs : List String) : Option String :=
  if vs.isEmpty || !vs.all isSafeValue || !decide vs.Nodup then none
  else some ("(" ++ ", ".intercalate (vs.map fun v => "'" ++ v ++ "'") ++ ")")

end AgentWorkspace.Er.Core
