import AgentWorkspace.Concepts.Share

/-!
# Today's publication tables: `shares`, `share_views`, `share_run_charges`

The three tables of the publication cluster as `Er.Core` sees them (`catalogue`), plus what the
core leaves to the owning cluster:

* the nine foreign keys of the cluster, named, so theorems can instantiate the generic isolation
  lemmas of `Theorems/Invariants/ErCore.lean` per key;
* the SQL bodies of the five checks that are not closed sets, pinned to what `drizzle-kit`
  rendered in `migrations/meta/0025_snapshot.json`, and their semantics on a row
  (`checkSemantics?`), with SQL's three-valued reading of `NULL` (a check whose expression is
  `NULL` passes);
* `consistent`: `Er.Core.consistent` refined by those five checks;
* a **Target** reading (`Target.consistent`) that adds what the service maintains and the
  documents promise but no constraint enforces: an agent share always has a mode, only a runnable
  share has a budget, and `shares.subject_id` names a subject row of the share's own workspace.
-/

namespace AgentWorkspace.Er.Current.Publication

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Concepts.Share

/-- The tables of the publication cluster. -/
@[aw_spec (ts := "packages/core/src/db/schema/index.ts")
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")]
def tables : List TableName := [.shares, .shareViews, .shareRunCharges]

/-! ## The nine foreign keys -/

/-- `shares.workspace_id → workspaces.id`, `ON DELETE CASCADE`. -/
def sharesWorkspaceKey : ForeignKey :=
  { name := "shares_workspace_id_workspaces_id_fk", columns := ["workspace_id"],
    refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true }

/-- `shares.created_by → users.id`, `ON DELETE RESTRICT`: the legacy human attribution. -/
def sharesCreatedByKey : ForeignKey :=
  { name := "shares_created_by_users_id_fk", columns := ["created_by"], refTable := .users,
    refColumns := ["id"], onDelete := .restrict, inline := true }

/-- `(shares.workspace_id, created_by) → memberships (workspace_id, user_id)`: the creator is a
member of the share's workspace. -/
@[aw_spec (ts := "packages/core/src/db/schema/shares.ts#shares_creator_workspace_fk")]
def sharesCreatorKey : ForeignKey :=
  { name := "shares_creator_workspace_fk", columns := ["workspace_id", "created_by"],
    refTable := .memberships, refColumns := ["workspace_id", "user_id"], onDelete := .noAction,
    inline := false }

/-- `(shares.workspace_id, publisher_principal_id) → workspace_principals (workspace_id, id)`. -/
@[aw_spec (ts := "packages/core/src/db/schema/shares.ts#shares_publisher_principal_workspace_fk")
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
def sharesPublisherKey : ForeignKey :=
  { name := "shares_publisher_principal_workspace_fk",
    columns := ["workspace_id", "publisher_principal_id"], refTable := .workspacePrincipals,
    refColumns := ["workspace_id", "id"], onDelete := .noAction, inline := false }

/-- `share_views.workspace_id → workspaces.id`. -/
def viewsWorkspaceKey : ForeignKey :=
  { name := "share_views_workspace_id_workspaces_id_fk", columns := ["workspace_id"],
    refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true }

/-- `(share_views.share_id, workspace_id) → shares (id, workspace_id)`, `ON DELETE CASCADE`. -/
@[aw_spec (ts := "packages/core/src/db/schema/share-views.ts#share_views_share_workspace_fk")]
def viewsShareKey : ForeignKey :=
  { name := "share_views_share_workspace_fk", columns := ["share_id", "workspace_id"],
    refTable := .shares, refColumns := ["id", "workspace_id"], onDelete := .cascade,
    inline := false }

/-- `share_run_charges.workspace_id → workspaces.id`. -/
def chargesWorkspaceKey : ForeignKey :=
  { name := "share_run_charges_workspace_id_workspaces_id_fk", columns := ["workspace_id"],
    refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := true }

/-- `(share_run_charges.share_id, workspace_id) → shares (id, workspace_id)`. -/
@[aw_spec (ts := "packages/core/src/db/schema/share-run-charges.ts#share_run_charges_share_workspace_fk")]
def chargesShareKey : ForeignKey :=
  { name := "share_run_charges_share_workspace_fk", columns := ["share_id", "workspace_id"],
    refTable := .shares, refColumns := ["id", "workspace_id"], onDelete := .cascade,
    inline := false }

/-- `(share_run_charges.run_id, workspace_id) → runs (id, workspace_id)`. -/
@[aw_spec (ts := "packages/core/src/db/schema/share-run-charges.ts#share_run_charges_run_workspace_fk")]
def chargesRunKey : ForeignKey :=
  { name := "share_run_charges_run_workspace_fk", columns := ["run_id", "workspace_id"],
    refTable := .runs, refColumns := ["id", "workspace_id"], onDelete := .cascade,
    inline := false }

/-- Every foreign key of the cluster, with the table that declares it. -/
def foreignKeys : List (TableName × ForeignKey) :=
  [(.shares, sharesWorkspaceKey), (.shares, sharesCreatedByKey), (.shares, sharesCreatorKey),
    (.shares, sharesPublisherKey), (.shareViews, viewsWorkspaceKey),
    (.shareViews, viewsShareKey), (.shareRunCharges, chargesWorkspaceKey),
    (.shareRunCharges, chargesShareKey), (.shareRunCharges, chargesRunKey)]

/-! ## The checks that are not closed sets -/

/-- The SQL of each non-closed-set check of the cluster, as `migrations/meta/0025_snapshot.json`
records it. -/
@[aw_spec (ts := "packages/core/src/db/schema/shares.ts#shares")
  (ts := "packages/core/src/db/schema/share-run-charges.ts#shareRunCharges")]
def checkSql : List (TableName × String × String) :=
  [(.shares, "shares_agent_mode_only",
      "\"shares\".\"mode\" is null or \"shares\".\"subject_type\" = 'agent'"),
    (.shares, "shares_budget_nonnegative",
      "\"shares\".\"budget_cap_usd\" is null or \"shares\".\"budget_cap_usd\" >= 0"),
    (.shares, "shares_spend_nonnegative", "\"shares\".\"spent_usd\" >= 0"),
    (.shares, "shares_subject_id_not_blank", "length(btrim(\"shares\".\"subject_id\")) > 0"),
    (.shareRunCharges, "share_run_charges_nonnegative",
      "\"share_run_charges\".\"charged_usd\" >= 0")]

/-- `x >= 0` on a nullable numeric column: `NULL` passes (the check is `NULL`, not false). -/
def nullOrNonNegative : Option String → Bool
  | none => true
  | some v => nonNegativeAmount v

/-- The semantics of a non-closed-set check of the cluster on one row, by name; `none` for a
name the cluster does not own. -/
@[aw_spec (ts := "packages/core/src/db/schema/shares.ts#shares")
  (ts := "packages/core/src/db/schema/share-run-charges.ts#shareRunCharges")]
def checkSemantics? (n : String) (r : Row) : Option Bool :=
  if n == "shares_agent_mode_only" then
    some (match r.get "mode", r.get "subject_type" with
      | none, _ => true
      | some _, none => true
      | some _, some t => t == "agent")
  else if n == "shares_budget_nonnegative" then some (nullOrNonNegative (r.get "budget_cap_usd"))
  else if n == "shares_spend_nonnegative" then some (nullOrNonNegative (r.get "spent_usd"))
  else if n == "shares_subject_id_not_blank" then some ((r.get "subject_id").all notBlankSql)
  else if n == "share_run_charges_nonnegative" then some (nullOrNonNegative (r.get "charged_usd"))
  else none

/-- A check of the schema holds on a row, with the cluster's semantics where it has one. -/
def refinedCheckHolds (n : String) (r : Row) : Bool :=
  (checkSemantics? n r).getD (otherCheckHolds n r)

/-- Every non-closed-set check of the cluster's tables holds with its semantics. -/
def clusterChecksHold (st : State) : Bool :=
  tables.all fun t => (catalogue t).checks.all fun
    | .other n => (st t).all (refinedCheckHolds n)
    | .oneOf .. => true

/-- The states PostgreSQL can hold, as far as this cluster knows: every constraint of every table
holds, and the cluster's own checks hold with their semantics. -/
@[aw_spec (ts := "packages/core/src/db/schema/shares.ts#shares")
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")]
def consistent (st : State) : Bool := Er.Core.consistent catalogue st && clusterChecksHold st

/-! ## The Target reading -/

namespace Target

/-- Proposed `shares_agent_has_mode`: an agent share has a mode (the service always writes one). -/
@[aw_spec (ts := "apps/web/server/shares/core/service.ts#ShareService")
  (doc := "docs/spec.md#2063-publishing-an-agent")]
def agentHasMode (r : Row) : Bool :=
  r.get "subject_type" != some "agent" || (r.get "mode").isSome

/-- Proposed `shares_budget_only_runnable`: only a runnable share has a budget cap (the contract
says `null` unless the share is a runnable agent). -/
@[aw_spec (ts := "packages/contracts/src/shares.ts#ShareResourceSchema")
  (doc := "docs/spec.md#2063-publishing-an-agent")]
def budgetOnlyRunnable (r : Row) : Bool :=
  (r.get "budget_cap_usd").isNone || r.get "mode" == some "runnable"

/-- The subject a share names exists in the share's own workspace: a row of the subject type's
table with `id = subject_id` and the same `workspace_id`. -/
@[aw_spec (ts := "apps/web/server/composition/wiring/projects.ts#subjectOwnership")
  (doc := "docs/sdk/site/concepts/ownership-and-sharing.mdx#beyond-one-workspace")]
def subjectResolves (st : State) (r : Row) : Bool :=
  match (r.get "subject_type").bind (WireEnum.ofWire? (α := SubjectType)) with
  | none => false
  | some ty => (st ty.table).any fun s =>
      s.get "id" == r.get "subject_id" && s.get "workspace_id" == r.get "workspace_id"

/-- The target publication states: today's constraints, plus the three above on every share. -/
def consistent (st : State) : Bool :=
  Publication.consistent st &&
    (st .shares).all fun r => agentHasMode r && budgetOnlyRunnable r && subjectResolves st r

end Target

end AgentWorkspace.Er.Current.Publication
