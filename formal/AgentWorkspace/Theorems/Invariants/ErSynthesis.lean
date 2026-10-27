import AgentWorkspace.Er.Refinement
import AgentWorkspace.Theorems.Invariants.ErCore

/-!
T2 — tenancy and ownership as invariants of the whole schema, today and in the target.

The five concept clusters each proved isolation for their own keys. Here it is stated once for the
whole database (`Er.Current.consistent`, the conjunction of every cluster's view):

* no reference, and no chain of references, between tenant-carrying rows crosses a workspace, in
  every consistent state and so in every state reachable by committed transactions; a transaction
  that would leave one is rolled back;
* every composite foreign key of the schema is tenant-paired, so a composite reference stays in
  its workspace in **any** state, consistent or not;
* every tenant-owned row has exactly one owning workspace, and every row the schema gives an owner
  column has exactly one owning principal, which lives in the row's own workspace;
* the two checks two clusters both refine mean the same thing in both.

The same isolation holds for the target schema, where it also covers what today's schema leaves to
the service: a share's subject and a grant's principal live in the row's own workspace.
-/

namespace AgentWorkspace.Theorems.Invariants.ErSynthesis

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Er
open AgentWorkspace.Theorems.Invariants.ErCore (no_cross_tenant_reference
  paired_reference_preserves_tenant tenant_path_preserves_tenant)

/-! ## Generic helpers over any schema -/

private theorem core_of_current {st : State} (h : Current.consistent st = true) :
    Er.Core.consistent catalogue st = true := by
  simp only [Current.consistent, Current.Identity.consistent, Bool.and_eq_true] at h
  exact h.1.1.1.1.1

private theorem core_of_target {st : State} (h : Target.consistent st = true) :
    Er.Core.consistent Target.schema st = true := by
  simp only [Target.consistent, Bool.and_eq_true] at h
  exact h.1.1.1

private theorem table_ok {S : Schema} {st : State} (hc : Er.Core.consistent S st = true)
    (t : TableName) : tableConsistent S st t = true :=
  List.all_eq_true.mp hc t (WireEnum.complete t)

private theorem fk_parent {S : Schema} {st : State} (hc : Er.Core.consistent S st = true)
    {t : TableName} {fk : ForeignKey} (hfk : fk ∈ (S t).foreignKeys) {r : Row} (hr : r ∈ st t)
    (hp : r.present fk.columns = true) :
    ∃ r' ∈ st fk.refTable, r'.project fk.refColumns = r.project fk.columns := by
  have h := table_ok hc t
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  have := List.all_eq_true.mp (h.1.2 fk hfk) r hr
  simp only [hp, Bool.not_true, Bool.false_or, List.any_eq_true, beq_iff_eq] at this
  exact this

private theorem not_null_get {S : Schema} {st : State} (hc : Er.Core.consistent S st = true)
    {t : TableName} {c : String} (hnn : (S t).isNotNull c = true) {r : Row} (hr : r ∈ st t) :
    (r.get c).isSome = true := by
  have h := table_ok hc t
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  obtain ⟨col, hcol, hc'⟩ := List.any_eq_true.mp hnn
  simp only [Bool.and_eq_true, beq_iff_eq] at hc'
  have := h.1.1.1.1 col hcol
  simp only [notNullHolds, hc'.2, Bool.not_true, Bool.false_or, List.all_eq_true] at this
  rw [← hc'.1]
  exact this r hr

/-- Two rows of a table keyed by `id` with the same non-`NULL` `id` are the same row. -/
private theorem id_unique {S : Schema} {st : State} (hc : Er.Core.consistent S st = true)
    {t : TableName} (hpk : (S t).primaryKey = ["id"]) {r1 r2 : Row} (h1 : r1 ∈ st t)
    (h2 : r2 ∈ st t) (hs : (r1.get "id").isSome = true) (hv : r1.get "id" = r2.get "id") :
    r1 = r2 := by
  have h := table_ok hc t
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  have hkey := h.1.1.1.2
  rw [hpk] at hkey
  simp only [keyHolds, List.all_nil] at hkey
  rw [List.filter_eq_self.mpr (fun _ _ => rfl), List.all_eq_true] at hkey
  have := hkey r1 h1
  simp only [Row.present, List.all_cons, List.all_nil, Bool.and_true, hs, Bool.not_true,
    Bool.false_or, List.all_eq_true] at this
  have := this r2 h2
  simp only [Row.project, List.map_cons, List.map_nil, hv, bne_self_eq_false, Bool.false_or,
    beq_iff_eq] at this
  exact this

private theorem get_of_project {r r' : Row} {c c' : String} {cs cs' : List String}
    (h : r'.project (c' :: cs') = r.project (c :: cs)) : r'.get c' = r.get c := by
  simp only [Row.project, List.map_cons, List.cons.injEq] at h
  exact h.1

private theorem get_of_project₂ {r r' : Row} {a b a' b' : String}
    (h : r'.project [a', b'] = r.project [a, b]) : r'.get b' = r.get b := by
  simp only [Row.project, List.map_cons, List.map_nil, List.cons.injEq] at h
  exact h.2.1

private theorem present₂ {r : Row} {a b : String} (ha : (r.get a).isSome = true)
    (hb : (r.get b).isSome = true) : r.present [a, b] = true := by
  simp [Row.present, ha, hb]

/-- Under any schema: a key `(c, workspace_id) → t (id, workspace_id)` or
`(workspace_id, c) → t (workspace_id, id)` of a table keyed by `id` pins, for a row whose `c` is
set, exactly one parent row with that `id`, and it is in the row's workspace. -/
private theorem paired_id_parent {S : Schema} {st : State} (hc : Er.Core.consistent S st = true)
    {t : TableName} {fk : ForeignKey} (hfk : fk ∈ (S t).foreignKeys) {c : String}
    (hshape : (fk.columns = [c, "workspace_id"] ∧ fk.refColumns = ["id", "workspace_id"]) ∨
      (fk.columns = ["workspace_id", c] ∧ fk.refColumns = ["workspace_id", "id"]))
    (hpk : (S fk.refTable).primaryKey = ["id"]) (hws : (S t).isNotNull "workspace_id" = true)
    {r : Row} (hr : r ∈ st t) (hcs : (r.get c).isSome = true) :
    ∃ p ∈ st fk.refTable, p.get "id" = r.get c ∧ p.get "workspace_id" = r.get "workspace_id" ∧
      ∀ p' ∈ st fk.refTable, p'.get "id" = r.get c → p' = p := by
  have hw := not_null_get hc hws hr
  rcases hshape with ⟨hcols, hrefs⟩ | ⟨hcols, hrefs⟩
  · obtain ⟨p, hp, he⟩ := fk_parent hc hfk hr (by rw [hcols]; exact present₂ hcs hw)
    rw [hcols, hrefs] at he
    have hid : p.get "id" = r.get c := get_of_project he
    refine ⟨p, hp, hid, get_of_project₂ he, fun p' hp' hid' => ?_⟩
    exact id_unique hc hpk hp' hp (by rw [hid']; exact hcs) (hid'.trans hid.symm)
  · obtain ⟨p, hp, he⟩ := fk_parent hc hfk hr (by rw [hcols]; exact present₂ hw hcs)
    rw [hcols, hrefs] at he
    have hid : p.get "id" = r.get c := get_of_project₂ he
    refine ⟨p, hp, hid, get_of_project he, fun p' hp' hid' => ?_⟩
    exact id_unique hc hpk hp' hp (by rw [hid']; exact hcs) (hid'.trans hid.symm)

private theorem mem_of_any {l : List ForeignKey} {p : ForeignKey → Bool} (h : l.any p = true) :
    ∃ fk ∈ l, p fk = true := List.any_eq_true.mp h

/-! ## Today's schema -/

/-- Every composite foreign key of today's schema pairs the child's tenant column with the
parent's, so the database itself compares the two workspaces as part of the key. -/
@[aw_spec (tier := T2)
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")]
theorem every_composite_key_is_tenant_paired (t : TableName) (fk : ForeignKey)
    (hfk : fk ∈ (catalogue t).foreignKeys) (hlen : 2 ≤ fk.columns.length) :
    isPaired catalogue t fk = true := by
  have h : (allTables.all fun t => (catalogue t).foreignKeys.all fun fk =>
      decide (fk.columns.length < 2) || isPaired catalogue t fk) = true := by decide +kernel
  have := List.all_eq_true.mp (List.all_eq_true.mp h t (WireEnum.complete t)) fk hfk
  simpa [Nat.not_lt.mpr hlen] using this

/-- In any state of today's database, consistent or not, a reference through a composite foreign
key joins two rows of the same workspace. -/
@[aw_spec (tier := T2)
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")]
theorem composite_reference_stays_in_workspace (st : State) {t : TableName} {fk : ForeignKey}
    {r r' : Row} (href : References catalogue st t fk r r') (hlen : 2 ≤ fk.columns.length) :
    tenantOf catalogue t r = tenantOf catalogue fk.refTable r' :=
  paired_reference_preserves_tenant catalogue st
    (every_composite_key_is_tenant_paired t fk href.1 hlen) href

/-- In every consistent state of today's whole schema, no foreign-key reference joins a row of one
workspace to a tenant-carrying row of another. -/
@[aw_spec (tier := T2) (doc := "docs/architecture.md#runtime-and-trust-boundaries")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")]
theorem no_cross_workspace_reference (st : State) (hc : Current.consistent st = true)
    {t : TableName} {fk : ForeignKey} {r r' : Row}
    (htarget : (catalogue fk.refTable).tenantColumn?.isSome = true)
    (href : References catalogue st t fk r r') :
    tenantOf catalogue t r = tenantOf catalogue fk.refTable r' :=
  no_cross_tenant_reference catalogue (by decide +kernel) st (core_of_current hc) htarget href

/-- In every consistent state of today's whole schema, every row reached from a row by a chain of
references through tenant-carrying tables belongs to the starting row's workspace. -/
@[aw_spec (tier := T2) (doc := "docs/architecture.md#runtime-and-trust-boundaries")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")]
theorem reference_chain_stays_in_workspace (st : State) (hc : Current.consistent st = true)
    {t t' : TableName} {r r' : Row} (hpath : TenantPath catalogue st t r t' r') :
    tenantOf catalogue t r = tenantOf catalogue t' r' :=
  tenant_path_preserves_tenant catalogue (by decide +kernel) st (core_of_current hc) hpath

/-- Every state a database with constraint set `P` reaches from empty, by any sequence of
committed transactions, satisfies `P`, provided the empty database does. -/
@[aw_spec (tier := T2) (doc := "docs/formal/00-orchestrator-prompt.md#61-tiers")]
theorem reachable_state_satisfies_constraints (P : State → Bool) (hP : P State.empty = true)
    {st : State} (h : Current.Reachable P st) : P st = true := by
  induction h with
  | empty => exact hP
  | commit tx _ ih =>
    unfold Current.commit
    split
    · assumption
    · exact ih

/-- The empty database satisfies every constraint of today's whole schema. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/index.ts")
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")]
theorem empty_database_is_consistent : Current.consistent State.empty = true := by decide +kernel

/-- No sequence of committed transactions, whatever rows any writer sends, reaches a state of
today's database with a reference from one workspace to a tenant-carrying row of another. -/
@[aw_spec (tier := T2) (doc := "docs/architecture.md#runtime-and-trust-boundaries")
  (doc := "docs/formal/00-orchestrator-prompt.md#61-tiers")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")]
theorem reachable_state_has_no_cross_workspace_reference {st : State}
    (h : Current.Reachable Current.consistent st) {t : TableName} {fk : ForeignKey} {r r' : Row}
    (htarget : (catalogue fk.refTable).tenantColumn?.isSome = true)
    (href : References catalogue st t fk r r') :
    tenantOf catalogue t r = tenantOf catalogue fk.refTable r' :=
  no_cross_workspace_reference st
    (reachable_state_satisfies_constraints _ empty_database_is_consistent h) htarget href

/-- A transaction whose writes would leave a reference from one workspace to a tenant-carrying
row of another is rolled back: the database stays in the state before it. -/
@[aw_spec (tier := T2) (doc := "docs/architecture.md#runtime-and-trust-boundaries")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")]
theorem cross_workspace_write_is_rolled_back (st : State) (tx : List Current.Stmt)
    {t : TableName} {fk : ForeignKey} {r r' : Row}
    (htarget : (catalogue fk.refTable).tenantColumn?.isSome = true)
    (href : References catalogue (Current.run tx st) t fk r r')
    (hcross : tenantOf catalogue t r ≠ tenantOf catalogue fk.refTable r') :
    Current.commit Current.consistent st tx = st := by
  unfold Current.commit
  split
  · rename_i hc
    exact absurd (no_cross_workspace_reference _ hc htarget href) hcross
  · rfl

/-- In every consistent state of today's database, every row of a tenant-scoped table has exactly
one owning workspace: one `workspaces` row whose `id` is the row's `workspace_id`. -/
@[aw_spec (tier := T2)
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#workspace-and-principal")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#TENANT_COLUMN")]
theorem tenant_row_has_exactly_one_workspace (st : State) (hc : Current.consistent st = true)
    {t : TableName} (hscoped : (catalogue t).tenancy = .scoped) {r : Row} (hr : r ∈ st t) :
    ∃ w ∈ st .workspaces, w.get "id" = r.get "workspace_id" ∧ (w.get "id").isSome = true ∧
      ∀ w' ∈ st .workspaces, w'.get "id" = r.get "workspace_id" → w' = w := by
  have hcore := core_of_current hc
  have hfacts : (allTables.all fun t => (catalogue t).tenancy != .scoped ||
      ((catalogue t).isNotNull "workspace_id" && (catalogue t).foreignKeys.any Current.isRootKey)) =
      true := by decide +kernel
  have := List.all_eq_true.mp hfacts t (WireEnum.complete t)
  simp only [hscoped, bne_self_eq_false, Bool.false_or, Bool.and_eq_true] at this
  obtain ⟨hnn, hany⟩ := this
  obtain ⟨fk, hfk, hroot⟩ := mem_of_any hany
  simp only [Current.isRootKey, Bool.and_eq_true, beq_iff_eq] at hroot
  obtain ⟨⟨hcols, hto⟩, hrefs⟩ := hroot
  have hw := not_null_get hcore hnn hr
  obtain ⟨w, hwm, he⟩ := fk_parent hcore hfk hr (by rw [hcols]; simp [Row.present, hw])
  rw [hto] at hwm
  rw [hcols, hrefs] at he
  have hid : w.get "id" = r.get "workspace_id" := get_of_project he
  refine ⟨w, hwm, hid, by rw [hid]; exact hw, fun w' hw' hid' => ?_⟩
  exact id_unique hcore (S := catalogue) (t := .workspaces) rfl hw' hwm
    (by rw [hid']; exact hw) (hid'.trans hid.symm)

/-- In every consistent state of today's database, a row whose owner column is set names exactly
one principal, and that principal belongs to the row's own workspace. -/
@[aw_spec (tier := T2) (doc := "docs/sdk/04-api-specification.md#2-resource-model")
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#workspace-and-principal")
  (ts := "packages/core/src/db/schema/agents.ts#agents_owner_principal_workspace_fk")]
theorem owner_reference_names_exactly_one_principal (st : State)
    (hc : Current.consistent st = true) {t : TableName} {c : String}
    (hown : Current.ownerColumn? t = some c) {r : Row} (hr : r ∈ st t)
    (hset : (r.get c).isSome = true) :
    ∃ p ∈ st .workspacePrincipals, p.get "id" = r.get c ∧
      p.get "workspace_id" = r.get "workspace_id" ∧
      ∀ p' ∈ st .workspacePrincipals, p'.get "id" = r.get c → p' = p := by
  have hcore := core_of_current hc
  have hfacts : (allTables.all fun t => match Current.ownerColumn? t with
      | none => true
      | some c => (catalogue t).isNotNull "workspace_id" &&
          (catalogue t).foreignKeys.any (Current.isOwnerKey c)) = true := by decide +kernel
  have := List.all_eq_true.mp hfacts t (WireEnum.complete t)
  simp only [hown, Bool.and_eq_true] at this
  obtain ⟨hnn, hany⟩ := this
  obtain ⟨fk, hfk, hkey⟩ := mem_of_any hany
  simp only [Current.isOwnerKey, Bool.and_eq_true, beq_iff_eq] at hkey
  obtain ⟨⟨hcols, hto⟩, hrefs⟩ := hkey
  have := paired_id_parent hcore hfk (Or.inr ⟨hcols, hrefs⟩) (by rw [hto]; rfl) hnn hr hset
  rw [hto] at this
  exact this

/-- The owner column is `NOT NULL` on every table that has one except `audit_events`, whose actor
may be a deleted principal or none. -/
@[aw_spec (tier := T2) (doc := "docs/sdk/04-api-specification.md#2-resource-model")
  (ts := "packages/core/src/db/schema/audit-events.ts#auditEvents")]
theorem owner_is_mandatory_except_for_audit_actors (t : TableName) (c : String)
    (hown : Current.ownerColumn? t = some c) :
    (catalogue t).isNotNull c = (t != .auditEvents) := by
  cases t <;> simp only [Current.ownerColumn?, reduceCtorEq, Option.some.injEq] at hown <;>
    subst hown <;> decide +kernel

/-- In every consistent state of today's database, every row of a table whose owner column is
`NOT NULL` has exactly one owning principal, in its own workspace. -/
@[aw_spec (tier := T2) (doc := "docs/sdk/04-api-specification.md#2-resource-model")
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#workspace-and-principal")
  (ts := "packages/core/src/db/schema/agents.ts#agents_owner_principal_workspace_fk")]
theorem owned_row_has_exactly_one_owner (st : State) (hc : Current.consistent st = true)
    {t : TableName} {c : String} (hown : Current.ownerColumn? t = some c)
    (hnotaudit : t ≠ .auditEvents) {r : Row} (hr : r ∈ st t) :
    ∃ p ∈ st .workspacePrincipals, p.get "id" = r.get c ∧
      p.get "workspace_id" = r.get "workspace_id" ∧
      ∀ p' ∈ st .workspacePrincipals, p'.get "id" = r.get c → p' = p := by
  have hnn := owner_is_mandatory_except_for_audit_actors t c hown
  have hnn' : (catalogue t).isNotNull c = true := by rw [hnn]; simpa using hnotaudit
  exact owner_reference_names_exactly_one_principal st hc hown hr
    (not_null_get (core_of_current hc) hnn' hr)

/-- The two checks two clusters both give a meaning to, `workspaces_default_model_pair` (identity
and configuration) and `projects_default_model_pair` (work and configuration), mean the same on
every row in both clusters. -/
@[aw_spec (tier := T2) (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")
  (ts := "packages/core/src/db/schema/workspaces.ts#workspaces")
  (ts := "packages/core/src/db/schema/projects.ts#projects")]
theorem shared_checks_agree (r : Row) :
    ((Current.Identity.semantics? "workspaces_default_model_pair").all (·.holds r) =
        Current.Configuration.configCheckHolds "workspaces_default_model_pair" r) ∧
      Current.Work.workCheckHolds "projects_default_model_pair" r =
        Current.Configuration.configCheckHolds "projects_default_model_pair" r := by
  constructor
  · have hs : Current.Identity.semantics? "workspaces_default_model_pair" =
        some (.nullIff "default_model_connection_id" "default_model") := by decide +kernel
    rw [hs]
    simp only [Option.all_some, Current.Identity.CheckExpr.holds, Current.Identity.CheckExpr.eval,
      Current.Configuration.configCheckHolds, Current.Configuration.pairHolds]
    generalize ((r.get "default_model_connection_id").isNone == (r.get "default_model").isNone) = b
    cases b <;> rfl
  · simp only [Current.Work.workCheckHolds, Current.Work.workCheck,
      Current.Configuration.configCheckHolds, Current.Configuration.pairHolds]
    simp

/-! ## The target schema -/

/-- In every consistent state of the target schema, no foreign-key reference joins a row of one
workspace to a tenant-carrying row of another. -/
@[aw_spec (tier := T2) (doc := "docs/formal/concepts.md#the-target-er-model")
  (doc := "docs/architecture.md#runtime-and-trust-boundaries")]
theorem target_has_no_cross_workspace_reference (st : State) (hc : Target.consistent st = true)
    {t : TableName} {fk : ForeignKey} {r r' : Row}
    (htarget : (Target.schema fk.refTable).tenantColumn?.isSome = true)
    (href : References Target.schema st t fk r r') :
    tenantOf Target.schema t r = tenantOf Target.schema fk.refTable r' :=
  no_cross_tenant_reference Target.schema (by decide +kernel) st (core_of_target hc) htarget href

/-- In every consistent state of the target, a share's subject column names exactly one row of its
subject type's table, and that row is in the share's own workspace: a share can no longer name a
missing subject or another workspace's. -/
@[aw_spec (tier := T2)
  (doc := "docs/sdk/site/concepts/ownership-and-sharing.mdx#beyond-one-workspace")
  (ts := "apps/web/server/composition/wiring/projects.ts#subjectOwnership")]
theorem target_share_subject_stays_in_workspace (st : State) (hc : Target.consistent st = true)
    (ty : Concepts.Share.SubjectType) {r : Row} (hr : r ∈ st .shares)
    (hset : (r.get (Target.subjectColumn ty)).isSome = true) :
    ∃ s ∈ st ty.table, s.get "id" = r.get (Target.subjectColumn ty) ∧
      s.get "workspace_id" = r.get "workspace_id" ∧
      ∀ s' ∈ st ty.table, s'.get "id" = r.get (Target.subjectColumn ty) → s' = s := by
  have hcore := core_of_target hc
  have hfacts : ((WireEnum.all : List Concepts.Share.SubjectType).all fun ty =>
      (Target.schema .shares).isNotNull "workspace_id" &&
        (Target.schema .shares).foreignKeys.any fun fk =>
          fk.columns == [Target.subjectColumn ty, "workspace_id"] && fk.refTable == ty.table &&
            fk.refColumns == ["id", "workspace_id"] &&
            (Target.schema ty.table).primaryKey == ["id"]) = true := by decide +kernel
  have := List.all_eq_true.mp hfacts ty (WireEnum.complete ty)
  simp only [Bool.and_eq_true] at this
  obtain ⟨hnn, hany⟩ := this
  obtain ⟨fk, hfk, hkey⟩ := mem_of_any hany
  simp only [Bool.and_eq_true, beq_iff_eq] at hkey
  obtain ⟨⟨⟨hcols, hto⟩, hrefs⟩, hpk⟩ := hkey
  have := paired_id_parent hcore hfk (Or.inl ⟨hcols, hrefs⟩) (by rw [hto]; exact hpk) hnn hr hset
  rw [hto] at this
  exact this

/-- In every consistent state of the target, a grant names exactly one principal, and it is a
principal of the grant's own workspace. -/
@[aw_spec (tier := T2) (doc := "docs/sdk/site/concepts/ownership-and-sharing.mdx#catalog-assignment-grant")
  (ts := "packages/core/src/db/schema/agent-grants.ts#agentGrants")]
theorem target_grant_names_one_principal_of_its_workspace (st : State)
    (hc : Target.consistent st = true) {r : Row} (hr : r ∈ st .agentGrants) :
    ∃ p ∈ st .workspacePrincipals, p.get "id" = r.get "principal_id" ∧
      p.get "workspace_id" = r.get "workspace_id" ∧
      ∀ p' ∈ st .workspacePrincipals, p'.get "id" = r.get "principal_id" → p' = p := by
  have hcore := core_of_target hc
  have hfk : Target.grantPrincipalKey ∈ (Target.schema .agentGrants).foreignKeys := by decide +kernel
  have := paired_id_parent hcore hfk (c := "principal_id") (Or.inr ⟨rfl, rfl⟩) (by decide +kernel)
    (by decide +kernel) hr (not_null_get hcore (by decide +kernel) hr)
  exact this

/-! ## Witnesses -/

/-- Today's witness state is consistent under every cluster's view. -/
private theorem witness_consistent : Current.consistent Current.Witness.state = true := by
  decide +kernel

private theorem load_runs_to_witness : Current.run Current.Witness.load State.empty =
    Current.Witness.state := by
  funext t
  cases t <;> decide +kernel

/-- The witness state is reachable: loading it in one transaction commits. -/
private theorem witness_reachable :
    Current.Reachable Current.consistent Current.Witness.state := by
  have h := Current.Reachable.commit (P := Current.consistent) Current.Witness.load .empty
  unfold Current.commit at h
  rw [load_runs_to_witness] at h
  simpa [witness_consistent] using h

private theorem target_witness_consistent :
    Target.consistent (Refinement.toTarget Current.Witness.state) = true := by
  decide +kernel

/-- The agent `a1` references its owner `p1` through a composite key of the witness state. -/
example : tenantOf catalogue .agents Current.Witness.agent =
    tenantOf catalogue .workspacePrincipals (Current.Witness.memberPrincipal "p1" "w1" "m1") :=
  composite_reference_stays_in_workspace Current.Witness.state
    (fk := Target.principalKey "agents_owner_principal_workspace_fk" "owner_principal_id" .noAction)
    (by unfold References; decide +kernel) (by decide +kernel)

example : tenantOf catalogue .agents Current.Witness.agent =
    tenantOf catalogue .workspacePrincipals (Current.Witness.memberPrincipal "p1" "w1" "m1") :=
  no_cross_workspace_reference Current.Witness.state witness_consistent
    (fk := Target.principalKey "agents_owner_principal_workspace_fk" "owner_principal_id" .noAction)
    rfl (by unfold References; decide +kernel)

example : tenantOf catalogue .agents Current.Witness.agent =
    tenantOf catalogue .workspacePrincipals (Current.Witness.memberPrincipal "p1" "w1" "m1") :=
  reachable_state_has_no_cross_workspace_reference witness_reachable
    (fk := Target.principalKey "agents_owner_principal_workspace_fk" "owner_principal_id" .noAction)
    rfl (by unfold References; decide +kernel)

example : TenantPath catalogue Current.Witness.state .agents Current.Witness.agent
    .workspacePrincipals (Current.Witness.memberPrincipal "p1" "w1" "m1") := by
  refine .step (Target.principalKey "agents_owner_principal_workspace_fk" "owner_principal_id"
    .noAction) (by unfold References; decide +kernel) rfl rfl (.refl _ _)

example : Current.Reachable Current.consistent Current.Witness.state := witness_reachable

/-- A forged transaction: an agent of `w2`, owned by `w2`'s principal, that names `w1`'s model
connection `c1`. A composite key cannot even express a reference across workspaces (the key
includes the workspace), so the forgery goes through the single-column `SET NULL` sibling
`agents.model_connection_id → model_connections.id`, which the tenant-paired sibling beside it
refuses. -/
private def forgedAgent : Row :=
  ⟨[("id", "a9"), ("workspace_id", "w2"), ("name", "Forged"), ("instructions", "x"),
    ("model_connection_id", "c1"), ("model", "claude-sonnet"), ("permissions", "{}"),
    ("owner_principal_id", "p4"), ("created_at", "1000"), ("updated_at", "1000")]⟩

/-- The single-column sibling key the forgery uses. -/
private def connectionKey : ForeignKey :=
  Target.siblingKey "agents_model_connection_id_model_connections_id_fk" "model_connection_id"
    .modelConnections

/-- The model connection `c1` of `w1`. -/
private def connection : Row :=
  ⟨[("id", "c1"), ("workspace_id", "w1"), ("name", "Claude"), ("provider", "anthropic"),
    ("config", "{}"), ("created_at", "1000"), ("updated_at", "1000")]⟩

/-- The forged write is rolled back. -/
example : Current.commit Current.consistent Current.Witness.state
    [.insert .agents forgedAgent] = Current.Witness.state := by
  have h : Current.consistent (Current.run [.insert .agents forgedAgent] Current.Witness.state) =
      false := by decide +kernel
  unfold Current.commit
  simp [h]

/-- The forged write satisfies the hypotheses of the rollback theorem: after it, the forged agent
of `w2` references `w1`'s model connection through the sibling key. -/
example : Current.commit Current.consistent Current.Witness.state
    [.insert .agents forgedAgent] = Current.Witness.state :=
  cross_workspace_write_is_rolled_back Current.Witness.state [.insert .agents forgedAgent]
    (t := .agents) (r := forgedAgent) (r' := connection) (fk := connectionKey)
    rfl (by unfold References; decide +kernel) (by decide +kernel)

/-- A one-hop chain from the agent to its owner principal stays in the workspace. -/
example : tenantOf catalogue .agents Current.Witness.agent =
    tenantOf catalogue .workspacePrincipals (Current.Witness.memberPrincipal "p1" "w1" "m1") :=
  reference_chain_stays_in_workspace Current.Witness.state witness_consistent
    (.step (Target.principalKey "agents_owner_principal_workspace_fk" "owner_principal_id"
      .noAction) (by unfold References; decide +kernel) rfl rfl (.refl _ _))

example : ∃ w ∈ Current.Witness.state .workspaces, w.get "id" = Current.Witness.agent.get "workspace_id" ∧
    (w.get "id").isSome = true ∧ ∀ w' ∈ Current.Witness.state .workspaces,
      w'.get "id" = Current.Witness.agent.get "workspace_id" → w' = w :=
  tenant_row_has_exactly_one_workspace _ witness_consistent (t := .agents) rfl
    (by simp [Current.Witness.state])

example : ∃ p ∈ Current.Witness.state .workspacePrincipals,
    p.get "id" = Current.Witness.share.get "publisher_principal_id" ∧
    p.get "workspace_id" = Current.Witness.share.get "workspace_id" ∧
    ∀ p' ∈ Current.Witness.state .workspacePrincipals,
      p'.get "id" = Current.Witness.share.get "publisher_principal_id" → p' = p :=
  owned_row_has_exactly_one_owner _ witness_consistent (t := .shares) rfl (by decide +kernel)
    (by simp [Current.Witness.state])

/-- The audit event's actor is set in the witness, so the nullable case is exercised too. -/
example : ∃ p ∈ Current.Witness.state .workspacePrincipals, p.get "id" = some "p1" ∧
    p.get "workspace_id" = some "w1" ∧
    ∀ p' ∈ Current.Witness.state .workspacePrincipals, p'.get "id" = some "p1" → p' = p := by
  have hr : Current.Witness.row [("id", "ae1"), ("workspace_id", "w1"), ("actor_user_id", "u1"),
       ("actor_principal_id", "p1"), ("actor_label", "Ada"), ("action", "agent-changed"),
       ("subject_label", "General"), ("created_at", "1000")] ∈
      Current.Witness.state .auditEvents := by simp [Current.Witness.state]
  exact owner_reference_names_exactly_one_principal _ witness_consistent (t := .auditEvents)
    rfl hr (by decide +kernel)

example : tenantOf Target.schema .agentGrants
      (Refinement.mapRow Current.Witness.state .agentGrants Current.Witness.grant) =
    tenantOf Target.schema .workspacePrincipals (Current.Witness.memberPrincipal "p2" "w1" "m2") :=
  target_has_no_cross_workspace_reference _ target_witness_consistent
    (fk := Target.grantPrincipalKey) rfl (by unfold References; decide +kernel)

example : ∃ s ∈ Refinement.toTarget Current.Witness.state Concepts.Share.SubjectType.agent.table,
    s.get "id" = (Refinement.mapRow Current.Witness.state .shares Current.Witness.share).get
      (Target.subjectColumn .agent) ∧
    s.get "workspace_id" =
      (Refinement.mapRow Current.Witness.state .shares Current.Witness.share).get "workspace_id" ∧
    ∀ s' ∈ Refinement.toTarget Current.Witness.state Concepts.Share.SubjectType.agent.table,
      s'.get "id" = (Refinement.mapRow Current.Witness.state .shares Current.Witness.share).get
        (Target.subjectColumn .agent) → s' = s :=
  target_share_subject_stays_in_workspace _ target_witness_consistent .agent
    (by simp [Refinement.toTarget, Current.Witness.state]) (by decide +kernel)

example : ∃ p ∈ Refinement.toTarget Current.Witness.state .workspacePrincipals,
    p.get "id" = (Refinement.mapRow Current.Witness.state .agentGrants Current.Witness.grant).get
      "principal_id" ∧
    p.get "workspace_id" =
      (Refinement.mapRow Current.Witness.state .agentGrants Current.Witness.grant).get
        "workspace_id" ∧
    ∀ p' ∈ Refinement.toTarget Current.Witness.state .workspacePrincipals,
      p'.get "id" = (Refinement.mapRow Current.Witness.state .agentGrants
        Current.Witness.grant).get "principal_id" → p' = p :=
  target_grant_names_one_principal_of_its_workspace _ target_witness_consistent
    (by simp [Refinement.toTarget, Current.Witness.state])

/-! ## Every cluster's checks are part of whole-schema consistency -/

/-- For each of the five clusters there is a state that satisfies every constraint of the bare
catalogue yet is inconsistent for the whole schema, because it breaks exactly one check that only
that cluster gives a meaning to. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/index.ts")
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")]
theorem every_cluster_check_is_enforced :
    Refinement.Refusals.cells.map (·.1) = (WireEnum.all : List Current.Cluster) ∧
      (Refinement.Refusals.cells.all fun (c, st, t, n) =>
        Er.Core.consistent catalogue st && !Current.consistent st &&
          Refinement.currentViolations st == [n] && Current.refinedBy t n == [c]) = true := by
  decide +kernel

/-! ## Reachable target states -/

/-- The empty database satisfies every constraint of the target. -/
@[aw_spec (tier := T2) (doc := "docs/formal/concepts.md#the-target-er-model")]
theorem target_empty_database_is_consistent : Target.consistent State.empty = true := by
  decide +kernel

private theorem target_load_runs_to_base :
    Current.run Refinement.TargetCells.load State.empty = Refinement.TargetCells.base := by
  funext t
  cases t <;> decide +kernel

/-- The image of today's witness is reachable under the target's constraints: loading it into an
empty target database in one transaction commits. -/
@[aw_spec (tier := T2) (doc := "docs/formal/concepts.md#current-to-target-mapping")]
theorem target_witness_is_reachable :
    Current.Reachable Target.consistent (Refinement.toTarget Current.Witness.state) := by
  have h := Current.Reachable.commit (P := Target.consistent) Refinement.TargetCells.load .empty
  unfold Current.commit at h
  rw [target_load_runs_to_base] at h
  have hc : Target.consistent Refinement.TargetCells.base = true := target_witness_consistent
  rw [ite_eq_left_of_eq_true _ _ (eq_true hc)] at h
  exact h

/-- No sequence of committed transactions under the target's constraints reaches a state with a
reference from one workspace to a tenant-carrying row of another. -/
@[aw_spec (tier := T2) (doc := "docs/formal/concepts.md#the-target-er-model")
  (doc := "docs/architecture.md#runtime-and-trust-boundaries")]
theorem target_reachable_state_has_no_cross_workspace_reference {st : State}
    (h : Current.Reachable Target.consistent st) {t : TableName} {fk : ForeignKey} {r r' : Row}
    (htarget : (Target.schema fk.refTable).tenantColumn?.isSome = true)
    (href : References Target.schema st t fk r r') :
    tenantOf Target.schema t r = tenantOf Target.schema fk.refTable r' :=
  target_has_no_cross_workspace_reference st
    (reachable_state_satisfies_constraints _ target_empty_database_is_consistent h) htarget href

/-- In every state reachable under the target's constraints, a share's subject column names
exactly one row of its subject type's table, in the share's own workspace. -/
@[aw_spec (tier := T2)
  (doc := "docs/adr/FORMAL-P1-share-subject-is-a-typed-reference.md#decision")
  (ts := "apps/web/server/composition/wiring/projects.ts#subjectOwnership")]
theorem target_reachable_share_subject_stays_in_workspace {st : State}
    (h : Current.Reachable Target.consistent st) (ty : Concepts.Share.SubjectType) {r : Row}
    (hr : r ∈ st .shares) (hset : (r.get (Target.subjectColumn ty)).isSome = true) :
    ∃ s ∈ st ty.table, s.get "id" = r.get (Target.subjectColumn ty) ∧
      s.get "workspace_id" = r.get "workspace_id" ∧
      ∀ s' ∈ st ty.table, s'.get "id" = r.get (Target.subjectColumn ty) → s' = s :=
  target_share_subject_stays_in_workspace st
    (reachable_state_satisfies_constraints _ target_empty_database_is_consistent h) ty hr hset

/-- In every state reachable under the target's constraints, a grant names exactly one principal,
of the grant's own workspace. -/
@[aw_spec (tier := T2) (doc := "docs/adr/FORMAL-P1-grants-name-principals.md#decision")
  (ts := "packages/core/src/db/schema/agent-grants.ts#agentGrants")]
theorem target_reachable_grant_names_one_principal {st : State}
    (h : Current.Reachable Target.consistent st) {r : Row} (hr : r ∈ st .agentGrants) :
    ∃ p ∈ st .workspacePrincipals, p.get "id" = r.get "principal_id" ∧
      p.get "workspace_id" = r.get "workspace_id" ∧
      ∀ p' ∈ st .workspacePrincipals, p'.get "id" = r.get "principal_id" → p' = p :=
  target_grant_names_one_principal_of_its_workspace st
    (reachable_state_satisfies_constraints _ target_empty_database_is_consistent h) hr

example : tenantOf Target.schema .agentGrants
      (Refinement.mapRow Current.Witness.state .agentGrants Current.Witness.grant) =
    tenantOf Target.schema .workspacePrincipals (Current.Witness.memberPrincipal "p2" "w1" "m2") :=
  target_reachable_state_has_no_cross_workspace_reference target_witness_is_reachable
    (fk := Target.grantPrincipalKey) rfl (by unfold References; decide +kernel)

example : ∃ s ∈ Refinement.toTarget Current.Witness.state Concepts.Share.SubjectType.agent.table,
    s.get "id" = (Refinement.mapRow Current.Witness.state .shares Current.Witness.share).get
      (Target.subjectColumn .agent) ∧
    s.get "workspace_id" =
      (Refinement.mapRow Current.Witness.state .shares Current.Witness.share).get "workspace_id" ∧
    ∀ s' ∈ Refinement.toTarget Current.Witness.state Concepts.Share.SubjectType.agent.table,
      s'.get "id" = (Refinement.mapRow Current.Witness.state .shares Current.Witness.share).get
        (Target.subjectColumn .agent) → s' = s :=
  target_reachable_share_subject_stays_in_workspace target_witness_is_reachable .agent
    (by simp [Refinement.toTarget, Current.Witness.state]) (by decide +kernel)

example : ∃ p ∈ Refinement.toTarget Current.Witness.state .workspacePrincipals,
    p.get "id" = (Refinement.mapRow Current.Witness.state .agentGrants Current.Witness.grant).get
      "principal_id" ∧
    p.get "workspace_id" =
      (Refinement.mapRow Current.Witness.state .agentGrants Current.Witness.grant).get
        "workspace_id" ∧
    ∀ p' ∈ Refinement.toTarget Current.Witness.state .workspacePrincipals,
      p'.get "id" = (Refinement.mapRow Current.Witness.state .agentGrants
        Current.Witness.grant).get "principal_id" → p' = p :=
  target_reachable_grant_names_one_principal target_witness_is_reachable
    (by simp [Refinement.toTarget, Current.Witness.state])

end AgentWorkspace.Theorems.Invariants.ErSynthesis
