import AgentWorkspace.Er.Refinement

/-!
T4 — today's ER model against the target: what the refinement map keeps, and exactly where the
two diverge.

* **Nothing of tenancy is lost.** Every tenancy constraint of today's schema (a reference to the
  tenant root, or a reference between tenant-carrying tables paired by itself or by a sibling) has
  an image in the target with the same class, every key of today has an image, and every key the
  target adds is itself a tenancy constraint. The map never adds, drops or re-homes a row.
* **The schemas diverge at named cells**: the six keys the target changes, the nine it adds, the
  columns and checks it adds and drops, the three renamed tables, the two unexecutable
  `SET NULL` keys, the one closed set that escapes the DDL value gate, and the one owner column
  with another name.
* **The states diverge at named cells**: the witness state of today maps onto a consistent target
  state, and each one-cell edit of it that today's schema admits breaks exactly the named target
  constraint. Deleting a project's default agent is refused today and allowed in the target.
* **Identity.** Resolving a browser session by user id (target) agrees with resolving it by email
  (today) whenever the email finds the user, and survives an email change; today's does not.
-/

namespace AgentWorkspace.Theorems.Refinement.ErSynthesis

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Er AgentWorkspace.Er.Refinement

/-! ## Helpers: what a row edit leaves alone -/

private theorem lookup_append (k : String) :
    ∀ (l m : List (String × String)), (l ++ m).lookup k = (l.lookup k).or (m.lookup k)
  | [], m => by simp
  | (a, b) :: l, m => by
    simp only [List.cons_append, List.lookup]
    split <;> simp_all [lookup_append k l m]

private theorem lookup_filter_ne {k c : String} (h : k ≠ c) :
    ∀ l : List (String × String), (l.filter (·.1 != c)).lookup k = l.lookup k
  | [] => rfl
  | (a, b) :: l => by
    by_cases hac : a = c
    · subst hac
      have hka : (k == a) = false := by simpa using h
      simp [List.filter, List.lookup, hka, lookup_filter_ne h l]
    · have hne : (a != c) = true := by simpa using hac
      simp only [List.filter, hne, List.lookup]
      split <;> simp_all [lookup_filter_ne h l]

private theorem setCell_get {k c : String} (h : k ≠ c) (v : Option String) (r : Row) :
    (setCell c v r).get k = r.get k := by
  unfold setCell Row.get
  rw [lookup_append, lookup_filter_ne h]
  cases v with
  | none => simp
  | some x =>
    have hkc : (k == c) = false := by simpa using h
    cases hl : r.cells.lookup k <;> simp [hkc]

private theorem lookup_rename {k old new : String} (h1 : k ≠ old) (h2 : k ≠ new) :
    ∀ l : List (String × String),
      (l.map fun p => if p.1 == old then (new, p.2) else p).lookup k = l.lookup k
  | [] => rfl
  | (a, b) :: l => by
    have ih := lookup_rename h1 h2 l
    rw [List.map_cons]
    by_cases ha : a = old
    · rw [ite_eq_left_of_eq_true _ _ (eq_true (beq_iff_eq.mpr ha))]
      have hk2 : (k == new) = false := beq_false_of_ne h2
      have hk1 : (k == a) = false := beq_false_of_ne (ha ▸ h1)
      simp only [List.lookup, hk1, hk2]
      exact ih
    · rw [ite_eq_right_of_eq_false _ _ (eq_false (by simpa using ha))]
      simp only [List.lookup]
      cases (k == a)
      · exact ih
      · rfl

private theorem renameCell_get {k old new : String} (h1 : k ≠ old) (h2 : k ≠ new) (r : Row) :
    (renameCell old new r).get k = r.get k := lookup_rename h1 h2 r.cells

private theorem lookup_mapValue {k c : String} (h : k ≠ c) (f : String → String) :
    ∀ l : List (String × String),
      (l.map fun p => if p.1 == c then (p.1, f p.2) else p).lookup k = l.lookup k
  | [] => rfl
  | (a, b) :: l => by
    have ih := lookup_mapValue h f l
    rw [List.map_cons]
    by_cases ha : a = c
    · rw [ite_eq_left_of_eq_true _ _ (eq_true (beq_iff_eq.mpr ha))]
      have hk : (k == a) = false := beq_false_of_ne (ha ▸ h)
      simp only [List.lookup, hk]
      exact ih
    · rw [ite_eq_right_of_eq_false _ _ (eq_false (by simpa using ha))]
      simp only [List.lookup]
      cases (k == a)
      · exact ih
      · rfl

private theorem mapCell_get {k c : String} (h : k ≠ c) (f : String → String) (r : Row) :
    (mapCell c f r).get k = r.get k := lookup_mapValue h f r.cells

private theorem splitSubject_get {k : String} (h1 : k ≠ "subject_id")
    (h2 : ∀ ty, k ≠ Target.subjectColumn ty) (r : Row) : (splitSubject r).get k = r.get k := by
  unfold splitSubject
  split
  · rename_i ty _
    rw [setCell_get (h2 ty), setCell_get h1]
  · rw [setCell_get h1]

/-- The map leaves the tenant column and the `id` of every row alone. -/
private theorem mapRow_get (st : State) (t : TableName) (r : Row) {k : String}
    (hk : k = "workspace_id" ∨ k = "id") : (mapRow st t r).get k = r.get k := by
  have hne : ∀ c : String, c ≠ "workspace_id" → c ≠ "id" → k ≠ c := by
    intro c h1 h2 hkc; subst hkc; rcases hk with h | h <;> simp_all
  have hsub : ∀ ty, k ≠ Target.subjectColumn ty := by
    intro ty; exact hne _ (by cases ty <;> decide +kernel) (by cases ty <;> decide +kernel)
  cases t <;> simp only [mapRow]
  all_goals first
    | rfl
    | rw [setCell_get (hne _ (by decide +kernel) (by decide +kernel)), setCell_get (hne _ (by decide +kernel) (by decide +kernel))]
    | rw [setCell_get (hne _ (by decide +kernel) (by decide +kernel))]
    | rw [renameCell_get (hne _ (by decide +kernel) (by decide +kernel)) (hne _ (by decide +kernel) (by decide +kernel))]
    | rw [mapCell_get (hne _ (by decide +kernel) (by decide +kernel))]
    | rw [splitSubject_get (hne _ (by decide +kernel) (by decide +kernel)) hsub,
        renameCell_get (hne _ (by decide +kernel) (by decide +kernel)) (hne _ (by decide +kernel) (by decide +kernel))]

private theorem column_cases {c : String} {ten : Tenancy} (h : ten.column? = some c) :
    c = "workspace_id" ∨ c = "id" := by
  cases ten <;> simp [Tenancy.column?] at h <;> subst h <;> simp

/-! ## Nothing of tenancy is lost -/

/-- The target classifies every table as today's schema does: the same tenant root, the same two
global identity tables, the same 30 tenant-scoped tables. -/
@[aw_spec (tier := T4) (doc := "docs/formal/concepts.md#the-target-er-model")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#TENANT_EXEMPT")]
theorem tenancy_classes_are_unchanged (t : TableName) :
    (Target.schema t).tenancy = (catalogue t).tenancy := by
  cases t <;> decide +kernel

/-- Every tenancy constraint of today's schema has an image in the target with the same tenancy
class: no reference to the tenant root and no tenant-paired or sibling-paired reference is lost. -/
@[aw_spec (tier := T4) (doc := "docs/formal/00-orchestrator-prompt.md#61-tiers")
  (doc := "docs/formal/concepts.md#current-to-target-mapping")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")]
theorem every_tenancy_constraint_is_kept (t : TableName) (fk : ForeignKey)
    (hfk : fk ∈ (catalogue t).foreignKeys) (hten : isTenancyConstraint catalogue t fk = true) :
    fkImage t fk ∈ (Target.schema t).foreignKeys ∧
      classify Target.schema t (fkImage t fk) = classify catalogue t fk := by
  have h : (allTables.all fun t => (catalogue t).foreignKeys.all fun fk =>
      !isTenancyConstraint catalogue t fk || keptInTarget t fk) = true := by decide +kernel
  have := List.all_eq_true.mp (List.all_eq_true.mp h t (WireEnum.complete t)) fk hfk
  simp only [hten, Bool.not_true, Bool.false_or, keptInTarget, Bool.and_eq_true, beq_iff_eq,
    List.contains_iff_mem] at this
  exact this

/-- Every foreign key of today's schema, tenancy constraint or reference to a global table, has
its image among the target's keys. -/
@[aw_spec (tier := T4) (doc := "docs/formal/concepts.md#current-to-target-mapping")
  (ts := "packages/core/src/db/schema/index.ts")]
theorem every_key_has_an_image (t : TableName) (fk : ForeignKey)
    (hfk : fk ∈ (catalogue t).foreignKeys) : fkImage t fk ∈ (Target.schema t).foreignKeys := by
  have h : (allTables.all fun t => (catalogue t).foreignKeys.all fun fk =>
      (Target.schema t).foreignKeys.contains (fkImage t fk)) = true := by decide +kernel
  have := List.all_eq_true.mp (List.all_eq_true.mp h t (WireEnum.complete t)) fk hfk
  simpa using this

/-- Every key the target adds (no key of today's schema maps onto it) is itself a tenancy
constraint: the target only tightens tenancy. -/
@[aw_spec (tier := T4) (doc := "docs/formal/concepts.md#the-target-er-model")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")]
theorem added_keys_are_tenancy_constraints :
    (allTables.all fun t => (Target.schema t).foreignKeys.all fun fk' =>
      (catalogue t).foreignKeys.any (fun fk => fkImage t fk == fk') ||
        isTenancyConstraint Target.schema t fk') = true := by decide +kernel

/-- The target has no unpaired reference and no undeclared `*_id` column, so today's tenancy test
rules 2 and 3 hold of it as they do of today's schema. -/
@[aw_spec (tier := T4) (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#NON_REFERENCE_ID_COLUMNS")]
theorem target_keeps_the_tenancy_rules :
    pairingComplete catalogue = true ∧ pairingComplete Target.schema = true ∧
      idColumnsCovered catalogue Er.Core.nonReferenceIdColumns = true ∧
      idColumnsCovered Target.schema Target.nonReferenceIdColumns = true := by decide +kernel

/-- The refinement map keeps every row in its workspace: the tenant of each row of the target
state, in order, is the tenant of the row of today's state it comes from. -/
@[aw_spec (tier := T4) (doc := "docs/formal/concepts.md#current-to-target-mapping")
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#workspace-and-principal")]
theorem refinement_keeps_every_row_in_its_workspace (st : State) (t : TableName) :
    (toTarget st t).map (tenantOf Target.schema t) = (st t).map (tenantOf catalogue t) := by
  simp only [toTarget, List.map_map]
  apply List.map_congr_left
  intro r _
  simp only [Function.comp, tenantOf, TableSpec.tenantColumn?, tenancy_classes_are_unchanged]
  cases hc : (catalogue t).tenancy.column? with
  | none => rfl
  | some c => simp only [Option.bind_some]; exact mapRow_get st t r (column_cases hc)

/-- The refinement map keeps every row's identity: the `id`s of each table, in order, are today's. -/
@[aw_spec (tier := T4) (doc := "docs/formal/concepts.md#current-to-target-mapping")]
theorem refinement_keeps_row_ids (st : State) (t : TableName) :
    (toTarget st t).map (·.get "id") = (st t).map (·.get "id") := by
  simp only [toTarget, List.map_map]
  exact List.map_congr_left fun r _ => mapRow_get st t r (Or.inr rfl)

/-! ## The schemas diverge at named cells -/

/-- The target changes exactly six keys of today's schema: the grant key (member → principal),
the two connector keys (column rename), the two composite `SET NULL` keys (now `NO ACTION`
beside a sibling) and the share owner key (publisher → owner). -/
@[aw_spec (tier := T4) (doc := "docs/formal/concepts.md#current-to-target-mapping")
  (ts := "packages/core/src/db/schema/agent-grants.ts#agentGrants")]
theorem keys_diverge_exactly_at :
    changedKeys =
      [(.agentGrants, "agent_grants_member_workspace_fk"),
       (.agentMcpServers, "agent_mcp_servers_server_workspace_fk"),
       (.projectMcpServers, "project_mcp_servers_server_workspace_fk"),
       (.projects, "projects_default_agent_workspace_fk"),
       (.sessions, "sessions_project_workspace_fk"),
       (.shares, "shares_publisher_principal_workspace_fk")] := by decide +kernel

/-- The target adds exactly nine keys: the inviter's principal (paired and sibling), the model
connection's credential, the two `SET NULL` siblings and one subject key per subject type. -/
@[aw_spec (tier := T4) (doc := "docs/formal/concepts.md#current-to-target-mapping")
  (ts := "apps/web/server/composition/wiring/projects.ts#subjectOwnership")]
theorem keys_added_exactly_at :
    addedKeys =
      [(.invitations, "invitations_inviter_principal_workspace_fk"),
       (.invitations, "invitations_invited_by_principal_id_workspace_principals_id_fk"),
       (.modelConnections, "model_connections_credential_secret_workspace_fk"),
       (.projects, "projects_default_agent_id_agents_id_fk"),
       (.sessions, "sessions_project_id_projects_id_fk"),
       (.shares, "shares_subject_agent_workspace_fk"),
       (.shares, "shares_subject_session_workspace_fk"),
       (.shares, "shares_subject_project_workspace_fk"),
       (.shares, "shares_subject_skill_workspace_fk")] := by decide +kernel

/-- The target adds and drops exactly these columns: `principal_id` for `user_id` on grants,
`connector_id` for `mcp_server_id` on the two connector links, the inviter's principal, the model
connection's credential, and on shares the owner and the four typed subject columns for the
publisher and the untyped subject id. -/
@[aw_spec (tier := T4) (doc := "docs/formal/concepts.md#current-to-target-mapping")
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
theorem columns_diverge_exactly_at :
    columnChanges =
      [(.agentGrants, ["principal_id"], ["user_id"]),
       (.agentMcpServers, ["connector_id"], ["mcp_server_id"]),
       (.invitations, ["invited_by_principal_id"], []),
       (.modelConnections, ["credential_secret_id"], []),
       (.projectMcpServers, ["connector_id"], ["mcp_server_id"]),
       (.shares, ["owner_principal_id", "subject_agent_id", "subject_session_id",
          "subject_project_id", "subject_skill_id"], ["subject_id", "publisher_principal_id"])] := by
  decide +kernel

/-- The target adds and drops exactly these checks: the model pair on agents, the ledger's provider
set, the transcript key, the SDK session id, three share checks (subject, mode, budget) for the
blank-subject-id check, and the principal kind and source checks respelled with `api-key`. -/
@[aw_spec (tier := T4) (doc := "docs/formal/concepts.md#current-to-target-mapping")
  (ts := "packages/core/src/db/schema/workspace-principals.ts#workspacePrincipals")]
theorem checks_diverge_exactly_at :
    checkChanges =
      [(.agents, ["agents_model_pair"], []),
       (.runUsageRecords, ["run_usage_records_provider_valid"], []),
       (.sessionTranscripts, ["session_transcripts_project_key_is_workspace"], []),
       (.sessions, ["sessions_sdk_id_is_id"], []),
       (.shares, ["shares_subject_matches_type", "shares_agent_has_mode",
          "shares_budget_only_runnable"], ["shares_subject_id_not_blank"]),
       (.workspacePrincipals, ["workspace_principals_kind_valid",
          "workspace_principals_source_matches_kind"],
          ["workspace_principals_kind_valid", "workspace_principals_source_xor"])] := by decide +kernel

/-- The target renames exactly the three connector tables, so that "connector" is the concept's
one name. -/
@[aw_spec (tier := T4) (doc := "docs/sdk/04-api-specification.md#58-connectors-mcp-servers--awconnectors")
  (ts := "packages/core/src/db/schema/mcp-servers.ts#mcpServers")]
theorem table_names_diverge_exactly_at :
    allTables.filter (fun t => Target.tableName t != t.toWire) =
      [.agentMcpServers, .mcpServers, .projectMcpServers] := by decide +kernel

/-- Today exactly two keys carry an `ON DELETE SET NULL` that cannot execute (it would null the
`NOT NULL` `workspace_id` too); the target has none. -/
@[aw_spec (tier := T4) (doc := "docs/formal/concepts.md#current-to-target-mapping")
  (ts := "packages/core/src/db/schema/projects.ts#projects")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#referenceIdentityOf")]
theorem set_null_diverges_exactly_at :
    unsoundSetNull catalogue =
        [(.projects, "projects_default_agent_workspace_fk"),
         (.sessions, "sessions_project_workspace_fk")] ∧
      unsoundSetNull Target.schema = [] := by decide +kernel

/-- Today exactly one closed set cannot be inlined into DDL by `oneOf` (the principal kind's
`api_key`); in the target every closed set can. -/
@[aw_spec (tier := T4) (ts := "packages/core/src/db/schema/one-of.ts#renderValueList")
  (ts := "packages/contracts/src/team.ts#PRINCIPAL_KINDS")]
theorem value_gate_diverges_exactly_at :
    unrenderable catalogue = [(.workspacePrincipals, "workspace_principals_kind_valid")] ∧
      unrenderable Target.schema = [] := by decide +kernel

/-- Every owned resource names its owner `owner_principal_id` in the target; today exactly one
table, `shares`, names it otherwise. -/
@[aw_spec (tier := T4) (doc := "docs/sdk/04-api-specification.md#2-resource-model")
  (ts := "packages/core/src/db/schema/shares.ts#shares_publisher_principal_workspace_fk")]
theorem owner_columns_diverge_exactly_at :
    allTables.filter (fun t => Current.ownerColumn? t != Target.ownerColumn? t) = [.shares] ∧
      Current.ownerColumn? .shares = some "publisher_principal_id" ∧
      Target.ownerColumn? .shares = some "owner_principal_id" := by decide +kernel

/-! ## The states diverge at named cells -/

/-- The witness state of today's schema is consistent, and so is its image: the refinement map
takes a well-formed database of today onto a well-formed target database. -/
@[aw_spec (tier := T4) (doc := "docs/formal/concepts.md#current-to-target-mapping")
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
theorem refinement_holds_on_the_witness :
    Current.consistent Current.Witness.state = true ∧
      Target.consistent (toTarget Current.Witness.state) = true ∧
      Target.violations (toTarget Current.Witness.state) = [] := by decide +kernel

/-- Every one-cell divergence is admitted today and breaks exactly its named constraints in the
target. -/
@[aw_spec (tier := T4) (doc := "docs/formal/concepts.md#current-to-target-mapping")]
theorem every_divergence_cell_is_exact :
    (Divergence.cells.all fun (_, st, vs) => Current.consistent st &&
      !Target.consistent (toTarget st) && Target.violations (toTarget st) == vs) = true := by
  decide +kernel

/-- A named divergence cell holds: read off `every_divergence_cell_is_exact`, so the kernel
evaluates each cell once. -/
private theorem divergence_cell {n : String} {st : State} {vs : List String}
    (h : (n, st, vs) ∈ Divergence.cells) :
    Current.consistent st = true ∧ Target.violations (toTarget st) = vs := by
  have := List.all_eq_true.mp every_divergence_cell_is_exact _ h
  simp only [Bool.and_eq_true, beq_iff_eq] at this
  exact ⟨this.1.1, this.2⟩

/-- Membership of a literal cell in `Divergence.cells`, found by its name. -/
local macro "divergence_cell_mem" : tactic =>
  `(tactic| (unfold Divergence.cells
             repeat (first | exact List.Mem.head _ | apply List.Mem.tail)))

/-- An API key with no principal is a consistent state today; the target requires one principal
per membership and per API key (RF-101). -/
@[aw_spec (tier := T4)
  (doc := "docs/architecture/refactoring/claude-agent-workspace-refactoring-plan.md#rf-101--introduce-workspaceprincipal-and-split-identity-ownership-and-attribution")
  (ts := "packages/core/src/db/schema/workspace-principals.ts#workspacePrincipals")]
theorem diverges_at_a_source_without_principal :
    Current.consistent Divergence.keyWithoutPrincipal = true ∧
      Target.violations (toTarget Divergence.keyWithoutPrincipal) =
        ["every_source_has_a_principal"] :=
  divergence_cell (by divergence_cell_mem)

/-- A grant held by a member who has no principal is a consistent state today (the grant stores the
user id); in the target the grant has no principal to name. -/
@[aw_spec (tier := T4)
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#workspace-and-principal")
  (ts := "packages/core/src/db/schema/agent-grants.ts#agentGrants")]
theorem diverges_at_a_grant_without_principal :
    Current.consistent Divergence.grantedMemberWithoutPrincipal = true ∧
      Target.violations (toTarget Divergence.grantedMemberWithoutPrincipal) =
        ["agent_grants.principal_id", "every_source_has_a_principal"] :=
  divergence_cell (by divergence_cell_mem)

/-- A runtime profile naming a plain secret as its runtime connection is consistent today; the
target types the reference (RF-204). -/
@[aw_spec (tier := T4) (doc := "docs/sdk/04-api-specification.md#55-secrets--awsecrets")
  (ts := "packages/core/src/db/schema/runtime-profiles.ts#runtimeProfiles")]
theorem diverges_at_an_untyped_runtime_connection :
    Current.consistent Divergence.plainSecretAsRuntimeConnection = true ∧
      Target.violations (toTarget Divergence.plainSecretAsRuntimeConnection) =
        ["runtime_connections_are_typed"] :=
  divergence_cell (by divergence_cell_mem)

/-- An agent with a model and no model connection is consistent today; the target enforces the
documented pair. -/
@[aw_spec (tier := T4) (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")
  (ts := "packages/core/src/db/schema/agents.ts#agents")]
theorem diverges_at_a_model_without_connection :
    Current.consistent Divergence.modelWithoutConnection = true ∧
      Target.violations (toTarget Divergence.modelWithoutConnection) = ["agents_model_pair"] :=
  divergence_cell (by divergence_cell_mem)

/-- A session whose SDK session id is not its own id is consistent today although the launch path
never records one (it refuses any reported id other than the session id); the target makes that
rule a check. -/
@[aw_spec (tier := T4) (doc := "docs/formal/units/concept-work.md#findings")
  (ts := "apps/web/server/composition/session-launch.ts#recordReportedSessionIdentity")]
theorem diverges_at_a_foreign_sdk_session_id :
    Current.consistent Divergence.foreignSdkSessionId = true ∧
      Target.violations (toTarget Divergence.foreignSdkSessionId) = ["sessions_sdk_id_is_id"] :=
  divergence_cell (by divergence_cell_mem)

/-- A transcript stored under a key other than its workspace id is consistent today; the target
checks that the key is the workspace. -/
@[aw_spec (tier := T4) (doc := "docs/sdk/04-api-specification.md#511-sessions-and-transcripts--awsessions")
  (ts := "packages/contracts/src/sessions.ts#projectKey")]
theorem diverges_at_a_transcript_under_another_key :
    Current.consistent Divergence.transcriptUnderAnotherKey = true ∧
      Target.violations (toTarget Divergence.transcriptUnderAnotherKey) =
        ["session_transcripts_project_key_is_workspace"] :=
  divergence_cell (by divergence_cell_mem)

/-- A share whose subject does not exist is consistent today; in the target the subject is a key. -/
@[aw_spec (tier := T4)
  (doc := "docs/sdk/site/concepts/ownership-and-sharing.mdx#beyond-one-workspace")
  (ts := "apps/web/server/composition/wiring/projects.ts#subjectOwnership")]
theorem diverges_at_a_dangling_subject :
    Current.consistent Divergence.danglingSubject = true ∧
      Target.violations (toTarget Divergence.danglingSubject) =
        ["shares_subject_agent_workspace_fk"] :=
  divergence_cell (by divergence_cell_mem)

/-- A share of one workspace whose subject is another workspace's agent is consistent today; in
the target the subject key is tenant-paired and refuses it. -/
@[aw_spec (tier := T4)
  (doc := "docs/sdk/site/concepts/ownership-and-sharing.mdx#beyond-one-workspace")
  (doc := "docs/architecture.md#runtime-and-trust-boundaries")
  (ts := "apps/web/server/composition/wiring/projects.ts#subjectOwnership")]
theorem diverges_at_a_cross_workspace_subject :
    Current.consistent Divergence.crossWorkspaceSubject = true ∧
      Target.violations (toTarget Divergence.crossWorkspaceSubject) =
        ["shares_subject_agent_workspace_fk"] :=
  divergence_cell (by divergence_cell_mem)

/-- A share whose subject id names a row of another type is consistent today; in the target each
subject type has its own key. -/
@[aw_spec (tier := T4)
  (doc := "docs/sdk/site/concepts/ownership-and-sharing.mdx#beyond-one-workspace")
  (ts := "packages/contracts/src/shares.ts#ShareResourceSchema")]
theorem diverges_at_a_wrongly_typed_subject :
    Current.consistent Divergence.wronglyTypedSubject = true ∧
      Target.violations (toTarget Divergence.wronglyTypedSubject) =
        ["shares_subject_skill_workspace_fk"] :=
  divergence_cell (by divergence_cell_mem)

/-- An agent share with no mode is consistent today; the target requires one. -/
@[aw_spec (tier := T4) (doc := "docs/spec.md#2063-publishing-an-agent")
  (ts := "packages/contracts/src/shares.ts#ShareResourceSchema")]
theorem diverges_at_an_agent_share_without_mode :
    Current.consistent Divergence.agentShareWithoutMode = true ∧
      Target.violations (toTarget Divergence.agentShareWithoutMode) =
        ["shares_agent_has_mode"] :=
  divergence_cell (by divergence_cell_mem)

/-- A budget on a definition share is consistent today; the target allows a budget only on a
runnable share. -/
@[aw_spec (tier := T4) (doc := "docs/spec.md#2063-publishing-an-agent")
  (ts := "packages/contracts/src/shares.ts#ShareResourceSchema")]
theorem diverges_at_a_budget_on_a_definition_share :
    Current.consistent Divergence.budgetOnDefinitionShare = true ∧
      Target.violations (toTarget Divergence.budgetOnDefinitionShare) =
        ["shares_budget_only_runnable"] :=
  divergence_cell (by divergence_cell_mem)

/-- A ledger row whose provider is outside `MODEL_PROVIDERS` is consistent today; the target closes
the set as `runs.provider` already is. -/
@[aw_spec (tier := T4) (doc := "docs/sdk/04-api-specification.md#512-runs-and-the-event-stream--awruns")
  (ts := "packages/core/src/db/schema/run-usage-records.ts#runUsageRecords")]
theorem diverges_at_an_unknown_ledger_provider :
    Current.consistent Divergence.unknownLedgerProvider = true ∧
      Target.violations (toTarget Divergence.unknownLedgerProvider) =
        ["run_usage_records_provider_valid"] :=
  divergence_cell (by divergence_cell_mem)

/-- Deleting an agent that is a project's default is refused today (the composite `SET NULL` nulls
`projects.workspace_id`), while the target clears the default and stays consistent. -/
@[aw_spec (tier := T4) (doc := "docs/formal/concepts.md#current-to-target-mapping")
  (ts := "packages/core/src/db/schema/projects.ts#projects")]
theorem deleting_a_default_agent_diverges :
    Current.consistent DeleteWitness.state = true ∧
      currentViolations (Current.deleteRow catalogue DeleteWitness.state .agents
        DeleteWitness.state.agent) = ["projects.workspace_id"] ∧
      Target.consistent (toTarget DeleteWitness.state) = true ∧
      Target.consistent (Current.deleteRow Target.schema (toTarget DeleteWitness.state) .agents
        DeleteWitness.state.agent) = true := by decide +kernel

/-! ## Identity: resolving a browser session -/

open Target.Resolution in
/-- Resolving a browser session by user id never depends on any user's email: it survives an email
change, which today's resolution by email does not. -/
@[aw_spec (tier := T4) (doc := "docs/architecture.md#runtime-and-trust-boundaries")
  (ts := "packages/core/src/db/repositories/root.ts#resolveMembership")]
theorem target_identity_survives_an_email_change (st : State) (c : ClaimsTarget) (uid e : String) :
    resolveTarget (changeEmail st uid e) c = resolveTarget st c := by
  simp [resolveTarget, resolveMember, selectWorkspace, changeEmail]

open Target.Resolution in
/-- Today, a browser session keyed by email stops resolving once the user's email changes, although
the user, the membership and the principal are unchanged. -/
@[aw_spec (tier := T4) (ts := "apps/web/server/auth/session.ts#SessionClaims")
  (ts := "packages/core/src/db/repositories/root.ts#resolveMembership")]
theorem current_identity_breaks_on_an_email_change :
    resolveCurrent Current.Witness.state ⟨"ada@example.com", "one", "owner"⟩ = some ("p1", "owner") ∧
      resolveCurrent (changeEmail Current.Witness.state "u1" "ada@new.example.com")
        ⟨"ada@example.com", "one", "owner"⟩ = none := by decide +kernel

open Target.Resolution in
/-- Wherever today's email lookup finds a user, today's resolution and the target's resolution by
that user's id give the same principal and role. -/
@[aw_spec (tier := T4) (doc := "docs/architecture.md#runtime-and-trust-boundaries")
  (ts := "packages/core/src/db/repositories/root.ts#resolveMembership")]
theorem resolution_by_id_refines_resolution_by_email (st : State) (c : ClaimsCurrent) (u : Row)
    (uid : String) (hv : verifyCurrent c = true)
    (hu : (st .users).find? (·.get "email" == some c.sub) = some u) (hid : u.get "id" = some uid) :
    resolveCurrent st c = resolveTarget st ⟨uid, c.ws⟩ := by
  simp only [resolveCurrent, hv, Bool.not_true, Bool.false_eq_true, ↓reduceIte, hu, resolveTarget]
  cases selectWorkspace st c.ws <;> simp [hid]

open Target.Resolution in
/-- Today's session verification accepts only the role claim `owner`, so the claim carries no
information and the target drops it without losing anything. -/
@[aw_spec (tier := T4) (ts := "apps/web/server/auth/session.ts#SessionClaims")
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#three-separate-questions-three-separate-mechanisms")]
theorem role_claim_carries_no_information (c : ClaimsCurrent) (h : verifyCurrent c = true) :
    c.role = "owner" := by
  simpa [verifyCurrent] using h

/-! ## Witnesses -/

example : fkImage .shares ((catalogue .shares).foreignKey? "shares_publisher_principal_workspace_fk" |>.getD default) ∈
    (Target.schema .shares).foreignKeys ∧
    classify Target.schema .shares
        (fkImage .shares ((catalogue .shares).foreignKey? "shares_publisher_principal_workspace_fk"
          |>.getD default)) =
      classify catalogue .shares
        ((catalogue .shares).foreignKey? "shares_publisher_principal_workspace_fk" |>.getD default) :=
  every_tenancy_constraint_is_kept .shares _ (by decide +kernel) (by decide +kernel)

/-- A reference to a global table (`projects.created_by → users`) keeps its image too. -/
example : fkImage .projects ((catalogue .projects).foreignKey? "projects_created_by_users_id_fk"
    |>.getD default) ∈ (Target.schema .projects).foreignKeys :=
  every_key_has_an_image .projects _ (by decide +kernel)

example : Target.Resolution.resolveCurrent Current.Witness.state ⟨"ada@example.com", "one", "owner"⟩ =
    Target.Resolution.resolveTarget Current.Witness.state ⟨"u1", "one"⟩ :=
  resolution_by_id_refines_resolution_by_email _ _ (Current.Witness.state .users |>.head!) "u1"
    rfl (by decide +kernel) (by decide +kernel)

example : (⟨"a@b.c", "one", "owner"⟩ : Target.Resolution.ClaimsCurrent).role = "owner" :=
  role_claim_carries_no_information _ rfl

/-! ## Checks only the target has: states whose only fault is a target check -/

/-- An agent share that also names a skill (two subject columns set, both keys resolving in the
share's workspace) is refused by the target's subject check and by nothing else. -/
@[aw_spec (tier := T4)
  (doc := "docs/adr/FORMAL-P1-share-subject-is-a-typed-reference.md#decision")
  (ts := "packages/contracts/src/shares.ts#ShareResourceSchema")]
theorem target_refuses_two_subjects :
    Target.violations TargetCells.twoSubjects = ["shares_subject_matches_type"] := by
  decide +kernel

/-- An agent share whose subject sits in the session column (the column does not match
`subject_type`) is refused by the target's subject check and by nothing else. -/
@[aw_spec (tier := T4)
  (doc := "docs/adr/FORMAL-P1-share-subject-is-a-typed-reference.md#decision")
  (ts := "packages/contracts/src/shares.ts#ShareResourceSchema")]
theorem target_refuses_a_subject_in_another_column :
    Target.violations TargetCells.subjectInAnotherColumn = ["shares_subject_matches_type"] := by
  decide +kernel

/-- The target closes the ledger's provider column over exactly the value list today's schema
already enforces on `runs.provider` (`MODEL_PROVIDERS`), on the same column. -/
@[aw_spec (tier := T4) (doc := "docs/sdk/04-api-specification.md#512-runs-and-the-event-stream--awruns")
  (ts := "packages/contracts/src/runs.ts#MODEL_PROVIDERS")
  (ts := "packages/core/src/db/schema/runs.ts#runs_provider_valid")]
theorem ledger_providers_are_the_run_providers :
    (Target.schema .runUsageRecords).oneOfCheck? "run_usage_records_provider_valid" =
        (catalogue .runs).oneOfCheck? "runs_provider_valid" ∧
      (catalogue .runs).oneOfCheck? "runs_provider_valid" =
        some ("provider", ["anthropic", "anthropic-compatible", "openai", "azure-openai",
          "openai-compatible"]) := by decide +kernel

/-- Every provider today's `runs.provider` accepts is accepted on a ledger row of the target: the
target witness with its ledger row's provider set to any of them breaks no constraint. -/
@[aw_spec (tier := T4) (doc := "docs/sdk/04-api-specification.md#512-runs-and-the-event-stream--awruns")
  (ts := "packages/contracts/src/runs.ts#MODEL_PROVIDERS")]
theorem every_run_provider_is_a_valid_ledger_provider :
    (((catalogue .runs).oneOfCheck? "runs_provider_valid").map (·.2) |>.getD []).all
      (fun p => Target.violations (TargetCells.ledgerRowWith p) == []) = true := by
  decide +kernel

end AgentWorkspace.Theorems.Refinement.ErSynthesis
