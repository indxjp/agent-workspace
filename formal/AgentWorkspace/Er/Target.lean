import AgentWorkspace.Er.Current

/-!
# The target ER model: one meaning per term

The cleaned-up schema that the P1 synthesis proposes, stated as an `Er.Core.Schema` over the same
tables, so that every predicate and every isolation lemma of `Er.Core` applies to it unchanged.
It keeps each distinction the formalisation showed to be real and removes each accident of
history. Each change below is one proposed ADR (`docs/adr/FORMAL-P1-*.md`, status proposed; none
changes product code).

| Change | Tables | ADR |
| --- | --- | --- |
| A grant names the member's **principal**, not its user id | `agent_grants` | `FORMAL-P1-grants-name-principals` |
| Every membership and API key has its principal | state invariant | `FORMAL-P1-every-source-has-a-principal` |
| One name for connectors | `mcp_servers`, `agent_mcp_servers`, `project_mcp_servers` | `FORMAL-P1-connector-is-the-only-name` |
| Every owned row names its owner `owner_principal_id`; attribution by principal | `shares`, `invitations` | `FORMAL-P1-one-owner-vocabulary` |
| A share's subject is a typed, tenant-paired reference | `shares` | `FORMAL-P1-share-subject-is-a-typed-reference` |
| A `SET NULL` reference uses the sibling pattern | `projects`, `sessions` | `FORMAL-P1-set-null-keys-use-the-sibling-pattern` |
| A principal kind has one spelling (`api-key`) | `workspace_principals` | `FORMAL-P1-principal-kind-has-one-spelling` |
| A secret's purpose is typed | `model_connections`, state invariant | `FORMAL-P1-secret-purpose-is-typed` |
| Documented row invariants are database checks | `agents`, `sessions`, `session_transcripts`, `shares`, `run_usage_records` | `FORMAL-P1-documented-row-invariants-are-checks` |
| Identity, permission and tenant selection stay separate | session claims | `FORMAL-P1-identity-permission-tenant-selection` |

Also here: the target's naming layer (`tableName`), its row-check semantics (`checkHolds`), its
consistency, `violations` (the names of the constraints a state breaks), a mermaid rendering of
the target ER (`erDiagram`), the session-claim resolution today and in the target, and the
concept glossary as data (`glossary`, `conflations`).
-/

namespace AgentWorkspace.Er.Target

open AgentWorkspace AgentWorkspace.Er.Core

/-! ## Editing table specifications -/

/-- A column list with `old` renamed to `new`. -/
def renameIn (old new : String) (cs : List String) : List String :=
  cs.map fun c => if c == old then new else c

/-- The specification with column `old` renamed to `new` everywhere the table itself mentions it:
its column list, primary key, own foreign keys, unique keys and closed-set checks. -/
def renameColumn (old new : String) (s : TableSpec) : TableSpec :=
  { s with
    columns := s.columns.map fun c => if c.name == old then { c with name := new } else c
    primaryKey := renameIn old new s.primaryKey
    foreignKeys := s.foreignKeys.map fun fk => { fk with columns := renameIn old new fk.columns }
    uniques := s.uniques.map fun u =>
      { u with columns := renameIn old new u.columns,
               partialNullColumns := renameIn old new u.partialNullColumns,
               partialNotNullColumns := renameIn old new u.partialNotNullColumns }
    checks := s.checks.map fun
      | .oneOf n c vs => .oneOf n (if c == old then new else c) vs
      | ck => ck }

/-- The foreign key named `n` replaced by `f` of it. -/
def mapKey (n : String) (f : ForeignKey → ForeignKey) (s : TableSpec) : TableSpec :=
  { s with foreignKeys := s.foreignKeys.map fun fk => if fk.name == n then f fk else fk }

/-- Columns, keys and checks appended. -/
def extend (cols : List Column) (fks : List ForeignKey) (cks : List Check) (s : TableSpec) :
    TableSpec :=
  { s with columns := s.columns ++ cols, foreignKeys := s.foreignKeys ++ fks,
           checks := s.checks ++ cks }

/-- A nullable `uuid` column. -/
def optUuid (n : String) : Column := ⟨n, .uuid, false⟩

/-- `(workspace_id, c) → workspace_principals (workspace_id, id)`. -/
def principalKey (name c : String) (onDelete : OnDelete) : ForeignKey :=
  { name, columns := ["workspace_id", c], refTable := .workspacePrincipals,
    refColumns := ["workspace_id", "id"], onDelete, inline := false }

/-- `(c, workspace_id) → t (id, workspace_id)`. -/
def pairedKey (name c : String) (t : TableName) (onDelete : OnDelete) : ForeignKey :=
  { name, columns := [c, "workspace_id"], refTable := t, refColumns := ["id", "workspace_id"],
    onDelete, inline := false }

/-- The single-column `c → t.id` key carrying `ON DELETE SET NULL` beside a tenant-paired sibling. -/
def siblingKey (name c : String) (t : TableName) : ForeignKey :=
  { name, columns := [c], refTable := t, refColumns := ["id"], onDelete := .setNull,
    inline := true }

/-! ## The target schema -/

/-- A share subject's column: one nullable, tenant-paired reference per subject type. -/
@[aw_spec (ts := "apps/web/server/composition/wiring/projects.ts#subjectOwnership")
  (doc := "docs/sdk/site/concepts/ownership-and-sharing.mdx#beyond-one-workspace")]
def subjectColumn : Concepts.Share.SubjectType → String
  | .agent => "subject_agent_id"
  | .session => "subject_session_id"
  | .project => "subject_project_id"
  | .skill => "subject_skill_id"

/-- The four subject columns, in `SHARE_SUBJECT_TYPES` order. -/
def subjectColumns : List String :=
  (WireEnum.all : List Concepts.Share.SubjectType).map subjectColumn

/-- The grant key of the target: `(workspace_id, principal_id) → workspace_principals`. -/
def grantPrincipalKey : ForeignKey :=
  principalKey "agent_grants_principal_workspace_fk" "principal_id" .cascade

/-- The target schema. Each edit of today's `catalogue` is one proposed cleanup. -/
@[aw_spec (doc := "docs/formal/concepts.md#the-target-er-model")
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
def schema : Schema :=
  let s := catalogue
  -- FORMAL-P1-grants-name-principals
  let s := s.update .agentGrants fun t =>
    { t with
      columns := t.columns.map fun c => if c.name == "user_id" then ⟨"principal_id", .uuid, true⟩ else c
      foreignKeys := t.foreignKeys.map fun fk =>
        if fk.name == "agent_grants_member_workspace_fk" then grantPrincipalKey else fk
      uniques := [{ name := "agent_grants_workspace_agent_principal_key",
                    columns := ["workspace_id", "agent_id", "principal_id"], kind := .constraint,
                    partialNullColumns := [] }] }
  -- FORMAL-P1-connector-is-the-only-name
  let s := s.update .agentMcpServers (renameColumn "mcp_server_id" "connector_id")
  let s := s.update .projectMcpServers (renameColumn "mcp_server_id" "connector_id")
  -- FORMAL-P1-set-null-keys-use-the-sibling-pattern
  let s := s.update .projects fun t =>
    (mapKey "projects_default_agent_workspace_fk" (fun fk => { fk with onDelete := .noAction }) t)
      |> extend [] [siblingKey "projects_default_agent_id_agents_id_fk" "default_agent_id" .agents] []
  -- FORMAL-P1-set-null-keys-use-the-sibling-pattern, FORMAL-P1-documented-row-invariants-are-checks
  let s := s.update .sessions fun t =>
    (mapKey "sessions_project_workspace_fk" (fun fk => { fk with onDelete := .noAction }) t)
      |> extend [] [siblingKey "sessions_project_id_projects_id_fk" "project_id" .projects]
        [.other "sessions_sdk_id_is_id"]
  -- FORMAL-P1-principal-kind-has-one-spelling
  let s := s.update .workspacePrincipals fun t =>
    { t with checks := [.oneOf "workspace_principals_kind_valid" "kind" ["membership", "api-key"],
                        .other "workspace_principals_source_matches_kind",
                        .other "workspace_principals_revoked_after_activation",
                        .other "workspace_principals_acts_for_api_key_only",
                        .other "workspace_principals_acts_for_not_self"] }
  -- FORMAL-P1-one-owner-vocabulary, FORMAL-P1-share-subject-is-a-typed-reference,
  -- FORMAL-P1-documented-row-invariants-are-checks
  let s := s.update .shares fun t =>
    { (renameColumn "publisher_principal_id" "owner_principal_id" t) with
      columns := ((renameColumn "publisher_principal_id" "owner_principal_id" t).columns.filter
          (·.name != "subject_id")) ++ subjectColumns.map optUuid
      foreignKeys := (t.foreignKeys.map fun fk =>
          if fk.name == "shares_publisher_principal_workspace_fk" then
            principalKey "shares_owner_principal_workspace_fk" "owner_principal_id" .noAction
          else fk) ++
        [pairedKey "shares_subject_agent_workspace_fk" "subject_agent_id" .agents .cascade,
         pairedKey "shares_subject_session_workspace_fk" "subject_session_id" .sessions .cascade,
         pairedKey "shares_subject_project_workspace_fk" "subject_project_id" .projects .cascade,
         pairedKey "shares_subject_skill_workspace_fk" "subject_skill_id" .skills .cascade]
      checks := (t.checks.filter (·.name != "shares_subject_id_not_blank")) ++
        [.other "shares_subject_matches_type", .other "shares_agent_has_mode",
         .other "shares_budget_only_runnable"] }
  -- FORMAL-P1-one-owner-vocabulary
  let s := s.update .invitations
    (extend [optUuid "invited_by_principal_id"]
      [principalKey "invitations_inviter_principal_workspace_fk" "invited_by_principal_id" .noAction,
       siblingKey "invitations_invited_by_principal_id_workspace_principals_id_fk"
         "invited_by_principal_id" .workspacePrincipals] [])
  -- FORMAL-P1-secret-purpose-is-typed
  let s := s.update .modelConnections
    (extend [optUuid "credential_secret_id"]
      [pairedKey "model_connections_credential_secret_workspace_fk" "credential_secret_id" .secrets
        .restrict] [])
  -- FORMAL-P1-documented-row-invariants-are-checks
  let s := s.update .agents (extend [] [] [.other "agents_model_pair"])
  let s := s.update .sessionTranscripts
    (extend [] [] [.other "session_transcripts_project_key_is_workspace"])
  let s := s.update .runUsageRecords
    (extend [] [] [.oneOf "run_usage_records_provider_valid" "provider"
      ["anthropic", "anthropic-compatible", "openai", "azure-openai", "openai-compatible"]])
  s

/-- The target's `NON_REFERENCE_ID_COLUMNS`: today's, less `shares.subject_id`, which the typed
subject columns replace. -/
def nonReferenceIdColumns : List (TableName × String × SqlType) :=
  Er.Core.nonReferenceIdColumns.filter fun d => !(d.1 == .shares && d.2.1 == "subject_id")

/-! ## Names -/

/-- The SQL name of each table in the target: the connector tables take the concept's one name. -/
@[aw_spec (doc := "docs/sdk/04-api-specification.md#58-connectors-mcp-servers--awconnectors")
  (ts := "packages/core/src/db/schema/mcp-servers.ts#mcpServers")]
def tableName : TableName → String
  | .mcpServers => "connectors"
  | .agentMcpServers => "agent_connectors"
  | .projectMcpServers => "project_connectors"
  | t => t.toWire

/-- The column of a row that names its owner principal, in the target: `owner_principal_id` on
every owned resource, including shares. -/
@[aw_spec (doc := "docs/sdk/04-api-specification.md#2-resource-model")]
def ownerColumn? : TableName → Option String
  | .agents | .skills | .files | .mcpServers | .projects | .sessions | .shares =>
    some "owner_principal_id"
  | .browserTokens => some "minted_by_principal_id"
  | .auditEvents => some "actor_principal_id"
  | _ => none

/-! ## Row checks of the target -/

/-- `shares_subject_matches_type`: exactly the subject column the subject type names is set. -/
def subjectMatchesType (r : Row) : Bool :=
  match (r.get "subject_type").bind (WireEnum.ofWire? (α := Concepts.Share.SubjectType)) with
  | none => true
  | some ty => subjectColumns.all fun c => (c == subjectColumn ty) == (r.get c).isSome

/-- The meaning of each check the target adds, by name; `none` for a check it inherits. -/
@[aw_spec (ts := "packages/core/src/db/schema/workspace-principals.ts#workspacePrincipals")
  (ts := "packages/core/src/db/schema/shares.ts#shares")
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")]
def targetCheck? (n : String) (r : Row) : Option Bool :=
  if n == "workspace_principals_source_matches_kind" then
    some ((Current.Identity.CheckExpr.xor "kind" "membership" "membership_id" "api-key"
      "api_key_id").holds r)
  else if n == "workspace_principals_acts_for_api_key_only" then
    some ((Current.Identity.CheckExpr.nullOrEquals "acts_for_principal_id" "kind" "api-key").holds r)
  else if n == "agents_model_pair" then
    some ((r.get "model_connection_id").isNone == (r.get "model").isNone)
  else if n == "sessions_sdk_id_is_id" then
    some ((r.get "engine_session_id").all fun v => some v == r.get "id")
  else if n == "session_transcripts_project_key_is_workspace" then
    some (r.get "project_key" == r.get "workspace_id")
  else if n == "shares_subject_matches_type" then some (subjectMatchesType r)
  else if n == "shares_agent_has_mode" then some (Current.Publication.Target.agentHasMode r)
  else if n == "shares_budget_only_runnable" then
    some (Current.Publication.Target.budgetOnlyRunnable r)
  else none

/-- A check of the target holds on a row: its new meaning, or the one today's schema gives it. -/
def checkHolds (t : TableName) (n : String) (r : Row) : Bool :=
  (targetCheck? n r).getD (Current.checkSemantics t n r)

/-- Every check of the target that is not a closed set holds on every row. -/
def checksHold (st : State) : Bool :=
  allTables.all fun t => (schema t).checks.all fun
    | .other n => (st t).all (checkHolds t n)
    | .oneOf .. => true

/-- The identity cluster's cell typing, against the target's columns. -/
def typed (st : State) : Bool :=
  Current.Identity.tables.all fun t => (st t).all fun r =>
    r.cells.all (Current.Identity.cellTyped (schema t)) && decide (r.cells.map (·.1)).Nodup

/-- The invariants of the target that are not row checks: every membership and API key has its
principal (RF-101), and every runtime connection a profile names is one (RF-204). -/
@[aw_spec (doc := "docs/architecture/refactoring/claude-agent-workspace-refactoring-plan.md#rf-101--introduce-workspaceprincipal-and-split-identity-ownership-and-attribution")
  (doc := "docs/architecture/refactoring/claude-agent-workspace-refactoring-plan.md#rf-204--make-credential-ownership-typed-and-transactional")]
def stateInvariants (st : State) : Bool :=
  Current.Identity.everySourceHasPrincipal st && Current.Configuration.runtimeConnectionsTyped st

/-- The states the target database can hold. -/
@[aw_spec (doc := "docs/formal/concepts.md#the-target-er-model")]
def consistent (st : State) : Bool :=
  Er.Core.consistent schema st && checksHold st && typed st && stateInvariants st

/-- The names of the constraints of schema `S` a state breaks: `<table>.<column>` for a `NULL` in a
`NOT NULL` column, `<table>_pkey` for a duplicate primary key, and the constraint name of each
failing unique key, foreign key and check, with `sem` the meaning of the non-closed-set checks. -/
def violationsUnder (S : Schema) (sem : TableName → String → Row → Bool) (st : State) :
    List String :=
  allTables.flatMap fun t =>
    let s := S t
    let rows := st t
    (s.columns.filter (fun c => !notNullHolds rows c)).map (fun c => t.toWire ++ "." ++ c.name) ++
      (if keyHolds rows s.primaryKey [] then [] else [t.toWire ++ "_pkey"]) ++
      (s.uniques.filter (fun u => !keyHolds rows u.columns u.partialNullColumns)).map (·.name) ++
      (s.foreignKeys.filter (fun fk => !fkHolds st t fk)).map (·.name) ++
      (s.checks.filterMap fun
        | .oneOf n c vs => if rows.all (fun r => (r.get c).all vs.contains) then none else some n
        | .other n =>
          if rows.all (fun r => otherCheckHolds n r && sem t n r) then none else some n)

/-- The target constraints a state breaks, including the two state invariants by name. -/
def violations (st : State) : List String :=
  violationsUnder schema checkHolds st ++
    (if Current.Identity.everySourceHasPrincipal st then [] else ["every_source_has_a_principal"]) ++
    (if Current.Configuration.runtimeConnectionsTyped st then []
     else ["runtime_connections_are_typed"])

/-! ## The target ER diagram -/

/-- Every column of the primary key, or of some total unique key, of `s` is among `cols`: two rows
that agree on `cols` are the same row. -/
def coversKey (s : TableSpec) (cols : List String) : Bool :=
  s.primaryKey.all cols.contains ||
    s.uniques.any fun u =>
      u.partialNullColumns.isEmpty && u.partialNotNullColumns.isEmpty && u.columns.all cols.contains

/-- The mermaid cardinality of a foreign key: `||` when every key column is `NOT NULL` (exactly one
parent), `|o` otherwise; `o|` on the child side when the key's columns cover a key of the child
(at most one child per parent), `o{` otherwise. -/
def cardinality (S : Schema) (t : TableName) (fk : ForeignKey) : String :=
  (if fk.columns.all (S t).isNotNull then "||" else "|o") ++ "--" ++
    (if coversKey (S t) fk.columns then "o|" else "o{")

/-- The relationships the diagram draws: every foreign key except the reference to the tenant
root (every scoped table has one) and the single-column `SET NULL` siblings (the tenant-paired key
beside each is drawn instead). The label is the child's key columns without `workspace_id`. -/
def drawn (S : Schema) : List (TableName × ForeignKey) :=
  allTables.flatMap fun t => ((S t).foreignKeys.filter fun fk =>
    classify S t fk != .rootReference && classify S t fk != .siblingPaired).map (t, ·)

/-- The label of a drawn relationship: the child's key columns other than its tenant column. -/
def label (S : Schema) (t : TableName) (fk : ForeignKey) : String :=
  match fk.columns.filter fun c => some c != (S t).tenantColumn? with
  | [] => ", ".intercalate fk.columns
  | cs => ", ".intercalate cs

/-- The target ER as a mermaid `erDiagram`, one relationship per line, generated from `schema`:
`docs/formal/concepts.md` carries this text verbatim and the conformance suite compares them. -/
@[aw_spec (doc := "docs/formal/concepts.md#the-target-er-model")]
def erDiagram : String :=
  "erDiagram\n" ++ String.join ((drawn schema).map fun (t, fk) =>
    "  " ++ tableName fk.refTable ++ " " ++ cardinality schema t fk ++ " " ++ tableName t ++
      " : \"" ++ label schema t fk ++ "\"\n")

/-! ## Identity, permission and tenant selection -/

namespace Resolution

/-- Today's browser-session claims: the subject is the user's **email**, the workspace is a slug,
and a role claim is carried that verification pins to `owner`. -/
@[aw_spec (ts := "apps/web/server/auth/session.ts#SessionClaims")]
structure ClaimsCurrent where
  sub : String
  ws : String
  role : String
  deriving DecidableEq, Repr

/-- The target's claims: the subject is the user's **id**; no permission-shaped field. -/
structure ClaimsTarget where
  sub : String
  ws : String
  deriving DecidableEq, Repr

/-- Verification of today's claims: any role other than `owner` is refused. -/
@[aw_spec (ts := "apps/web/server/auth/session.ts#SessionClaims")]
def verifyCurrent (c : ClaimsCurrent) : Bool := c.role == "owner"

/-- The principal `resolveMembership` accepts for membership row `m` of workspace `wid`: one of
that workspace, naming that membership, of kind `membership`, and not revoked (the four
conditions of its `workspacePrincipals.findFirst`). -/
@[aw_spec (ts := "packages/core/src/db/repositories/root.ts#resolveMembership")]
def activeMemberPrincipal (wid : Option String) (m p : Row) : Bool :=
  p.get "workspace_id" == wid && p.get "membership_id" == m.get "id" &&
    p.get "kind" == some "membership" && (p.get "revoked_at").isNone

/-- The active principal and role of the membership of user `uid` in workspace `wid`: the role is
read from the directory, never from a token. -/
@[aw_spec (ts := "packages/core/src/db/repositories/root.ts#resolveMembership")]
def resolveMember (st : State) (wid uid : Option String) : Option (String × String) :=
  match (st .memberships).find? (fun m => m.get "workspace_id" == wid && m.get "user_id" == uid) with
  | none => none
  | some m =>
    match (st .workspacePrincipals).find? (activeMemberPrincipal wid m) with
    | none => none
    | some p => (p.get "id").bind fun pid => (m.get "role").map (pid, ·)

/-- The workspace a slug selects. -/
def selectWorkspace (st : State) (slug : String) : Option Row :=
  (st .workspaces).find? (·.get "slug" == some slug)

/-- Today's resolution (`DatabaseRoot.resolveMembership(email, workspaceSlug)`): the user is
found by email. -/
@[aw_spec (ts := "packages/core/src/db/repositories/root.ts#resolveMembership")
  (doc := "docs/architecture.md#runtime-and-trust-boundaries")]
def resolveCurrent (st : State) (c : ClaimsCurrent) : Option (String × String) :=
  if !verifyCurrent c then none
  else match (st .users).find? (·.get "email" == some c.sub), selectWorkspace st c.ws with
    | some u, some w => resolveMember st (w.get "id") (u.get "id")
    | _, _ => none

/-- The target's resolution: the subject is the user id itself. -/
@[aw_spec (doc := "docs/architecture.md#runtime-and-trust-boundaries")]
def resolveTarget (st : State) (c : ClaimsTarget) : Option (String × String) :=
  match selectWorkspace st c.ws with
  | some w => resolveMember st (w.get "id") (some c.sub)
  | none => none

/-- The state after user `uid`'s email changes to `e` (a mutable attribute). -/
def changeEmail (st : State) (uid e : String) : State := fun t =>
  if t = .users then (st .users).map fun u =>
    if u.get "id" == some uid then ⟨(u.cells.filter (·.1 != "email")) ++ [("email", e)]⟩ else u
  else st t

end Resolution

/-! ## The concept glossary -/

/-- One glossary term: its canonical name, one meaning, today's other names for it, and the
tables where it lives in the target ER. -/
structure Term where
  name : String
  meaning : String
  aliases : List String
  tables : List TableName
  deriving Repr

/-- The concept glossary: every term with one meaning. `docs/formal/concepts.md` is its prose
form. -/
@[aw_spec (doc := "docs/formal/concepts.md#glossary")]
def glossary : List Term :=
  [⟨"workspace", "the tenant; every tenant-owned row belongs to exactly one", ["tenant"],
     [.workspaces]⟩,
   ⟨"user", "a global human identity, keyed by id", [], [.users]⟩,
   ⟨"user identity", "one OIDC (issuer, subject) pair bound to one user", [], [.userIdentities]⟩,
   ⟨"membership", "one user in one workspace with exactly one role", [], [.memberships]⟩,
   ⟨"role", "owner, admin, builder or viewer, carried by a membership, API key or invitation",
     ["permissions (api_keys header)"], []⟩,
   ⟨"principal", "a workspace_principals row: the workspace-local identity that owns rows",
     ["WorkspacePrincipal", "workspace_principals"], [.workspacePrincipals]⟩,
   ⟨"authenticated principal", "what a verified credential resolves to for one request",
     ["Principal (rbac/principal.ts)", "ActorContext"], []⟩,
   ⟨"principal kind", "membership or api-key", ["api_key (stored spelling)"], []⟩,
   ⟨"verifier", "how the caller proved identity: session, api-key or browser-token", ["via"],
     []⟩,
   ⟨"api key", "a machine credential of one workspace with one fixed role", [], [.apiKeys]⟩,
   ⟨"invitation", "an offer of one role in one workspace to one email", [], [.invitations]⟩,
   ⟨"browser token", "a short bearer attenuating its minter to one run or one session", [],
     [.browserTokens]⟩,
   ⟨"cli session", "one `aw login` of one member: an approved device code, then a user token",
     ["awu_live_", "user token", "device authorization"], [.cliSessions]⟩,
   ⟨"minter", "the principal that minted a browser token", ["minted_by_principal_id"], []⟩,
   ⟨"label", "display attribution, never an authorisation input",
     ["actor (compatibility string)", "actor_label", "displayActor"], []⟩,
   ⟨"owner", "the principal authorisation compares for own/other",
     ["publisher", "publisher_principal_id", "ownerPrincipalId"], []⟩,
   ⟨"creator", "legacy human attribution (a user id), for display only",
     ["created_by", "createdBy", "invited_by", "initiatingUserId"], []⟩,
   ⟨"agent", "an agents row", [], [.agents]⟩,
   ⟨"skill", "a skills row, addressed by its slug name", [], [.skills]⟩,
   ⟨"skill revision", "one published, immutable, numbered copy of a skill's files that an assignment may pin",
     [], [.skillRevisions]⟩,
   ⟨"file", "a node of the workspace tree: a file or a folder", ["folder"], [.files]⟩,
   ⟨"file text", "one extracted, searchable passage of a file, cached for lexical search",
     [], [.fileTexts]⟩,
   ⟨"connector", "an MCP server reached by stdio, http or sse",
     ["MCP server", "mcp_servers", "mcp_server_id", "mcpServerIds"], [.mcpServers]⟩,
   ⟨"assignment", "an agent may load or call a catalogued resource",
     ["resources", "capabilities", "file grant", "read-only grant"],
     [.agentFiles, .agentSkills, .agentStorageGrants, .agentMcpServers]⟩,
   ⟨"project link", "a project contributes a resource to its sessions", ["project resources"],
     [.projectFiles, .projectMcpServers]⟩,
   ⟨"grant", "a member (by principal) may run an agent", ["Viewer grant", "permitted"],
     [.agentGrants]⟩,
   ⟨"agent version", "one immutable, numbered snapshot of an agent's definition", [],
     [.agentVersions, .agentVersionStorageGrants]⟩,
   ⟨"version pointer", "the version of an agent that is live in one environment", [],
     [.agentVersionPointers]⟩,
   ⟨"pointer move", "one recorded move of a version pointer: a set, a promotion or a rollback", [],
     [.agentPointerMoves]⟩,
   ⟨"evaluation", "one server-scored run of an agent version's evaluation cases", [],
     [.agentVersionEvaluations]⟩,
   ⟨"endpoint client",
     "what one external platform may reach: one MCP project or one agent's A2A endpoint, with the agents it names, the API keys bound to it and the OAuth codes and tokens issued to it",
     [], [.endpointClients, .endpointClientAgents, .endpointClientApiKeys, .oauthTokens]⟩,
   ⟨"access", "read or read-write on a file assignment", [], []⟩,
   ⟨"model connection", "a named way to reach one model provider", [], [.modelConnections]⟩,
   ⟨"provider", "the API family a model connection speaks", [], []⟩,
   ⟨"runtime provider", "the engine that executes an agent", ["claude-agent-sdk"], []⟩,
   ⟨"model choice", "the pair (model connection, model)", [], []⟩,
   ⟨"credential", "the write-only secret value of a connection or connector", ["hasCredential"],
     []⟩,
   ⟨"runtime driver", "where a run executes; its last passing Test Runtime is recorded per workspace",
     ["driver"], [.runtimeVerifications]⟩,
   ⟨"runtime profile", "a named description of where and within which limits runs execute", [],
     [.runtimeProfiles]⟩,
   ⟨"runtime connection", "the endpoint and credential a driver needs",
     ["RuntimeConnection", "RUNTIME_CONNECTION__ secret"], []⟩,
   ⟨"secret", "one envelope-encrypted value of a workspace", [], [.secrets]⟩,
   ⟨"storage connection", "a bucket or folder a workspace connected; its credential is a secret",
     [], [.storageConnections]⟩,
   ⟨"secret purpose", "plain, model-connection credential or runtime connection", [], []⟩,
   ⟨"project", "a container of sessions, instructions, defaults and links", [], [.projects]⟩,
   ⟨"session", "one conversation with one agent", ["conversation"], [.sessions]⟩,
   ⟨"sign-in session", "the browser credential that proves identity",
     ["browser session", "SessionPrincipal"], []⟩,
   ⟨"engine session id", "the id the engine reports for a session; equal to the session id",
     ["engineSessionId", "providerSessionId", "engine_session_id", "claudeSessionId",
      "claude_session_id"], []⟩,
   ⟨"engine", "the harness that runs the agent loop", ["AgentPolicy.engine", "sessions.engine",
     "runs.engine"], []⟩,
   ⟨"transcript", "one stored SDK transcript of a session", [], [.sessionTranscripts]⟩,
   ⟨"transcript message", "one delivery of a transcript entry", [], [.sessionMessages]⟩,
   ⟨"session state stream", "one engine's opaque, ordered state of a session",
     ["stream", "streamKey"], [.sessionStateStreams]⟩,
   ⟨"session state entry", "one stored entry of a stream, idempotent by its entry key",
     ["entryKey"], [.sessionStateEntries]⟩,
   ⟨"session state blob", "a size-capped snapshot of an engine's own state directory",
     ["blobKey", "snapshot"], [.sessionStateBlobs]⟩,
   ⟨"run", "one execution of one agent inside one session", [], [.runs]⟩,
   ⟨"run status", "queued, running, completed, failed or cancelled", [], []⟩,
   ⟨"accounting state", "whether usage settlement is trustworthy", [], []⟩,
   ⟨"usage", "the five counters", [], []⟩,
   ⟨"ledger row", "one provider response's usage", ["usage record", "run_usage_records"],
     [.runUsageRecords]⟩,
   ⟨"run event", "a durable, sequenced stream entry of a run", [], [.runEvents]⟩,
   ⟨"run feedback", "one rating, up or down, of the answer a run gave", [], [.runFeedback]⟩,
   ⟨"run token", "a gateway credential minted for one run", [], [.runTokens]⟩,
   ⟨"surface session key", "the hashed key that lets a browser resume one surface session",
     ["resumeKey"], [.surfaceSessionKeys]⟩,
   ⟨"trigger", "what starts runs of one agent without a person at the keyboard: a webhook or a schedule",
     [], [.triggers]⟩,
   ⟨"trigger delivery", "the claimed slot of one firing of a trigger, naming the run it started",
     [], [.triggerDeliveries]⟩,
   ⟨"builder tool call", "one tool call of a Builder run, as its journal keeps it", [],
     [.builderToolCalls]⟩,
   ⟨"workspace feature", "one product feature a workspace has switched off; no row means it is on",
     ["workspace_features", "disabled feature"], [.workspaceFeatures]⟩,
   ⟨"storage migration run", "one verify pass of the move off the old object naming", [],
     [.storageMigrationRuns]⟩,
   ⟨"audit event", "one recorded control-plane action", [], [.auditEvents]⟩,
   ⟨"share", "one published subject of one workspace", [], [.shares]⟩,
   ⟨"subject", "what a share publishes: a typed reference", ["subject_id"], []⟩,
   ⟨"visibility", "who may open a share: private, workspace or public", [], []⟩,
   ⟨"mode", "how an agent share behaves: definition or runnable", [], []⟩,
   ⟨"share view", "one opening of a public link", [], [.shareViews]⟩,
   ⟨"charge", "the cost of one run attributed to a runnable share", [], [.shareRunCharges]⟩,
   ⟨"identity", "who is calling: a verified credential resolved to a principal",
     ["authentication"], []⟩,
   ⟨"permission", "what a principal may do: its role through the decision table",
     ["authorisation", "RBAC"], []⟩,
   ⟨"tenant selection", "which workspace's rows a query may touch: a repository scope",
     ["repository scope", "workspace selection"], []⟩]

/-- Words that today denote more than one glossary term, with the terms they denote. -/
@[aw_spec (doc := "docs/formal/concepts.md#conflations-today")]
def conflations : List (String × List String) :=
  [("principal", ["principal", "authenticated principal"]),
   ("session", ["session", "sign-in session"]),
   ("grant", ["grant", "assignment"]),
   ("provider", ["provider", "runtime provider"]),
   ("owner", ["owner", "role"]),
   ("failed", ["run status", "accounting state"]),
   ("project", ["project", "workspace"]),
   ("actor", ["label", "authenticated principal"]),
   ("secret", ["secret", "runtime connection", "credential"]),
   ("creator", ["creator", "owner"])]

/-- The term named `n`, if the glossary has one. -/
def term? (n : String) : Option Term := glossary.find? (·.name == n)

/-- The glossary terms whose name or alias is `w`. -/
def resolve (w : String) : List String :=
  (glossary.filter fun t => t.name == w || t.aliases.contains w).map (·.name)

end AgentWorkspace.Er.Target
