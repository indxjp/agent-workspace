import AgentWorkspace.Er.Current.Identity
import AgentWorkspace.Er.Current.Catalog
import AgentWorkspace.Er.Current.Configuration
import AgentWorkspace.Er.Current.Work
import AgentWorkspace.Er.Current.Publication

/-!
# Today's schema, whole

The five concept clusters of phase P1b each model a slice of today's tables
(`Er/Current/{Identity,Catalog,Configuration,Work,Publication}.lean`), and each gives meaning to
the non-closed-set checks of its own tables. This module puts them together into one view of
today's database:

* `Cluster` and `Cluster.tables`: the five clusters partition the tables (a T0 theorem says so);
* `refinedBy`: which cluster gives each of the 73 non-closed-set checks its meaning, and
  `checkSemantics`, the one meaning the whole schema uses (the owning cluster's);
* `consistent`: a state is consistent when every cluster's view of it is, which is
  `Er.Core.consistent catalogue` plus every refined check and the identity cluster's cell typing;
* `ownerColumn?`: the column naming the principal that owns a row, where the schema has one;
* **transactions and reachability**: a `Stmt` inserts, deletes or updates one row, a transaction is
  a list of them, and PostgreSQL commits a transaction only when the state it leaves satisfies
  every constraint (`commit`). `Reachable P` is the closure of the empty database under commits.
  Checking constraints only at the end of a transaction admits more intermediate states than
  PostgreSQL's per-statement checking does, so an invariant proved for `Reachable` holds for every
  sequence of writes the real database accepts;
* `deleteRow`: deleting one row with its inbound foreign keys' `ON DELETE` actions applied one
  level deep (`cascade` removes the referencing rows, `set null` nulls the key's columns), which
  is what exposes the unexecutable composite `SET NULL` keys of er-core finding 1;
* `Witness.state`: one consistent state with at least one row in every table and a
  populated reference through almost every foreign key, used as the witness of the whole-schema
  theorems and, mapped by `Er/Refinement.lean`, of the target.

The whole-schema theorems live in `Theorems/{WellFormed,Invariants}/ErSynthesis.lean`.
-/

namespace AgentWorkspace.Er.Current

open AgentWorkspace AgentWorkspace.Er.Core

/-! ## The five clusters -/

/-- The concept clusters of phase P1b, each the owner of a disjoint set of tables. -/
@[aw_spec (doc := "docs/formal/00-orchestrator-prompt.md#7-phases-and-units")]
inductive Cluster where
  | identity
  | catalog
  | configuration
  | work
  | publication
  deriving DecidableEq, Repr, Inhabited

/-- The cluster's name, as its unit report spells it. -/
def Cluster.toWire : Cluster → String
  | .identity => "identity"
  | .catalog => "catalog"
  | .configuration => "configuration"
  | .work => "work"
  | .publication => "publication"

instance : WireEnum Cluster where
  all := [.identity, .catalog, .configuration, .work, .publication]
  toWire := Cluster.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by
    intro a b h
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-- The tables each cluster models. -/
@[aw_spec (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")
  (ts := "packages/core/src/db/schema/index.ts")]
def Cluster.tables : Cluster → List TableName
  | .identity => Identity.tables
  | .catalog => Catalog.tables
  | .configuration => Configuration.clusterTables
  | .work => Work.workTables
  | .publication => Publication.tables

/-- The cluster a table belongs to. -/
def clusterOf (t : TableName) : Cluster :=
  ((WireEnum.all : List Cluster).find? (·.tables.contains t)).getD .identity

/-! ## Check semantics, whole-schema -/

/-- Every check of today's schema that is not a closed set, as (table, constraint name). -/
@[aw_spec (ts := "packages/core/src/db/schema/index.ts")
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")]
def otherChecks : List (TableName × String) :=
  allTables.flatMap fun t => (catalogue t).checks.filterMap fun
    | .other n => some (t, n)
    | .oneOf .. => none

/-- Whether cluster `c` gives check `n` of table `t` a meaning of its own. -/
def Cluster.refines : Cluster → TableName → String → Bool
  | .identity, t, n => Identity.checks.any fun (t', n', _) => t' == t && n' == n
  | .catalog, t, n => Catalog.modelledChecks.contains (t, n)
  | .configuration, t, n => Configuration.refinedChecks.contains (t, n)
  | .work, t, n => Work.workTables.contains t && (Work.workCheck n).isSome
  | .publication, t, n => Publication.checkSql.any fun (t', n', _) => t' == t && n' == n

/-- The clusters that give check `n` of table `t` a meaning. -/
def refinedBy (t : TableName) (n : String) : List Cluster :=
  (WireEnum.all : List Cluster).filter (·.refines t n)

/-- The meaning of check `n` of table `t` on a row: the semantics of the cluster that owns the
table. A check nobody refines holds (there is none: `every_other_check_is_refined`). -/
@[aw_spec (ts := "packages/core/src/db/schema/index.ts")
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")]
def checkSemantics (t : TableName) (n : String) (r : Row) : Bool :=
  match clusterOf t with
  | .identity => (Identity.semantics? n).all (·.holds r)
  | .catalog => Catalog.clusterCheckHolds n r
  | .configuration => Configuration.configCheckHolds n r
  | .work => Work.workCheckHolds n r
  | .publication => Publication.refinedCheckHolds n r

/-! ## Consistency, whole-schema -/

/-- Today's database is consistent: every cluster's view of the state is. That is every constraint
of `catalogue` (`Er.Core.consistent`), the meaning of every one of the 97 checks that are not
closed sets, and the identity cluster's cell typing (timestamps are instants, booleans are
`true` or `false`). -/
@[aw_spec (ts := "packages/core/src/db/schema/index.ts")
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
def consistent (st : State) : Bool :=
  Identity.consistent st && Catalog.consistent st && Configuration.consistentConfig st &&
    Work.workConsistent st && Publication.consistent st

/-! ## Owners -/

/-- The column of a row that names the principal owning it, where the schema has one: the
catalogued resources, projects and sessions (`owner_principal_id`), shares
(`publisher_principal_id`), browser tokens (`minted_by_principal_id`) and audit events
(`actor_principal_id`, the only nullable one). -/
@[aw_spec (doc := "docs/sdk/04-api-specification.md#2-resource-model")
  (ts := "packages/core/src/db/schema/agents.ts#agents_owner_principal_workspace_fk")
  (ts := "packages/core/src/db/schema/shares.ts#shares_publisher_principal_workspace_fk")]
def ownerColumn? : TableName → Option String
  | .agents | .skills | .files | .mcpServers | .projects | .sessions => some "owner_principal_id"
  | .shares => some "publisher_principal_id"
  | .browserTokens => some "minted_by_principal_id"
  | .auditEvents => some "actor_principal_id"
  | _ => none

/-- The tenant-paired key `(workspace_id, c) → workspace_principals (workspace_id, id)`. -/
def isOwnerKey (c : String) (fk : ForeignKey) : Bool :=
  fk.columns == ["workspace_id", c] && fk.refTable == .workspacePrincipals &&
    fk.refColumns == ["workspace_id", "id"]

/-- The single-column key `workspace_id → workspaces.id`. -/
def isRootKey (fk : ForeignKey) : Bool :=
  fk.columns == ["workspace_id"] && fk.refTable == .workspaces && fk.refColumns == ["id"]

/-! ## Transactions and reachable states -/

/-- One write statement: insert a row, delete every copy of a row, or replace a row by another. -/
inductive Stmt where
  | insert (t : TableName) (r : Row)
  | delete (t : TableName) (r : Row)
  | update (t : TableName) (old new : Row)
  deriving DecidableEq, Repr

/-- The state after one statement, before any constraint is checked. -/
def Stmt.apply : Stmt → State → State
  | .insert t r, st => fun u => if u = t then st u ++ [r] else st u
  | .delete t r, st => fun u => if u = t then (st u).filter (· != r) else st u
  | .update t o n, st => fun u => if u = t then (st u).map (fun x => if x == o then n else x)
      else st u

/-- The state after every statement of a transaction, before any constraint is checked. -/
def run (tx : List Stmt) (st : State) : State := tx.foldl (fun s x => x.apply s) st

/-- Commit a transaction under the constraint set `P`: its state if `P` holds there, otherwise a
rollback to the state before it. -/
def commit (P : State → Bool) (st : State) (tx : List Stmt) : State :=
  if P (run tx st) then run tx st else st

/-- The states a database with constraint set `P` can reach from empty by committed transactions,
whatever statements any writer sends. -/
inductive Reachable (P : State → Bool) : State → Prop where
  | empty : Reachable P State.empty
  | commit {st : State} (tx : List Stmt) : Reachable P st → Reachable P (commit P st tx)

/-! ## Deleting one row -/

/-- The rows of table `u` that reference row `r` of table `t` through key `fk`. -/
def referencesRow (t : TableName) (r : Row) (fk : ForeignKey) (child : Row) : Bool :=
  fk.refTable == t && child.present fk.columns && r.project fk.refColumns == child.project fk.columns

/-- Delete row `r` of table `t` under schema `S`, applying each inbound key's `ON DELETE` action to
the rows that reference it, one level deep: `cascade` removes them and `set null` sets every
column of the key to `NULL`. `no action` and `restrict` leave them, so a remaining reference
makes the state inconsistent, which is how PostgreSQL refuses the delete. -/
def deleteRow (S : Schema) (st : State) (t : TableName) (r : Row) : State := fun u =>
  let rows := if u = t then (st u).filter (· != r) else st u
  (S u).foreignKeys.foldl (fun rs fk =>
    if fk.refTable != t then rs
    else match fk.onDelete with
      | .cascade => rs.filter fun c => !referencesRow t r fk c
      | .setNull => rs.map fun c => if referencesRow t r fk c then c.nullify fk.columns else c
      | _ => rs) rows

/-! ## A consistent state with a row in every table -/

namespace Witness

/-- A row of the given cells. -/
def row (cells : List (String × String)) : Row := ⟨cells⟩

/-- The creation and update stamps every table but the two project links carries. -/
def stamps : List (String × String) := [("created_at", "1000"), ("updated_at", "1000")]

/-- The envelope columns of a well-formed secret (`secrets_*_size` checks). -/
def envelope : List (String × String) :=
  [("algorithm", "aes-256-gcm"), ("master_key_id", "local-v1"),
   ("wrapped_data_key", Configuration.bytesCell 32),
   ("wrapped_data_key_nonce", Configuration.bytesCell 12),
   ("wrapped_data_key_tag", Configuration.bytesCell 16), ("ciphertext", Configuration.bytesCell 5),
   ("ciphertext_nonce", Configuration.bytesCell 12),
   ("ciphertext_tag", Configuration.bytesCell 16)] ++ stamps

/-- A secret of workspace `ws`. -/
def secret (id ws name : String) : Row := row ([("id", id), ("workspace_id", ws), ("name", name)] ++ envelope)

/-- A membership principal. -/
def memberPrincipal (id ws m : String) : Row :=
  row [("id", id), ("workspace_id", ws), ("kind", "membership"), ("membership_id", m),
    ("activated_at", "1000"), ("created_at", "1000")]

/-- The agent `a1` of workspace `w1`. -/
def agent : Row :=
  row ([("id", "a1"), ("workspace_id", "w1"), ("name", "General"), ("instructions", "Help."),
    ("model_connection_id", "c1"), ("model", "claude-sonnet"), ("runtime_profile_id", "rp1"),
    ("permissions", "{}"), ("created_by", "u1"), ("owner_principal_id", "p1")] ++ stamps)

/-- The runtime profile of `w1`, naming the runtime connection `s1`. -/
def profile : Row :=
  row ([("id", "rp1"), ("workspace_id", "w1"), ("name", "default"), ("driver", "docker"),
    ("runtime_connection_id", "s1"), ("network_policy", "none"), ("filesystem", "read-write")] ++
    stamps)

/-- The session of `w1`, whose SDK session id is its own id. -/
def session : Row :=
  row ([("id", "se1"), ("workspace_id", "w1"), ("user_id", "u1"), ("owner_principal_id", "p1"),
    ("agent_id", "a1"), ("project_id", "pr1"), ("engine_session_id", "se1"),
    ("engine", "claude-agent-sdk"), ("status", "active")] ++ stamps)

/-- The agent share of `w1`, a definition page. -/
def share : Row :=
  row [("id", "sh1"), ("workspace_id", "w1"), ("token", "tok1"), ("subject_type", "agent"),
    ("subject_id", "a1"), ("subject_label", "General"), ("visibility", "public"),
    ("mode", "definition"), ("include", "{}"), ("spent_usd", "0"), ("stopped", "false"),
    ("created_by", "u1"), ("publisher_principal_id", "p1"), ("created_at", "1000")]

/-- The main transcript of session `se1`. -/
def transcript : Row :=
  row ([("workspace_id", "w1"), ("project_key", "w1"), ("session_id", "se1"), ("subpath", "")] ++
    stamps)

/-- The first message of that transcript. -/
def message : Row :=
  row [("workspace_id", "w1"), ("project_key", "w1"), ("session_id", "se1"), ("subpath", ""),
    ("sequence", "1"), ("position", "1"), ("entry", "{}"), ("created_at", "1000")]

/-- The usage ledger row of run `r1`. -/
def usage : Row :=
  row [("id", "ur1"), ("workspace_id", "w1"), ("run_id", "r1"),
    ("provider_response_id", "resp_1"), ("provider", "anthropic"), ("model", "claude-sonnet"),
    ("input_tokens", "10"), ("output_tokens", "5"), ("cache_read_input_tokens", "0"),
    ("cache_creation_input_tokens", "0"), ("tool_calls", "0"), ("cost_usd", "0"),
    ("cost_currency", "USD"), ("wire_protocol", "anthropic-messages"), ("created_at", "1000")]

/-- The invitation of `w1`, sent by `u1`. -/
def invitation : Row :=
  row ([("id", "i1"), ("workspace_id", "w1"), ("email", "cy@example.com"), ("role", "viewer"),
    ("invited_by", "u1"), ("token_hash", "cd34"), ("expires_at", "2000")] ++ stamps)

/-- The API-key principal of `w1`. -/
def keyPrincipal : Row :=
  row [("id", "p3"), ("workspace_id", "w1"), ("kind", "api_key"), ("api_key_id", "k1"),
    ("activated_at", "1000"), ("created_at", "1000")]

/-- The grant of agent `a1` to the viewer `u2`. -/
def grant : Row :=
  row [("id", "g1"), ("workspace_id", "w1"), ("agent_id", "a1"), ("user_id", "u2"),
    ("created_at", "1000")]

/-- Two workspaces. `w1` has two members (`u1` its owner, `u2` a viewer) and an API key, each
with its principal; a model connection (the workspace and project default) and its credential; a
runtime connection and the profile that names it, and a passing Test Runtime of its driver; a connector with its credential; a
skill with one published revision; an agent with
a file, the skill (pinned to that revision) and the connector assigned and a grant to the viewer; a project that links the
file and the connector; a session with its transcript and a message; a completed run with an
event, a usage row, a run token and a browser token; an audit event; an invitation; and a public
agent share with a view and a charge; and a webhook trigger of the agent, run as its owner, with
the delivery that started the run. `w2` has `u2` as its owner and an agent of its own. -/
@[aw_spec (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
def state : State
  | .workspaces =>
    [row ([("id", "w1"), ("slug", "one"), ("name", "One"), ("public_sharing_enabled", "true"),
       ("default_model_connection_id", "c1"), ("default_model", "claude-sonnet")] ++ stamps),
     row ([("id", "w2"), ("slug", "two"), ("name", "Two"), ("public_sharing_enabled", "false")] ++
       stamps)]
  | .users =>
    [row ([("id", "u1"), ("email", "ada@example.com"), ("name", "Ada")] ++ stamps),
     row ([("id", "u2"), ("email", "bob@example.com"), ("name", "Bob")] ++ stamps)]
  | .userIdentities =>
    [row ([("id", "ui1"), ("issuer", "https://id.example.com"), ("subject", "248289761001"),
       ("user_id", "u1")] ++ stamps)]
  | .memberships =>
    [row ([("id", "m1"), ("workspace_id", "w1"), ("user_id", "u1"), ("role", "owner")] ++ stamps),
     row ([("id", "m2"), ("workspace_id", "w1"), ("user_id", "u2"), ("role", "viewer")] ++ stamps),
     row ([("id", "m3"), ("workspace_id", "w2"), ("user_id", "u2"), ("role", "owner")] ++ stamps)]
  | .apiKeys =>
    [row ([("id", "k1"), ("workspace_id", "w1"), ("name", "CI"), ("role", "builder"),
       ("key_prefix", "ak_live_AAAA"), ("key_hash", "ab12")] ++ stamps)]
  | .workspacePrincipals =>
    [memberPrincipal "p1" "w1" "m1", memberPrincipal "p2" "w1" "m2", keyPrincipal,
     memberPrincipal "p4" "w2" "m3"]
  | .invitations => [invitation]
  | .browserTokens =>
    [row [("id", "bt1"), ("workspace_id", "w1"), ("minted_by_principal_id", "p1"),
       ("scope_kind", "run"), ("run_id", "r1"), ("token_hash", "ef56"), ("expires_at", "1300"),
       ("created_at", "1000")]]
  | .builderToolCalls =>
    [row [("id", "btc1"), ("workspace_id", "w1"), ("run_id", "engine-run-1"),
       ("call_id", "toolu_1"), ("tool", "draft_check"), ("decision", "run"), ("outcome", "ok"),
       ("input_json", "{}"), ("trace_id", "trace-1"), ("model_id", "model-1"),
       ("prompt_version", "prompt-1"), ("created_at", "1000")]]
  | .cliSessions =>
    [row [("id", "cs1"), ("workspace_id", "w1"), ("user_id", "u1"), ("user_code", "ABCDEFGH"),
       ("status", "active"), ("approval_expires_at", "1100"), ("token_hash", "bb22"),
       ("expires_at", "1300"), ("created_at", "1000")]]
  | .modelConnections =>
    [row ([("id", "c1"), ("workspace_id", "w1"), ("name", "Claude"), ("provider", "anthropic"),
       ("config", "{}")] ++ stamps)]
  | .secrets =>
    [secret "s1" "w1" "RUNTIME_CONNECTION__DOCKER__PRIMARY", secret "s2" "w1" "GITHUB_TOKEN",
     secret "s3" "w1" (Concepts.Secret.modelConnectionSecretName "c1")]
  | .runtimeProfiles => [profile]
  | .runtimeVerifications =>
    [row [("id", "rv1"), ("workspace_id", "w1"), ("driver_id", "docker"),
       ("configuration_key", "cfg1"), ("fingerprint", "fp1"), ("verified_at", "1000"),
       ("expires_at", "2000")]]
  | .agents =>
    [agent,
     row ([("id", "a2"), ("workspace_id", "w2"), ("name", "Other"), ("instructions", "Help."),
       ("permissions", "{}"), ("owner_principal_id", "p4")] ++ stamps)]
  | .skills =>
    [row ([("id", "sk1"), ("workspace_id", "w1"), ("name", "review"), ("skill_md", "# Review"),
       ("enabled", "true"), ("created_by", "u1"), ("owner_principal_id", "p1")] ++ stamps)]
  | .skillRevisions =>
    [row [("id", "skr1"), ("workspace_id", "w1"), ("skill_id", "sk1"), ("number", "1"),
       ("file_count", "1"), ("pending", "false"), ("created_at", "1000")]]
  | .fileTexts =>
    [row [("id", "ft1"), ("workspace_id", "w1"), ("file_id", "f1"), ("ordinal", "0"),
       ("page", "1"), ("text", "Hello"), ("tsv", "'hello':1"), ("source_size_bytes", "12"),
       ("source_updated_at", "1000"), ("created_at", "1000")]]
  | .files =>
    [row ([("id", "f1"), ("workspace_id", "w1"), ("path", "docs/a.md"), ("kind", "file"),
       ("storage_key", "docs/a.md"), ("size_bytes", "12"), ("content_type", "text/markdown"),
       ("created_by", "u1"), ("status", "ready"), ("area", "files"),
       ("owner_principal_id", "p1")] ++ stamps),
     row ([("id", "f2"), ("workspace_id", "w1"), ("path", "docs"), ("kind", "folder"),
       ("size_bytes", "0"), ("status", "ready"), ("area", "files"),
       ("owner_principal_id", "p1")] ++ stamps)]
  | .mcpServers =>
    [row ([("id", "cn1"), ("workspace_id", "w1"), ("name", "github"), ("kind", "mcp"),
       ("transport", "http"),
       ("url", "https://mcp.example.com"), ("auth_type", "bearer"),
       ("credential_secret_id", "s2"), ("enabled", "true"), ("owner_principal_id", "p1")] ++
       stamps)]
  | .agentFiles =>
    [row ([("id", "af1"), ("workspace_id", "w1"), ("agent_id", "a1"), ("file_id", "f1"),
       ("access", "read")] ++ stamps)]
  | .agentSkills =>
    [row [("id", "as1"), ("workspace_id", "w1"), ("agent_id", "a1"), ("skill_id", "sk1"),
       ("revision", "1"), ("created_at", "1000")]]
  | .agentStorageGrants =>
    [row [("id", "asg1"), ("workspace_id", "w1"), ("agent_id", "a1"), ("connection_id", "sc1"),
       ("prefix", "reports/"), ("access", "read"), ("created_at", "1000")]]
  | .agentMcpServers =>
    [row [("id", "am1"), ("workspace_id", "w1"), ("agent_id", "a1"), ("mcp_server_id", "cn1"),
       ("created_at", "1000")]]
  | .agentGrants => [grant]
  | .agentVersions =>
    [row [("id", "av1"), ("workspace_id", "w1"), ("agent_id", "a1"), ("number", "1"),
       ("summary", "First version"), ("via", "ui"), ("body", "{}"),
       ("created_by_principal_id", "p1"), ("created_at", "1000")]]
  | .agentVersionStorageGrants =>
    [row [("id", "avsg1"), ("workspace_id", "w1"), ("version_id", "av1"),
       ("connection_id", "sc1"), ("prefix", "reports/"), ("access", "read"),
       ("created_at", "1000")]]
  | .agentPointerMoves =>
    [row [("id", "apm1"), ("workspace_id", "w1"), ("agent_id", "a1"), ("environment", "local"),
       ("version_id", "av1"), ("moved_by", "p1"), ("moved_at", "1000"), ("reason", "set")]]
  | .agentVersionEvaluations =>
    [row [("id", "ave1"), ("workspace_id", "w1"), ("version_id", "av1"), ("score", "1.0000"),
       ("passed", "1"), ("total", "1"), ("cases_snapshot", "[]"), ("results", "[]"),
       ("created_by_principal_id", "p1"), ("created_at", "1100"), ("status", "completed")]]
  | .agentVersionPointers =>
    [row ([("workspace_id", "w1"), ("agent_id", "a1"), ("environment", "local"),
       ("version_id", "av1")] ++ stamps)]
  | .endpointClients =>
    [row ([("id", "ec1"), ("workspace_id", "w1"), ("name", "General"), ("kind", "a2a-agent"),
       ("acts_for_principal_id", "p1"), ("created_by_principal_id", "p1"),
       ("redirect_uris", "{}")] ++ stamps)]
  | .endpointClientAgents =>
    [row [("client_id", "ec1"), ("workspace_id", "w1"), ("agent_id", "a1")]]
  | .endpointClientApiKeys =>
    [row [("api_key_id", "k1"), ("client_id", "ec1"), ("workspace_id", "w1")]]
  | .oauthTokens =>
    [row [("id", "ot1"), ("workspace_id", "w1"), ("client_id", "ec1"), ("kind", "access"),
       ("token_hash", "h-ot1"), ("subject_principal_id", "p1"),
       ("resource", "https://aw.example/api/a2a/agents/general"), ("family_id", "fam1"),
       ("expires_at", "1300"), ("created_at", "1000")]]
  | .projects =>
    [row ([("id", "pr1"), ("workspace_id", "w1"), ("name", "Launch"), ("default_agent_id", "a1"),
       ("visibility", "private"), ("default_model_connection_id", "c1"),
       ("default_model", "claude-sonnet"), ("created_by", "u1"), ("owner_principal_id", "p1")] ++
       stamps)]
  | .projectFiles => [row [("workspace_id", "w1"), ("project_id", "pr1"), ("file_id", "f1")]]
  | .projectMcpServers =>
    [row [("workspace_id", "w1"), ("project_id", "pr1"), ("mcp_server_id", "cn1")]]
  | .sessions => [session]
  | .sessionTranscripts => [transcript]
  | .sessionMessages => [message]
  | .sessionStateStreams =>
    [row ([("workspace_id", "w1"), ("session_id", "se1"), ("engine", "claude-agent-sdk"),
       ("stream_key", "w1/")] ++ stamps)]
  | .sessionStateEntries =>
    [row [("workspace_id", "w1"), ("session_id", "se1"), ("engine", "claude-agent-sdk"),
       ("stream_key", "w1/"), ("sequence", "1"), ("entry_key", "e1"), ("entry", "{}"),
       ("created_at", "1000")]]
  | .sessionStateBlobs =>
    [row ([("workspace_id", "w1"), ("session_id", "se1"), ("engine", "claude-agent-sdk"),
       ("blob_key", "state.tar"), ("storage_key", "session-state/se1/claude-agent-sdk/state.tar"),
       ("status", "ready"), ("size_bytes", "3"), ("sha256", "ab12")] ++ stamps)]
  | .runs =>
    [row ([("id", "r1"), ("workspace_id", "w1"), ("session_id", "se1"), ("status", "completed"),
       ("model", "claude-sonnet"), ("provider", "anthropic"), ("model_connection_id", "c1"),
       ("started_at", "1000"), ("ended_at", "1100"), ("input_tokens", "10"),
       ("output_tokens", "5"), ("cache_read_input_tokens", "0"),
       ("cache_creation_input_tokens", "0"), ("cost_usd", "0"), ("cost_currency", "USD"),
       ("tool_calls", "0"), ("accounting_state", "pending"), ("tool_connector_ids", "{}"), ("file_grants", "{}"), ("approved_tool_calls", "[]"), ("consumed_tool_calls", "[]")] ++
       stamps)]
  | .runEvents =>
    [row [("run_id", "r1"), ("workspace_id", "w1"), ("sequence", "1"), ("type", "run.status"),
       ("data", "{}"), ("created_at", "1000")]]
  | .runFeedback =>
    [row [("id", "rf1"), ("workspace_id", "w1"), ("run_id", "r1"), ("rating", "up"),
       ("comment", "Clear answer"), ("created_at", "1100")]]
  | .runUsageRecords => [usage]
  | .runTokens =>
    [row [("id", "rt1"), ("run_id", "r1"), ("workspace_id", "w1"), ("token_hash", "aa11"),
       ("expires_at", "1300"), ("created_at", "1000")]]
  | .auditEvents =>
    [row [("id", "ae1"), ("workspace_id", "w1"), ("actor_user_id", "u1"),
       ("actor_principal_id", "p1"), ("actor_label", "Ada"), ("action", "agent-changed"),
       ("subject_label", "General"), ("created_at", "1000")]]
  | .shares => [share]
  | .shareViews => [row [("id", "sv1"), ("workspace_id", "w1"), ("share_id", "sh1"),
      ("created_at", "1000")]]
  | .shareRunCharges =>
    [row ([("run_id", "r1"), ("workspace_id", "w1"), ("share_id", "sh1"), ("charged_usd", "0")] ++
      stamps)]
  | .surfaceSessionKeys =>
    [row [("session_id", "se1"), ("workspace_id", "w1"), ("surface_name", "main"),
       ("agent_id", "a1"), ("key_hash", "h1"), ("created_at", "1000")]]
  | .triggers =>
    [row ([("id", "tr1"), ("workspace_id", "w1"), ("agent_id", "a1"), ("name", "Deploy hook"),
       ("kind", "webhook"), ("prompt_template", "Summarise {{body}}"), ("enabled", "true"),
       ("owner_principal_id", "p1"),
       ("secret_hash", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
       ("last_fired_at", "1000")] ++ stamps)]
  | .triggerDeliveries =>
    [row [("id", "td1"), ("workspace_id", "w1"), ("trigger_id", "tr1"), ("delivery_key", "evt-1"),
       ("run_id", "r1"), ("created_at", "1000")]]
  | .storageConnections =>
    [row ([("id", "sc1"), ("workspace_id", "w1"), ("name", "archive"), ("provider", "s3"),
       ("url", "s3://archive/"), ("allowed_prefixes", "{}"), ("write_allowed", "false")] ++
       stamps)]
  | .workspaceFeatures =>
    [row [("id", "wf1"), ("workspace_id", "w1"), ("feature", "surfaces"), ("created_at", "1000")]]
  | .storageMigrationRuns =>
    [row [("id", "smr1"), ("finished_at", "1000"), ("rows_checked", "4"), ("legacy_rows", "0"),
       ("mismatches", "0"), ("stage", "finalize"), ("skipped_ownerless", "0"),
       ("skipped_path_taken", "0"), ("skipped_failed", "0")]]

/-- The transaction that inserts every row of `state` into an empty database, parents first. -/
def load : List Stmt :=
  [.workspaces, .users, .userIdentities, .memberships, .apiKeys, .workspacePrincipals,
    .invitations, .cliSessions, .modelConnections, .secrets, .storageConnections, .runtimeProfiles,
    .runtimeVerifications, .agents, .skills, .skillRevisions, .files, .fileTexts,
    .mcpServers, .agentFiles, .agentSkills, .agentStorageGrants, .agentMcpServers, .agentGrants,
    .agentVersions, .agentVersionStorageGrants,
    .agentVersionPointers, .agentPointerMoves, .agentVersionEvaluations, .endpointClients,
    .endpointClientAgents, .endpointClientApiKeys, .oauthTokens, .projects, .projectFiles,
    .projectMcpServers, .sessions, .surfaceSessionKeys, .sessionTranscripts, .sessionMessages, .sessionStateStreams, .sessionStateEntries, .sessionStateBlobs, .runs,
    .runEvents, .runFeedback, .runUsageRecords, .runTokens, .browserTokens, .builderToolCalls, .auditEvents, .shares, .shareViews,
    .shareRunCharges, .triggers, .triggerDeliveries, .storageMigrationRuns,
    .workspaceFeatures].flatMap fun t =>
      (state t).map (.insert t)

end Witness

end AgentWorkspace.Er.Current
