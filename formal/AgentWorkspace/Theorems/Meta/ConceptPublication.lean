import AgentWorkspace.Er.Current.Publication

/-!
T5 — properties of the publication specification itself: where the documents and the code
disagree about the concept. Each theorem pins one finding of `docs/formal/units/concept-publication.md`.
-/

namespace AgentWorkspace.Theorems.Meta.ConceptPublication

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Concepts.Share
open AgentWorkspace.Concepts (Membership.Role)

/-- A Builder or Viewer never lists a `workspace` share that another principal published, and the
public link never opens it, so today no member other than its publisher and the Owners and Admins
can read a workspace share, contrary to the specification's "any member of the workspace"
(finding 1). -/
@[aw_spec (tier := T5) (doc := "docs/spec.md#2061-three-visibilities-for-every-shareable-object")
  (ts := "apps/web/app/api/shares/route.ts#GET")
  (ts := "packages/core/src/db/repositories/root.ts#findShareWorkspace")]
theorem a_member_cannot_read_another's_workspace_share (s : Share) (viewer : PrincipalId)
    (hv : s.visibility = .workspace) (hp : s.publisher ≠ viewer) (now : Nat) :
    listedFor .builder viewer s = false ∧ listedFor .viewer viewer s = false ∧
      s.publiclyOpen now = false := by
  simp [listedFor, Share.publiclyOpen, hv, hp]

/-- A private and a workspace share with the same publisher are listed for exactly the same
callers: the list filter reads the role and the publisher, never the visibility (finding 1). -/
@[aw_spec (tier := T5) (doc := "docs/spec.md#2061-three-visibilities-for-every-shareable-object")
  (ts := "apps/web/app/api/shares/route.ts#GET")]
theorem private_and_workspace_shares_list_alike (s : Share) (role : Membership.Role)
    (viewer : PrincipalId) :
    listedFor role viewer { s with visibility := .«private» } =
      listedFor role viewer { s with visibility := .workspace } := by
  cases role <;> simp [listedFor]

/-- A workspace share and a private share are both refused by the public link at every instant,
so the only difference between the two visibilities is the stored word (finding 1). -/
@[aw_spec (tier := T5) (doc := "docs/spec.md#2061-three-visibilities-for-every-shareable-object")
  (ts := "packages/core/src/db/repositories/root.ts#findShareWorkspace")]
theorem private_and_workspace_shares_never_open (s : Share) (now : Nat)
    (h : s.visibility ≠ .«public») : s.publiclyOpen now = false := by
  unfold Share.publiclyOpen
  cases hv : s.visibility <;> simp_all

/-- `shares` carries a `publisher_principal_id`, not the `owner_principal_id` the API
specification says every ownable row carries, and neither column reaches the wire resource
(finding 2). -/
@[aw_spec (tier := T5) (doc := "docs/sdk/04-api-specification.md#2-resource-model")
  (ts := "packages/core/src/db/schema/shares.ts#shares")
  (ts := "apps/web/server/shares/core/resource.ts#toShareResource")]
theorem shares_carry_a_publisher_not_an_owner (v : Visibility) (withViewCount : Bool) :
    (catalogue .shares).hasColumn "owner_principal_id" = false ∧
      (catalogue .shares).hasColumn "publisher_principal_id" = true ∧
      (resourceKeys v withViewCount).contains "ownerPrincipalId" = false ∧
      (resourceKeys v withViewCount).contains "publisherPrincipalId" = false := by
  cases v <;> cases withViewCount <;> decide +kernel

/-- A subject id of one space is non-empty, so the request and resource schemas' `min(1)` accept
it, yet the database's `length(btrim(subject_id)) > 0` refuses it, so the insert fails after
validation passed (finding 3). A tab, which `btrim` keeps, passes both. -/
@[aw_spec (tier := T5) (ts := "apps/web/server/shares/core/input.ts#PublishShareRequestSchema")
  (ts := "packages/core/src/db/schema/shares.ts#shares")]
theorem a_space_subject_id_passes_validation_but_not_the_database :
    " ".length ≥ 1 ∧ notBlankSql " " = false ∧ notBlankSql "\t" = true ∧ notBlankSql " a " = true := by
  decide +kernel

/-- The specification's column list for `shares` omits six columns of today's table (`token`,
`subject_label`, `stopped`, `publisher_principal_id`, `suspended_at`, `created_at`), and today's
table has every column the specification lists (finding 4). -/
@[aw_spec (tier := T5) (doc := "docs/spec.md#27-minimal-database-model")
  (ts := "packages/core/src/db/schema/shares.ts#shares")]
theorem specification_column_list_is_a_strict_subset :
    let specified := ["id", "workspace_id", "subject_type", "subject_id", "visibility", "mode",
      "snapshot", "include", "budget_cap_usd", "spent_usd", "expires_at", "passphrase_hash",
      "created_by", "revoked_at"]
    specified.all (catalogue .shares).hasColumn = true ∧
      (catalogue .shares).columnNames.filter (fun c => !specified.contains c) =
        ["token", "subject_label", "stopped", "publisher_principal_id", "suspended_at",
          "created_at"] := by
  decide +kernel

private def workspaceShare : Share :=
  { (default : Share) with visibility := .workspace, publisher := ⟨"p1"⟩ }

example := a_member_cannot_read_another's_workspace_share workspaceShare ⟨"p2"⟩ rfl (by decide +kernel) 0
example := private_and_workspace_shares_never_open workspaceShare 0 (by decide +kernel)
example : workspaceShare.visibility ≠ .«public» ∧ workspaceShare.publiclyOpen 0 = false :=
  ⟨by decide +kernel, private_and_workspace_shares_never_open workspaceShare 0 (by decide +kernel)⟩

/-- A project share with a budget cap and no mode. -/
private def budgetedProjectShare : Share :=
  { (default : Share) with
    subjectType := .project
    subjectId := "p"
    budgetCapUsd := some "5"
    spentUsd := "0" }

/-- The database ties a mode to agent shares (`shares_agent_mode_only`) but ties no budget to
runnable mode: a project share with a budget cap passes every database check, although the
documents reserve `budget_cap_usd` for runnable links and the service never writes such a share
(finding 5). -/
@[aw_spec (tier := T5) (doc := "docs/spec.md#2063-publishing-an-agent")
  (ts := "packages/core/src/db/schema/shares.ts#shares")]
theorem budget_is_not_tied_to_runnable_mode_in_the_database :
    budgetedProjectShare.dbValid = true ∧ budgetedProjectShare.wellPublished = false := by
  decide +kernel

end AgentWorkspace.Theorems.Meta.ConceptPublication
