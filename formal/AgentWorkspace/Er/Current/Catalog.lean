import AgentWorkspace.Er.Core
import AgentWorkspace.Concepts.Skill
import AgentWorkspace.Concepts.Connector
import AgentWorkspace.Concepts.Grant
import AgentWorkspace.Concepts.Agent

/-!
# Today's catalog tables

The catalog cluster's fourteen tables, as `Er.Core` rows: the four catalogued resources and their
owner (`agents`, `skills`, `files`, `mcp_servers`), the three assignment tables (`agent_files`,
`agent_skills`, `agent_mcp_servers`), the grant table (`agent_grants`), an agent's version history
and the pointer that says which version is live in an environment (`agent_versions`,
`agent_version_pointers`, #442), every move of that pointer (`agent_pointer_moves`, #615), the
server-scored evaluations of a version (`agent_version_evaluations`, #618), and the two project link tables (`project_files`,
`project_mcp_servers`). Their columns, keys and closed-set checks are
`Er.Core.catalogue`'s (transcribed from the Drizzle schema and pinned to the latest snapshot there);
this module adds what `Er.Core` leaves to the owning cluster:

* the semantics of the 23 non-closed-set checks on these tables (`clusterCheckHolds`), refining
  `Er.Core.otherCheckHolds`, and `consistent`, the states PostgreSQL can hold once they are
  enforced too;
* the encoding of the typed concepts (`Concepts/*`) as rows, so that a concept's invariant and
  its table's checks can be compared;
* a sample state with a row in every table of the cluster and a reference through every one of
  its foreign keys, used as the witness of the per-key theorems and emitted as vectors.
-/

namespace AgentWorkspace.Er.Current.Catalog

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Concepts

/-- The fourteen tables of the catalog cluster, in barrel order. -/
@[aw_spec (ts := "packages/core/src/db/schema/index.ts")
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
def tables : List TableName :=
  [.agentFiles, .agentGrants, .agentMcpServers, .agentSkills, .agentPointerMoves,
    .agentVersionEvaluations, .agentVersionPointers,
    .agentVersions, .agents, .files, .mcpServers, .projectFiles, .projectMcpServers, .skills]

/-- The catalogued resources a principal owns (`owner_principal_id`). -/
def resourceTables : List TableName := [.agents, .skills, .files, .mcpServers]

/-- The tables that link an agent (or a project) to a catalogued resource or to a person. -/
def linkTables : List TableName :=
  [.agentFiles, .agentSkills, .agentMcpServers, .agentGrants, .projectFiles, .projectMcpServers]

/-! ## The non-closed-set checks -/

/-- `length(btrim(x)) > 0` on a nullable column: `NULL` passes (the comparison is `NULL`). -/
def rowNotBlank (v : Option String) : Bool := v.all File.notBlank

/-- The text of an `integer` cell greater than zero, as PostgreSQL renders one: decimal digits
only (a negative number has a leading `-`), and at least one of them not `0`. -/
def positiveNumeral (v : String) : Bool :=
  !v.toList.isEmpty && v.toList.all Char.isDigit && v.toList.any (· != '0')

/-- The value of the text of a non-negative `integer` cell (decimal digits). It is only read
once the cell is known to be digits; a list fold, so that `decide` evaluates it. -/
def numeralValue (v : String) : Nat :=
  v.toList.foldl (fun n c => 10 * n + (c.toNat - '0'.toNat)) 0

/-- `kind <> v` is not false: the kind is `NULL` (the comparison is `NULL`) or another kind. -/
def kindIsNot (r : Row) (v : String) : Bool := (r.get "kind").all (· != v)

/-- `kind = v` is not false: the kind is `NULL` (the comparison is `NULL`) or `v`. -/
def kindMayBe (r : Row) (v : String) : Bool := (r.get "kind").all (· == v)

/-- The semantics of every check on the cluster's tables that is not a closed set, read from the
check bodies in
`packages/core/src/db/schema/{agent-versions,agent-version-evaluations,agents,skills,files,mcp-servers}.ts`. A check
passes unless it is false, so a comparison with a `NULL` column passes (SQL's three-valued
reading), and a disjunction passes when one of its disjuncts is not false. That is how the MCP
checks of `mcp_servers`, guarded by `kind <> 'mcp' or …`, pass on a tool connector's `NULL`
transport. The other guard columns are `NOT NULL`, so their `NULL` case only arises in states
`consistent` already refuses. `size_bytes` is compared as the text PostgreSQL renders a `bigint`
in, a version's `number` and an evaluation's `passed` and `total` as the text of an `integer`
(`positiveNumeral`, `numeralValue`), and `tool_config` as the
text of a `jsonb` value (`Connector.jsonbObject`). -/
@[aw_spec (ts := "packages/core/src/db/schema/agent-versions.ts#agent_versions_number_positive")
  (ts := "packages/core/src/db/schema/agent-version-evaluations.ts#agent_version_evaluations_counts")
  (ts := "packages/core/src/db/schema/agents.ts#agents")
  (ts := "packages/core/src/db/schema/skills.ts#skills")
  (ts := "packages/core/src/db/schema/files.ts#files")
  (ts := "packages/core/src/db/schema/mcp-servers.ts#mcpServers")]
def clusterCheckHolds (n : String) (r : Row) : Bool :=
  if n == "agent_versions_number_positive" then
    (r.get "number").all positiveNumeral
  -- `total > 0 and passed >= 0 and passed <= total` is false only when one conjunct is.
  else if n == "agent_version_evaluations_counts" then
    (r.get "total").all positiveNumeral &&
      (r.get "passed").all (fun p => p.toList.head? != some '-') &&
      (match r.get "passed", r.get "total" with
        | some p, some t => numeralValue p ≤ numeralValue t
        | _, _ => true)
  else if n == "agents_name_not_blank" then rowNotBlank (r.get "name")
  else if n == "skills_name_shape" then (r.get "name").all Skill.nameShape
  else if n == "skills_skill_md_not_blank" then rowNotBlank (r.get "skill_md")
  else if n == "files_path_shape" then (r.get "path").all File.pathShape
  else if n == "files_path_no_dot_segments" then (r.get "path").all File.noDotSegments
  else if n == "files_storage_key_iff_file" then
    (r.get "kind").all fun k => (k == "file") == (r.get "storage_key").isSome
  else if n == "files_storage_key_not_blank" then rowNotBlank (r.get "storage_key")
  else if n == "files_size_non_negative" then
    (r.get "size_bytes").all fun s => s.toList.head? != some '-'
  else if n == "files_folder_has_no_content" then
    (r.get "kind").all fun k =>
      k != "folder" || (r.get "size_bytes" == some "0" && (r.get "content_type").isNone)
  else if n == "mcp_servers_transport_by_kind" then
    (r.get "kind").all fun k => (k == "mcp") == (r.get "transport").isSome
  else if n == "mcp_servers_tool_kind_fields" then
    kindMayBe r "mcp" ||
      ((r.get "command").isNone && (r.get "args").isNone && (r.get "url").isNone)
  else if n == "mcp_servers_tool_config_by_kind" then
    (r.get "kind").all fun k => (k == "mcp") == (r.get "tool_config").isNone
  else if n == "mcp_servers_tool_config_is_object" then
    (r.get "tool_config").all Connector.jsonbObject
  else if n == "mcp_servers_tool_credential" then
    kindMayBe r "mcp" ||
      ((r.get "auth_type").all (· == "none") &&
        (kindIsNot r "postgres" || (r.get "credential_secret_id").isSome))
  else if n == "mcp_servers_stdio_has_command" then
    kindIsNot r "mcp" ||
      (r.get "transport").all fun t => (t == "stdio") == (r.get "command").isSome
  else if n == "mcp_servers_remote_has_url" then
    kindIsNot r "mcp" ||
      (r.get "transport").all fun t => ["http", "sse"].contains t == (r.get "url").isSome
  else if n == "mcp_servers_args_are_stdio_only" then
    kindIsNot r "mcp" || (r.get "args").isNone || (r.get "transport").all (· == "stdio")
  else if n == "mcp_servers_command_not_blank" then rowNotBlank (r.get "command")
  else if n == "mcp_servers_url_shape" then (r.get "url").all Connector.urlShape
  else if n == "mcp_servers_credential_required" then
    kindIsNot r "mcp" || (r.get "auth_type").all fun a =>
      ["api-key", "bearer", "oauth"].contains a == (r.get "credential_secret_id").isSome
  else if n == "mcp_servers_name_not_blank" then rowNotBlank (r.get "name")
  else true

/-- The SQL body of each check `clusterCheckHolds` gives a meaning to, as `drizzle-kit` rendered it in
the latest snapshot (`Er.Snapshot.file`): the semantics above are the semantics of exactly these
expressions, and the conformance suite fails when a body changes. -/
@[aw_spec (ts := "packages/core/src/db/schema/files.ts#files")
  (ts := "packages/core/src/db/schema/mcp-servers.ts#mcpServers")
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")]
def checkSql : List (String × String) :=
  [("agent_versions_number_positive", "\"agent_versions\".\"number\" > 0"),
    ("agent_version_evaluations_counts",
      "\"agent_version_evaluations\".\"total\" > 0 and \"agent_version_evaluations\".\"passed\" >= 0 and \"agent_version_evaluations\".\"passed\" <= \"agent_version_evaluations\".\"total\""),
    ("agents_name_not_blank", "length(btrim(\"agents\".\"name\")) > 0"),
    ("skills_name_shape", "\"skills\".\"name\" ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'"),
    ("skills_skill_md_not_blank", "length(btrim(\"skills\".\"skill_md\")) > 0"),
    ("files_path_shape", "\"files\".\"path\" ~ '^[^/[:cntrl:]]+(/[^/[:cntrl:]]+)*$'"),
    ("files_path_no_dot_segments", "\"files\".\"path\" !~ '(^|/)[.][.]?(/|$)'"),
    ("files_storage_key_iff_file",
      "(\"files\".\"kind\" = 'file') = (\"files\".\"storage_key\" is not null)"),
    ("files_storage_key_not_blank",
      "\"files\".\"storage_key\" is null or length(btrim(\"files\".\"storage_key\")) > 0"),
    ("files_size_non_negative", "\"files\".\"size_bytes\" >= 0"),
    ("files_folder_has_no_content",
      "\"files\".\"kind\" <> 'folder' or (\"files\".\"size_bytes\" = 0 and \"files\".\"content_type\" is null)"),
    ("mcp_servers_transport_by_kind",
      "(\"mcp_servers\".\"kind\" = 'mcp') = (\"mcp_servers\".\"transport\" is not null)"),
    ("mcp_servers_tool_kind_fields",
      "\"mcp_servers\".\"kind\" = 'mcp' or (\"mcp_servers\".\"command\" is null and \"mcp_servers\".\"args\" is null and \"mcp_servers\".\"url\" is null)"),
    ("mcp_servers_tool_config_by_kind",
      "(\"mcp_servers\".\"kind\" = 'mcp') = (\"mcp_servers\".\"tool_config\" is null)"),
    ("mcp_servers_tool_config_is_object",
      "\"mcp_servers\".\"tool_config\" is null or jsonb_typeof(\"mcp_servers\".\"tool_config\") = 'object'"),
    ("mcp_servers_tool_credential",
      "\"mcp_servers\".\"kind\" = 'mcp' or (\"mcp_servers\".\"auth_type\" = 'none' and (\"mcp_servers\".\"kind\" <> 'postgres' or \"mcp_servers\".\"credential_secret_id\" is not null))"),
    ("mcp_servers_stdio_has_command",
      "\"mcp_servers\".\"kind\" <> 'mcp' or ((\"mcp_servers\".\"transport\" = 'stdio') = (\"mcp_servers\".\"command\" is not null))"),
    ("mcp_servers_remote_has_url",
      "\"mcp_servers\".\"kind\" <> 'mcp' or ((\"mcp_servers\".\"transport\" in ('http', 'sse')) = (\"mcp_servers\".\"url\" is not null))"),
    ("mcp_servers_args_are_stdio_only",
      "\"mcp_servers\".\"kind\" <> 'mcp' or (\"mcp_servers\".\"args\" is null or \"mcp_servers\".\"transport\" = 'stdio')"),
    ("mcp_servers_command_not_blank",
      "\"mcp_servers\".\"command\" is null or length(btrim(\"mcp_servers\".\"command\")) > 0"),
    ("mcp_servers_url_shape",
      "\"mcp_servers\".\"url\" is null or \"mcp_servers\".\"url\" ~ '^https?://'"),
    ("mcp_servers_credential_required",
      "\"mcp_servers\".\"kind\" <> 'mcp' or ((\"mcp_servers\".\"auth_type\" in ('api-key', 'bearer', 'oauth')) = (\"mcp_servers\".\"credential_secret_id\" is not null))"),
    ("mcp_servers_name_not_blank", "length(btrim(\"mcp_servers\".\"name\")) > 0")]

/-- The checks `clusterCheckHolds` gives a meaning to, table by table. -/
def modelledChecks : List (TableName × String) :=
  [(.agentVersions, "agent_versions_number_positive"),
    (.agentVersionEvaluations, "agent_version_evaluations_counts"),
    (.agents, "agents_name_not_blank"),
    (.skills, "skills_name_shape"), (.skills, "skills_skill_md_not_blank"),
    (.files, "files_path_shape"), (.files, "files_path_no_dot_segments"),
    (.files, "files_storage_key_iff_file"), (.files, "files_storage_key_not_blank"),
    (.files, "files_size_non_negative"), (.files, "files_folder_has_no_content"),
    (.mcpServers, "mcp_servers_transport_by_kind"), (.mcpServers, "mcp_servers_tool_kind_fields"),
    (.mcpServers, "mcp_servers_tool_config_by_kind"),
    (.mcpServers, "mcp_servers_tool_config_is_object"),
    (.mcpServers, "mcp_servers_tool_credential"),
    (.mcpServers, "mcp_servers_stdio_has_command"), (.mcpServers, "mcp_servers_remote_has_url"),
    (.mcpServers, "mcp_servers_args_are_stdio_only"),
    (.mcpServers, "mcp_servers_command_not_blank"), (.mcpServers, "mcp_servers_url_shape"),
    (.mcpServers, "mcp_servers_credential_required"), (.mcpServers, "mcp_servers_name_not_blank")]

/-- The non-closed-set checks of the cluster's tables hold on every row. -/
def clusterChecksHold (st : State) : Bool :=
  tables.all fun t => (catalogue t).checks.all fun
    | .other n => (st t).all (clusterCheckHolds n)
    | .oneOf .. => true

/-- The states PostgreSQL can hold for this cluster: `Er.Core.consistent` under today's schema,
and the cluster's own checks. -/
@[aw_spec (ts := "packages/core/src/db/schema/index.ts")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
def consistent (st : State) : Bool := Er.Core.consistent catalogue st && clusterChecksHold st

/-- The target of a foreign key is keyed by exactly its referenced column list (the primary key
or a total unique key, in the same order), so a child row names at most one parent. -/
def targetIsExactKey (S : Schema) (fk : ForeignKey) : Bool :=
  (S fk.refTable).primaryKey == fk.refColumns ||
    (S fk.refTable).uniques.any fun u => u.partialNullColumns.isEmpty && u.columns == fk.refColumns

/-- Every foreign key of the cluster's tables, with its table. -/
def clusterForeignKeys : List (TableName × ForeignKey) :=
  tables.flatMap fun t => (catalogue t).foreignKeys.map (t, ·)

/-- A foreign key whose columns are all `NOT NULL`: every child row has exactly one parent. -/
def isMandatory (t : TableName) (fk : ForeignKey) : Bool :=
  fk.columns.all (catalogue t).isNotNull

/-! ## The typed concepts as rows -/

/-- A cell for a nullable column: nothing when the value is `NULL`. -/
def cell (c : String) : Option String → List (String × String)
  | some v => [(c, v)]
  | none => []

/-- The `jsonb` text of an argument list (only its presence matters to the checks). -/
def renderArgs (as : List String) : String := "[" ++ ",".intercalate (as.map Connector.jsonQuote) ++ "]"

/-- An MCP connector as its `mcp_servers` row (kind `mcp`, no `tool_config`), stamped with `ts`
for both timestamps. -/
def connectorRow (c : Connector.Connector) (ts : String) : Row :=
  ⟨[("id", c.id.val), ("workspace_id", c.workspace.val), ("name", c.name), ("kind", "mcp"),
      ("transport", c.transport.toWire)] ++ cell "command" c.command ++
    cell "args" (c.args.map renderArgs) ++ cell "url" c.url ++
    [("auth_type", c.authType.toWire)] ++ cell "credential_secret_id" (c.credentialSecret.map (·.val)) ++
    [("enabled", toString c.enabled)] ++ cell "created_by" (c.createdBy.map (·.val)) ++
    [("owner_principal_id", c.owner.val), ("created_at", ts), ("updated_at", ts)]⟩

/-- A tool connector as its `mcp_servers` row (no transport, command, arguments or URL, and
`auth_type` `none`), stamped with `ts` for both timestamps. -/
def toolConnectorRow (t : Connector.ToolConnector) (ts : String) : Row :=
  ⟨[("id", t.id.val), ("workspace_id", t.workspace.val), ("name", t.name),
      ("kind", t.kind.toWire), ("tool_config", t.toolConfig), ("auth_type", "none")] ++
    cell "credential_secret_id" (t.credentialSecret.map (·.val)) ++
    [("enabled", toString t.enabled)] ++ cell "created_by" (t.createdBy.map (·.val)) ++
    [("owner_principal_id", t.owner.val), ("created_at", ts), ("updated_at", ts)]⟩

/-- The `jsonb` text of an agent's permission object (only its presence matters to the checks). -/
def renderPermissions (p : Agent.Permissions) : String :=
  "{\"readFiles\":" ++ toString p.readFiles ++ ",\"writeFiles\":" ++ toString p.writeFiles ++
    ",\"runCommands\":" ++ toString p.runCommands ++ ",\"unrestrictedNetwork\":" ++
    toString p.unrestrictedNetwork ++ "}"

/-- An agent as its `agents` row, stamped with `ts` for both timestamps. The stored policy's
content is not modelled (`Agent.policyStored` says only whether it is non-`NULL`), so a stored
policy is rendered as the placeholder `{}`. -/
@[aw_spec (ts := "packages/core/src/db/schema/agents.ts#agents")]
def agentRow (a : Agent.Agent) (ts : String) : Row :=
  ⟨[("id", a.id.val), ("workspace_id", a.workspace.val), ("name", a.name),
      ("instructions", a.instructions)] ++ cell "model_connection_id" (a.modelConnection.map (·.val)) ++
    cell "model" a.model ++ cell "runtime_profile_id" (a.runtimeProfile.map (·.val)) ++
    [("permissions", renderPermissions a.permissions)] ++
    cell "policy" (if a.policyStored then some "{}" else none) ++
    cell "created_by" (a.createdBy.map (·.val)) ++
    [("owner_principal_id", a.owner.val), ("created_at", ts), ("updated_at", ts)]⟩

/-- The checks of `agents` an agent row must pass, by name. -/
def agentChecks : List String := ["agents_name_not_blank"]

/-- The checks of `files` a file row must pass, by name. -/
def fileChecks : List String :=
  ["files_path_shape", "files_path_no_dot_segments", "files_storage_key_iff_file",
    "files_storage_key_not_blank", "files_size_non_negative", "files_folder_has_no_content"]

/-- A file as its `files` row, its `bigint` size rendered as PostgreSQL renders it: in decimal,
with a leading `-` exactly when it is negative. -/
def fileRow (f : File.File) (ts : String) : Row :=
  ⟨[("id", f.id.val), ("workspace_id", f.workspace.val), ("path", f.path),
      ("kind", f.kind.toWire)] ++ cell "storage_key" f.storageKey ++
    [("size_bytes", toString f.sizeBytes)] ++ cell "content_type" f.contentType ++
    cell "created_by" (f.createdBy.map (·.val)) ++
    [("owner_principal_id", f.owner.val), ("created_at", ts), ("updated_at", ts)]⟩

/-- A skill as its `skills` row. -/
def skillRow (s : Skill.Skill) (ts : String) : Row :=
  ⟨[("id", s.id.val), ("workspace_id", s.workspace.val), ("name", s.name),
      ("skill_md", s.skillMd), ("enabled", toString s.enabled)] ++
    cell "created_by" (s.createdBy.map (·.val)) ++
    [("owner_principal_id", s.owner.val), ("created_at", ts), ("updated_at", ts)]⟩

/-- The checks of `mcp_servers` a connector row of any kind must pass, by name. -/
def connectorChecks : List String :=
  ["mcp_servers_transport_by_kind", "mcp_servers_tool_kind_fields",
    "mcp_servers_tool_config_by_kind", "mcp_servers_tool_config_is_object",
    "mcp_servers_tool_credential", "mcp_servers_stdio_has_command", "mcp_servers_remote_has_url",
    "mcp_servers_args_are_stdio_only", "mcp_servers_command_not_blank", "mcp_servers_url_shape",
    "mcp_servers_credential_required", "mcp_servers_name_not_blank"]

/-! ## A sample state: one row per table, one reference per key -/

namespace Sample

/-- A row from literal cells. -/
def row (cells : List (String × String)) : Row := ⟨cells⟩

/-- Two workspaces, two users; `u1` owns `w1` and `w2`, `u2` is a Viewer of `w1`; each membership
has its principal; in `w1` a secret, a model connection, a runtime profile, a project, an agent
that uses all three and has one version pointed at the `local` environment (one recorded move), two files (a folder and a file in it), a skill, a remote connector
authenticated by the secret and a `stdio` connector; the agent is assigned the file, the skill and
the remote connector, and granted to `u2`; the project links the file and the connector; `w2` has
an agent of its own. -/
@[aw_spec (doc := "docs/sdk/site/concepts/ownership-and-sharing.mdx#catalog-assignment-grant")]
def state : State
  | .workspaces =>
    [row [("id", "w1"), ("slug", "one"), ("name", "One"), ("public_sharing_enabled", "true"),
        ("created_at", "t0"), ("updated_at", "t0")],
     row [("id", "w2"), ("slug", "two"), ("name", "Two"), ("public_sharing_enabled", "true"),
        ("created_at", "t0"), ("updated_at", "t0")]]
  | .users =>
    [row [("id", "u1"), ("email", "a@example.com"), ("name", "A"), ("created_at", "t0"),
        ("updated_at", "t0")],
     row [("id", "u2"), ("email", "b@example.com"), ("name", "B"), ("created_at", "t0"),
        ("updated_at", "t0")]]
  | .memberships =>
    [row [("id", "m1"), ("workspace_id", "w1"), ("user_id", "u1"), ("role", "owner"),
        ("created_at", "t0"), ("updated_at", "t0")],
     row [("id", "m2"), ("workspace_id", "w1"), ("user_id", "u2"), ("role", "viewer"),
        ("created_at", "t0"), ("updated_at", "t0")],
     row [("id", "m3"), ("workspace_id", "w2"), ("user_id", "u1"), ("role", "owner"),
        ("created_at", "t0"), ("updated_at", "t0")]]
  | .workspacePrincipals =>
    [row [("id", "p1"), ("workspace_id", "w1"), ("kind", "membership"), ("membership_id", "m1"),
        ("activated_at", "t0"), ("created_at", "t0")],
     row [("id", "p2"), ("workspace_id", "w1"), ("kind", "membership"), ("membership_id", "m2"),
        ("activated_at", "t0"), ("created_at", "t0")],
     row [("id", "p3"), ("workspace_id", "w2"), ("kind", "membership"), ("membership_id", "m3"),
        ("activated_at", "t0"), ("created_at", "t0")]]
  | .secrets =>
    [row [("id", "s1"), ("workspace_id", "w1"), ("name", "github-token"),
        ("algorithm", "aes-256-gcm"), ("master_key_id", "k1"), ("wrapped_data_key", "x"),
        ("wrapped_data_key_nonce", "x"), ("wrapped_data_key_tag", "x"), ("ciphertext", "x"),
        ("ciphertext_nonce", "x"), ("ciphertext_tag", "x"), ("created_at", "t0"),
        ("updated_at", "t0")]]
  | .modelConnections =>
    [row [("id", "mc1"), ("workspace_id", "w1"), ("name", "default"), ("provider", "anthropic"),
        ("config", "{}"), ("created_at", "t0"), ("updated_at", "t0")]]
  | .runtimeProfiles =>
    [row [("id", "rp1"), ("workspace_id", "w1"), ("name", "standard"), ("driver", "docker"),
        ("network_policy", "restricted"), ("filesystem", "read-write"), ("created_at", "t0"),
        ("updated_at", "t0")]]
  | .projects =>
    [row [("id", "pr1"), ("workspace_id", "w1"), ("name", "Launch"), ("visibility", "private"),
        ("created_by", "u1"), ("owner_principal_id", "p1"), ("created_at", "t0"),
        ("updated_at", "t0")]]
  | .agents =>
    [row [("id", "a1"), ("workspace_id", "w1"), ("name", "General"), ("instructions", ""),
        ("model_connection_id", "mc1"), ("model", "claude-sonnet-4-5"),
        ("runtime_profile_id", "rp1"), ("permissions", "{}"), ("created_by", "u1"),
        ("owner_principal_id", "p1"), ("materialised_version_id", "av1"), ("created_at", "t0"),
        ("updated_at", "t0")],
     row [("id", "a2"), ("workspace_id", "w2"), ("name", "General"), ("instructions", ""),
        ("permissions", "{}"), ("owner_principal_id", "p3"), ("created_at", "t0"),
        ("updated_at", "t0")]]
  | .files =>
    [row [("id", "f1"), ("workspace_id", "w1"), ("path", "contracts"), ("kind", "folder"),
        ("size_bytes", "0"), ("created_by", "u1"), ("owner_principal_id", "p1"),
        ("created_at", "t0"), ("updated_at", "t0")],
     row [("id", "f2"), ("workspace_id", "w1"), ("path", "contracts/agreement.pdf"),
        ("kind", "file"), ("storage_key", "files/w1/contracts/agreement.pdf"),
        ("size_bytes", "1024"), ("content_type", "application/pdf"), ("created_by", "u1"),
        ("owner_principal_id", "p1"), ("created_at", "t0"), ("updated_at", "t0")]]
  | .skills =>
    [row [("id", "k1"), ("workspace_id", "w1"), ("name", "release-notes"),
        ("skill_md", "---\nname: release-notes\n---\nWrite notes."), ("enabled", "true"),
        ("created_by", "u1"), ("owner_principal_id", "p1"), ("created_at", "t0"),
        ("updated_at", "t0")]]
  | .mcpServers =>
    [row [("id", "c1"), ("workspace_id", "w1"), ("name", "GitHub"), ("kind", "mcp"),
        ("transport", "http"),
        ("url", "https://example.com/mcp"), ("auth_type", "bearer"),
        ("credential_secret_id", "s1"), ("enabled", "true"), ("created_by", "u1"),
        ("owner_principal_id", "p1"), ("created_at", "t0"), ("updated_at", "t0")],
     row [("id", "c2"), ("workspace_id", "w1"), ("name", "Filesystem"), ("kind", "mcp"),
        ("transport", "stdio"),
        ("command", "npx"), ("args", "[\"-y\"]"), ("auth_type", "none"), ("enabled", "true"),
        ("owner_principal_id", "p1"), ("created_at", "t0"), ("updated_at", "t0")]]
  | .agentFiles =>
    [row [("id", "af1"), ("workspace_id", "w1"), ("agent_id", "a1"), ("file_id", "f2"),
        ("access", "read-write"), ("created_at", "t0"), ("updated_at", "t0")]]
  | .agentSkills =>
    [row [("id", "as1"), ("workspace_id", "w1"), ("agent_id", "a1"), ("skill_id", "k1"),
        ("created_at", "t0")]]
  | .agentMcpServers =>
    [row [("id", "am1"), ("workspace_id", "w1"), ("agent_id", "a1"), ("mcp_server_id", "c1"),
        ("created_at", "t0")]]
  | .agentGrants =>
    [row [("id", "ag1"), ("workspace_id", "w1"), ("agent_id", "a1"), ("user_id", "u2"),
        ("created_at", "t0")]]
  | .agentVersions =>
    [row [("id", "av1"), ("workspace_id", "w1"), ("agent_id", "a1"), ("number", "1"),
        ("summary", "First version"), ("via", "ui"), ("body", "{}"),
        ("created_by_principal_id", "p1"), ("created_at", "t0")]]
  | .agentPointerMoves =>
    [row [("id", "apm1"), ("workspace_id", "w1"), ("agent_id", "a1"), ("environment", "local"),
        ("version_id", "av1"), ("moved_by", "p1"), ("moved_at", "t0"), ("reason", "set")]]
  | .agentVersionEvaluations =>
    [row [("id", "ave1"), ("workspace_id", "w1"), ("version_id", "av1"), ("score", "1.0000"),
        ("passed", "1"), ("total", "1"), ("cases_snapshot", "[]"), ("results", "[]"),
        ("created_by_principal_id", "p1"), ("created_at", "t0"), ("status", "completed")]]
  | .agentVersionPointers =>
    [row [("workspace_id", "w1"), ("agent_id", "a1"), ("environment", "local"),
        ("version_id", "av1"), ("created_at", "t0"), ("updated_at", "t0")]]
  | .projectFiles => [row [("workspace_id", "w1"), ("project_id", "pr1"), ("file_id", "f2")]]
  | .projectMcpServers =>
    [row [("workspace_id", "w1"), ("project_id", "pr1"), ("mcp_server_id", "c1")]]
  | _ => []

/-- The first child row of `t` whose key `fk` is non-`NULL`, with its parent row. -/
def pairOf (st : State) (t : TableName) (fk : ForeignKey) : Option (Row × Row) := do
  let r ← (st t).find? (·.present fk.columns)
  let r' ← (st fk.refTable).find? fun r' => r'.project fk.refColumns == r.project fk.columns
  pure (r, r')

/-- The sample child row for `fk`. -/
def child (t : TableName) (fk : ForeignKey) : Row := ((pairOf state t fk).map (·.1)).getD default

/-- The sample parent row for `fk`. -/
def parent (t : TableName) (fk : ForeignKey) : Row := ((pairOf state t fk).map (·.2)).getD default

end Sample

/-- The foreign key named `n` of table `t` in today's schema. -/
def fk (t : TableName) (n : String) : ForeignKey := ((catalogue t).foreignKey? n).getD default

/-- The equation lemmas of `List.lookup`, generated in this module so that the theorem modules
that compute row lookups reuse them. -/
private theorem lookup_equations (k c v : String) (rest : List (String × String)) :
    List.lookup k ([] : List (String × String)) = none ∧
      List.lookup k ((c, v) :: rest) = (if k == c then some v else List.lookup k rest) := by
  constructor
  · simp [List.lookup]
  · by_cases h : (k == c) = true <;> simp [List.lookup, h]

end AgentWorkspace.Er.Current.Catalog
