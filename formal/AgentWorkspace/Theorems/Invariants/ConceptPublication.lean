import AgentWorkspace.Er.Current.Publication
import AgentWorkspace.Theorems.Invariants.ErCore

/-!
T2 — invariants of every state PostgreSQL can hold for the publication cluster.

* **Tenant isolation, per key.** Each of the five tenant-paired keys of the cluster instantiates
  `paired_reference_preserves_tenant`: a share and its publisher, a share and its creator's
  membership, a view and its share, a charge and its share, a charge and its run always share a
  workspace. Composing two of them, a charge never funds a run of another workspace than its
  share's.
* **Cardinalities.** In a consistent state a share has exactly one publisher principal and lies in
  exactly one workspace; a view has exactly one share; a charge has exactly one share and exactly
  one run; a run is funded by at most one share; a token names at most one share in the whole
  database, so the unscoped `/p/<token>` lookup resolves at most one workspace; a share's
  `created_by`, when present, is a member of the share's workspace.
* **Closed sets and refined checks.** Every share's subject type, visibility and mode decode to the
  concept's vocabularies, a share with a mode is an agent share, amounts are non-negative, and the
  subject id is not blank.
* **Typed rows.** `Share.toRow` stores each field in its column, and `Share.dbValid` is exactly
  the cluster's checks on that row, so the typed invariants and the database agree.
* **Time.** A public link that is closed at an instant stays closed at every later instant.

Every hypothesis-bearing theorem has a witness below, built on `Witness.state`: a consistent
state with a workspace, a member, its principal, an agent, a session, a run, a runnable agent
share of that agent, a view of it and the run's charge.
-/

namespace AgentWorkspace.Theorems.Invariants.ConceptPublication

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Concepts.Share
open AgentWorkspace.Concepts (Membership.Role)
open AgentWorkspace.Er.Current
open AgentWorkspace.Er.Current.Publication (tables sharesWorkspaceKey sharesCreatedByKey
  sharesCreatorKey sharesPublisherKey viewsWorkspaceKey viewsShareKey chargesWorkspaceKey
  chargesShareKey chargesRunKey refinedCheckHolds checkSemantics? nullOrNonNegative
  clusterChecksHold)
open AgentWorkspace.Theorems.Invariants.ErCore (paired_reference_preserves_tenant)

/-! ## Helpers -/

private theorem table_consistent {st : State} (hc : Er.Core.consistent catalogue st = true)
    (t : TableName) : tableConsistent catalogue st t = true :=
  List.all_eq_true.mp hc t (WireEnum.complete t)

private theorem core_of {st : State} (hc : Publication.consistent st = true) :
    Er.Core.consistent catalogue st = true :=
  ((Bool.and_eq_true _ _).mp hc).1

private theorem fk_parent {st : State} (hc : Er.Core.consistent catalogue st = true)
    {t : TableName} {fk : ForeignKey} (hfk : fk ∈ (catalogue t).foreignKeys) {r : Row}
    (hr : r ∈ st t) (hp : r.present fk.columns = true) :
    ∃ r' ∈ st fk.refTable, r'.project fk.refColumns = r.project fk.columns := by
  have h := table_consistent hc t
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  have := List.all_eq_true.mp (h.1.2 fk hfk) r hr
  simpa [hp] using this

private theorem not_null {st : State} (hc : Er.Core.consistent catalogue st = true)
    {t : TableName} {c : String} (hnn : (catalogue t).isNotNull c = true) {r : Row}
    (hr : r ∈ st t) : (r.get c).isSome = true := by
  have h := table_consistent hc t
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  obtain ⟨col, hcol, hc'⟩ := List.any_eq_true.mp hnn
  simp only [Bool.and_eq_true, beq_iff_eq] at hc'
  have := h.1.1.1.1 col hcol
  simp only [notNullHolds, hc'.2, Bool.not_true, Bool.false_or, List.all_eq_true] at this
  rw [← hc'.1]
  exact this r hr

private theorem key_holds_single {rows : List Row} {k : String} (h : keyHolds rows [k] [] = true)
    {r1 r2 : Row} (h1 : r1 ∈ rows) (h2 : r2 ∈ rows) (hs : (r1.get k).isSome = true)
    (hv : r1.get k = r2.get k) : r1 = r2 := by
  simp only [keyHolds, List.all_nil] at h
  rw [List.filter_eq_self.mpr (fun _ _ => rfl), List.all_eq_true] at h
  have := h r1 h1
  simp only [Row.present, List.all_cons, List.all_nil, Bool.and_true, hs, Bool.not_true,
    Bool.false_or, List.all_eq_true] at this
  have := this r2 h2
  simp only [Row.project, List.map_cons, List.map_nil, hv, bne_self_eq_false, Bool.false_or,
    beq_iff_eq] at this
  exact this

private theorem pk_unique {st : State} (hc : Er.Core.consistent catalogue st = true)
    {t : TableName} {k : String} (hpk : (catalogue t).primaryKey = [k]) {r1 r2 : Row}
    (h1 : r1 ∈ st t) (h2 : r2 ∈ st t) (hs : (r1.get k).isSome = true)
    (hv : r1.get k = r2.get k) : r1 = r2 := by
  have h := table_consistent hc t
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  have hkey := h.1.1.1.2
  rw [hpk] at hkey
  exact key_holds_single hkey h1 h2 hs hv

private theorem unique_single {st : State} (hc : Er.Core.consistent catalogue st = true)
    {t : TableName} {u : UniqueKey} (hu : u ∈ (catalogue t).uniques) {k : String}
    (hcols : u.columns = [k]) (hpart : u.partialNullColumns = []) {r1 r2 : Row}
    (h1 : r1 ∈ st t) (h2 : r2 ∈ st t) (hs : (r1.get k).isSome = true)
    (hv : r1.get k = r2.get k) : r1 = r2 := by
  have h := table_consistent hc t
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  have hkey := h.1.1.2 u hu
  rw [hcols, hpart] at hkey
  exact key_holds_single hkey h1 h2 hs hv

private theorem check_holds {st : State} (hc : Er.Core.consistent catalogue st = true)
    {t : TableName} {ck : Check} (hck : ck ∈ (catalogue t).checks) :
    checkHolds (st t) ck = true := by
  have h := table_consistent hc t
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  exact h.2 ck hck

private theorem refined_check {st : State} (hc : Publication.consistent st = true)
    {t : TableName} (ht : t ∈ tables) {n : String} (hck : Check.other n ∈ (catalogue t).checks)
    {r : Row} (hr : r ∈ st t) : refinedCheckHolds n r = true := by
  have h := ((Bool.and_eq_true _ _).mp hc).2
  unfold clusterChecksHold at h
  have h1 := List.all_eq_true.mp (List.all_eq_true.mp h t ht) _ hck
  exact List.all_eq_true.mp h1 r hr

private theorem one_of_value {st : State} (hc : Er.Core.consistent catalogue st = true)
    {t : TableName} {n c : String} {vs : List String} (hck : Check.oneOf n c vs ∈ (catalogue t).checks)
    {r : Row} (hr : r ∈ st t) : (r.get c).all vs.contains = true := by
  have := check_holds hc hck
  simp only [checkHolds, List.all_eq_true] at this
  exact this r hr

/-! ## Encoding typed rows -/

private theorem rowOf_get_none :
    ∀ {cells : List (String × Option String)} {c : String},
      c ∉ cells.map Prod.fst → (rowOf cells).get c = none
  | [], _, _ => rfl
  | (c', v') :: rest, c, h => by
    simp only [List.map_cons, List.mem_cons, not_or] at h
    have ih := rowOf_get_none (cells := rest) h.2
    cases v' with
    | none => simpa [rowOf, Row.get] using ih
    | some x =>
      simp only [rowOf, Row.get, List.filterMap_cons, Option.map_some] at ih ⊢
      rw [List.lookup_cons]
      have : (c == c') = false := by simpa using h.1
      simp [this, ih]

private theorem rowOf_get :
    ∀ {cells : List (String × Option String)} {c : String} {v : Option String},
      (cells.map Prod.fst).Nodup → (c, v) ∈ cells → (rowOf cells).get c = v
  | [], _, _, _, h => by simp at h
  | (c', v') :: rest, c, v, hnd, hm => by
    simp only [List.map_cons, List.nodup_cons] at hnd
    simp only [List.mem_cons, Prod.mk.injEq] at hm
    rcases hm with ⟨rfl, rfl⟩ | hm
    · cases v with
      | none => simpa [rowOf, Row.get] using rowOf_get_none hnd.1
      | some x => simp [rowOf, Row.get]
    · have hne : c ≠ c' := by
        intro heq
        subst heq
        exact hnd.1 (List.mem_map.mpr ⟨(c, v), hm, rfl⟩)
      have ih := rowOf_get hnd.2 hm
      cases v' with
      | none => simpa [rowOf, Row.get] using ih
      | some x =>
        simp only [rowOf, Row.get, List.filterMap_cons, Option.map_some] at ih ⊢
        rw [List.lookup_cons]
        have : (c == c') = false := by simpa using hne
        simp [this, ih]

private theorem share_cells_nodup (s : Share) : (s.cells.map Prod.fst).Nodup := by
  rw [show s.cells.map Prod.fst = (catalogue .shares).columnNames from rfl]
  decide

private theorem share_get {s : Share} {c : String} {v : Option String} (hm : (c, v) ∈ s.cells) :
    s.toRow.get c = v :=
  rowOf_get (share_cells_nodup s) hm

private theorem charge_get {x : ShareRunCharge} {c : String} {v : Option String}
    (hm : (c, v) ∈ x.cells) : x.toRow.get c = v := by
  refine rowOf_get ?_ hm
  rw [show x.cells.map Prod.fst = (catalogue .shareRunCharges).columnNames from rfl]
  decide

/-- A share's row stores each field in its own column: the subject type, the mode (absent when
the share has none), the budget, the spend, the subject id, the visibility, the token and the
publisher. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/shares.ts#shares")
  (ts := "packages/core/src/db/repositories/shares.ts#ShareRecord")]
theorem share_row_encodes_fields (s : Share) :
    s.toRow.get "subject_type" = some s.subjectType.toWire ∧
      s.toRow.get "mode" = s.mode.map Mode.toWire ∧
      s.toRow.get "budget_cap_usd" = s.budgetCapUsd ∧
      s.toRow.get "spent_usd" = some s.spentUsd ∧
      s.toRow.get "subject_id" = some s.subjectId ∧
      s.toRow.get "visibility" = some s.visibility.toWire ∧
      s.toRow.get "token" = some s.token ∧
      s.toRow.get "publisher_principal_id" = some s.publisher.val := by
  refine ⟨share_get ?_, share_get ?_, share_get ?_, share_get ?_, share_get ?_, share_get ?_,
    share_get ?_, share_get ?_⟩ <;> simp [Share.cells]

/-- The four database checks of `shares` hold on a share's row exactly when the typed share is
`dbValid`, so the typed invariant and the database constraint agree on every share. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/shares.ts#shares")]
theorem share_db_valid_iff_row_checks (s : Share) :
    s.dbValid = true ↔
      (["shares_agent_mode_only", "shares_budget_nonnegative", "shares_spend_nonnegative",
        "shares_subject_id_not_blank"].all fun n => refinedCheckHolds n s.toRow) = true := by
  obtain ⟨hst, hm, hb, hsp, hsid, -⟩ := share_row_encodes_fields s
  simp only [List.all_cons, List.all_nil, Bool.and_true, refinedCheckHolds, checkSemantics?,
    hst, hm, hb, hsp, hsid, Share.dbValid, Share.modeOnlyForAgent, Share.budgetNonNegative,
    Share.spendNonNegative, nullOrNonNegative]
  cases s.mode <;> cases s.subjectType <;> cases s.budgetCapUsd <;>
    simp [SubjectType.toWire, and_assoc]

/-- The database check of `share_run_charges` holds on a charge's row exactly when the typed
charge is `dbValid`. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/share-run-charges.ts#shareRunCharges")]
theorem charge_db_valid_iff_row_check (x : ShareRunCharge) :
    x.dbValid = true ↔ refinedCheckHolds "share_run_charges_nonnegative" x.toRow = true := by
  have h : x.toRow.get "charged_usd" = some x.chargedUsd := charge_get (by simp [ShareRunCharge.cells])
  simp [refinedCheckHolds, checkSemantics?, h, ShareRunCharge.dbValid, nullOrNonNegative]

/-- A share as the service publishes it passes every database check of `shares`. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/shares/core/service.ts#ShareService")
  (ts := "packages/core/src/db/schema/shares.ts#shares")]
theorem well_published_share_passes_the_checks (s : Share) (h : s.wellPublished = true) :
    (["shares_agent_mode_only", "shares_budget_nonnegative", "shares_spend_nonnegative",
        "shares_subject_id_not_blank"].all fun n => refinedCheckHolds n s.toRow) = true := by
  refine (share_db_valid_iff_row_checks s).mp ?_
  simp only [Share.wellPublished, Bool.and_eq_true] at h
  exact h.1.1.1.1

/-! ## Tenant isolation, one instance per tenant-paired key -/

/-- A share and the principal that published it always belong to the same workspace. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/schema/shares.ts#shares_publisher_principal_workspace_fk")
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
theorem share_and_publisher_share_a_workspace (st : State) {r r' : Row}
    (href : References catalogue st .shares sharesPublisherKey r r') :
    tenantOf catalogue .shares r = tenantOf catalogue .workspacePrincipals r' :=
  paired_reference_preserves_tenant catalogue st (by decide) href

/-- A share and the membership of the user who created it always belong to the same workspace. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/shares.ts#shares_creator_workspace_fk")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
theorem share_and_creator_membership_share_a_workspace (st : State) {r r' : Row}
    (href : References catalogue st .shares sharesCreatorKey r r') :
    tenantOf catalogue .shares r = tenantOf catalogue .memberships r' :=
  paired_reference_preserves_tenant catalogue st (by decide) href

/-- A share view and the share it records always belong to the same workspace. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/schema/share-views.ts#share_views_share_workspace_fk")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
theorem view_and_share_share_a_workspace (st : State) {r r' : Row}
    (href : References catalogue st .shareViews viewsShareKey r r') :
    tenantOf catalogue .shareViews r = tenantOf catalogue .shares r' :=
  paired_reference_preserves_tenant catalogue st (by decide) href

/-- A run charge and the share whose budget it draws on always belong to the same workspace. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/schema/share-run-charges.ts#share_run_charges_share_workspace_fk")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
theorem charge_and_share_share_a_workspace (st : State) {r r' : Row}
    (href : References catalogue st .shareRunCharges chargesShareKey r r') :
    tenantOf catalogue .shareRunCharges r = tenantOf catalogue .shares r' :=
  paired_reference_preserves_tenant catalogue st (by decide) href

/-- A run charge and the run it funds always belong to the same workspace. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/schema/share-run-charges.ts#share_run_charges_run_workspace_fk")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
theorem charge_and_run_share_a_workspace (st : State) {r r' : Row}
    (href : References catalogue st .shareRunCharges chargesRunKey r r') :
    tenantOf catalogue .shareRunCharges r = tenantOf catalogue .runs r' :=
  paired_reference_preserves_tenant catalogue st (by decide) href

/-- A share's budget only ever funds runs of the share's own workspace: the run and the share a
charge joins are in one workspace. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/schema/share-run-charges.ts#shareRunCharges")
  (doc := "docs/spec.md#2063-publishing-an-agent")]
theorem charge_funds_runs_of_its_share's_workspace (st : State) {c s u : Row}
    (hs : References catalogue st .shareRunCharges chargesShareKey c s)
    (hu : References catalogue st .shareRunCharges chargesRunKey c u) :
    tenantOf catalogue .shares s = tenantOf catalogue .runs u :=
  (charge_and_share_share_a_workspace st hs).symm.trans (charge_and_run_share_a_workspace st hu)

/-! ## Cardinalities -/

/-- In a consistent state every share lies in exactly one existing workspace: the row its
`workspace_id` names. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/shares.ts#shares")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
theorem share_has_exactly_one_workspace (st : State)
    (hc : Er.Core.consistent catalogue st = true) {r : Row} (hr : r ∈ st .shares) :
    ∃ w ∈ st .workspaces, w.get "id" = r.get "workspace_id" ∧
      ∀ w' ∈ st .workspaces, w'.get "id" = r.get "workspace_id" → w' = w := by
  have hw : (r.get "workspace_id").isSome = true := not_null hc (by decide) hr
  obtain ⟨w, hwm, hproj⟩ := fk_parent hc (fk := sharesWorkspaceKey) (by decide) hr
    (by simp [Row.present, sharesWorkspaceKey, hw])
  simp only [sharesWorkspaceKey, Row.project, List.map_cons, List.map_nil,
    List.cons.injEq, and_true] at hproj
  refine ⟨w, hwm, hproj, fun w' hw' he => ?_⟩
  exact (pk_unique hc (t := .workspaces) rfl hwm hw' (by rw [hproj]; exact hw)
    (hproj.trans he.symm)).symm

/-- In a consistent state every share has exactly one publisher: a principal of the share's own
workspace, and no other principal row carries that id. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/schema/shares.ts#shares_publisher_principal_workspace_fk")
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
theorem share_has_exactly_one_publisher (st : State)
    (hc : Er.Core.consistent catalogue st = true) {r : Row} (hr : r ∈ st .shares) :
    ∃ p ∈ st .workspacePrincipals, p.get "workspace_id" = r.get "workspace_id" ∧
      p.get "id" = r.get "publisher_principal_id" ∧
      ∀ p' ∈ st .workspacePrincipals, p'.get "id" = r.get "publisher_principal_id" → p' = p := by
  have hw : (r.get "workspace_id").isSome = true := not_null hc (by decide) hr
  have hp : (r.get "publisher_principal_id").isSome = true := not_null hc (by decide) hr
  obtain ⟨p, hpm, hproj⟩ := fk_parent hc (fk := sharesPublisherKey) (by decide) hr
    (by simp [Row.present, sharesPublisherKey, hw, hp])
  simp only [sharesPublisherKey, Row.project, List.map_cons, List.map_nil,
    List.cons.injEq, and_true] at hproj
  refine ⟨p, hpm, hproj.1, hproj.2, fun p' hp' he => ?_⟩
  exact (pk_unique hc (t := .workspacePrincipals) rfl hpm hp' (by rw [hproj.2]; exact hp)
    (hproj.2.trans he.symm)).symm

/-- In a consistent state every share view records exactly one share, of its own workspace. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/schema/share-views.ts#share_views_share_workspace_fk")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
theorem view_has_exactly_one_share (st : State) (hc : Er.Core.consistent catalogue st = true)
    {v : Row} (hv : v ∈ st .shareViews) :
    ∃ s ∈ st .shares, s.get "id" = v.get "share_id" ∧ s.get "workspace_id" = v.get "workspace_id" ∧
      ∀ s' ∈ st .shares, s'.get "id" = v.get "share_id" → s' = s := by
  have hw : (v.get "workspace_id").isSome = true := not_null hc (by decide) hv
  have hs : (v.get "share_id").isSome = true := not_null hc (by decide) hv
  obtain ⟨s, hsm, hproj⟩ := fk_parent hc (fk := viewsShareKey) (by decide) hv
    (by simp [Row.present, viewsShareKey, hw, hs])
  simp only [viewsShareKey, Row.project, List.map_cons, List.map_nil,
    List.cons.injEq, and_true] at hproj
  refine ⟨s, hsm, hproj.1, hproj.2, fun s' hs' he => ?_⟩
  exact (pk_unique hc (t := .shares) rfl hsm hs' (by rw [hproj.1]; exact hs)
    (hproj.1.trans he.symm)).symm

/-- In a consistent state every run charge draws on exactly one share, of its own workspace. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/schema/share-run-charges.ts#share_run_charges_share_workspace_fk")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
theorem charge_has_exactly_one_share (st : State) (hc : Er.Core.consistent catalogue st = true)
    {c : Row} (hcm : c ∈ st .shareRunCharges) :
    ∃ s ∈ st .shares, s.get "id" = c.get "share_id" ∧ s.get "workspace_id" = c.get "workspace_id" ∧
      ∀ s' ∈ st .shares, s'.get "id" = c.get "share_id" → s' = s := by
  have hw : (c.get "workspace_id").isSome = true := not_null hc (by decide) hcm
  have hs : (c.get "share_id").isSome = true := not_null hc (by decide) hcm
  obtain ⟨s, hsm, hproj⟩ := fk_parent hc (fk := chargesShareKey) (by decide) hcm
    (by simp [Row.present, chargesShareKey, hw, hs])
  simp only [chargesShareKey, Row.project, List.map_cons, List.map_nil,
    List.cons.injEq, and_true] at hproj
  refine ⟨s, hsm, hproj.1, hproj.2, fun s' hs' he => ?_⟩
  exact (pk_unique hc (t := .shares) rfl hsm hs' (by rw [hproj.1]; exact hs)
    (hproj.1.trans he.symm)).symm

/-- In a consistent state every run charge funds exactly one run, of its own workspace. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/schema/share-run-charges.ts#share_run_charges_run_workspace_fk")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
theorem charge_has_exactly_one_run (st : State) (hc : Er.Core.consistent catalogue st = true)
    {c : Row} (hcm : c ∈ st .shareRunCharges) :
    ∃ u ∈ st .runs, u.get "id" = c.get "run_id" ∧ u.get "workspace_id" = c.get "workspace_id" ∧
      ∀ u' ∈ st .runs, u'.get "id" = c.get "run_id" → u' = u := by
  have hw : (c.get "workspace_id").isSome = true := not_null hc (by decide) hcm
  have hu : (c.get "run_id").isSome = true := not_null hc (by decide) hcm
  obtain ⟨u, hum, hproj⟩ := fk_parent hc (fk := chargesRunKey) (by decide) hcm
    (by simp [Row.present, chargesRunKey, hw, hu])
  simp only [chargesRunKey, Row.project, List.map_cons, List.map_nil,
    List.cons.injEq, and_true] at hproj
  refine ⟨u, hum, hproj.1, hproj.2, fun u' hu' he => ?_⟩
  exact (pk_unique hc (t := .runs) rfl hum hu' (by rw [hproj.1]; exact hu)
    (hproj.1.trans he.symm)).symm

/-- In a consistent state a run is funded by at most one share: two charge rows for the same run
are the same row (`run_id` is the primary key). -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/share-run-charges.ts#shareRunCharges")
  (ts := "packages/core/src/db/repositories/shares.ts#linkRun")]
theorem run_is_funded_by_at_most_one_share (st : State)
    (hc : Er.Core.consistent catalogue st = true) {c1 c2 : Row} (h1 : c1 ∈ st .shareRunCharges)
    (h2 : c2 ∈ st .shareRunCharges) (hrun : c1.get "run_id" = c2.get "run_id") :
    c1 = c2 ∧ c1.get "share_id" = c2.get "share_id" := by
  have hs : (c1.get "run_id").isSome = true := not_null hc (by decide) h1
  have := pk_unique hc (t := .shareRunCharges) rfl h1 h2 hs hrun
  exact ⟨this, by rw [this]⟩

/-- In a consistent state a token names at most one share in the whole database, whatever the
workspaces, so the unscoped `/p/<token>` lookup resolves at most one workspace. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/shares.ts#shares")
  (ts := "packages/core/src/db/repositories/root.ts#findShareWorkspace")]
theorem token_names_at_most_one_share (st : State)
    (hc : Er.Core.consistent catalogue st = true) {r1 r2 : Row} (h1 : r1 ∈ st .shares)
    (h2 : r2 ∈ st .shares) (htok : r1.get "token" = r2.get "token") :
    r1 = r2 ∧ r1.get "workspace_id" = r2.get "workspace_id" := by
  have hs : (r1.get "token").isSome = true := not_null hc (by decide) h1
  have := unique_single hc (t := .shares)
    (u := { name := "shares_token_key", columns := ["token"], kind := .constraint,
            partialNullColumns := [] }) (by decide) rfl rfl h1 h2 hs htok
  exact ⟨this, by rw [this]⟩

/-- In a consistent state, when a share records the user who created it, that user is a member
of the share's workspace. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/shares.ts#shares_creator_workspace_fk")
  (doc := "docs/sdk/04-api-specification.md#2-resource-model")]
theorem share_creator_is_a_member (st : State) (hc : Er.Core.consistent catalogue st = true)
    {r : Row} (hr : r ∈ st .shares) {u : String} (hu : r.get "created_by" = some u) :
    ∃ m ∈ st .memberships, m.get "workspace_id" = r.get "workspace_id" ∧
      m.get "user_id" = some u := by
  have hw : (r.get "workspace_id").isSome = true := not_null hc (by decide) hr
  obtain ⟨m, hmm, hproj⟩ := fk_parent hc (fk := sharesCreatorKey) (by decide) hr
    (by simp [Row.present, sharesCreatorKey, hw, hu])
  simp only [sharesCreatorKey, Row.project, List.map_cons, List.map_nil,
    List.cons.injEq, and_true] at hproj
  exact ⟨m, hmm, hproj.1, hproj.2.trans hu⟩

/-! ## Closed sets -/

/-- In a consistent state every share's subject type is one of the concept's four subject types. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/shares.ts#shareSubjectTypes")
  (doc := "docs/spec.md#2061-three-visibilities-for-every-shareable-object")]
theorem share_subject_type_decodes (st : State) (hc : Er.Core.consistent catalogue st = true)
    {r : Row} (hr : r ∈ st .shares) : ∃ ty : SubjectType, r.get "subject_type" = some ty.toWire := by
  have hs : (r.get "subject_type").isSome = true := not_null hc (by decide) hr
  have h := one_of_value hc (t := .shares) (n := "shares_subject_type_valid")
    (c := "subject_type") (vs := ["agent", "session", "project", "skill"]) (by decide) hr
  cases hv : r.get "subject_type" with
  | none => rw [hv] at hs; cases hs
  | some x =>
    rw [hv] at h
    simp only [Option.all_some, List.contains_cons, List.contains_nil, Bool.or_false,
      Bool.or_eq_true, beq_iff_eq] at h
    rcases h with rfl | rfl | rfl | rfl
    · exact ⟨.agent, rfl⟩
    · exact ⟨.session, rfl⟩
    · exact ⟨.project, rfl⟩
    · exact ⟨.skill, rfl⟩

/-- In a consistent state every share's visibility is one of the concept's three visibilities. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/shares.ts#shareVisibilities")
  (doc := "docs/spec.md#2061-three-visibilities-for-every-shareable-object")]
theorem share_visibility_decodes (st : State) (hc : Er.Core.consistent catalogue st = true)
    {r : Row} (hr : r ∈ st .shares) : ∃ v : Visibility, r.get "visibility" = some v.toWire := by
  have hs : (r.get "visibility").isSome = true := not_null hc (by decide) hr
  have h := one_of_value hc (t := .shares) (n := "shares_visibility_valid")
    (c := "visibility") (vs := ["private", "workspace", "public"]) (by decide) hr
  cases hv : r.get "visibility" with
  | none => rw [hv] at hs; cases hs
  | some x =>
    rw [hv] at h
    simp only [Option.all_some, List.contains_cons, List.contains_nil, Bool.or_false,
      Bool.or_eq_true, beq_iff_eq] at h
    rcases h with rfl | rfl | rfl
    · exact ⟨.«private», rfl⟩
    · exact ⟨.workspace, rfl⟩
    · exact ⟨.«public», rfl⟩

/-- In a consistent state every share's mode is absent or one of the concept's two modes. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/shares.ts#shareModes")
  (doc := "docs/spec.md#2063-publishing-an-agent")]
theorem share_mode_decodes (st : State) (hc : Er.Core.consistent catalogue st = true)
    {r : Row} (hr : r ∈ st .shares) :
    r.get "mode" = none ∨ ∃ m : Mode, r.get "mode" = some m.toWire := by
  have h := one_of_value hc (t := .shares) (n := "shares_mode_valid")
    (c := "mode") (vs := ["definition", "runnable"]) (by decide) hr
  cases hv : r.get "mode" with
  | none => exact Or.inl rfl
  | some x =>
    rw [hv] at h
    simp only [Option.all_some, List.contains_cons, List.contains_nil, Bool.or_false,
      Bool.or_eq_true, beq_iff_eq] at h
    rcases h with (rfl | rfl)
    · exact Or.inr ⟨.definition, rfl⟩
    · exact Or.inr ⟨.runnable, rfl⟩

/-! ## The refined checks -/

/-- In a consistent state a share that has a mode is an agent share. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/shares.ts#shares")
  (doc := "docs/spec.md#2063-publishing-an-agent")]
theorem share_with_mode_is_an_agent_share (st : State) (hc : Publication.consistent st = true)
    {r : Row} (hr : r ∈ st .shares) (hm : (r.get "mode").isSome = true) :
    r.get "subject_type" = some "agent" := by
  have h := refined_check hc (t := .shares) (by decide) (n := "shares_agent_mode_only")
    (by decide) hr
  have hs : (r.get "subject_type").isSome = true := not_null (core_of hc) (by decide) hr
  simp only [refinedCheckHolds, checkSemantics?, beq_self_eq_true, ite_true,
    Option.getD_some] at h
  cases hmode : r.get "mode" with
  | none => rw [hmode] at hm; cases hm
  | some m =>
    cases hty : r.get "subject_type" with
    | none => rw [hty] at hs; cases hs
    | some t =>
      rw [hmode, hty] at h
      simpa using h

/-- In a consistent state every share's spend is a non-negative amount, and its budget cap is
absent or a non-negative amount. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/shares.ts#shares")
  (doc := "docs/sdk/04-api-specification.md#513-shares--awshares")]
theorem share_amounts_are_non_negative (st : State) (hc : Publication.consistent st = true)
    {r : Row} (hr : r ∈ st .shares) :
    (r.get "spent_usd").all nonNegativeAmount = true ∧
      (r.get "budget_cap_usd").all nonNegativeAmount = true := by
  have hsp := refined_check hc (t := .shares) (by decide) (n := "shares_spend_nonnegative")
    (by decide) hr
  have hb := refined_check hc (t := .shares) (by decide) (n := "shares_budget_nonnegative")
    (by decide) hr
  have hs : (r.get "spent_usd").isSome = true := not_null (core_of hc) (by decide) hr
  simp only [refinedCheckHolds, checkSemantics?] at hsp hb
  simp at hsp hb
  constructor
  · cases h : r.get "spent_usd" with
    | none => rw [h] at hs; cases hs
    | some v => rw [h] at hsp; simpa [nullOrNonNegative] using hsp
  · cases h : r.get "budget_cap_usd" with
    | none => rfl
    | some v => rw [h] at hb; simpa [nullOrNonNegative] using hb

/-- In a consistent state every share's subject id has a character other than a space. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/shares.ts#shares")]
theorem share_subject_id_is_not_blank (st : State) (hc : Publication.consistent st = true)
    {r : Row} (hr : r ∈ st .shares) : ∃ sid, r.get "subject_id" = some sid ∧ notBlankSql sid := by
  have h := refined_check hc (t := .shares) (by decide) (n := "shares_subject_id_not_blank")
    (by decide) hr
  have hs : (r.get "subject_id").isSome = true := not_null (core_of hc) (by decide) hr
  simp only [refinedCheckHolds, checkSemantics?] at h
  simp at h
  cases hv : r.get "subject_id" with
  | none => rw [hv] at hs; cases hs
  | some sid => rw [hv] at h; exact ⟨sid, rfl, by simpa using h⟩

/-- In a consistent state every run charge is a non-negative amount. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/share-run-charges.ts#shareRunCharges")]
theorem charge_is_non_negative (st : State) (hc : Publication.consistent st = true)
    {c : Row} (hcm : c ∈ st .shareRunCharges) : (c.get "charged_usd").all nonNegativeAmount = true := by
  have h := refined_check hc (t := .shareRunCharges) (by decide)
    (n := "share_run_charges_nonnegative") (by decide) hcm
  simp only [refinedCheckHolds, checkSemantics?] at h
  simp at h
  cases hv : c.get "charged_usd" with
  | none => rfl
  | some v => rw [hv] at h; simpa [nullOrNonNegative] using h

/-! ## Time -/

/-- A public link that does not open at an instant does not open at any later instant: every
cause (visibility, revocation, suspension, the stop, expiry) persists as time passes. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/shares/core/service.ts#ShareService")
  (doc := "docs/spec.md#2062-publishing-a-session-run-history")]
theorem closed_link_stays_closed (s : Share) {t1 t2 : Nat} (hle : t1 ≤ t2)
    (h : s.publiclyOpen t1 = false) : s.publiclyOpen t2 = false := by
  unfold Share.publiclyOpen Share.stateAt Share.expiredAt at *
  cases hv : s.visibility <;> simp [hv] at h ⊢
  split at h <;> simp_all
  split at h <;> simp_all
  split at h <;> simp_all
  cases he : s.expiresAt with
  | none => simp [he] at h
  | some e =>
    simp [he] at h ⊢
    omega

/-- A share's derived state never returns to `live` once it has expired: expiry is permanent as
time passes. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/shares/core/service.ts#ShareService")
  (doc := "docs/formal/inventory.md#2-state-machines")]
theorem expired_state_is_permanent (s : Share) {t1 t2 : Nat} (hle : t1 ≤ t2)
    (h : s.stateAt t1 = .expired) : s.stateAt t2 = .expired := by
  unfold Share.stateAt Share.expiredAt at *
  split at h <;> simp_all
  split at h <;> simp_all
  split at h <;> simp_all
  cases he : s.expiresAt with
  | none => simp [he] at h
  | some e =>
    simp [he] at h ⊢
    omega

/-! ## The publishing service -/

/-- A share whose token lacks the `pub_` prefix is not a share the service publishes, whatever
its other fields. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/shares/core/service.ts#ShareService")]
theorem well_published_requires_the_pub_prefix (s : Share)
    (h : tokenPrefix.toList.isPrefixOf s.token.toList = false) : s.wellPublished = false := by
  simp [Share.wellPublished, h]

/-- An admitted publish gives a mode exactly to an agent share, and a budget exactly to a
runnable one: the two row-local halves of `wellPublished` hold for everything the service writes. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/shares/core/service.ts#ShareService")
  (doc := "docs/spec.md#27-minimal-database-model")]
theorem published_mode_and_budget_fit (r : PublishRequest) (role : Membership.Role)
    (pse re : Bool) (now : Nat) (p : Published)
    (h : publishDecision r role pse re now = .published p) :
    p.mode.isSome = (r.subjectType == .agent) ∧
      p.budgetCapUsd.isSome = (p.mode == some .runnable) := by
  unfold publishDecision at h
  split at h
  · cases h
  · split at h
    · cases h
    · split at h
      · cases h
      · cases h
        constructor
        · cases ht : r.subjectType <;> simp [PublishRequest.effectiveMode, ht]
        · cases hm : r.effectiveMode == some .runnable <;> simp_all

/-- While the release gate is closed (today), no admitted publish writes a runnable share. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/shares/runnable/feature.ts#runnablePublicLinksEnabled")
  (doc := "docs/sdk/04-api-specification.md#513-shares--awshares")]
theorem no_runnable_share_is_published_today (r : PublishRequest) (role : Membership.Role)
    (pse : Bool) (now : Nat) (p : Published)
    (h : publishDecision r role pse runnableReleased now = .published p) :
    p.mode ≠ some .runnable ∧ p.budgetCapUsd = none := by
  unfold publishDecision runnableReleased at h
  split at h
  · cases h
  · split at h
    · cases h
    · rename_i hgate
      split at h
      · cases h
      · cases h
        have hne : (r.effectiveMode == some .runnable) = false := by simpa using hgate
        simp_all

/-- While public sharing is off, no admitted publish is a public share. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/shares/core/service.ts#ShareService")
  (doc := "docs/spec.md#2064-administration")]
theorem no_public_share_is_published_while_sharing_is_off (r : PublishRequest)
    (role : Membership.Role) (re : Bool) (now : Nat) (p : Published)
    (h : publishDecision r role false re now = .published p) : r.visibility ≠ .«public» := by
  intro hv
  simp [publishDecision, hv] at h

/-- An admitted publish expires exactly its expiry's lifetime after `now`, and never with
`never` or no expiry. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/shares/core/service.ts#EXPIRY_MS")
  (doc := "docs/spec.md#2062-publishing-a-session-run-history")]
theorem published_expiry_counts_from_now (r : PublishRequest) (role : Membership.Role)
    (pse re : Bool) (now : Nat) (p : Published)
    (h : publishDecision r role pse re now = .published p) :
    p.expiresAt = (r.expiry.getD .never).durationMs?.map (now + ·) := by
  unfold publishDecision at h
  split at h
  · cases h
  · split at h
    · cases h
    · split at h
      · cases h
      · cases h
        rfl

/-! ## Opening a link -/

/-- A link opens exactly when it is public and live and, if it has a passphrase, the right one is
presented. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/shares/core/service.ts#ShareService")]
theorem resolve_opens_iff (s : Share) (now : Nat) (a : PassphraseAttempt) :
    s.resolveAt now a = .opened ↔
      s.publiclyOpen now = true ∧ (s.passphraseRequired = false ∨ a = .right) := by
  unfold Share.resolveAt
  cases ho : s.publiclyOpen now <;> cases hp : s.passphraseRequired <;> cases a <;> simp

/-- A closed link answers `share_unavailable` whatever passphrase is presented, so a visitor of a
closed link learns nothing about whether it has a passphrase. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/shares/core/service.ts#ShareService")]
theorem closed_link_is_unavailable_whatever_the_passphrase (s : Share) (now : Nat)
    (h : s.publiclyOpen now = false) (a : PassphraseAttempt) :
    s.resolveAt now a = .unavailable := by
  simp [Share.resolveAt, h]

/-! ## Witnesses -/

namespace Witness

/-- The witness share: a public runnable agent share of agent `a1`, with a $20 budget, published
by principal `p1` of workspace `w1`. It is a row the schema admits and the service would write
once the D-06 gate opens; today `publishDecision` refuses every runnable request
(`no_runnable_share_is_published_today`). -/
def share : Share :=
  { id := ⟨"sh1"⟩, workspace := ⟨"w1"⟩, token := "pub_abc", subjectType := .agent,
    subjectId := "a1", subjectLabel := "General", visibility := .«public», mode := some .runnable,
    snapshot := none, «include» := {}, budgetCapUsd := some "20", spentUsd := "0",
    stopped := false, expiresAt := some 100, passphraseHash := none, createdBy := some ⟨"u1"⟩,
    publisher := ⟨"p1"⟩, revokedAt := none, suspendedAt := none, createdAt := 0 }

/-- A view of the witness share. -/
def view : ShareView :=
  { id := ⟨"v1"⟩, workspace := ⟨"w1"⟩, share := ⟨"sh1"⟩, visitorKey := none, createdAt := 1 }

/-- The charge that attributes run `r1` to the witness share. -/
def charge : ShareRunCharge :=
  { run := ⟨"r1"⟩, workspace := ⟨"w1"⟩, share := ⟨"sh1"⟩, chargedUsd := "0.5", createdAt := 2,
    updatedAt := 2 }

/-- The witness state with `shares` replaced by `rows`. -/
def stateWith (rows : List Row) : State
  | .workspaces =>
    [⟨[("id", "w1"), ("slug", "one"), ("name", "One"), ("public_sharing_enabled", "true"),
       ("created_at", "0"), ("updated_at", "0")]⟩,
     ⟨[("id", "w2"), ("slug", "two"), ("name", "Two"), ("public_sharing_enabled", "true"),
       ("created_at", "0"), ("updated_at", "0")]⟩]
  | .users =>
    [⟨[("id", "u1"), ("email", "a@example.com"), ("name", "A"), ("created_at", "0"),
       ("updated_at", "0")]⟩]
  | .memberships =>
    [⟨[("id", "m1"), ("workspace_id", "w1"), ("user_id", "u1"), ("role", "owner"),
       ("created_at", "0"), ("updated_at", "0")]⟩]
  | .workspacePrincipals =>
    [⟨[("id", "p1"), ("workspace_id", "w1"), ("kind", "membership"), ("membership_id", "m1"),
       ("activated_at", "0"), ("created_at", "0")]⟩]
  | .agents =>
    [⟨[("id", "a1"), ("workspace_id", "w1"), ("name", "General"), ("instructions", "Help."),
       ("permissions", "{}"), ("created_by", "u1"), ("owner_principal_id", "p1"),
       ("created_at", "0"), ("updated_at", "0")]⟩]
  | .sessions =>
    [⟨[("id", "s1"), ("workspace_id", "w1"), ("user_id", "u1"), ("owner_principal_id", "p1"),
       ("agent_id", "a1"), ("status", "active"), ("created_at", "0"), ("updated_at", "0")]⟩]
  | .runs =>
    [⟨[("id", "r1"), ("workspace_id", "w1"), ("session_id", "s1"), ("status", "queued"),
       ("input_tokens", "0"), ("output_tokens", "0"), ("cache_read_input_tokens", "0"),
       ("cache_creation_input_tokens", "0"), ("cost_usd", "0"), ("cost_currency", "USD"),
       ("tool_calls", "0"), ("accounting_state", "pending"), ("tool_connector_ids", "{}"),
       ("created_at", "0"), ("updated_at", "0")]⟩]
  | .shares => rows
  | .shareViews => [view.toRow]
  | .shareRunCharges => [charge.toRow]
  | _ => []

/-- The witness state: the witness share, its view and its charge, over a workspace with a
member, its principal, an agent, a session and a run. -/
def state : State := stateWith [share.toRow]

private theorem state_is_consistent : Publication.consistent state = true := by decide +kernel

end Witness

example : Witness.share.wellPublished = true := by decide
example : Witness.share.dbValid = true := by decide
example : Witness.charge.dbValid = true := by decide

example : ∃ w ∈ Witness.state .workspaces, w.get "id" = Witness.share.toRow.get "workspace_id" ∧
    ∀ w' ∈ Witness.state .workspaces, w'.get "id" = Witness.share.toRow.get "workspace_id" →
      w' = w :=
  share_has_exactly_one_workspace _ (core_of Witness.state_is_consistent) (by simp [Witness.state, Witness.stateWith])

example : ∃ p ∈ Witness.state .workspacePrincipals,
    p.get "workspace_id" = Witness.share.toRow.get "workspace_id" ∧
    p.get "id" = Witness.share.toRow.get "publisher_principal_id" ∧
    ∀ p' ∈ Witness.state .workspacePrincipals,
      p'.get "id" = Witness.share.toRow.get "publisher_principal_id" → p' = p :=
  share_has_exactly_one_publisher _ (core_of Witness.state_is_consistent)
    (by simp [Witness.state, Witness.stateWith])

example : ∃ s ∈ Witness.state .shares, s.get "id" = Witness.view.toRow.get "share_id" ∧
    s.get "workspace_id" = Witness.view.toRow.get "workspace_id" ∧
    ∀ s' ∈ Witness.state .shares, s'.get "id" = Witness.view.toRow.get "share_id" → s' = s :=
  view_has_exactly_one_share _ (core_of Witness.state_is_consistent)
    (by simp [Witness.state, Witness.stateWith])

example : ∃ s ∈ Witness.state .shares, s.get "id" = Witness.charge.toRow.get "share_id" ∧
    s.get "workspace_id" = Witness.charge.toRow.get "workspace_id" ∧
    ∀ s' ∈ Witness.state .shares, s'.get "id" = Witness.charge.toRow.get "share_id" → s' = s :=
  charge_has_exactly_one_share _ (core_of Witness.state_is_consistent)
    (by simp [Witness.state, Witness.stateWith])

example : ∃ u ∈ Witness.state .runs, u.get "id" = Witness.charge.toRow.get "run_id" ∧
    u.get "workspace_id" = Witness.charge.toRow.get "workspace_id" ∧
    ∀ u' ∈ Witness.state .runs, u'.get "id" = Witness.charge.toRow.get "run_id" → u' = u :=
  charge_has_exactly_one_run _ (core_of Witness.state_is_consistent)
    (by simp [Witness.state, Witness.stateWith])

example : Witness.charge.toRow = Witness.charge.toRow ∧
    Witness.charge.toRow.get "share_id" = Witness.charge.toRow.get "share_id" :=
  run_is_funded_by_at_most_one_share _ (core_of Witness.state_is_consistent)
    (by simp [Witness.state, Witness.stateWith]) (by simp [Witness.state, Witness.stateWith]) rfl

example : Witness.share.toRow = Witness.share.toRow ∧
    Witness.share.toRow.get "workspace_id" = Witness.share.toRow.get "workspace_id" :=
  token_names_at_most_one_share _ (core_of Witness.state_is_consistent)
    (by simp [Witness.state, Witness.stateWith]) (by simp [Witness.state, Witness.stateWith]) rfl

example : ∃ m ∈ Witness.state .memberships,
    m.get "workspace_id" = Witness.share.toRow.get "workspace_id" ∧ m.get "user_id" = some "u1" :=
  share_creator_is_a_member _ (core_of Witness.state_is_consistent)
    (by simp [Witness.state, Witness.stateWith]) (by decide)

example : ∃ ty : SubjectType, Witness.share.toRow.get "subject_type" = some ty.toWire :=
  share_subject_type_decodes _ (core_of Witness.state_is_consistent)
    (by simp [Witness.state, Witness.stateWith])

example : ∃ v : Visibility, Witness.share.toRow.get "visibility" = some v.toWire :=
  share_visibility_decodes _ (core_of Witness.state_is_consistent)
    (by simp [Witness.state, Witness.stateWith])

example : Witness.share.toRow.get "mode" = none ∨
    ∃ m : Mode, Witness.share.toRow.get "mode" = some m.toWire :=
  share_mode_decodes _ (core_of Witness.state_is_consistent)
    (by simp [Witness.state, Witness.stateWith])

example : Witness.share.toRow.get "subject_type" = some "agent" :=
  share_with_mode_is_an_agent_share _ Witness.state_is_consistent
    (by simp [Witness.state, Witness.stateWith]) (by decide)

example : (Witness.share.toRow.get "spent_usd").all nonNegativeAmount = true ∧
    (Witness.share.toRow.get "budget_cap_usd").all nonNegativeAmount = true :=
  share_amounts_are_non_negative _ Witness.state_is_consistent
    (by simp [Witness.state, Witness.stateWith])

example : ∃ sid, Witness.share.toRow.get "subject_id" = some sid ∧ notBlankSql sid :=
  share_subject_id_is_not_blank _ Witness.state_is_consistent
    (by simp [Witness.state, Witness.stateWith])

example : (Witness.charge.toRow.get "charged_usd").all nonNegativeAmount = true :=
  charge_is_non_negative _ Witness.state_is_consistent
    (by simp [Witness.state, Witness.stateWith])

/-- The paired references of the witness state, each satisfying its isolation theorem. -/
example : tenantOf catalogue .shares Witness.share.toRow =
    tenantOf catalogue .workspacePrincipals
      ⟨[("id", "p1"), ("workspace_id", "w1"), ("kind", "membership"), ("membership_id", "m1"),
        ("activated_at", "0"), ("created_at", "0")]⟩ :=
  share_and_publisher_share_a_workspace Witness.state (by unfold References; decide +kernel)

example : tenantOf catalogue .shares Witness.share.toRow =
    tenantOf catalogue .memberships
      ⟨[("id", "m1"), ("workspace_id", "w1"), ("user_id", "u1"), ("role", "owner"),
        ("created_at", "0"), ("updated_at", "0")]⟩ :=
  share_and_creator_membership_share_a_workspace Witness.state (by unfold References; decide +kernel)

example : tenantOf catalogue .shareViews Witness.view.toRow =
    tenantOf catalogue .shares Witness.share.toRow :=
  view_and_share_share_a_workspace Witness.state (by unfold References; decide +kernel)

example : tenantOf catalogue .shareRunCharges Witness.charge.toRow =
    tenantOf catalogue .shares Witness.share.toRow :=
  charge_and_share_share_a_workspace Witness.state (by unfold References; decide +kernel)

example : tenantOf catalogue .shares Witness.share.toRow =
    tenantOf catalogue .runs (Witness.state .runs).head! :=
  charge_funds_runs_of_its_share's_workspace Witness.state (c := Witness.charge.toRow)
    (by unfold References; decide +kernel) (by unfold References; decide +kernel)

example : Witness.share.publiclyOpen 100 = false :=
  closed_link_stays_closed Witness.share (t1 := 100) (Nat.le_refl _) (by decide)

example : Witness.share.stateAt 150 = .expired :=
  expired_state_is_permanent Witness.share (t1 := 100) (by decide) (by decide)

example : Witness.share.publiclyOpen 99 = true := by decide

end AgentWorkspace.Theorems.Invariants.ConceptPublication
