import AgentWorkspace.Er.Core
import AgentWorkspace.Concepts.ModelConnection
import AgentWorkspace.Concepts.RuntimeProfile

/-!
# Today's configuration tables: `model_connections`, `runtime_profiles`, `secrets`

The three tables of the configuration cluster are rows of `Er.Core.catalogue`; this module adds
what the shared foundation leaves to the owning cluster:

* **the foreign keys that touch the cluster**, outbound and inbound, by name (`clusterForeignKeys`);
* **the semantics of the cluster's non-closed-set checks** (`configCheckHolds`): the name and
  envelope checks of `secrets`, `runtime_profiles_name_not_blank`, and the two
  `…_default_model_pair` checks that constrain how a model connection may be referenced;
* **the delete behaviour of inbound references** (`deleteClearsReference`), which decides whether
  deleting a connection, profile or secret can be refused by a referencing row;
* **the maps from concept rows to `Er.Core` rows** (`secretRow`, `modelConnectionRow`,
  `runtimeProfileRow`), so the generic constraint predicates and isolation lemmas apply to the
  concepts;
* **the typed-reference target** for runtime connections (`runtimeConnectionsTyped`), which today's
  schema does not enforce.

A `bytea` cell is written as hexadecimal text, two digits per byte, so its octet length is half
its length.
-/

namespace AgentWorkspace.Er.Current.Configuration

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Concepts

/-! ## The cluster and its foreign keys -/

/-- The tables of the configuration cluster. -/
@[aw_spec (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")
  (ts := "packages/core/src/db/schema/index.ts")]
def clusterTables : List TableName := [.modelConnections, .runtimeProfiles, .secrets]

/-- The foreign key named `n` of table `t` in today's schema (a default key if there is none). -/
def fkOf (t : TableName) (n : String) : ForeignKey := ((catalogue t).foreignKey? n).getD default

/-- Every foreign key into table `target`, with the table that declares it. -/
def inbound (S : Schema) (target : TableName) : List (TableName × ForeignKey) :=
  allTables.flatMap fun t => ((S t).foreignKeys.filter (·.refTable == target)).map (t, ·)

/-- Every foreign key that starts or ends in the cluster, as (declaring table, constraint name,
target table): the cluster's own references to the root and to `secrets`, and every reference
from elsewhere into a cluster table. -/
@[aw_spec (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")]
def clusterForeignKeys : List (TableName × String × TableName) :=
  [(.modelConnections, "model_connections_workspace_id_workspaces_id_fk", .workspaces),
   (.runtimeProfiles, "runtime_profiles_workspace_id_workspaces_id_fk", .workspaces),
   (.runtimeProfiles, "runtime_profiles_runtime_connection_id_secrets_id_fk", .secrets),
   (.runtimeProfiles, "runtime_profiles_runtime_connection_workspace_fk", .secrets),
   (.secrets, "secrets_workspace_id_workspaces_id_fk", .workspaces),
   (.agents, "agents_model_connection_id_model_connections_id_fk", .modelConnections),
   (.agents, "agents_model_connection_workspace_fk", .modelConnections),
   (.agents, "agents_runtime_profile_id_runtime_profiles_id_fk", .runtimeProfiles),
   (.agents, "agents_runtime_profile_workspace_fk", .runtimeProfiles),
   (.projects, "projects_default_model_connection_id_model_connections_id_fk", .modelConnections),
   (.projects, "projects_default_model_connection_workspace_fk", .modelConnections),
   (.runs, "runs_model_connection_id_model_connections_id_fk", .modelConnections),
   (.runs, "runs_model_connection_workspace_fk", .modelConnections),
   (.workspaces, "workspaces_default_model_connection_id_model_connections_id_fk",
     .modelConnections),
   (.workspaces, "workspaces_default_model_connection_workspace_fk", .modelConnections),
   (.mcpServers, "mcp_servers_credential_secret_workspace_fk", .secrets)]

/-- `clusterForeignKeys` is exactly the set of today's foreign keys that start or end in a cluster
table: every listed key exists with the listed target, and no other key touches the cluster. -/
def clusterForeignKeysComplete : Bool :=
  clusterForeignKeys.all (fun (t, n, target) =>
      ((catalogue t).foreignKey? n).any (·.refTable == target)) &&
    allTables.all fun t => (catalogue t).foreignKeys.all fun fk =>
      !(clusterTables.contains t || clusterTables.contains fk.refTable) ||
        clusterForeignKeys.contains (t, fk.name, fk.refTable)

/-! ## Delete behaviour of inbound references -/

/-- Deleting the referenced row can never be refused because of this key: the key cascades, sets
itself to `NULL`, or is a composite `NO ACTION` key whose non-tenant columns a `SET NULL` sibling on
the same target clears first (so `MATCH SIMPLE` stops checking it). -/
def deleteClearsReference (S : Schema) (t : TableName) (fk : ForeignKey) : Bool :=
  fk.onDelete == .cascade || fk.onDelete == .setNull ||
    (fk.onDelete == .noAction &&
      (S t).foreignKeys.any fun g =>
        g.refTable == fk.refTable && g.onDelete == .setNull &&
          g.columns == fk.columns.filter fun c => some c != (S t).tenantColumn?)

/-- No row anywhere can make deleting a row of `target` fail: every inbound key clears itself
(`deleteClearsReference`), and every `SET NULL` key is executable (`setNullSound`). -/
def deleteNeverBlocked (S : Schema) (target : TableName) : Bool :=
  (inbound S target).all fun (t, fk) => deleteClearsReference S t fk && setNullSound S t fk

/-! ## Check semantics -/

/-- The octet length of a `bytea` cell written as hexadecimal text. -/
def octetLength (s : String) : Nat := s.length / 2

/-- A cell satisfies `p`, or is `NULL` (SQL's three-valued `CHECK` passes on `NULL`). -/
def cellOk (r : Row) (c : String) (p : String → Bool) : Bool := (r.get c).all p

/-- `(a IS NULL) = (b IS NULL)`: the two columns are set together or not at all. -/
def pairHolds (r : Row) (a b : String) : Bool := (r.get a).isNone == (r.get b).isNone

/-- The semantics of the non-closed-set checks this cluster owns or depends on, by constraint
name; any other name holds here (the owning cluster refines it). -/
@[aw_spec (ts := "packages/core/src/db/schema/secrets.ts#secrets")
  (ts := "packages/core/src/db/schema/runtime-profiles.ts#runtimeProfiles")
  (ts := "packages/core/src/db/schema/workspaces.ts#workspaces")
  (ts := "packages/core/src/db/schema/projects.ts#projects")]
def configCheckHolds (n : String) (r : Row) : Bool :=
  if n == "secrets_name_shape" then cellOk r "name" Secret.isValidName
  else if n == "secrets_master_key_id_not_blank" then cellOk r "master_key_id" Secret.sqlNotBlank
  else if n == "secrets_wrapped_data_key_size" then
    cellOk r "wrapped_data_key" (octetLength · == Secret.wrappedDataKeyBytes)
  else if n == "secrets_nonce_sizes" then
    cellOk r "wrapped_data_key_nonce" (octetLength · == Secret.nonceBytes) &&
      cellOk r "ciphertext_nonce" (octetLength · == Secret.nonceBytes)
  else if n == "secrets_tag_sizes" then
    cellOk r "wrapped_data_key_tag" (octetLength · == Secret.tagBytes) &&
      cellOk r "ciphertext_tag" (octetLength · == Secret.tagBytes)
  else if n == "secrets_ciphertext_not_empty" then cellOk r "ciphertext" (0 < octetLength ·)
  else if n == "runtime_profiles_name_not_blank" then cellOk r "name" Secret.sqlNotBlank
  else if n == "runtime_profiles_workspace_default_true_or_null" then
    cellOk r "workspace_default" (· == "true")
  else if n == "workspaces_default_model_pair" || n == "projects_default_model_pair" then
    pairHolds r "default_model_connection_id" "default_model"
  else true

/-- The checks refined here, by table. -/
def refinedChecks : List (TableName × String) :=
  [(.secrets, "secrets_name_shape"), (.secrets, "secrets_master_key_id_not_blank"),
   (.secrets, "secrets_wrapped_data_key_size"), (.secrets, "secrets_nonce_sizes"),
   (.secrets, "secrets_tag_sizes"), (.secrets, "secrets_ciphertext_not_empty"),
   (.runtimeProfiles, "runtime_profiles_name_not_blank"),
   (.runtimeProfiles, "runtime_profiles_workspace_default_true_or_null"),
   (.workspaces, "workspaces_default_model_pair"), (.projects, "projects_default_model_pair")]

/-- Every refined check holds on every row of its table. -/
def refinedChecksHold (st : State) : Bool :=
  refinedChecks.all fun (t, n) => (st t).all (configCheckHolds n)

/-- The states PostgreSQL can hold, with this cluster's checks given their meaning. -/
@[aw_spec (ts := "packages/core/src/db/schema/secrets.ts#secrets")
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")]
def consistentConfig (st : State) : Bool := consistent catalogue st && refinedChecksHold st

/-! ## Concept rows as `Er.Core` rows -/

/-- A `bytea` cell of `n` octets. -/
def bytesCell (n : Nat) : String := String.ofList (List.replicate (2 * n) '0')

/-- The optional cells of a row: present values only. -/
def optCells (cs : List (String × Option String)) : List (String × String) :=
  cs.filterMap fun (c, v) => v.map (c, ·)

/-- Looking a column up past a cell of another column: that cell does not answer for it, whether
present or absent. -/
theorem lookup_optCells_cons_ne {k c : String} {w : Option String}
    {cs : List (String × Option String)} (h : c ≠ k) :
    List.lookup k (optCells ((c, w) :: cs)) = List.lookup k (optCells cs) := by
  cases w with
  | none => simp [optCells]
  | some x =>
    have hb : (k == c) = false := beq_false_of_ne (Ne.symm h)
    simp [optCells, List.lookup, hb]

/-- The one optional cell of a column is what looking that column up answers. -/
theorem lookup_optCells_single (k : String) (v : Option String) :
    List.lookup k (optCells [(k, v)]) = v := by
  cases v <;> simp [optCells]

/-- A secret as a `secrets` row. -/
def secretRow (s : Secret.Secret) : Row :=
  ⟨[("id", s.id.val), ("workspace_id", s.workspace.val), ("name", s.name),
    ("algorithm", s.algorithm.toWire), ("master_key_id", s.envelope.masterKeyId),
    ("wrapped_data_key", bytesCell s.envelope.wrappedDataKey),
    ("wrapped_data_key_nonce", bytesCell s.envelope.wrappedDataKeyNonce),
    ("wrapped_data_key_tag", bytesCell s.envelope.wrappedDataKeyTag),
    ("ciphertext", bytesCell s.envelope.ciphertext),
    ("ciphertext_nonce", bytesCell s.envelope.ciphertextNonce),
    ("ciphertext_tag", bytesCell s.envelope.ciphertextTag),
    ("created_at", s.createdAt), ("updated_at", s.updatedAt)]⟩

/-- The `jsonb` text of a model-connection config. -/
def configJson (c : ModelConnection.Config) : String :=
  "{" ++ ", ".intercalate (optCells [("\"baseUrl\"", c.baseUrl.map (s!"\"{·}\"")),
    ("\"deployment\"", c.deployment.map (s!"\"{·}\"")),
    ("\"apiVersion\"", c.apiVersion.map (s!"\"{·}\""))] |>.map fun (k, v) => k ++ ": " ++ v) ++ "}"

/-- A model connection as a `model_connections` row. -/
def modelConnectionRow (m : ModelConnection.ModelConnection) : Row :=
  ⟨[("id", m.id.val), ("workspace_id", m.workspace.val), ("name", m.name),
    ("provider", m.provider.toWire), ("config", configJson m.config),
    ("created_at", m.createdAt), ("updated_at", m.updatedAt)]⟩

/-- A runtime profile as a `runtime_profiles` row. -/
def runtimeProfileRow (p : RuntimeProfile.RuntimeProfile) : Row :=
  ⟨[("id", p.id.val), ("workspace_id", p.workspace.val), ("name", p.name),
    ("driver", p.driver.toWire), ("network_policy", p.networkPolicy.toWire),
    ("filesystem", p.filesystem.toWire), ("created_at", p.createdAt),
    ("updated_at", p.updatedAt)] ++
    optCells [("runtime_connection_id", p.runtimeConnection.map (·.val)),
      ("cpu", p.cpu.map toString), ("memory_mb", p.memoryMb.map toString),
      ("disk_mb", p.diskMb.map toString),
      ("allowed_domains", p.allowedDomains.map toString),
      ("persist_paths", p.persistPaths.map toString),
      ("timeout_seconds", p.timeoutSeconds.map toString),
      ("idle_timeout_seconds", p.idleTimeoutSeconds.map toString),
      ("driver_config", if p.hasDriverConfig then some "{}" else none),
      ("workspace_default", if p.workspaceDefault then some "true" else none)]⟩

/-! ## The typed-reference target for runtime connections -/

/-- Target (RF-204, `docs/sdk/04-api-specification.md` §5.5): every secret a runtime profile names
is a runtime connection. Today nothing enforces it; the foreign key accepts any secret of the
workspace. -/
@[aw_spec (doc := "docs/sdk/04-api-specification.md#55-secrets--awsecrets")
  (ts := "packages/core/src/db/schema/runtime-profiles.ts#runtimeProfiles")]
def runtimeConnectionsTyped (st : State) : Bool :=
  (st .runtimeProfiles).all fun p =>
    match p.get "runtime_connection_id" with
    | none => true
    | some sid => (st .secrets).all fun s =>
        s.get "id" != some sid || (s.get "name").any fun n =>
          Secret.purposeOf n == .runtimeConnection

/-! ## A witness state

Two workspaces. The first has a member and its principal, a model connection that is also the
workspace and project default, a runtime connection (a secret) and a runtime profile that names
it, a plain secret that a connector uses as its credential, an agent that uses the connection and
the profile, a project, a session and a run that records the connection. The second workspace
reuses the connection and secret names, which are unique per workspace only. Every foreign key
that touches the cluster has a populated reference in it. -/

namespace Witness

/-- A `bytea` value of `n` octets. -/
def bytes (n : Nat) : String := bytesCell n

/-- The envelope columns of a well-formed secret. -/
def envelope : List (String × String) :=
  [("algorithm", "aes-256-gcm"), ("master_key_id", "local-v1"),
   ("wrapped_data_key", bytes 32), ("wrapped_data_key_nonce", bytes 12),
   ("wrapped_data_key_tag", bytes 16), ("ciphertext", bytes 5), ("ciphertext_nonce", bytes 12),
   ("ciphertext_tag", bytes 16), ("created_at", "t0"), ("updated_at", "t0")]

/-- A `secrets` row. -/
def secret (id ws name : String) : Row :=
  ⟨[("id", id), ("workspace_id", ws), ("name", name)] ++ envelope⟩

/-- A `model_connections` row. -/
def connection (id ws : String) : Row :=
  ⟨[("id", id), ("workspace_id", ws), ("name", "Claude"), ("provider", "anthropic"),
    ("config", "{}"), ("created_at", "t0"), ("updated_at", "t0")]⟩

/-- The runtime profile of the first workspace, naming the runtime connection `s1`. -/
def profile : Row :=
  ⟨[("id", "rp1"), ("workspace_id", "w1"), ("name", "default"), ("driver", "docker"),
    ("runtime_connection_id", "s1"), ("network_policy", "none"), ("filesystem", "read-write"),
    ("created_at", "t0"), ("updated_at", "t0")]⟩

/-- The agent of the first workspace. -/
def agent : Row :=
  ⟨[("id", "a1"), ("workspace_id", "w1"), ("name", "General"), ("instructions", "Help."),
    ("model_connection_id", "c1"), ("model", "claude-sonnet"), ("runtime_profile_id", "rp1"),
    ("permissions", "{}"), ("owner_principal_id", "p1"), ("created_at", "t0"),
    ("updated_at", "t0")]⟩

/-- The first workspace, defaulting to connection `c1`. -/
def workspace1 : Row :=
  ⟨[("id", "w1"), ("slug", "one"), ("name", "One"), ("public_sharing_enabled", "true"),
    ("default_model_connection_id", "c1"), ("default_model", "claude-sonnet"),
    ("created_at", "t0"), ("updated_at", "t0")]⟩

/-- The project of the first workspace, defaulting to connection `c1`. -/
def project : Row :=
  ⟨[("id", "pr1"), ("workspace_id", "w1"), ("name", "Launch"), ("visibility", "private"),
    ("default_model_connection_id", "c1"), ("default_model", "claude-sonnet"),
    ("owner_principal_id", "p1"), ("created_at", "t0"), ("updated_at", "t0")]⟩

/-- The run of the first workspace, recording connection `c1`. -/
def run : Row :=
  ⟨[("id", "r1"), ("workspace_id", "w1"), ("session_id", "se1"), ("status", "queued"),
    ("model_connection_id", "c1"), ("provider", "anthropic"), ("input_tokens", "0"),
    ("output_tokens", "0"), ("cache_read_input_tokens", "0"),
    ("cache_creation_input_tokens", "0"), ("cost_usd", "0"), ("cost_currency", "USD"),
    ("tool_calls", "0"), ("accounting_state", "pending"), ("tool_connector_ids", "{}"),
    ("created_at", "t0"),
    ("updated_at", "t0")]⟩

/-- The connector of the first workspace, using the plain secret `s2` as its credential. -/
def connector : Row :=
  ⟨[("id", "k1"), ("workspace_id", "w1"), ("name", "github"), ("kind", "mcp"),
    ("transport", "http"),
    ("url", "https://mcp.example.com"), ("auth_type", "bearer"), ("credential_secret_id", "s2"),
    ("enabled", "true"), ("owner_principal_id", "p1"), ("created_at", "t0"),
    ("updated_at", "t0")]⟩

/-- The witness state. -/
def state : State
  | .workspaces =>
    [workspace1,
     ⟨[("id", "w2"), ("slug", "two"), ("name", "Two"), ("public_sharing_enabled", "true"),
       ("created_at", "t0"), ("updated_at", "t0")]⟩]
  | .users =>
    [⟨[("id", "u1"), ("email", "a@example.com"), ("name", "A"), ("created_at", "t0"),
       ("updated_at", "t0")]⟩]
  | .memberships =>
    [⟨[("id", "m1"), ("workspace_id", "w1"), ("user_id", "u1"), ("role", "owner"),
       ("created_at", "t0"), ("updated_at", "t0")]⟩]
  | .workspacePrincipals =>
    [⟨[("id", "p1"), ("workspace_id", "w1"), ("kind", "membership"), ("membership_id", "m1"),
       ("activated_at", "t0"), ("created_at", "t0")]⟩]
  | .modelConnections => [connection "c1" "w1", connection "c2" "w2"]
  | .secrets =>
    [secret "s1" "w1" "RUNTIME_CONNECTION__DOCKER__PRIMARY", secret "s2" "w1" "GITHUB_TOKEN",
     secret "s3" "w2" "GITHUB_TOKEN"]
  | .runtimeProfiles => [profile]
  | .agents => [agent]
  | .projects => [project]
  | .sessions =>
    [⟨[("id", "se1"), ("workspace_id", "w1"), ("owner_principal_id", "p1"), ("agent_id", "a1"),
       ("status", "active"), ("created_at", "t0"), ("updated_at", "t0")]⟩]
  | .runs => [run]
  | .mcpServers => [connector]
  | _ => []

end Witness

end AgentWorkspace.Er.Current.Configuration
