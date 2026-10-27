import AgentWorkspace.Er.Core

/-!
T2 — tenant isolation as a property of every state PostgreSQL can hold.

The lemmas are stated for an arbitrary `Schema`, so a concept cluster (or the target model) reuses
them for its own tables: a tenant-paired foreign key, or a single-column key covered by a
tenant-paired sibling, can only join two rows of one workspace, in any consistent state. For
today's `catalogue`, which is `pairingComplete`, no reference and no chain of references between
tenant-carrying rows ever crosses a workspace.
-/

namespace AgentWorkspace.Theorems.Invariants.ErCore

open AgentWorkspace AgentWorkspace.Er.Core

/-! ## Helpers -/

private theorem get_eq_of_mem_pairs {r r' : Row} :
    ∀ {cs rcs : List String} {c rc : String},
      (c, rc) ∈ cs.zip rcs → r'.project rcs = r.project cs → r'.get rc = r.get c
  | [], _, _, _, h, _ => by simp at h
  | _ :: _, [], _, _, h, _ => by simp at h
  | x :: xs, y :: ys, c, rc, h, hp => by
    simp only [Row.project, List.map_cons, List.cons.injEq] at hp
    simp only [List.zip_cons_cons, List.mem_cons, Prod.mk.injEq] at h
    rcases h with ⟨rfl, rfl⟩ | h
    · exact hp.1
    · exact get_eq_of_mem_pairs h hp.2

private theorem table_consistent {S : Schema} {st : State} (hc : consistent S st = true)
    (t : TableName) : tableConsistent S st t = true :=
  List.all_eq_true.mp hc t (WireEnum.complete t)

private theorem fk_holds {S : Schema} {st : State} (hc : consistent S st = true)
    {t : TableName} {fk : ForeignKey} (hfk : fk ∈ (S t).foreignKeys) : fkHolds st t fk = true := by
  have h := table_consistent hc t
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  exact h.1.2 fk hfk

private theorem fk_holds_elim {st : State} {t : TableName} {fk : ForeignKey} {r : Row}
    (h : fkHolds st t fk = true) (hr : r ∈ st t) (hp : r.present fk.columns = true) :
    ∃ r' ∈ st fk.refTable, r'.project fk.refColumns = r.project fk.columns := by
  have := List.all_eq_true.mp h r hr
  simpa [hp] using this

private theorem not_null_holds {S : Schema} {st : State} (hc : consistent S st = true)
    {t : TableName} {c : String} (hnn : (S t).isNotNull c = true) {r : Row} (hr : r ∈ st t) :
    (r.get c).isSome = true := by
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

private theorem single_key_unique {S : Schema} {st : State} (hc : consistent S st = true)
    {t : TableName} {k : String} (hk : (S t).isSingleKey k = true) {r1 r2 : Row}
    (h1 : r1 ∈ st t) (h2 : r2 ∈ st t) (hs : (r1.get k).isSome = true)
    (hv : r1.get k = r2.get k) : r1 = r2 := by
  have h := table_consistent hc t
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  simp only [TableSpec.isSingleKey, Bool.or_eq_true, beq_iff_eq, List.any_eq_true,
    Bool.and_eq_true, List.isEmpty_iff] at hk
  rcases hk with hpk | ⟨u, hu, ⟨hpn, -⟩, hcols⟩
  · have hkey := h.1.1.1.2
    rw [hpk] at hkey
    exact key_holds_single hkey h1 h2 hs hv
  · have hkey := h.1.1.2 u hu
    rw [hpn, hcols] at hkey
    exact key_holds_single hkey h1 h2 hs hv

private theorem mem_of_contains {l : List (String × String)} {p : String × String}
    (h : l.contains p = true) : p ∈ l := by
  simpa using h

/-! ## The generic isolation lemmas -/

/-- A reference through a tenant-paired foreign key joins two rows of the same workspace, in any
state and under any schema: the database compares the two tenant columns as part of the key. -/
@[aw_spec (tier := T2)
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")]
theorem paired_reference_preserves_tenant (S : Schema) (st : State) {t : TableName}
    {fk : ForeignKey} {r r' : Row} (hp : isPaired S t fk = true)
    (href : References S st t fk r r') : tenantOf S t r = tenantOf S fk.refTable r' := by
  obtain ⟨_, _, _, _, hproj⟩ := href
  unfold isPaired at hp
  unfold tenantOf
  cases hc1 : (S t).tenantColumn? with
  | none => simp [hc1] at hp
  | some c =>
    cases hc2 : (S fk.refTable).tenantColumn? with
    | none => simp [hc1, hc2] at hp
    | some rc =>
      simp only [hc1, hc2] at hp
      simp only [Option.bind_some]
      exact (get_eq_of_mem_pairs (mem_of_contains hp) hproj).symm

/-- In a consistent state, a single-column reference covered by a tenant-paired sibling also
joins two rows of the same workspace: the sibling pins a parent row in the child's workspace,
and the parent key is unique, so both constraints reach that one row. -/
@[aw_spec (tier := T2)
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#referenceIdentityOf")]
theorem sibling_reference_preserves_tenant (S : Schema) (st : State)
    (hc : consistent S st = true) {t : TableName} {fk : ForeignKey} {r r' : Row}
    (hs : siblingCovers S t fk = true) (href : References S st t fk r r') :
    tenantOf S t r = tenantOf S fk.refTable r' := by
  obtain ⟨_, hr, hr', hpres, hproj⟩ := href
  unfold siblingCovers at hs
  match hcols : fk.columns, hrcols : fk.refColumns, htc : (S t).tenantColumn? with
  | [c], [k], some tc =>
    rw [hcols, hrcols, htc] at hs
    simp only [Bool.and_eq_true, List.any_eq_true, beq_iff_eq] at hs
    obtain ⟨⟨hnn, hkey⟩, g, hg, ⟨⟨hgt, hgp⟩, hgck⟩, hgcols⟩ := hs
    -- the child's key column and tenant column are both present
    have hcpres : (r.get c).isSome = true := by
      simpa [Row.present, hcols] using hpres
    have htpres : (r.get tc).isSome = true := not_null_holds hc hnn hr
    have hgpres : r.present g.columns = true := by
      simp only [Row.present, List.all_eq_true]
      intro x hx
      have := List.all_eq_true.mp hgcols x hx
      simp only [Bool.or_eq_true, beq_iff_eq] at this
      rcases this with rfl | rfl
      · exact hcpres
      · exact htpres
    -- the sibling's parent row
    obtain ⟨r'', hr'', hproj''⟩ := fk_holds_elim (fk_holds hc hg) hr hgpres
    rw [hgt] at hr''
    have hk' : r'.get k = r.get c := by
      rw [hcols, hrcols] at hproj
      simpa [Row.project] using hproj
    have hk'' : r''.get k = r.get c := get_eq_of_mem_pairs (mem_of_contains hgck) hproj''
    have heq : r' = r'' :=
      single_key_unique hc hkey hr' hr'' (by rw [hk']; exact hcpres) (by rw [hk', hk''])
    subst heq
    -- the sibling pairs the tenant columns
    unfold isPaired at hgp
    unfold tenantOf
    rw [htc] at hgp ⊢
    rw [hgt] at hgp
    cases hc2 : (S fk.refTable).tenantColumn? with
    | none => simp [hc2] at hgp
    | some rc =>
      simp only [hc2] at hgp
      simp only [Option.bind_some]
      exact (get_eq_of_mem_pairs (mem_of_contains hgp) hproj'').symm
  | [], _, _ => simp [hcols] at hs
  | _ :: _ :: _, _, _ => simp [hcols] at hs
  | [_], [], _ => simp [hcols, hrcols] at hs
  | [_], _ :: _ :: _, _ => simp [hcols, hrcols] at hs
  | [_], [_], none => simp [hcols, hrcols, htc] at hs

/-- In a consistent state, every reference through a foreign key that is neither unpaired nor a
reference to a global table joins two rows of the same workspace. -/
@[aw_spec (tier := T2)
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")]
theorem reference_preserves_tenant (S : Schema) (st : State) (hc : consistent S st = true)
    {t : TableName} {fk : ForeignKey} {r r' : Row} (hu : classify S t fk ≠ .unpaired)
    (hg : classify S t fk ≠ .globalReference) (href : References S st t fk r r') :
    tenantOf S t r = tenantOf S fk.refTable r' := by
  unfold classify at hu hg
  cases hten : (S fk.refTable).tenancy with
  | global =>
    simp only [hten] at hu hg
    split at hu
    · exact absurd rfl hu
    · rename_i h
      simp only [h] at hg
      exact absurd rfl hg
  | root =>
    simp only [hten] at hu
    split at hu
    · rename_i h
      simp only [Bool.and_eq_true] at h
      exact paired_reference_preserves_tenant S st h.1 href
    · exact absurd rfl hu
  | «scoped» =>
    simp only [hten] at hu
    split at hu
    · rename_i h
      exact paired_reference_preserves_tenant S st h href
    · split at hu
      · rename_i _ h
        exact sibling_reference_preserves_tenant S st hc h href
      · exact absurd rfl hu

private theorem classify_ne_global {S : Schema} {t : TableName} {fk : ForeignKey}
    (h : (S fk.refTable).tenantColumn?.isSome = true) : classify S t fk ≠ .globalReference := by
  unfold classify
  unfold TableSpec.tenantColumn? at h
  split
  · rename_i hten
    rw [hten] at h
    simp [Tenancy.column?] at h
  · split <;> simp
  · split
    · simp
    · split <;> simp

private theorem classify_ne_unpaired {S : Schema} (hS : pairingComplete S = true)
    {t : TableName} {fk : ForeignKey} (hfk : fk ∈ (S t).foreignKeys) :
    classify S t fk ≠ .unpaired := by
  have := List.all_eq_true.mp (List.all_eq_true.mp hS t (WireEnum.complete t)) fk hfk
  simpa using this

/-- Under a schema with no unpaired reference, no consistent state holds a reference from a row
of one workspace to a tenant-carrying row of another: cross-tenant references are
unrepresentable in the database. -/
@[aw_spec (tier := T2)
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")]
theorem no_cross_tenant_reference (S : Schema) (hS : pairingComplete S = true) (st : State)
    (hc : consistent S st = true) {t : TableName} {fk : ForeignKey} {r r' : Row}
    (htarget : (S fk.refTable).tenantColumn?.isSome = true) (href : References S st t fk r r') :
    tenantOf S t r = tenantOf S fk.refTable r' :=
  reference_preserves_tenant S st hc (classify_ne_unpaired hS href.1) (classify_ne_global htarget)
    href

/-- Under a schema with no unpaired reference, every row reached from a row by a chain of
references through tenant-carrying tables belongs to the starting row's workspace. -/
@[aw_spec (tier := T2)
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")]
theorem tenant_path_preserves_tenant (S : Schema) (hS : pairingComplete S = true) (st : State)
    (hc : consistent S st = true) {t t' : TableName} {r r' : Row}
    (hpath : TenantPath S st t r t' r') : tenantOf S t r = tenantOf S t' r' := by
  induction hpath with
  | refl => rfl
  | step fk href hto hsome _ ih =>
    subst hto
    exact (no_cross_tenant_reference S hS st hc hsome href).trans ih

/-- In a consistent state every row of a tenant-carrying table has a workspace (its tenant
column is `NOT NULL`), provided the schema declares that column `NOT NULL`. -/
@[aw_spec (tier := T2) (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#TENANT_EXEMPT")]
theorem tenant_row_has_workspace (S : Schema) (st : State) (hc : consistent S st = true)
    {t : TableName} {tc : String} (htc : (S t).tenantColumn? = some tc)
    (hnn : (S t).isNotNull tc = true) {r : Row} (hr : r ∈ st t) : (tenantOf S t r).isSome = true := by
  unfold tenantOf
  rw [htc]
  simpa using not_null_holds hc hnn hr

/-- A foreign key never constrains a row with a `NULL` in its key (`MATCH SIMPLE`): adding such
a row to a state where the key holds keeps it holding. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/schema/sessions.ts#sessions_project_workspace_fk")]
theorem null_key_row_preserves_fk (st : State) (t : TableName) (fk : ForeignKey) (r : Row)
    (hfk : fk.refTable ≠ t) (hnull : r.present fk.columns = false)
    (h : fkHolds st t fk = true) :
    fkHolds (fun u => if u = t then r :: st u else st u) t fk = true := by
  simp only [fkHolds] at h ⊢
  simp [hfk, hnull, h]


private theorem other_check_holds {S : Schema} {st : State} (hc : consistent S st = true)
    {t : TableName} {n : String} (hck : Check.other n ∈ (S t).checks) {r : Row} (hr : r ∈ st t) :
    otherCheckHolds n r = true := by
  have h := table_consistent hc t
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  have := h.2 _ hck
  simp only [checkHolds, List.all_eq_true] at this
  exact this r hr

/-- In a consistent state, under today's schema, every principal has exactly one source: a
membership principal has a membership and no API key, and an API-key principal has a key and no
membership. -/
@[aw_spec (tier := T2) (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")
  (ts := "packages/core/src/db/schema/workspace-principals.ts#workspacePrincipals")]
theorem principal_has_exactly_one_source (st : State) (hc : consistent catalogue st = true)
    {r : Row} (hr : r ∈ st .workspacePrincipals) :
    (r.get "kind" = some "membership" ∧ (r.get "membership_id").isSome = true ∧
        r.get "api_key_id" = none) ∨
      (r.get "kind" = some "api_key" ∧ (r.get "api_key_id").isSome = true ∧
        r.get "membership_id" = none) := by
  have hx := other_check_holds hc (t := .workspacePrincipals)
    (n := "workspace_principals_source_xor") (by decide +kernel) hr
  have hk : (r.get "kind").isSome = true := not_null_holds hc (by decide +kernel) hr
  simp only [otherCheckHolds, principalSourceXor, beq_self_eq_true, ite_true] at hx
  cases hkind : r.get "kind" with
  | none => rw [hkind] at hk; cases hk
  | some k =>
    rw [hkind] at hx
    simp only [Bool.or_eq_true, Bool.and_eq_true, beq_iff_eq, Option.isNone_iff_eq_none] at hx
    rcases hx with ⟨⟨rfl, h1⟩, h2⟩ | ⟨⟨rfl, h1⟩, h2⟩
    · exact Or.inl ⟨rfl, h1, h2⟩
    · exact Or.inr ⟨rfl, h1, h2⟩


/-- In a consistent state, every row of a table with a closed-set check carries in that column
either `NULL` or one of the check's values, under any schema. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/one-of.ts#oneOf")]
theorem closed_set_value_is_in_its_set (S : Schema) (st : State) (hc : consistent S st = true)
    {t : TableName} {n c : String} {vs : List String} (hck : Check.oneOf n c vs ∈ (S t).checks)
    {r : Row} (hr : r ∈ st t) {v : String} (hv : r.get c = some v) : v ∈ vs := by
  have h := table_consistent hc t
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  have := h.2 _ hck
  simp only [checkHolds, List.all_eq_true] at this
  have := this r hr
  rw [hv] at this
  simpa using this

/-- The typed owning workspace of a row of a tenant-scoped table is exactly its tenant:
`Row.workspaceId?` reads the tenant column `workspace_id`. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/tenancy.test.ts#TENANT_COLUMN")]
theorem scoped_workspace_id_is_the_tenant (S : Schema) {t : TableName}
    (h : (S t).tenancy = .scoped) (r : Row) :
    r.workspaceId?.map AgentWorkspace.Id.val = tenantOf S t r := by
  simp [Row.workspaceId?, tenantOf, TableSpec.tenantColumn?, h, Tenancy.column?, Option.map_map]
  cases r.get "workspace_id" <;> rfl

/-- The typed primary key of a row of the tenant root is exactly its tenant: a `workspaces` row
is its own workspace, so `Row.id?` at kind `workspace` reads the root's tenant column `id`. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/schema/tenancy.test.ts#workspaceSelfPairingFault")]
theorem root_id_is_the_tenant (S : Schema) {t : TableName} (h : (S t).tenancy = .root) (r : Row) :
    (r.id? (k := .workspace)).map AgentWorkspace.Id.val = tenantOf S t r := by
  simp [Row.id?, tenantOf, TableSpec.tenantColumn?, h, Tenancy.column?, Option.map_map]
  cases r.get "id" <;> rfl

/-! ## Witnesses: a consistent state with root, global, paired and sibling references -/

namespace Witness

/-- Two workspaces; one user who is a member of the first; that membership's principal; a model
connection and an agent of the first workspace that uses it. -/
def state : State
  | .workspaces =>
    [⟨[("id", "w1"), ("slug", "one"), ("name", "One"), ("public_sharing_enabled", "true"),
       ("created_at", "t0"), ("updated_at", "t0")]⟩,
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
  | .modelConnections =>
    [⟨[("id", "c1"), ("workspace_id", "w1"), ("name", "default"), ("provider", "anthropic"),
       ("config", "{}"), ("created_at", "t0"), ("updated_at", "t0")]⟩]
  | .agents => [agent]
  | _ => []
where
  agent : Row :=
    ⟨[("id", "a1"), ("workspace_id", "w1"), ("name", "General"), ("instructions", "Help."),
      ("model_connection_id", "c1"), ("permissions", "{}"), ("created_by", "u1"),
      ("owner_principal_id", "p1"), ("created_at", "t0"), ("updated_at", "t0")]⟩

/-- The model connection the witness agent references. -/
def connection : Row :=
  ⟨[("id", "c1"), ("workspace_id", "w1"), ("name", "default"), ("provider", "anthropic"),
    ("config", "{}"), ("created_at", "t0"), ("updated_at", "t0")]⟩

/-- The single-column sibling key from `agents` to `model_connections`. -/
def siblingKey : ForeignKey :=
  { name := "agents_model_connection_id_model_connections_id_fk",
    columns := ["model_connection_id"], refTable := .modelConnections, refColumns := ["id"],
    onDelete := .setNull, inline := true }

private theorem state_is_consistent : consistent catalogue state = true := by decide +kernel

private theorem agent_references_connection :
    References catalogue state .agents siblingKey state.agent connection := by
  unfold References
  decide +kernel

end Witness

/-- The hypotheses of the isolation lemmas are satisfiable: a consistent state where an agent
references its connection through the `SET NULL` sibling key, and the two rows share a workspace. -/
example : tenantOf catalogue .agents Witness.state.agent =
    tenantOf catalogue .modelConnections Witness.connection :=
  sibling_reference_preserves_tenant catalogue Witness.state Witness.state_is_consistent
    (by decide +kernel) Witness.agent_references_connection

example : tenantOf catalogue .agents Witness.state.agent =
    tenantOf catalogue .modelConnections Witness.connection :=
  reference_preserves_tenant catalogue Witness.state Witness.state_is_consistent
    (by decide +kernel) (by decide +kernel) Witness.agent_references_connection

example : consistent catalogue State.empty = true := by decide +kernel

example : TenantPath catalogue Witness.state .agents Witness.state.agent .modelConnections
    Witness.connection :=
  .step Witness.siblingKey Witness.agent_references_connection rfl rfl (.refl _ _)

example : (tenantOf catalogue .agents Witness.state.agent).isSome = true :=
  tenant_row_has_workspace catalogue Witness.state Witness.state_is_consistent rfl
    (by decide +kernel) (by simp [Witness.state])

/-- The owner key of the witness agent: a tenant-paired reference to its principal. -/
private def ownerKey : ForeignKey :=
  { name := "agents_owner_principal_workspace_fk", columns := ["workspace_id", "owner_principal_id"],
    refTable := .workspacePrincipals, refColumns := ["workspace_id", "id"],
    onDelete := .noAction, inline := false }

private def principal : Row :=
  ⟨[("id", "p1"), ("workspace_id", "w1"), ("kind", "membership"), ("membership_id", "m1"),
    ("activated_at", "t0"), ("created_at", "t0")]⟩

example : tenantOf catalogue .agents Witness.state.agent =
    tenantOf catalogue .workspacePrincipals principal :=
  paired_reference_preserves_tenant catalogue Witness.state (fk := ownerKey) (by decide +kernel)
    (by unfold References; decide +kernel)

example : tenantOf catalogue .agents Witness.state.agent =
    tenantOf catalogue .workspacePrincipals principal :=
  no_cross_tenant_reference catalogue (by decide +kernel) Witness.state Witness.state_is_consistent
    (fk := ownerKey) rfl (by unfold References; decide +kernel)

example : principal.get "kind" = some "membership" ∧ (principal.get "membership_id").isSome = true ∧
      principal.get "api_key_id" = none ∨
    principal.get "kind" = some "api_key" ∧ (principal.get "api_key_id").isSome = true ∧
      principal.get "membership_id" = none :=
  principal_has_exactly_one_source Witness.state Witness.state_is_consistent
    (by simp [Witness.state, principal])

/-- A session with no project: its project key has a `NULL`, so the key does not constrain it. -/
example : fkHolds (fun u => if u = .sessions then
      ⟨[("id", "s1"), ("workspace_id", "w1")]⟩ :: State.empty u else State.empty u) .sessions
    { name := "sessions_project_workspace_fk", columns := ["project_id", "workspace_id"],
      refTable := .projects, refColumns := ["id", "workspace_id"], onDelete := .setNull,
      inline := false } = true :=
  null_key_row_preserves_fk State.empty .sessions _ _ (by decide +kernel) (by decide +kernel) (by decide +kernel)


/-- The witness membership's role is one of the four roles `memberships_role_valid` admits. -/
example : "owner" ∈ ["owner", "admin", "builder", "viewer"] :=
  closed_set_value_is_in_its_set catalogue Witness.state Witness.state_is_consistent
    (t := .memberships) (n := "memberships_role_valid") (c := "role") (by decide +kernel)
    (r := ⟨[("id", "m1"), ("workspace_id", "w1"), ("user_id", "u1"), ("role", "owner"),
      ("created_at", "t0"), ("updated_at", "t0")]⟩) (by simp [Witness.state]) rfl

example : Witness.state.agent.workspaceId?.map AgentWorkspace.Id.val = some "w1" :=
  (scoped_workspace_id_is_the_tenant catalogue (t := .agents) rfl Witness.state.agent).trans rfl

example : ((⟨[("id", "w1"), ("slug", "one")]⟩ : Row).id? (k := .workspace)).map
    AgentWorkspace.Id.val = some "w1" :=
  (root_id_is_the_tenant catalogue (t := .workspaces) rfl _).trans rfl

end AgentWorkspace.Theorems.Invariants.ErCore
