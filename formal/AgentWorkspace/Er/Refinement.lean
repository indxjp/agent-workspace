import AgentWorkspace.Er.Target

/-!
# The refinement map: today's schema onto the target

`toTarget` maps every state of today's database onto a state of the target schema, row by row:
it never adds or drops a row and never moves a row to another workspace
(`Theorems/Refinement/ErSynthesis.lean` proves both). Per table:

* `agent_grants`: `user_id` becomes `principal_id`, the principal of that user's membership in the
  grant's workspace;
* `agent_mcp_servers`, `project_mcp_servers`: `mcp_server_id` is renamed `connector_id`;
* `workspace_principals`: the kind `api_key` is spelled `api-key`;
* `shares`: `publisher_principal_id` is renamed `owner_principal_id`, and `subject_id` moves to
  the subject column its `subject_type` names;
* `invitations`: `invited_by_principal_id` is the principal of the inviter's membership, if any;
* `model_connections`: `credential_secret_id` is the secret named `MODEL_CONNECTION_<ID>` in the
  connection's workspace, if any (today's naming convention, made a key);
* every other table is unchanged.

`fkImage` is the same map on foreign keys: the key of the target that a key of today's schema
becomes. The T4 theorems check that every tenancy constraint of today (a root, tenant-paired or
sibling-paired reference) has an image of the same class in the target, and name every cell where
the two schemas differ.
-/

namespace AgentWorkspace.Er.Refinement

open AgentWorkspace AgentWorkspace.Er.Core

/-! ## Row edits -/

/-- The row with column `c` set to `v` (`none` is `NULL`). -/
def setCell (c : String) (v : Option String) (r : Row) : Row :=
  ⟨r.cells.filter (·.1 != c) ++ (v.map (c, ·)).toList⟩

/-- The row with column `old` renamed `new`. -/
def renameCell (old new : String) (r : Row) : Row :=
  ⟨r.cells.map fun p => if p.1 == old then (new, p.2) else p⟩

/-- The row with the value of column `c` rewritten by `f`. -/
def mapCell (c : String) (f : String → String) (r : Row) : Row :=
  ⟨r.cells.map fun p => if p.1 == c then (p.1, f p.2) else p⟩

/-! ## Lookups the map needs -/

/-- The principal of user `uid`'s membership in workspace `ws`, in state `st`. -/
@[aw_spec (ts := "packages/core/src/db/schema/agent-grants.ts#agentGrants")]
def principalOfUser (st : State) (ws uid : Option String) : Option String :=
  if uid.isNone then none
  else match (st .memberships).find? (fun m => m.get "workspace_id" == ws && m.get "user_id" == uid) with
    | none => none
    | some m => ((st .workspacePrincipals).find? fun p =>
        p.get "workspace_id" == ws && p.get "membership_id" == m.get "id").bind (·.get "id")

/-- The credential secret of model connection `id` in workspace `ws`: the secret the name
convention `MODEL_CONNECTION_<ID>` points at. -/
@[aw_spec (ts := "apps/web/server/models/store.ts#modelConnectionSecretName")]
def credentialOf (st : State) (ws id : Option String) : Option String :=
  match id with
  | none => none
  | some i => ((st .secrets).find? fun s =>
      s.get "workspace_id" == ws && s.get "name" == some (Concepts.Secret.modelConnectionSecretName i)).bind
      (·.get "id")

/-- The target spelling of a principal kind. -/
def kindToTarget (k : String) : String := if k == "api_key" then "api-key" else k

/-- A share's subject in the target: `subject_id` moved to its type's column. -/
def splitSubject (r : Row) : Row :=
  let r' := setCell "subject_id" none r
  match (r.get "subject_type").bind (WireEnum.ofWire? (α := Concepts.Share.SubjectType)) with
  | some ty => setCell (Target.subjectColumn ty) (r.get "subject_id") r'
  | none => r'

/-! ## The map -/

/-- One row of table `t` of state `st`, as the target stores it. -/
@[aw_spec (doc := "docs/formal/concepts.md#current-to-target-mapping")]
def mapRow (st : State) : TableName → Row → Row
  | .agentGrants, r =>
    setCell "user_id" none (setCell "principal_id"
      (principalOfUser st (r.get "workspace_id") (r.get "user_id")) r)
  | .agentMcpServers, r => renameCell "mcp_server_id" "connector_id" r
  | .projectMcpServers, r => renameCell "mcp_server_id" "connector_id" r
  | .workspacePrincipals, r => mapCell "kind" kindToTarget r
  | .shares, r => splitSubject (renameCell "publisher_principal_id" "owner_principal_id" r)
  | .invitations, r =>
    setCell "invited_by_principal_id" (principalOfUser st (r.get "workspace_id") (r.get "invited_by")) r
  | .modelConnections, r =>
    setCell "credential_secret_id" (credentialOf st (r.get "workspace_id") (r.get "id")) r
  | _, r => r

/-- The refinement map: every row of today's state, as the target stores it. -/
@[aw_spec (doc := "docs/formal/concepts.md#current-to-target-mapping")]
def toTarget (st : State) : State := fun t => (st t).map (mapRow st t)

/-- The key of the target a foreign key of today's table `t` becomes. -/
@[aw_spec (doc := "docs/formal/concepts.md#current-to-target-mapping")]
def fkImage (t : TableName) (fk : ForeignKey) : ForeignKey :=
  match t with
  | .agentGrants =>
    if fk.name == "agent_grants_member_workspace_fk" then Target.grantPrincipalKey else fk
  | .agentMcpServers | .projectMcpServers =>
    { fk with columns := Target.renameIn "mcp_server_id" "connector_id" fk.columns }
  | .projects =>
    if fk.name == "projects_default_agent_workspace_fk" then { fk with onDelete := .noAction }
    else fk
  | .sessions =>
    if fk.name == "sessions_project_workspace_fk" then { fk with onDelete := .noAction } else fk
  | .shares =>
    if fk.name == "shares_publisher_principal_workspace_fk" then
      Target.principalKey "shares_owner_principal_workspace_fk" "owner_principal_id" .noAction
    else fk
  | _ => fk

/-- A foreign key is a tenancy constraint: a reference to the tenant root, or a reference between
two tenant-carrying tables that is tenant-paired by itself or by a sibling. -/
def isTenancyConstraint (S : Schema) (t : TableName) (fk : ForeignKey) : Bool :=
  match classify S t fk with
  | .rootReference | .tenantPaired | .siblingPaired => true
  | .globalReference | .unpaired => false

/-- The key's image is a key of the target with the same tenancy class. -/
def keptInTarget (t : TableName) (fk : ForeignKey) : Bool :=
  (Target.schema t).foreignKeys.contains (fkImage t fk) &&
    classify Target.schema t (fkImage t fk) == classify catalogue t fk

/-! ## Where the two schemas differ -/

/-- The keys of today that the target changes, by table and constraint name. -/
def changedKeys : List (TableName × String) :=
  allTables.flatMap fun t =>
    ((catalogue t).foreignKeys.filter fun fk => fkImage t fk != fk).map fun fk => (t, fk.name)

/-- The keys of the target that are no key's image: the constraints the target adds. -/
def addedKeys : List (TableName × String) :=
  allTables.flatMap fun t =>
    ((Target.schema t).foreignKeys.filter fun fk' =>
      !(catalogue t).foreignKeys.any fun fk => fkImage t fk == fk').map fun fk => (t, fk.name)

/-- The columns the target adds and drops, by table. -/
def columnChanges : List (TableName × List String × List String) :=
  allTables.filterMap fun t =>
    let now := (catalogue t).columnNames
    let tgt := (Target.schema t).columnNames
    let added := tgt.filter (!now.contains ·)
    let dropped := now.filter (!tgt.contains ·)
    if added.isEmpty && dropped.isEmpty then none else some (t, added, dropped)

/-- The checks the target adds and drops, by table (a closed set whose value list changes counts
as both). -/
def checkChanges : List (TableName × List String × List String) :=
  allTables.filterMap fun t =>
    let now := (catalogue t).checks
    let tgt := (Target.schema t).checks
    let added := (tgt.filter (!now.contains ·)).map Check.name
    let dropped := (now.filter (!tgt.contains ·)).map Check.name
    if added.isEmpty && dropped.isEmpty then none else some (t, added, dropped)

/-- The foreign keys of a schema whose `ON DELETE SET NULL` cannot execute. -/
def unsoundSetNull (S : Schema) : List (TableName × String) :=
  allTables.flatMap fun t =>
    ((S t).foreignKeys.filter fun fk => !setNullSound S t fk).map fun fk => (t, fk.name)

/-- The closed-set checks of a schema whose values `oneOf` cannot inline into DDL. -/
def unrenderable (S : Schema) : List (TableName × String) :=
  allTables.flatMap fun t => (S t).checks.filterMap fun
    | .oneOf n _ vs => if (renderOneOf? n vs).isNone then some (t, n) else none
    | .other _ => none

/-- The names of the constraints of today's schema a state breaks, with each non-closed-set check
read by its owning cluster. -/
def currentViolations (st : State) : List String :=
  Target.violationsUnder catalogue Current.checkSemantics st

/-! ## One-cell divergences: states today's schema admits and the target refuses -/

namespace Divergence

open Current.Witness

/-- The witness state with row `old` of table `t` replaced by `new`. -/
def replace (st : State) (t : TableName) (old new : Row) : State := fun u =>
  if u = t then (st u).map fun r => if r == old then new else r else st u

/-- The witness state with row `r` of table `t` removed. -/
def remove (st : State) (t : TableName) (r : Row) : State := fun u =>
  if u = t then (st u).filter (· != r) else st u

/-- An API key with no principal (`FORMAL-P1-every-source-has-a-principal`). -/
def keyWithoutPrincipal : State := remove Current.Witness.state .workspacePrincipals keyPrincipal

/-- A member with a grant and no principal (`FORMAL-P1-grants-name-principals`). -/
def grantedMemberWithoutPrincipal : State :=
  remove Current.Witness.state .workspacePrincipals (memberPrincipal "p2" "w1" "m2")

/-- A runtime profile whose "runtime connection" is a plain secret
(`FORMAL-P1-secret-purpose-is-typed`). -/
def plainSecretAsRuntimeConnection : State :=
  replace Current.Witness.state .runtimeProfiles profile
    (setCell "runtime_connection_id" (some "s2") profile)

/-- An agent with a model and no model connection
(`FORMAL-P1-documented-row-invariants-are-checks`). -/
def modelWithoutConnection : State :=
  replace Current.Witness.state .agents agent (setCell "model_connection_id" none agent)

/-- A session whose SDK session id is not its own id. -/
def foreignSdkSessionId : State :=
  replace Current.Witness.state .sessions session (setCell "engine_session_id" (some "sdk-9") session)

/-- A transcript (and its message) stored under a key other than its workspace id. -/
def transcriptUnderAnotherKey : State :=
  replace (replace Current.Witness.state .sessionTranscripts transcript
      (setCell "project_key" (some "k9") transcript))
    .sessionMessages message (setCell "project_key" (some "k9") message)

/-- A share whose subject does not exist (`FORMAL-P1-share-subject-is-a-typed-reference`). -/
def danglingSubject : State :=
  replace Current.Witness.state .shares share (setCell "subject_id" (some "a9") share)

/-- A share of workspace `w1` whose subject is workspace `w2`'s agent. -/
def crossWorkspaceSubject : State :=
  replace Current.Witness.state .shares share (setCell "subject_id" (some "a2") share)

/-- A share whose subject type is `skill` and whose subject id is an agent's. -/
def wronglyTypedSubject : State :=
  replace Current.Witness.state .shares share
    (setCell "mode" none (setCell "subject_type" (some "skill") share))

/-- An agent share with no mode. -/
def agentShareWithoutMode : State :=
  replace Current.Witness.state .shares share (setCell "mode" none share)

/-- A budget on a definition (not runnable) share. -/
def budgetOnDefinitionShare : State :=
  replace Current.Witness.state .shares share (setCell "budget_cap_usd" (some "5") share)

/-- A ledger row whose provider is outside `MODEL_PROVIDERS`. -/
def unknownLedgerProvider : State :=
  replace Current.Witness.state .runUsageRecords usage (setCell "provider" (some "mistral") usage)

/-- Every one-cell divergence, with the names of the target constraints it breaks. -/
@[aw_spec (doc := "docs/formal/concepts.md#current-to-target-mapping")]
def cells : List (String × State × List String) :=
  [("key-without-principal", keyWithoutPrincipal, ["every_source_has_a_principal"]),
   ("granted-member-without-principal", grantedMemberWithoutPrincipal,
     ["agent_grants.principal_id", "every_source_has_a_principal"]),
   ("plain-secret-as-runtime-connection", plainSecretAsRuntimeConnection,
     ["runtime_connections_are_typed"]),
   ("model-without-connection", modelWithoutConnection, ["agents_model_pair"]),
   ("foreign-sdk-session-id", foreignSdkSessionId, ["sessions_sdk_id_is_id"]),
   ("transcript-under-another-key", transcriptUnderAnotherKey,
     ["session_transcripts_project_key_is_workspace"]),
   ("dangling-subject", danglingSubject, ["shares_subject_agent_workspace_fk"]),
   ("cross-workspace-subject", crossWorkspaceSubject, ["shares_subject_agent_workspace_fk"]),
   ("wrongly-typed-subject", wronglyTypedSubject, ["shares_subject_skill_workspace_fk"]),
   ("agent-share-without-mode", agentShareWithoutMode, ["shares_agent_has_mode"]),
   ("budget-on-definition-share", budgetOnDefinitionShare, ["shares_budget_only_runnable"]),
   ("unknown-ledger-provider", unknownLedgerProvider, ["run_usage_records_provider_valid"])]

end Divergence

/-! ## One-cell refusals: states each cluster's checks refuse, today -/

namespace Refusals

open Current.Witness Divergence

/-- A user whose email is not lower case (`users_email_lowercase`, identity cluster). -/
def upperCaseEmail : State :=
  let u := (Current.Witness.state .users).head!
  replace Current.Witness.state .users u (setCell "email" (some "Ada@example.com") u)

/-- An agent whose name is blank (`agents_name_not_blank`, catalog cluster). -/
def blankAgentName : State :=
  replace Current.Witness.state .agents agent (setCell "name" (some "   ") agent)

/-- A runtime profile whose name is blank (`runtime_profiles_name_not_blank`, configuration
cluster). -/
def blankProfileName : State :=
  replace Current.Witness.state .runtimeProfiles profile (setCell "name" (some " ") profile)

/-- A run whose cost is not in US dollars (`runs_cost_currency_usd`, work cluster). -/
def runInEuros : State :=
  let r := (Current.Witness.state .runs).head!
  replace Current.Witness.state .runs r (setCell "cost_currency" (some "EUR") r)

/-- A share with a negative spend (`shares_spend_nonnegative`, publication cluster). -/
def negativeSpend : State :=
  replace Current.Witness.state .shares share (setCell "spent_usd" (some "-1") share)

/-- One state per cluster that satisfies every constraint `Er.Core` gives a meaning to and breaks
exactly one check only that cluster refines, with the check's table and name. -/
@[aw_spec (ts := "packages/core/src/db/schema/index.ts")
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")]
def cells : List (Current.Cluster × State × TableName × String) :=
  [(.identity, upperCaseEmail, .users, "users_email_lowercase"),
   (.catalog, blankAgentName, .agents, "agents_name_not_blank"),
   (.configuration, blankProfileName, .runtimeProfiles, "runtime_profiles_name_not_blank"),
   (.work, runInEuros, .runs, "runs_cost_currency_usd"),
   (.publication, negativeSpend, .shares, "shares_spend_nonnegative")]

end Refusals

/-! ## One-cell refusals of the target: states only the target's own checks refuse -/

namespace TargetCells

open Divergence

/-- The witness share as the target stores it (its subject in `subject_agent_id`). -/
def share : Row := mapRow Current.Witness.state .shares Current.Witness.share

/-- The witness usage row as the target stores it. -/
def usage : Row := mapRow Current.Witness.state .runUsageRecords Current.Witness.usage

/-- The target image of the witness state. -/
def base : State := toTarget Current.Witness.state

/-- An agent share that also names a skill: two subject columns set. Both keys resolve in the
share's workspace, so only `shares_subject_matches_type` refuses it. -/
def twoSubjects : State :=
  replace base .shares share (setCell "subject_skill_id" (some "sk1") share)

/-- An agent share whose subject sits in the session column: the column does not match
`subject_type`. -/
def subjectInAnotherColumn : State :=
  replace base .shares share
    (setCell "subject_session_id" (some "se1") (setCell "subject_agent_id" none share))

/-- The target witness with its ledger row's provider set to `p`. -/
def ledgerRowWith (p : String) : State :=
  replace base .runUsageRecords usage (setCell "provider" (some p) usage)

/-- The transaction that inserts every row of the target witness into an empty database,
parents first. -/
def load : List Current.Stmt :=
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
      (base t).map (.insert t)

end TargetCells

/-! ## Session resolution: a revoked principal and a principal of the other kind -/

namespace ResolutionCells

open Divergence

/-- The principal `p1` of the owner `u1` in `w1`. -/
def ownerPrincipal : Row := Current.Witness.memberPrincipal "p1" "w1" "m1"

/-- The witness state with `p1` revoked after its activation. -/
def revoked : State :=
  replace Current.Witness.state .workspacePrincipals ownerPrincipal
    (setCell "revoked_at" (some "1100") ownerPrincipal)

/-- The witness state with `p1`'s kind spelled `api_key` (the source check refuses this state;
the resolution must refuse it on its own, as `resolveMembership` filters by kind). -/
def otherKind : State :=
  replace Current.Witness.state .workspacePrincipals ownerPrincipal
    (setCell "kind" (some "api_key") ownerPrincipal)

end ResolutionCells

/-! ## Deleting a default agent: the witness of the set-null divergence -/

namespace DeleteWitness

open Current.Witness in
/-- One workspace, its owner and that owner's principal, an agent with no connection or profile,
and a project whose default agent it is. -/
def state : State
  | .workspaces =>
    [row ([("id", "w1"), ("slug", "one"), ("name", "One"), ("public_sharing_enabled", "true")] ++
      stamps)]
  | .users => [row ([("id", "u1"), ("email", "ada@example.com"), ("name", "Ada")] ++ stamps)]
  | .memberships =>
    [row ([("id", "m1"), ("workspace_id", "w1"), ("user_id", "u1"), ("role", "owner")] ++ stamps)]
  | .workspacePrincipals => [memberPrincipal "p1" "w1" "m1"]
  | .agents => [agent]
  | .projects =>
    [row ([("id", "pr1"), ("workspace_id", "w1"), ("name", "Launch"), ("default_agent_id", "a1"),
      ("visibility", "private"), ("owner_principal_id", "p1")] ++ stamps)]
  | _ => []
where
  /-- The agent that is the project's default. -/
  agent : Row :=
    row ([("id", "a1"), ("workspace_id", "w1"), ("name", "General"), ("instructions", "Help."),
      ("permissions", "{}"), ("owner_principal_id", "p1")] ++ stamps)

end DeleteWitness

end AgentWorkspace.Er.Refinement
