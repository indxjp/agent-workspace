import AgentWorkspace.Theorems.Invariants.ErCore
import AgentWorkspace.Er.Current.Catalog

/-!
T2 — what holds of the catalog cluster in every state PostgreSQL can hold, and what its
operations preserve.

* **Per foreign key** (generated, 41 each): the reference joins two rows of one workspace
  (`<fk>_joins_one_workspace`, the generic `Er.Core` isolation lemma instantiated), and it names
  exactly one parent row (`<fk>_names_exactly_one_parent` for a `NOT NULL` key,
  `<fk>_names_one_parent_when_set` for a nullable one).
* **Per unique key** (generated): two rows that agree on a natural key are one row
  (`<key>_identifies_one_row`).
* **Operations**: `replace` writes only catalogued, distinct ids and never widens past
  `writeFiles`; the grants round trip returns exactly the principals written; the catalog upserts
  never transfer ownership; a subtree rename keeps every row's identity; the connector create
  path only ever hands the store a row the shape CHECKs accept.

Every generated theorem has an `example` built on `Sample.state`.
-/

namespace AgentWorkspace.Theorems.Invariants.ConceptCatalog

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Er.Current.Catalog
open AgentWorkspace.Concepts
open AgentWorkspace.Theorems.Invariants.ErCore (no_cross_tenant_reference)

/-! ## Helpers over rows -/

private theorem core_of {st : State} (hc : Er.Current.Catalog.consistent st = true) :
    Er.Core.consistent catalogue st = true := by
  unfold Er.Current.Catalog.consistent at hc
  exact (Bool.and_eq_true _ _ ▸ hc).1

private theorem table_consistent' {S : Schema} {st : State} (hc : Er.Core.consistent S st = true)
    (t : TableName) : tableConsistent S st t = true :=
  List.all_eq_true.mp hc t (WireEnum.complete t)

private theorem present_eq_project (r : Row) (cs : List String) :
    r.present cs = (r.project cs).all Option.isSome := by
  simp [Row.present, Row.project, List.all_map, Function.comp_def]

private theorem present_of_project_eq {r r' : Row} {cs rcs : List String}
    (h : r'.project rcs = r.project cs) (hp : r.present cs = true) : r'.present rcs = true := by
  rw [present_eq_project] at hp ⊢
  rw [h]
  exact hp

private theorem key_rows_equal {rows : List Row} {cols : List String}
    (h : keyHolds rows cols [] = true) {r1 r2 : Row} (h1 : r1 ∈ rows) (h2 : r2 ∈ rows)
    (hp : r1.present cols = true) (he : r1.project cols = r2.project cols) : r1 = r2 := by
  simp only [keyHolds, List.all_nil] at h
  rw [List.filter_eq_self.mpr (fun _ _ => rfl), List.all_eq_true] at h
  have := h r1 h1
  simp only [hp, Bool.not_true, Bool.false_or, List.all_eq_true] at this
  have := this r2 h2
  simpa [he] using this

private theorem exact_key_unique {S : Schema} {st : State} (hc : Er.Core.consistent S st = true)
    {fk : ForeignKey} (hk : targetIsExactKey S fk = true) {r1 r2 : Row}
    (h1 : r1 ∈ st fk.refTable) (h2 : r2 ∈ st fk.refTable) (hp : r1.present fk.refColumns = true)
    (he : r1.project fk.refColumns = r2.project fk.refColumns) : r1 = r2 := by
  have h := table_consistent' hc fk.refTable
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  simp only [targetIsExactKey, Bool.or_eq_true, beq_iff_eq, List.any_eq_true, Bool.and_eq_true,
    List.isEmpty_iff] at hk
  rcases hk with hpk | ⟨u, hu, ⟨hpn, -⟩, hcols⟩
  · have hkey := h.1.1.1.2
    rw [hpk] at hkey
    exact key_rows_equal hkey h1 h2 hp he
  · have hkey := h.1.1.2 u hu
    rw [hpn, hcols] at hkey
    exact key_rows_equal hkey h1 h2 hp he

private theorem fk_parent {S : Schema} {st : State} (hc : Er.Core.consistent S st = true)
    {t : TableName} {fk : ForeignKey} (hfk : fk ∈ (S t).foreignKeys) {r : Row} (hr : r ∈ st t)
    (hp : r.present fk.columns = true) :
    ∃ r' ∈ st fk.refTable, r'.project fk.refColumns = r.project fk.columns := by
  have h := table_consistent' hc t
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  have := List.all_eq_true.mp (h.1.2 fk hfk) r hr
  simpa [hp] using this

/-! ## The generic cardinality lemmas -/

/-- In a consistent state, a row whose foreign key is set names exactly one parent row, provided
the key targets an exact key of the parent. -/
@[aw_spec (tier := T2) (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")]
theorem reference_names_one_parent (S : Schema) (st : State)
    (hc : Er.Core.consistent S st = true) {t : TableName} {fk : ForeignKey}
    (hfk : fk ∈ (S t).foreignKeys) (hk : targetIsExactKey S fk = true) {r : Row} (hr : r ∈ st t)
    (hp : r.present fk.columns = true) :
    ∃ r' ∈ st fk.refTable, r'.project fk.refColumns = r.project fk.columns ∧
      ∀ r'' ∈ st fk.refTable, r''.project fk.refColumns = r.project fk.columns → r'' = r' := by
  obtain ⟨r', hr', he⟩ := fk_parent hc hfk hr hp
  refine ⟨r', hr', he, fun r'' hr'' he'' => ?_⟩
  exact exact_key_unique hc hk hr'' hr' (present_of_project_eq he'' hp) (he''.trans he.symm)

/-- In a consistent state, a foreign key over `NOT NULL` columns is set on every row. -/
@[aw_spec (tier := T2) (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")]
theorem mandatory_reference_is_set (S : Schema) (st : State)
    (hc : Er.Core.consistent S st = true) (t : TableName) (fk : ForeignKey)
    (hm : fk.columns.all (S t).isNotNull = true) {r : Row} (hr : r ∈ st t) :
    r.present fk.columns = true := by
  have h := table_consistent' hc t
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  simp only [Row.present, List.all_eq_true]
  intro c hcm
  have hnn := List.all_eq_true.mp hm c hcm
  obtain ⟨col, hcol, hc'⟩ := List.any_eq_true.mp hnn
  simp only [Bool.and_eq_true, beq_iff_eq] at hc'
  have := h.1.1.1.1 col hcol
  simp only [notNullHolds, hc'.2, Bool.not_true, Bool.false_or, List.all_eq_true] at this
  rw [← hc'.1]
  exact this r hr

/-- In a consistent state, two rows of a table that agree on the columns of a total unique key
(set on the first) are the same row. -/
@[aw_spec (tier := T2) (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")
  (ts := "packages/core/src/db/schema/index.ts")]
theorem unique_key_identifies_row (S : Schema) (st : State)
    (hc : Er.Core.consistent S st = true) {t : TableName} {u : UniqueKey}
    (hu : u ∈ (S t).uniques) (hpart : u.partialNullColumns = []) {r1 r2 : Row}
    (h1 : r1 ∈ st t) (h2 : r2 ∈ st t) (hp : r1.present u.columns = true)
    (he : r1.project u.columns = r2.project u.columns) : r1 = r2 := by
  have h := table_consistent' hc t
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  have hkey := h.1.1.2 u hu
  rw [hpart] at hkey
  exact key_rows_equal hkey h1 h2 hp he

/-- In a consistent state, two rows of a table that agree on its primary key are the same row. -/
@[aw_spec (tier := T2) (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")
  (ts := "packages/core/src/db/schema/index.ts")]
theorem primary_key_identifies_row (S : Schema) (st : State)
    (hc : Er.Core.consistent S st = true) {t : TableName} {r1 r2 : Row}
    (h1 : r1 ∈ st t) (h2 : r2 ∈ st t) (hp : r1.present (S t).primaryKey = true)
    (he : r1.project (S t).primaryKey = r2.project (S t).primaryKey) : r1 = r2 := by
  have h := table_consistent' hc t
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  exact key_rows_equal h.1.1.1.2 h1 h2 hp he

/-- The sample state is consistent. -/
private theorem sample_is_consistent : Er.Current.Catalog.consistent Sample.state = true := by decide +kernel

/-! ## Generated: one isolation and one cardinality theorem per foreign key, one identity
theorem per unique key -/

section Generator

open Lean Elab Command

private def mkDocComment (text : String) : TSyntax ``Lean.Parser.Command.docComment :=
  ⟨mkNode ``Lean.Parser.Command.docComment #[mkAtom "/--", mkAtom (text ++ " -/")]⟩

private def ctorName (sql : String) : Name :=
  match sql.splitOn "_" with
  | [] => .anonymous
  | w :: ws => Name.mkSimple (w ++ String.join (ws.map String.capitalize))

private def erDoc : String := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces"

/-- The consequence a natural key has, and the document that states it when one does (`none`:
the key is cited by its schema definition only). -/
private def uniqueSentence : String → Option (String × Option String)
  | "agent_files_workspace_agent_file_key" =>
    some ("an agent has at most one assignment of a given file, so changing its breadth updates \
      `access` rather than adding a row", none)
  | "agent_skills_workspace_agent_skill_key" =>
    some ("an agent has at most one assignment of a given skill", none)
  | "agent_mcp_servers_workspace_agent_server_key" =>
    some ("an agent has at most one assignment of a given connector", none)
  | "agent_grants_workspace_agent_user_key" =>
    some ("granting the same agent to the same user twice is not a second grant",
      some "docs/adr/W9-AUTH-117-viewer-permitted-agent-grants.md#decision")
  | "skills_workspace_name_key" =>
    some ("a skill is addressed by its name in the workspace",
      some "docs/sdk/04-api-specification.md#57-skills--awskills")
  | "files_workspace_path_key" =>
    some ("a file is addressed by its path in the workspace",
      some "docs/sdk/04-api-specification.md#56-files--awfiles")
  | "mcp_servers_workspace_name_key" =>
    some ("a second connector of the same name is `409 connector_name_conflict`",
      some "docs/sdk/04-api-specification.md#58-connectors-mcp-servers--awconnectors")
  | "agents_workspace_name_key" =>
    some ("two agents of one workspace never share a name", none)
  | _ => none

/-- A second row agreeing with `r` on `cols`: the first cell outside `cols` gets a different
value, or, when every cell is in `cols`, the workspace does. -/
private def twin (r : Row) (cols : List String) : Row :=
  match r.cells.find? (fun p => !cols.contains p.1) with
  | some (c, _) => ⟨r.cells.map fun p => if p.1 == c then (p.1, p.2 ++ "~") else p⟩
  | none => ⟨r.cells.map fun p => if p.1 == "workspace_id" then (p.1, p.2 ++ "~") else p⟩

/-- The first sample row of `t`. -/
private def r0 (t : TableName) : Row := (Sample.state t).head?.getD default

/-- `Sample.state` with `r` added to table `t`. -/
private def withRow (t : TableName) (r : Row) : AgentWorkspace.Er.Core.State :=
  fun t' => if t' = t then Sample.state t ++ [r] else Sample.state t'

/-- Elaborates the per-key theorems of the catalog cluster, each with its witness. -/
elab "aw_catalog_key_theorems" : command => do
  for (t, fk) in clusterForeignKeys do
    let s := catalogue t
    let sql := TableName.toWire t
    let tIdent := mkIdent (``TableName ++ ctorName sql)
    let path := "packages/core/src/db/schema/" ++ s.source
    let fkTs := Syntax.mkStrLit (path ++ "#" ++ (if fk.inline then s.tsExport else fk.name))
    let nameLit := Syntax.mkStrLit fk.name
    let parentSql := TableName.toWire fk.refTable
    -- isolation
    let thm := mkIdent (Name.mkSimple s!"{fk.name}_joins_one_workspace")
    let doc := mkDocComment s!"In every consistent state, a `{sql}` row and the `{parentSql}` \
      row it references through `{fk.name}` belong to the same workspace."
    elabCommand (← `(command|
      $doc:docComment
      @[aw_spec (tier := $(mkIdent `T2)) (doc := $(Syntax.mkStrLit erDoc)) (ts := $fkTs)
        (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")]
      theorem $thm (st : AgentWorkspace.Er.Core.State) (hc : AgentWorkspace.Er.Current.Catalog.consistent st = true) {r r' : AgentWorkspace.Er.Core.Row}
          (href : References catalogue st $tIdent (fk $tIdent $nameLit) r r') :
          tenantOf catalogue $tIdent r = tenantOf catalogue (fk $tIdent $nameLit).refTable r' :=
        no_cross_tenant_reference catalogue (by decide +kernel) st (core_of hc) (by decide +kernel) href))
    elabCommand (← `(command|
      example : tenantOf catalogue $tIdent (Sample.child $tIdent (fk $tIdent $nameLit)) =
          tenantOf catalogue (fk $tIdent $nameLit).refTable
            (Sample.parent $tIdent (fk $tIdent $nameLit)) :=
        $thm Sample.state sample_is_consistent (by unfold References; decide +kernel)))
    -- cardinality
    if isMandatory t fk then
      let thm := mkIdent (Name.mkSimple s!"{fk.name}_names_exactly_one_parent")
      let doc := mkDocComment s!"In every consistent state, every `{sql}` row names exactly one \
        `{parentSql}` row through `{fk.name}` (its columns are `NOT NULL`)."
      elabCommand (← `(command|
        $doc:docComment
        @[aw_spec (tier := $(mkIdent `T2)) (doc := $(Syntax.mkStrLit erDoc)) (ts := $fkTs)]
        theorem $thm (st : AgentWorkspace.Er.Core.State) (hc : AgentWorkspace.Er.Current.Catalog.consistent st = true) {r : AgentWorkspace.Er.Core.Row} (hr : r ∈ st $tIdent) :
            ∃ r' ∈ st (fk $tIdent $nameLit).refTable,
              r'.project (fk $tIdent $nameLit).refColumns = r.project (fk $tIdent $nameLit).columns ∧
              ∀ r'' ∈ st (fk $tIdent $nameLit).refTable,
                r''.project (fk $tIdent $nameLit).refColumns =
                  r.project (fk $tIdent $nameLit).columns → r'' = r' :=
          reference_names_one_parent catalogue st (core_of hc) (by decide +kernel) (by decide +kernel) hr
            (mandatory_reference_is_set catalogue st (core_of hc) _ _ (by decide +kernel) hr)))
      elabCommand (← `(command|
        example : ∃ r' ∈ Sample.state (fk $tIdent $nameLit).refTable,
            r'.project (fk $tIdent $nameLit).refColumns =
              (Sample.child $tIdent (fk $tIdent $nameLit)).project (fk $tIdent $nameLit).columns ∧
            ∀ r'' ∈ Sample.state (fk $tIdent $nameLit).refTable,
              r''.project (fk $tIdent $nameLit).refColumns =
                (Sample.child $tIdent (fk $tIdent $nameLit)).project (fk $tIdent $nameLit).columns →
                r'' = r' :=
          $thm Sample.state sample_is_consistent (by decide +kernel)))
    else
      let thm := mkIdent (Name.mkSimple s!"{fk.name}_names_one_parent_when_set")
      let doc := mkDocComment s!"In every consistent state, a `{sql}` row whose nullable key \
        `{fk.name}` is set names exactly one `{parentSql}` row (a `NULL` key names none)."
      elabCommand (← `(command|
        $doc:docComment
        @[aw_spec (tier := $(mkIdent `T2)) (doc := $(Syntax.mkStrLit erDoc)) (ts := $fkTs)]
        theorem $thm (st : AgentWorkspace.Er.Core.State) (hc : AgentWorkspace.Er.Current.Catalog.consistent st = true) {r : AgentWorkspace.Er.Core.Row} (hr : r ∈ st $tIdent)
            (hp : r.present (fk $tIdent $nameLit).columns = true) :
            ∃ r' ∈ st (fk $tIdent $nameLit).refTable,
              r'.project (fk $tIdent $nameLit).refColumns = r.project (fk $tIdent $nameLit).columns ∧
              ∀ r'' ∈ st (fk $tIdent $nameLit).refTable,
                r''.project (fk $tIdent $nameLit).refColumns =
                  r.project (fk $tIdent $nameLit).columns → r'' = r' :=
          reference_names_one_parent catalogue st (core_of hc) (by decide +kernel) (by decide +kernel) hr hp))
      elabCommand (← `(command|
        example : ∃ r' ∈ Sample.state (fk $tIdent $nameLit).refTable,
            r'.project (fk $tIdent $nameLit).refColumns =
              (Sample.child $tIdent (fk $tIdent $nameLit)).project (fk $tIdent $nameLit).columns ∧
            ∀ r'' ∈ Sample.state (fk $tIdent $nameLit).refTable,
              r''.project (fk $tIdent $nameLit).refColumns =
                (Sample.child $tIdent (fk $tIdent $nameLit)).project (fk $tIdent $nameLit).columns →
                r'' = r' :=
          $thm Sample.state sample_is_consistent (by decide +kernel) (by decide +kernel)))
  -- unique keys
  for t in tables do
    let s := catalogue t
    let sql := TableName.toWire t
    let tIdent := mkIdent (``TableName ++ ctorName sql)
    let path := "packages/core/src/db/schema/" ++ s.source
    for u in s.uniques do
      -- A partial key identifies a row only within its filter.
      if !u.partialNullColumns.isEmpty || !u.partialNotNullColumns.isEmpty then continue
      let thm := mkIdent (Name.mkSimple s!"{u.name}_identifies_one_row")
      let cols := ", ".intercalate u.columns
      let (sentence, docCite?) := (uniqueSentence u.name).getD
        ("PostgreSQL enforces the key, which composite tenant-paired references target", some erDoc)
      let doc := mkDocComment s!"In every consistent state, two `{sql}` rows that agree on \
        `({cols})` are the same row: {sentence}."
      let colsTerm : Term := quote u.columns
      let nameLit := Syntax.mkStrLit u.name
      let tsLit := Syntax.mkStrLit (path ++ "#" ++ s.tsExport)
      let attr ← match docCite? with
        | some d => `(Lean.Parser.Term.attrInstance|
            aw_spec (tier := $(mkIdent `T2)) (doc := $(Syntax.mkStrLit d)) (ts := $tsLit))
        | none => `(Lean.Parser.Term.attrInstance| aw_spec (tier := $(mkIdent `T2)) (ts := $tsLit))
      elabCommand (← `(command|
        $doc:docComment
        @[$attr]
        theorem $thm (st : AgentWorkspace.Er.Core.State) (hc : AgentWorkspace.Er.Current.Catalog.consistent st = true) {r1 r2 : AgentWorkspace.Er.Core.Row}
            (h1 : r1 ∈ st $tIdent) (h2 : r2 ∈ st $tIdent) (hp : r1.present $colsTerm = true)
            (he : r1.project $colsTerm = r2.project $colsTerm) : r1 = r2 :=
          unique_key_identifies_row catalogue st (core_of hc)
            (u := ((catalogue $tIdent).unique? $nameLit).getD default) (by decide +kernel) (by decide +kernel)
            h1 h2 hp he))
      -- the negative witness: a second, different row agreeing on the key makes the state
      -- inconsistent
      elabCommand (← `(command|
        example : r0 $tIdent ≠ twin (r0 $tIdent) $colsTerm ∧
            (r0 $tIdent).project $colsTerm = (twin (r0 $tIdent) $colsTerm).project $colsTerm ∧
            AgentWorkspace.Er.Current.Catalog.consistent
              (withRow $tIdent (twin (r0 $tIdent) $colsTerm)) = false := by
          decide +kernel))
      elabCommand (← `(command|
        example : ((Sample.state $tIdent).head?.getD default) =
            ((Sample.state $tIdent).head?.getD default) :=
          $thm Sample.state sample_is_consistent (by decide +kernel) (by decide +kernel)
            (by decide +kernel) rfl))
    if s.primaryKey != ["id"] then
      let thm := mkIdent (Name.mkSimple s!"{sql}_pkey_identifies_one_row")
      let cols := ", ".intercalate s.primaryKey
      let doc := mkDocComment s!"In every consistent state, two `{sql}` rows that agree on \
        `({cols})` are the same row: a project links a given resource at most once."
      let colsTerm : Term := quote s.primaryKey
      elabCommand (← `(command|
        $doc:docComment
        @[aw_spec (tier := $(mkIdent `T2)) (doc := $(Syntax.mkStrLit erDoc))
          (ts := $(Syntax.mkStrLit (path ++ "#" ++ s.tsExport)))]
        theorem $thm (st : AgentWorkspace.Er.Core.State) (hc : AgentWorkspace.Er.Current.Catalog.consistent st = true) {r1 r2 : AgentWorkspace.Er.Core.Row}
            (h1 : r1 ∈ st $tIdent) (h2 : r2 ∈ st $tIdent) (hp : r1.present $colsTerm = true)
            (he : r1.project $colsTerm = r2.project $colsTerm) : r1 = r2 :=
          primary_key_identifies_row catalogue st (core_of hc) h1 h2 hp he))
      elabCommand (← `(command|
        example : r0 $tIdent ≠ twin (r0 $tIdent) $colsTerm ∧
            (r0 $tIdent).project $colsTerm = (twin (r0 $tIdent) $colsTerm).project $colsTerm ∧
            AgentWorkspace.Er.Current.Catalog.consistent
              (withRow $tIdent (twin (r0 $tIdent) $colsTerm)) = false := by
          decide +kernel))
      elabCommand (← `(command|
        example : ((Sample.state $tIdent).head?.getD default) =
            ((Sample.state $tIdent).head?.getD default) :=
          $thm Sample.state sample_is_consistent (by decide +kernel) (by decide +kernel)
            (by decide +kernel) rfl))

end Generator

aw_catalog_key_theorems

/-! ## Replacing an agent's assignments -/

private theorem firstRepeat_go_none :
    ∀ (seen xs : List String), Grant.firstRepeat.go seen xs = none →
      xs.Nodup ∧ ∀ x ∈ xs, x ∉ seen
  | _, [], _ => ⟨List.nodup_nil, by simp⟩
  | seen, x :: rest, h => by
    simp only [Grant.firstRepeat.go] at h
    split at h
    · cases h
    · rename_i hx
      obtain ⟨hn, hs⟩ := firstRepeat_go_none (x :: seen) rest h
      refine ⟨List.nodup_cons.mpr ⟨fun hm => hs x hm (by simp), hn⟩, ?_⟩
      intro y hy
      rcases List.mem_cons.mp hy with rfl | hy
      · simpa using hx
      · exact fun hm => hs y hy (List.mem_cons_of_mem _ hm)

private theorem firstRepeat_none {xs : List String} (h : Grant.firstRepeat xs = none) :
    xs.Nodup :=
  (firstRepeat_go_none [] xs h).1

private theorem mem_dedup {x : String} : ∀ {xs : List String}, x ∈ Grant.dedup xs ↔ x ∈ xs
  | [] => by simp [Grant.dedup]
  | y :: ys => by
    simp only [Grant.dedup, List.mem_cons, List.mem_filter, bne_iff_ne, ne_eq, mem_dedup]
    by_cases hxy : x = y <;> simp [hxy]

private theorem dedup_nodup : ∀ xs : List String, (Grant.dedup xs).Nodup
  | [] => List.nodup_nil
  | x :: xs => List.nodup_cons.mpr ⟨by simp [List.mem_filter], (dedup_nodup xs).filter _⟩

/-! ### Sorting the read-back -/

private theorem insert_perm {α : Type} (key : α → String) (x : α) :
    ∀ l : List α, (Grant.insertByKey key x l).Perm (x :: l)
  | [] => by simp [Grant.insertByKey]
  | y :: ys => by
    simp only [Grant.insertByKey]
    split
    · exact List.Perm.refl _
    · exact ((insert_perm key x ys).cons y).trans (List.Perm.swap x y ys)

private theorem sort_perm {α : Type} (key : α → String) :
    ∀ l : List α, (Grant.sortByKey key l).Perm l
  | [] => by simp [Grant.sortByKey]
  | x :: xs => by
    simp only [Grant.sortByKey]
    exact (insert_perm key x _).trans ((sort_perm key xs).cons x)

private theorem insert_sorted {α : Type} (key : α → String) (x : α) :
    ∀ l : List α, l.Pairwise (fun a b => key a ≤ key b) →
      (Grant.insertByKey key x l).Pairwise (fun a b => key a ≤ key b)
  | [], _ => by simp [Grant.insertByKey]
  | y :: ys, h => by
    simp only [Grant.insertByKey]
    rw [List.pairwise_cons] at h
    split
    · rename_i hxy
      refine List.pairwise_cons.mpr ⟨?_, List.pairwise_cons.mpr h⟩
      intro z hz
      rcases List.mem_cons.mp hz with rfl | hz
      · exact hxy
      · exact String.le_trans hxy (h.1 z hz)
    · rename_i hxy
      refine List.pairwise_cons.mpr ⟨?_, insert_sorted key x ys h.2⟩
      intro z hz
      rcases List.mem_cons.mp ((insert_perm key x ys).mem_iff.mp hz) with rfl | hz
      · exact Std.le_of_not_ge hxy
      · exact h.1 z hz

private theorem sort_sorted {α : Type} (key : α → String) :
    ∀ l : List α, (Grant.sortByKey key l).Pairwise (fun a b => key a ≤ key b)
  | [] => by simp [Grant.sortByKey]
  | x :: xs => by
    simp only [Grant.sortByKey]
    exact insert_sorted key x _ (sort_sorted key xs)

/-! ### The outcome lemmas -/

private theorem firstRepeat_go_of_nodup :
    ∀ (seen xs : List String), xs.Nodup → (∀ x ∈ xs, x ∉ seen) →
      Grant.firstRepeat.go seen xs = none
  | _, [], _, _ => by simp [Grant.firstRepeat.go]
  | seen, x :: rest, hn, hs => by
    simp only [Grant.firstRepeat.go]
    have hx : seen.contains x = false := by
      simpa using hs x (List.mem_cons_self ..)
    rw [hx]
    simp only [Bool.false_eq_true, ite_false]
    obtain ⟨hxr, hn'⟩ := List.nodup_cons.mp hn
    apply firstRepeat_go_of_nodup (x :: seen) rest hn'
    intro y hy hm
    rcases List.mem_cons.mp hm with rfl | hm
    · exact hxr hy
    · exact hs y (List.mem_cons_of_mem _ hy) hm

private theorem firstRepeat_of_nodup {xs : List String} (h : xs.Nodup) :
    Grant.firstRepeat xs = none :=
  firstRepeat_go_of_nodup [] xs h (by simp)

private theorem find_filter_of {q r : String → Bool} (hqr : ∀ y, q y = true → r y = true) :
    ∀ l : List String, (l.filter r).find? q = l.find? q
  | [] => rfl
  | y :: ys => by
    by_cases hq : q y = true
    · simp [hqr y hq, hq]
    · by_cases hr : r y = true
      · simp [hr, hq, find_filter_of hqr ys]
      · simp [hr, hq, find_filter_of hqr ys]

private theorem find_dedup (q : String → Bool) :
    ∀ l : List String, (Grant.dedup l).find? q = l.find? q
  | [] => by simp [Grant.dedup]
  | x :: xs => by
    simp only [Grant.dedup]
    by_cases hq : q x = true
    · simp [hq]
    · have hne : ∀ y, q y = true → (y != x) = true := by
        intro y hy
        simp only [bne_iff_ne, ne_eq]
        rintro rfl
        exact hq hy
      simp [hq, find_filter_of hne, find_dedup q xs]

private theorem find_first {q : String → Bool} {pre post : List String} {x : String}
    (hpre : ∀ y ∈ pre, q y = false) (hx : q x = true) : (pre ++ x :: post).find? q = some x := by
  rw [List.find?_append, List.find?_eq_none.mpr (fun y hy => by simp [hpre y hy])]
  simp [hx]

private theorem find_none_of_all {q : String → Bool} {l : List String}
    (h : ∀ y ∈ l, q y = false) : l.find? q = none :=
  List.find?_eq_none.mpr fun y hy => by simp [h y hy]

private theorem narrowed_ids (p : Agent.Permissions) (fs : List Grant.FileEntry) :
    (fs.map fun g => { g with access := Grant.narrow p.writeFiles g.access }).map (·.file) =
      fs.map (·.file) := by
  simp [List.map_map, Function.comp_def]

private theorem replace_spec {p : Agent.Permissions} {cat : Grant.CatalogIds}
    {req a : Grant.Assignments} (h : Grant.replace (some p) cat req = .updated a) :
    a = Grant.readBack
        ⟨req.files.map (fun g => { g with access := Grant.narrow p.writeFiles g.access }),
          Grant.dedup req.skills, Grant.dedup req.connectors⟩ ∧
      Grant.firstRepeat (req.files.map (·.file)) = none ∧
      (∀ f ∈ req.files, cat.files.contains f.file = true) ∧
      (∀ k ∈ Grant.dedup req.skills, cat.skills.contains k = true) ∧
      (∀ c ∈ Grant.dedup req.connectors, cat.connectors.contains c = true) := by
  simp only [Grant.replace] at h
  split at h
  · simp at h
  · rename_i hrep
    split at h
    · simp at h
    · rename_i hf
      split at h
      · simp at h
      · rename_i hs
        split at h
        · simp at h
        · rename_i hc
          simp only [Grant.ReplaceOutcome.updated.injEq] at h
          subst h
          rw [narrowed_ids] at hrep hf
          refine ⟨rfl, hrep, ?_, ?_, ?_⟩ <;> intro x hx
          · have := List.find?_eq_none.mp hf _ (List.mem_map_of_mem (f := (·.file)) hx)
            simpa using this
          · have := List.find?_eq_none.mp hs _ hx
            simpa using this
          · have := List.find?_eq_none.mp hc _ hx
            simpa using this

/-- Replacing an agent's assignments writes only ids that name a file, skill or connector of the
agent's own workspace catalog: "importing a skill puts it in the workspace's catalog; assigning it
is what makes one particular agent's runs able to load it". -/
@[aw_spec (tier := T2)
  (doc := "docs/sdk/site/concepts/ownership-and-sharing.mdx#catalog-assignment-grant")
  (ts := "packages/core/src/db/repositories/agent-resources.ts#createDatabaseAgentResourceRepositoryProvider")]
theorem replace_assigns_only_catalogued_resources (p : Agent.Permissions)
    (cat : Grant.CatalogIds) (req a : Grant.Assignments)
    (h : Grant.replace (some p) cat req = .updated a) :
    (∀ f ∈ a.files, f.file ∈ cat.files) ∧ (∀ k ∈ a.skills, k ∈ cat.skills) ∧
      (∀ c ∈ a.connectors, c ∈ cat.connectors) := by
  obtain ⟨rfl, -, hf, hs, hc⟩ := replace_spec h
  refine ⟨fun f hm => ?_, fun k hm => ?_, fun c hm => ?_⟩
  · have hm' := (sort_perm _ _).mem_iff.mp hm
    rw [List.mem_map] at hm'
    obtain ⟨g, hg, rfl⟩ := hm'
    simpa using hf g hg
  · simpa using hs k ((sort_perm _ _).mem_iff.mp hm)
  · simpa using hc c ((sort_perm _ _).mem_iff.mp hm)

/-- An agent's written file assignments never exceed what was requested, and without the agent's
own `writeFiles` permission every one of them is `read` ("narrow, never widen"). -/
@[aw_spec (tier := T2)
  (doc := "docs/adr/W9-UI-133-permission-cap-narrows-at-read-and-write.md#decision")
  (ts := "packages/core/src/db/repositories/agent-resources.ts#createDatabaseAgentResourceRepositoryProvider")]
theorem replace_never_widens_past_write_files (p : Agent.Permissions) (cat : Grant.CatalogIds)
    (req a : Grant.Assignments) (h : Grant.replace (some p) cat req = .updated a) :
    ∀ f ∈ a.files, ∃ g ∈ req.files, g.file = f.file ∧ f.access.le g.access = true ∧
      (p.writeFiles = false → f.access = .read) := by
  obtain ⟨rfl, -⟩ := replace_spec h
  intro f hf
  have hf' := (sort_perm _ _).mem_iff.mp hf
  rw [List.mem_map] at hf'
  obtain ⟨g, hg, rfl⟩ := hf'
  refine ⟨g, hg, rfl, ?_, ?_⟩
  · cases hw : p.writeFiles <;> cases hga : g.access <;>
      simp [Grant.narrow, Grant.FileAccess.le]
  · intro hw
    simp [Grant.narrow, hw]

/-- Replacing assignments writes each file, skill and connector at most once, as the three
natural keys require: a repeated file id is refused and repeated skill and connector ids are
merged. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/repositories/agent-resources.ts#createDatabaseAgentResourceRepositoryProvider")
  (ts := "packages/core/src/db/schema/agent-files.ts#agentFiles")]
theorem replace_writes_each_resource_once (p : Agent.Permissions) (cat : Grant.CatalogIds)
    (req a : Grant.Assignments) (h : Grant.replace (some p) cat req = .updated a) :
    (a.files.map (·.file)).Nodup ∧ a.skills.Nodup ∧ a.connectors.Nodup := by
  obtain ⟨rfl, hrep, -⟩ := replace_spec h
  refine ⟨?_, (sort_perm _ _).nodup_iff.mpr (dedup_nodup _),
    (sort_perm _ _).nodup_iff.mpr (dedup_nodup _)⟩
  simp only [Grant.readBack]
  rw [((sort_perm _ _).map _).nodup_iff, narrowed_ids]
  exact firstRepeat_none hrep

/-- The answer of a successful replacement holds every requested file, skill and connector id and
no other, whatever order the request used (the answer is the read-back, in id order). -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/repositories/agent-resources.ts#createDatabaseAgentResourceRepositoryProvider")]
theorem replace_keeps_every_requested_id (p : Agent.Permissions) (cat : Grant.CatalogIds)
    (req a : Grant.Assignments) (h : Grant.replace (some p) cat req = .updated a) :
    (∀ k, k ∈ a.skills ↔ k ∈ req.skills) ∧ (∀ c, c ∈ a.connectors ↔ c ∈ req.connectors) ∧
      (a.files.map (·.file)).Perm (req.files.map (·.file)) := by
  obtain ⟨rfl, -⟩ := replace_spec h
  refine ⟨fun k => ?_, fun c => ?_, ?_⟩
  · simp only [Grant.readBack]
    rw [(sort_perm _ _).mem_iff, mem_dedup]
  · simp only [Grant.readBack]
    rw [(sort_perm _ _).mem_iff, mem_dedup]
  · simp only [Grant.readBack]
    rw [← narrowed_ids p req.files]
    exact (sort_perm _ _).map _

/-- The answer of a successful replacement lists files, skills and connectors each in ascending
id order, as `read(agentId)` returns them (`orderBy(asc(...))`), not in request order. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/repositories/agent-resources.ts#createDatabaseAgentResourceRepositoryProvider")]
theorem replace_answers_in_id_order (p : Agent.Permissions) (cat : Grant.CatalogIds)
    (req a : Grant.Assignments) (h : Grant.replace (some p) cat req = .updated a) :
    a.files.Pairwise (fun f g => f.file ≤ g.file) ∧ a.skills.Pairwise (· ≤ ·) ∧
      a.connectors.Pairwise (· ≤ ·) := by
  obtain ⟨rfl, -⟩ := replace_spec h
  exact ⟨sort_sorted _ _, sort_sorted id _, sort_sorted id _⟩

/-- Replacement checks the file ids first: when the file ids are distinct and `id` is the first
requested file id that names no file of the workspace, the answer is `unknown-file` naming `id`,
whatever the skills and connectors are. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/repositories/agent-resources.ts#ReplaceAgentResourcesOutcome")
  (ts := "packages/core/src/db/repositories/agent-resources.ts#createDatabaseAgentResourceRepositoryProvider")]
theorem replace_reports_the_first_uncatalogued_file (p : Agent.Permissions)
    (cat : Grant.CatalogIds) (req : Grant.Assignments) (pre post : List String) (id : String)
    (hids : req.files.map (·.file) = pre ++ id :: post) (hn : (req.files.map (·.file)).Nodup)
    (hpre : ∀ x ∈ pre, x ∈ cat.files) (hid : id ∉ cat.files) :
    Grant.replace (some p) cat req = .unknownFile id := by
  have hfind : (req.files.map (·.file)).find? (fun i => !cat.files.contains i) = some id := by
    rw [hids]
    exact find_first (fun y hy => by simp [hpre y hy]) (by simp [hid])
  simp only [Grant.replace, narrowed_ids, firstRepeat_of_nodup hn, hfind]

/-- Replacement checks the skill ids second: when every file id is distinct and catalogued and
`id` is the first requested skill id that names no skill of the workspace, the answer is
`unknown-skill` naming `id`, whatever the connectors are. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/repositories/agent-resources.ts#ReplaceAgentResourcesOutcome")
  (ts := "packages/core/src/db/repositories/agent-resources.ts#createDatabaseAgentResourceRepositoryProvider")]
theorem replace_reports_the_first_uncatalogued_skill (p : Agent.Permissions)
    (cat : Grant.CatalogIds) (req : Grant.Assignments) (pre post : List String) (id : String)
    (hn : (req.files.map (·.file)).Nodup) (hf : ∀ f ∈ req.files, f.file ∈ cat.files)
    (hsk : req.skills = pre ++ id :: post) (hpre : ∀ x ∈ pre, x ∈ cat.skills)
    (hid : id ∉ cat.skills) :
    Grant.replace (some p) cat req = .unknownSkill id := by
  have hfiles : (req.files.map (·.file)).find? (fun i => !cat.files.contains i) = none :=
    find_none_of_all fun y hy => by
      obtain ⟨g, hg, rfl⟩ := List.mem_map.mp hy
      simp [hf g hg]
  have hfind : (Grant.dedup req.skills).find? (fun i => !cat.skills.contains i) = some id := by
    rw [find_dedup, hsk]
    exact find_first (fun y hy => by simp [hpre y hy]) (by simp [hid])
  simp only [Grant.replace, narrowed_ids, firstRepeat_of_nodup hn, hfiles, hfind]

/-- Replacement checks the connector ids last: when every file id is distinct and catalogued,
every skill id is catalogued, and `id` is the first requested connector id that names no
connector of the workspace, the answer is `unknown-connector` naming `id`. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/repositories/agent-resources.ts#ReplaceAgentResourcesOutcome")
  (ts := "packages/core/src/db/repositories/agent-resources.ts#createDatabaseAgentResourceRepositoryProvider")]
theorem replace_reports_the_first_uncatalogued_connector (p : Agent.Permissions)
    (cat : Grant.CatalogIds) (req : Grant.Assignments) (pre post : List String) (id : String)
    (hn : (req.files.map (·.file)).Nodup) (hf : ∀ f ∈ req.files, f.file ∈ cat.files)
    (hs : ∀ k ∈ req.skills, k ∈ cat.skills)
    (hco : req.connectors = pre ++ id :: post) (hpre : ∀ x ∈ pre, x ∈ cat.connectors)
    (hid : id ∉ cat.connectors) :
    Grant.replace (some p) cat req = .unknownConnector id := by
  have hfiles : (req.files.map (·.file)).find? (fun i => !cat.files.contains i) = none :=
    find_none_of_all fun y hy => by
      obtain ⟨g, hg, rfl⟩ := List.mem_map.mp hy
      simp [hf g hg]
  have hskills : (Grant.dedup req.skills).find? (fun i => !cat.skills.contains i) = none := by
    rw [find_dedup]
    exact find_none_of_all fun y hy => by simp [hs y hy]
  have hfind :
      (Grant.dedup req.connectors).find? (fun i => !cat.connectors.contains i) = some id := by
    rw [find_dedup, hco]
    exact find_first (fun y hy => by simp [hpre y hy]) (by simp [hid])
  simp only [Grant.replace, narrowed_ids, firstRepeat_of_nodup hn, hfiles, hskills, hfind]

private theorem files_ok {cat : Grant.CatalogIds} {req : Grant.Assignments}
    (hf : (req.files.map (·.file)).find? (fun i => !cat.files.contains i) = none) :
    ∀ f ∈ req.files, f.file ∈ cat.files := fun f hm => by
  simpa using List.find?_eq_none.mp hf _ (List.mem_map_of_mem (f := (·.file)) hm)

/-- The check order, read back from the answer: an `unknown-skill` answer means every file id was
distinct and catalogued, and an `unknown-connector` answer means that and every skill id was
catalogued; the id named is a requested id outside the catalog. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/repositories/agent-resources.ts#ReplaceAgentResourcesOutcome")
  (ts := "packages/core/src/db/repositories/agent-resources.ts#createDatabaseAgentResourceRepositoryProvider")]
theorem replace_checks_files_then_skills_then_connectors (p : Agent.Permissions)
    (cat : Grant.CatalogIds) (req : Grant.Assignments) (id : String) :
    (Grant.replace (some p) cat req = .unknownSkill id →
        (req.files.map (·.file)).Nodup ∧ (∀ f ∈ req.files, f.file ∈ cat.files) ∧
          id ∈ req.skills ∧ id ∉ cat.skills) ∧
      (Grant.replace (some p) cat req = .unknownConnector id →
        (req.files.map (·.file)).Nodup ∧ (∀ f ∈ req.files, f.file ∈ cat.files) ∧
          (∀ k ∈ req.skills, k ∈ cat.skills) ∧ id ∈ req.connectors ∧ id ∉ cat.connectors) := by
  constructor
  · intro h
    simp only [Grant.replace, narrowed_ids] at h
    split at h
    · simp at h
    · rename_i hrep
      split at h
      · simp at h
      · rename_i hf
        split at h
        · rename_i k hs
          simp only [Grant.ReplaceOutcome.unknownSkill.injEq] at h
          subst h
          have hm := List.mem_of_find?_eq_some hs
          have hp := List.find?_some hs
          exact ⟨firstRepeat_none hrep, files_ok hf, mem_dedup.mp hm, by simpa using hp⟩
        · split at h <;> simp at h
  · intro h
    simp only [Grant.replace, narrowed_ids] at h
    split at h
    · simp at h
    · rename_i hrep
      split at h
      · simp at h
      · rename_i hf
        split at h
        · simp at h
        · rename_i hs
          split at h
          · rename_i c hc
            simp only [Grant.ReplaceOutcome.unknownConnector.injEq] at h
            subst h
            have hm := List.mem_of_find?_eq_some hc
            have hp := List.find?_some hc
            refine ⟨firstRepeat_none hrep, files_ok hf, fun k hk => ?_, mem_dedup.mp hm,
              by simpa using hp⟩
            simpa using List.find?_eq_none.mp hs _ (mem_dedup.mpr hk)
          · simp at h

/-- Whatever access a stored `agent_files` row carries, reading an agent's assignments without
its `writeFiles` permission yields only `read` access (a stale `read-write` row is narrowed on
read). -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/repositories/agent-resources.ts#createDatabaseAgentResourceRepositoryProvider")
  (doc := "docs/adr/W9-UI-133-permission-cap-narrows-at-read-and-write.md#decision")]
theorem read_narrows_stale_write_access (p : Agent.Permissions) (stored : Grant.Assignments)
    (hw : p.writeFiles = false) : ∀ f ∈ (Grant.effective p stored).files, f.access = .read := by
  intro f hf
  simp only [Grant.effective, List.mem_map] at hf
  obtain ⟨g, -, rfl⟩ := hf
  simp [Grant.narrow, hw]

section Witnesses
open Grant

private def cat : CatalogIds := ⟨["f1", "f2"], ["k1", "k2"], ["c1"]⟩
private def perms (w : Bool) : Agent.Permissions := ⟨true, w, false, false⟩
private def req : Assignments :=
  ⟨[⟨"f2", .readWrite⟩, ⟨"f1", .read⟩], ["k2", "k1", "k2"], ["c1"]⟩
private def answer (w : Bool) : Assignments :=
  ⟨[⟨"f1", .read⟩, ⟨"f2", if w then .readWrite else .read⟩], ["k1", "k2"], ["c1"]⟩

/- The request lists `f2` before `f1` and `k2` before `k1`; the answer is in id order. -/
example : replace (some (perms false)) cat req = .updated (answer false) := by decide +kernel
example : replace (some (perms true)) cat req = .updated (answer true) := by decide +kernel
example : (answer false).files.map (·.file) ≠ req.files.map (·.file) := by decide +kernel
example : (∀ f ∈ (answer false).files, f.file ∈ cat.files) :=
  (replace_assigns_only_catalogued_resources (perms false) cat req _ (by decide +kernel)).1
example : ∀ f ∈ (answer false).files, ∃ g ∈ req.files,
    g.file = f.file ∧ f.access.le g.access = true ∧
      ((perms false).writeFiles = false → f.access = .read) :=
  replace_never_widens_past_write_files (perms false) cat req _ (by decide +kernel)
example : ((answer true).files.map (·.file)).Nodup ∧ (answer true).skills.Nodup ∧
    (answer true).connectors.Nodup :=
  replace_writes_each_resource_once (perms true) cat req _ (by decide +kernel)
example : (∀ k, k ∈ (answer true).skills ↔ k ∈ req.skills) ∧
    (∀ c, c ∈ (answer true).connectors ↔ c ∈ req.connectors) ∧
    ((answer true).files.map (·.file)).Perm (req.files.map (·.file)) :=
  replace_keeps_every_requested_id (perms true) cat req _ (by decide +kernel)
example : (answer true).files.Pairwise (fun f g => f.file ≤ g.file) ∧
    (answer true).skills.Pairwise (· ≤ ·) ∧ (answer true).connectors.Pairwise (· ≤ ·) :=
  replace_answers_in_id_order (perms true) cat req _ (by decide +kernel)

/- A request with an unknown file `f9`, an unknown skill `k9` and an unknown connector `c9`:
the file is reported; with the file fixed, the skill; with the skill fixed too, the connector. -/
private def allUnknown : Assignments := ⟨[⟨"f1", .read⟩, ⟨"f9", .read⟩], ["k9"], ["c9"]⟩
example : replace (some (perms true)) cat allUnknown = .unknownFile "f9" :=
  replace_reports_the_first_uncatalogued_file _ _ _ ["f1"] [] "f9" rfl (by decide +kernel) (by decide +kernel)
    (by decide +kernel)
example : replace (some (perms true)) cat { allUnknown with files := [⟨"f1", .read⟩] } =
    .unknownSkill "k9" :=
  replace_reports_the_first_uncatalogued_skill _ _ _ [] [] "k9" (by decide +kernel) (by decide +kernel) rfl
    (by decide +kernel) (by decide +kernel)
example : replace (some (perms true)) cat
    { allUnknown with files := [⟨"f1", .read⟩], skills := ["k1", "k1"] } =
      .unknownConnector "c9" :=
  replace_reports_the_first_uncatalogued_connector _ _ _ [] [] "c9" (by decide +kernel) (by decide +kernel)
    (by decide +kernel) rfl (by decide +kernel) (by decide +kernel)
example : ([(⟨"f1", .read⟩ : FileEntry)].map (·.file)).Nodup ∧
    (∀ f ∈ [(⟨"f1", .read⟩ : FileEntry)], f.file ∈ cat.files) ∧
    "k9" ∈ ["k9"] ∧ "k9" ∉ cat.skills :=
  (replace_checks_files_then_skills_then_connectors (perms true) cat
    { allUnknown with files := [⟨"f1", .read⟩] } "k9").1 (by decide +kernel)
example : ([(⟨"f1", .read⟩ : FileEntry)].map (·.file)).Nodup ∧
    (∀ f ∈ [(⟨"f1", .read⟩ : FileEntry)], f.file ∈ cat.files) ∧
    (∀ k ∈ ["k1"], k ∈ cat.skills) ∧ "c9" ∈ ["c9"] ∧ "c9" ∉ cat.connectors :=
  (replace_checks_files_then_skills_then_connectors (perms true) cat
    { allUnknown with files := [⟨"f1", .read⟩], skills := ["k1"] } "c9").2 (by decide +kernel)
example : ∀ f ∈ (effective (perms false) ⟨[⟨"f1", .readWrite⟩], [], []⟩).files,
    f.access = .read :=
  read_narrows_stale_write_access _ _ rfl

end Witnesses

/-! ## Grants -/

private theorem lookup_spec {ps : List Grant.PrincipalView} {r : PrincipalId}
    {q : Grant.PrincipalView} (h : Grant.lookupGrantable ps r = some q) :
    q ∈ ps ∧ q.id = r ∧ q.grantable = true := by
  unfold Grant.lookupGrantable at h
  have hm := List.mem_of_find?_eq_some h
  have hp := List.find?_some h
  simp only [Bool.and_eq_true, beq_iff_eq] at hp
  exact ⟨hm, hp.1, hp.2⟩

/-- The grants round trip: when every user is behind at most one principal of the workspace (one
membership per user and one principal per membership), reading the grants back after replacing
them with a set of principal ids yields exactly that set, although the table stores users. -/
@[aw_spec (tier := T2)
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")
  (ts := "packages/core/src/db/repositories/agent-grants.ts#createDatabaseAgentGrantRepositoryProvider")]
theorem grants_round_trip (ps : List Grant.PrincipalView) (req : List PrincipalId)
    (users : List UserId)
    (hone : ∀ p ∈ ps, ∀ q ∈ ps, p.user.isSome = true → p.user = q.user → p = q)
    (h : Grant.grantsReplace true ps req = .updated users) :
    ∀ x, x ∈ Grant.grantsRead ps users ↔ x ∈ req := by
  simp only [Grant.grantsReplace, Bool.not_true, Bool.false_eq_true, ite_false] at h
  split at h
  · simp at h
  · rename_i hf
    simp only [Grant.GrantsOutcome.updated.injEq] at h
    subst h
    have hall : ∀ r ∈ req, ∃ q, Grant.lookupGrantable ps r = some q := by
      intro r hr
      have := List.find?_eq_none.mp hf r hr
      simp only [Option.isNone_iff_eq_none] at this
      exact Option.ne_none_iff_exists'.mp this
    intro x
    simp only [Grant.grantsRead, List.mem_map, List.mem_filter, Bool.and_eq_true]
    constructor
    · rintro ⟨p, ⟨hp, hg, hu⟩, rfl⟩
      obtain ⟨u, hpu⟩ := Option.isSome_iff_exists.mp (by
        simp only [Grant.PrincipalView.grantable, Bool.and_eq_true] at hg; exact hg.1)
      rw [hpu] at hu
      simp only [Option.any_some, List.contains_iff_mem, List.mem_filterMap] at hu
      obtain ⟨r, hr, hb⟩ := hu
      obtain ⟨q, hq⟩ := hall r hr
      rw [hq] at hb
      obtain ⟨hqm, hqid, -⟩ := lookup_spec hq
      simp only [Option.bind_some] at hb
      have : p = q := hone p hp q hqm (by rw [hpu]; rfl) (by rw [hpu, hb])
      subst this
      rw [hqid]
      exact hr
    · intro hx
      obtain ⟨q, hq⟩ := hall x hx
      obtain ⟨hqm, hqid, hg⟩ := lookup_spec hq
      obtain ⟨u, hqu⟩ := Option.isSome_iff_exists.mp (by
        simp only [Grant.PrincipalView.grantable, Bool.and_eq_true] at hg; exact hg.1)
      refine ⟨q, ⟨hqm, hg, ?_⟩, hqid⟩
      rw [hqu]
      simp only [Option.any_some, List.contains_iff_mem, List.mem_filterMap]
      exact ⟨x, hx, by rw [hq]; simp [hqu]⟩

/-- Reading grants names only active membership principals of the workspace: never an API-key
principal and never a revoked one. -/
@[aw_spec (tier := T2)
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#membership-roles")
  (ts := "packages/core/src/db/repositories/agent-grants.ts#createDatabaseAgentGrantRepositoryProvider")]
theorem grants_read_names_only_active_members (ps : List Grant.PrincipalView)
    (users : List UserId) :
    ∀ x ∈ Grant.grantsRead ps users, ∃ p ∈ ps, p.id = x ∧ p.user.isSome = true ∧
      p.revoked = false := by
  intro x hx
  simp only [Grant.grantsRead, List.mem_map, List.mem_filter, Bool.and_eq_true,
    Grant.PrincipalView.grantable, Bool.not_eq_true'] at hx
  obtain ⟨p, ⟨hp, ⟨hs, hr⟩, -⟩, rfl⟩ := hx
  exact ⟨p, hp, rfl, hs, hr⟩

section GrantWitnesses
open Grant

private def pv (i : String) (u : Option String) (rev : Bool) : PrincipalView :=
  ⟨⟨i⟩, u.map Id.mk, rev⟩
private def principals : List PrincipalView :=
  [pv "p1" (some "u1") false, pv "p2" (some "u2") false, pv "k1" none false]

example : ∀ x, x ∈ grantsRead principals [⟨"u2"⟩] ↔ x ∈ [(⟨"p2"⟩ : PrincipalId)] :=
  grants_round_trip principals [⟨"p2"⟩] [⟨"u2"⟩] (by decide +kernel) (by decide +kernel)
example : ∀ x ∈ grantsRead principals [⟨"u2"⟩], ∃ p ∈ principals, p.id = x ∧
    p.user.isSome = true ∧ p.revoked = false :=
  grants_read_names_only_active_members _ _

end GrantWitnesses

/-! ## The catalog upserts and subtree operations -/

/-- A file upload at a path that already exists updates the row's content and never its id,
owner or creator: "an upsert at an existing path never transfers it". -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/repositories/resource-catalogs.ts#CatalogFile")]
theorem put_file_never_transfers_owner (ws : WorkspaceId) (fresh : FileId) (input : File.PutFile)
    (fs : List File.File) (f : File.File) (hf : f ∈ fs) (hp : f.path = input.path) :
    ∃ f' ∈ File.putFile ws fresh input fs, f'.id = f.id ∧ f'.owner = f.owner ∧
      f'.createdBy = f.createdBy ∧ f'.path = input.path ∧ f'.storageKey = input.storageKey := by
  have hany : fs.any (·.path == input.path) = true :=
    List.any_eq_true.mpr ⟨f, hf, by simp [hp]⟩
  simp only [File.putFile, hany, ite_true]
  refine ⟨_, List.mem_map_of_mem hf, ?_⟩
  simp [hp]

/-- A file upload at a new path creates a row owned by the uploading principal. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/repositories/resource-catalogs.ts#CatalogFile")
  (doc := "docs/sdk/site/concepts/ownership-and-sharing.mdx#what-you-can-and-cannot-do-today")]
theorem put_file_at_a_new_path_is_owned_by_the_caller (ws : WorkspaceId) (fresh : FileId)
    (input : File.PutFile) (fs : List File.File) (hnew : ∀ f ∈ fs, f.path ≠ input.path) :
    ∃ f' ∈ File.putFile ws fresh input fs, f'.id = fresh ∧ f'.owner = input.owner ∧
      f'.workspace = ws ∧ f'.path = input.path := by
  have hany : fs.any (·.path == input.path) = false := by
    simp only [List.any_eq_false, beq_iff_eq]
    exact hnew
  simp only [File.putFile, hany, Bool.false_eq_true, ite_false]
  exact ⟨_, List.mem_append_right _ (List.mem_singleton_self _), rfl, rfl, rfl, rfl⟩

/-- A skill import under a name that already exists updates `SKILL.md` and `enabled` and never
the row's id, owner or creator. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/repositories/resource-catalogs.ts#CatalogSkill")]
theorem put_skill_never_transfers_owner (ws : WorkspaceId) (fresh : SkillId)
    (input : Skill.PutSkill) (ss : List Skill.Skill) (s : Skill.Skill) (hs : s ∈ ss)
    (hn : s.name = input.name) :
    ∃ s' ∈ Skill.putSkill ws fresh input ss, s'.id = s.id ∧ s'.owner = s.owner ∧
      s'.createdBy = s.createdBy ∧ s'.skillMd = input.skillMd := by
  have hany : ss.any (·.name == input.name) = true :=
    List.any_eq_true.mpr ⟨s, hs, by simp [hn]⟩
  simp only [Skill.putSkill, hany, ite_true]
  refine ⟨_, List.mem_map_of_mem hs, ?_⟩
  simp [hn]

/-- A subtree move rewrites paths by `UPDATE`, so every row keeps its id, workspace, owner and
creator, and with them every assignment and project link that names it. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/repositories/resource-catalogs.ts#ResourceCatalogRepository")
  (doc := "docs/sdk/04-api-specification.md#56-files--awfiles")]
theorem rename_by_prefix_keeps_every_identity (old new : String) (fs : List File.File) :
    (File.renameByPrefix old new fs).map (fun f => (f.id, f.workspace, f.owner, f.createdBy)) =
      fs.map (fun f => (f.id, f.workspace, f.owner, f.createdBy)) := by
  simp only [File.renameByPrefix, List.map_map, Function.comp_def]
  congr 1
  funext f
  by_cases h : File.underPrefix old f.path = true <;> simp [h]

/-- A subtree move leaves every row outside the prefix exactly as it was. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/repositories/resource-catalogs.ts#pathUnderPrefix")]
theorem rename_by_prefix_leaves_other_rows_alone (old new : String) (fs : List File.File)
    (f : File.File) (hf : f ∈ fs) (hout : File.underPrefix old f.path = false) :
    f ∈ File.renameByPrefix old new fs := by
  simp only [File.renameByPrefix, List.mem_map]
  exact ⟨f, hf, by simp [hout]⟩

/-- A subtree move keeps each file's object key at its path: a row whose key is its own path (as
every upload writes it) or which is a folder with no key still has that shape after the move. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/repositories/resource-catalogs.ts#createDatabaseResourceCatalogRepositoryProvider")
  (ts := "packages/core/src/db/schema/files.ts#files")]
theorem rename_by_prefix_keeps_the_key_at_the_path (old new : String) (fs : List File.File)
    (h : ∀ f ∈ fs, f.storageKey = if f.kind = .file then some f.path else none) :
    ∀ g ∈ File.renameByPrefix old new fs,
      g.storageKey = if g.kind = .file then some g.path else none := by
  intro g hg
  simp only [File.renameByPrefix, List.mem_map] at hg
  obtain ⟨f, hf, rfl⟩ := hg
  have hk := h f hf
  by_cases hu : File.underPrefix old f.path = true
  · cases hkind : f.kind <;> simp_all
  · simp [hu, hk]

/-- A subtree move renames every row under the prefix: its new path is the new prefix followed by
what followed the old one. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/repositories/resource-catalogs.ts#createDatabaseResourceCatalogRepositoryProvider")]
theorem rename_by_prefix_moves_the_rows_under_it (old new : String) (fs : List File.File)
    (f : File.File) (hf : f ∈ fs) (hin : File.underPrefix old f.path = true) :
    ∃ g ∈ File.renameByPrefix old new fs, g.id = f.id ∧ g.path = File.renamePath old new f.path := by
  simp only [File.renameByPrefix, List.mem_map]
  exact ⟨_, ⟨f, hf, rfl⟩, by simp [hin], by simp [hin, File.renamePath]⟩

/-- A subtree delete keeps exactly the rows outside the prefix. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/repositories/resource-catalogs.ts#pathUnderPrefix")]
theorem delete_by_prefix_keeps_exactly_the_other_rows (pre : String) (fs : List File.File)
    (f : File.File) :
    f ∈ File.deleteByPrefix pre fs ↔ f ∈ fs ∧ File.underPrefix pre f.path = false := by
  simp [File.deleteByPrefix, List.mem_filter]

section CatalogWitnesses

private def fileA : File.File :=
  ⟨⟨"f1"⟩, ⟨"w1"⟩, "docs/a.md", .file, some "files/k", 3, none, some ⟨"u1"⟩, ⟨"p1"⟩⟩
private def fileB : File.File :=
  ⟨⟨"f2"⟩, ⟨"w1"⟩, "docs2/b.md", .file, some "files/k2", 3, none, none, ⟨"p2"⟩⟩
private def upload : File.PutFile :=
  ⟨"docs/a.md", .file, some "files/k3", 5, none, none, ⟨"p9"⟩⟩

example : ∃ f' ∈ File.putFile ⟨"w1"⟩ ⟨"f9"⟩ upload [fileA, fileB], f'.id = fileA.id ∧
    f'.owner = fileA.owner ∧ f'.createdBy = fileA.createdBy ∧ f'.path = upload.path ∧
    f'.storageKey = upload.storageKey :=
  put_file_never_transfers_owner _ _ _ _ fileA (by simp) rfl
example : ∃ f' ∈ File.putFile ⟨"w1"⟩ ⟨"f9"⟩ { upload with path := "new.md" } [fileA, fileB],
    f'.id = ⟨"f9"⟩ ∧ f'.owner = upload.owner ∧ f'.workspace = ⟨"w1"⟩ ∧ f'.path = "new.md" :=
  put_file_at_a_new_path_is_owned_by_the_caller _ _ _ _ (by decide +kernel)
example : ∃ s' ∈ Skill.putSkill ⟨"w1"⟩ ⟨"k9"⟩ ⟨"notes", "# v2", true, none, ⟨"p9"⟩⟩
      [⟨⟨"k1"⟩, ⟨"w1"⟩, "notes", "# v1", true, some ⟨"u1"⟩, ⟨"p1"⟩⟩],
    s'.id = ⟨"k1"⟩ ∧ s'.owner = ⟨"p1"⟩ ∧ s'.createdBy = some ⟨"u1"⟩ ∧ s'.skillMd = "# v2" :=
  put_skill_never_transfers_owner _ _ _ _ _ (List.mem_singleton_self _) rfl
example : fileB ∈ File.renameByPrefix "docs" "archive" [fileA, fileB] :=
  rename_by_prefix_leaves_other_rows_alone _ _ _ _ (by simp) (by decide +kernel)
private def keyedA : File.File :=
  ⟨⟨"f1"⟩, ⟨"w1"⟩, "docs/a.md", .file, some "docs/a.md", 3, none, none, ⟨"p1"⟩⟩
private def keyedDir : File.File :=
  ⟨⟨"f3"⟩, ⟨"w1"⟩, "docs", .folder, none, 0, none, none, ⟨"p1"⟩⟩
example : ∀ g ∈ File.renameByPrefix "docs" "archive" [keyedA, keyedDir],
    g.storageKey = if g.kind = .file then some g.path else none :=
  rename_by_prefix_keeps_the_key_at_the_path _ _ _ (by decide +kernel)
example : File.renameByPrefix "docs" "archive" [keyedA] =
    [{ keyedA with path := "archive/a.md", storageKey := some "archive/a.md" }] := by decide +kernel
example : ∃ g ∈ File.renameByPrefix "docs" "archive" [keyedA, keyedDir], g.id = keyedA.id ∧
    g.path = "archive/a.md" :=
  rename_by_prefix_moves_the_rows_under_it _ _ _ keyedA (by simp) (by decide +kernel)
example : fileB ∈ File.deleteByPrefix "docs" [fileA, fileB] ↔
    fileB ∈ [fileA, fileB] ∧ File.underPrefix "docs" fileB.path = false :=
  delete_by_prefix_keeps_exactly_the_other_rows _ _ _

end CatalogWitnesses

/-! ## The connector create path establishes the shape checks -/

private theorem notBlank_of_trim {s : String} (h : Connector.jsTrimIsEmpty s = false) :
    File.notBlank s = true := by
  unfold Connector.jsTrimIsEmpty at h
  unfold File.notBlank
  rw [List.all_eq_false] at h
  obtain ⟨c, hc, hw⟩ := h
  rw [List.any_eq_true]
  refine ⟨c, hc, ?_⟩
  simp only [bne_iff_ne, ne_eq]
  intro heq
  subst heq
  exact hw (by decide +kernel)

section Parser
open Connector

private theorem shape_stdio (b : Body) (h : (shapeOf b (some .stdio)).1 = []) :
    ∃ s, (shapeOf b (some .stdio)).2.1 = some s ∧ jsTrimIsEmpty s = false ∧
      (shapeOf b (some .stdio)).2.2.2 = none := by
  simp only [shapeOf] at h ⊢
  split at h <;> (try split at h) <;> simp_all

private theorem shape_remote (b : Body) (t : Transport) (ht : t ≠ .stdio)
    (h : (shapeOf b (some t)).1 = []) :
    (shapeOf b (some t)).2.1 = none ∧ (shapeOf b (some t)).2.2.1 = none ∧
      ∃ s, (shapeOf b (some t)).2.2.2 = some s ∧ urlShape s = true := by
  cases t with
  | stdio => exact absurd rfl ht
  | http | sse =>
    simp only [shapeOf] at h ⊢
    split at h <;> (try split at h) <;> simp_all

private theorem cred (af cf : Field) (a : AuthType) (ha : authOf af = some a)
    (h : (credentialOf af cf).1 = []) :
    (credentialOf af cf).2.isSome = a.needsCredential ∧
      (credentialOf af cf).2.all (fun s => jsTrimIsEmpty s = false) := by
  cases af with
  | str s =>
    have hw : WireEnum.toWire a = s := WireEnum.toWire_ofWire? ha
    simp only [credentialOf] at h ⊢
    by_cases hn : s = "none"
    · subst hn
      have : a = .none := by cases a <;> simp_all [WireEnum.toWire, AuthType.toWire]
      subst this
      by_cases hcf : cf = Field.absent <;> simp_all [AuthType.needsCredential]
    · have : a.needsCredential = true := by
        cases a <;> simp_all [WireEnum.toWire, AuthType.toWire, AuthType.needsCredential]
      simp only [bne_iff_ne, ne_eq, hn, not_false_eq_true, ite_true] at h ⊢
      split at h <;> (try split at h) <;> simp_all
  | _ => simp [authOf] at ha

private theorem parsed_shape (b : Body) (p : Parsed) (h : parseBody (some b) = .ok p) :
    (p.transport = .stdio → (∃ s, p.command = some s ∧ jsTrimIsEmpty s = false) ∧
      p.url = none) ∧
    (p.transport ≠ .stdio → p.command = none ∧ p.args = none ∧
      ∃ s, p.url = some s ∧ urlShape s = true) ∧
    p.credential.isSome = p.authType.needsCredential ∧
    p.credential.all (fun s => jsTrimIsEmpty s = false) := by
  simp only [parseBody] at h
  cases ht : transportOf b.transport with
  | none => simp only [ht] at h; split at h <;> simp_all
  | some t =>
    cases ha : authOf (authFieldOf b.authType) with
    | none => simp only [ht, ha] at h; split at h <;> simp_all
    | some a =>
      simp only [ht, ha] at h
      split at h
      · rename_i herr _ htt haa
        simp only [Option.some.injEq] at htt haa
        subst htt haa
        simp only [Except.ok.injEq] at h
        subst h
        simp only [List.append_eq_nil_iff] at herr
        obtain ⟨⟨_, hs⟩, hc⟩ := herr
        refine ⟨?_, ?_, cred _ _ _ ha hc⟩
        · intro hst
          subst hst
          obtain ⟨s, h1, h2, h3⟩ := shape_stdio b hs
          exact ⟨⟨s, h1, h2⟩, h3⟩
        · intro hst
          exact shape_remote b _ hst hs
      · simp at h
      · simp at h

end Parser

/-- "Validating here means the database's constraints are a backstop": every body
`parseCreateConnectorBody` accepts yields a row that passes the six shape checks of `mcp_servers`
(command xor URL by transport, arguments only for `stdio`, a non-blank command, an absolute
`http(s)` URL, and a credential secret exactly when the authentication type needs one). -/
@[aw_spec (tier := T2) (ts := "apps/web/server/connectors/contract.ts#parseCreateConnectorBody")
  (doc := "docs/sdk/04-api-specification.md#58-connectors-mcp-servers--awconnectors")]
theorem created_connector_meets_the_shape_checks (b : Connector.Body) (p : Connector.Parsed)
    (h : Connector.parseBody (some b) = .ok p) (id : ConnectorId) (ws : WorkspaceId)
    (sid : SecretId) (createdBy : Option UserId) (owner : PrincipalId) :
    (p.toConnector id ws sid createdBy owner).stdioHasCommand = true ∧
      (p.toConnector id ws sid createdBy owner).remoteHasUrl = true ∧
      (p.toConnector id ws sid createdBy owner).argsStdioOnly = true ∧
      (p.toConnector id ws sid createdBy owner).commandNotBlank = true ∧
      (p.toConnector id ws sid createdBy owner).urlShapeOk = true ∧
      (p.toConnector id ws sid createdBy owner).credentialRequired = true := by
  obtain ⟨hstdio, hremote, hcred, -⟩ := parsed_shape b p h
  simp only [Connector.Parsed.toConnector, Connector.Connector.stdioHasCommand,
    Connector.Connector.remoteHasUrl, Connector.Connector.argsStdioOnly,
    Connector.Connector.commandNotBlank, Connector.Connector.urlShapeOk,
    Connector.Connector.credentialRequired, Option.isSome_map]
  refine ⟨?_, ?_, ?_, ?_, ?_, by rw [hcred]; simp⟩
  all_goals
    by_cases hst : p.transport = .stdio
    · obtain ⟨⟨s, hc, hs⟩, hu⟩ := hstdio hst
      simp [hst, hc, hu, Connector.Transport.isRemote, notBlank_of_trim hs]
    · obtain ⟨hc, ha, s, hu, hs⟩ := hremote hst
      cases ht : p.transport <;> simp_all [Connector.Transport.isRemote]

/-- A `stdio` body with arguments is accepted. -/
private def stdioBody : Connector.Body :=
  { name := .str "Filesystem", transport := .str "stdio", command := .str "npx", args := .strs ["-y"] }

private def httpBody : Connector.Body :=
  { name := .str "GitHub", transport := .str "http", url := .str "https://example.com/mcp",
    authType := .str "bearer", credential := .str "token" }

example : ∃ p, Connector.parseBody (some stdioBody) = .ok p := ⟨_, rfl⟩

example :
    let p : Connector.Parsed := ⟨"GitHub", .http, none, none, some "https://example.com/mcp",
      .bearer, some "token"⟩
    (p.toConnector ⟨"c1"⟩ ⟨"w1"⟩ ⟨"s1"⟩ none ⟨"p1"⟩).stdioHasCommand = true ∧
      (p.toConnector ⟨"c1"⟩ ⟨"w1"⟩ ⟨"s1"⟩ none ⟨"p1"⟩).remoteHasUrl = true ∧
      (p.toConnector ⟨"c1"⟩ ⟨"w1"⟩ ⟨"s1"⟩ none ⟨"p1"⟩).argsStdioOnly = true ∧
      (p.toConnector ⟨"c1"⟩ ⟨"w1"⟩ ⟨"s1"⟩ none ⟨"p1"⟩).commandNotBlank = true ∧
      (p.toConnector ⟨"c1"⟩ ⟨"w1"⟩ ⟨"s1"⟩ none ⟨"p1"⟩).urlShapeOk = true ∧
      (p.toConnector ⟨"c1"⟩ ⟨"w1"⟩ ⟨"s1"⟩ none ⟨"p1"⟩).credentialRequired = true :=
  created_connector_meets_the_shape_checks httpBody _ rfl _ _ _ _ _

/-! ## Single-row catalog operations: rename, delete -/

/-- A single-file rename (`renameFile`) is an `UPDATE` of the row at the old path: the returned
row keeps that row's id, workspace, owner and creator, carries the new path, and is in the new
catalog ("a rename changes the row's path and content metadata, never who owns or originally
created it"). -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/repositories/resource-catalogs.ts#ResourceCatalogRepository")
  (ts := "packages/core/src/db/repositories/resource-catalogs.ts#createDatabaseResourceCatalogRepositoryProvider")]
theorem rename_file_keeps_the_rows_identity (path : String) (input : File.RenameFile)
    (fs fs' : List File.File) (row : File.File)
    (h : File.renameFile path input fs = .renamed fs' row) :
    ∃ f ∈ fs, f.path = path ∧ row.id = f.id ∧ row.workspace = f.workspace ∧
      row.owner = f.owner ∧ row.createdBy = f.createdBy ∧ row.path = input.path ∧ row ∈ fs' := by
  unfold File.renameFile at h
  split at h
  · cases h
  · rename_i f hf
    have hm := List.mem_of_find?_eq_some hf
    have hp : f.path = path := by simpa using List.find?_some hf
    split at h
    · cases h
    · simp only [File.RenameOutcome.renamed.injEq] at h
      obtain ⟨rfl, rfl⟩ := h
      refine ⟨f, hm, hp, rfl, rfl, rfl, rfl, rfl, ?_⟩
      exact List.mem_map.mpr ⟨f, hm, by simp [hp]⟩

/-- A single-file rename answers `null` exactly when no row of the workspace is at the old path. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/repositories/resource-catalogs.ts#createDatabaseResourceCatalogRepositoryProvider")]
theorem rename_file_is_missing_iff_no_row (path : String) (input : File.RenameFile)
    (fs : List File.File) :
    File.renameFile path input fs = .missing ↔ ∀ f ∈ fs, f.path ≠ path := by
  unfold File.renameFile
  constructor
  · intro h
    split at h
    · rename_i hf
      intro f hm hp
      have := List.find?_eq_none.mp hf f hm
      simp [hp] at this
    · split at h <;> cases h
  · intro h
    rw [List.find?_eq_none.mpr (fun f hm => by simpa using h f hm)]

/-- A single-file rename never lands on a path another row holds: a successful rename either
keeps the path or moves the row to a path no row had (PostgreSQL raises the
`files_workspace_path_key` violation otherwise). -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/schema/files.ts#files")
  (ts := "packages/core/src/db/repositories/resource-catalogs.ts#createDatabaseResourceCatalogRepositoryProvider")]
theorem rename_file_never_takes_an_occupied_path (path : String) (input : File.RenameFile)
    (fs fs' : List File.File) (row : File.File)
    (h : File.renameFile path input fs = .renamed fs' row) :
    input.path = path ∨ ∀ g ∈ fs, g.path ≠ input.path := by
  unfold File.renameFile at h
  split at h
  · cases h
  · split at h
    · cases h
    · rename_i hc
      by_cases he : input.path = path
      · exact Or.inl he
      · refine Or.inr fun g hg hgp => hc ?_
        simp only [bne_iff_ne, ne_eq, he, not_false_eq_true, Bool.and_eq_true,
          true_and, List.any_eq_true, beq_iff_eq]
        exact ⟨g, hg, hgp⟩

/-- A single-file rename leaves every row at another path exactly as it was. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/repositories/resource-catalogs.ts#createDatabaseResourceCatalogRepositoryProvider")]
theorem rename_file_leaves_other_rows_alone (path : String) (input : File.RenameFile)
    (fs fs' : List File.File) (row g : File.File)
    (h : File.renameFile path input fs = .renamed fs' row) (hg : g ∈ fs) (hp : g.path ≠ path) :
    g ∈ fs' := by
  unfold File.renameFile at h
  split at h
  · cases h
  · split at h
    · cases h
    · simp only [File.RenameOutcome.renamed.injEq] at h
      obtain ⟨rfl, -⟩ := h
      exact List.mem_map.mpr ⟨g, hg, by simp [hp]⟩

/-- Deleting one file (`deleteFile`) removes exactly the row at that path; unlike a subtree
delete, the rows under a folder's path stay. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/repositories/resource-catalogs.ts#createDatabaseResourceCatalogRepositoryProvider")]
theorem delete_file_removes_exactly_that_path (path : String) (fs : List File.File)
    (f : File.File) : f ∈ File.deleteFile path fs ↔ f ∈ fs ∧ f.path ≠ path := by
  simp [File.deleteFile, List.mem_filter]

/-- Deleting one skill (`deleteSkill`) removes exactly the row with that name. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/repositories/resource-catalogs.ts#createDatabaseResourceCatalogRepositoryProvider")]
theorem delete_skill_removes_exactly_that_name (name : String) (ss : List Skill.Skill)
    (s : Skill.Skill) : s ∈ Skill.deleteSkill name ss ↔ s ∈ ss ∧ s.name ≠ name := by
  simp [Skill.deleteSkill, List.mem_filter]

section RenameWitnesses

private def dirDocs : File.File :=
  ⟨⟨"f3"⟩, ⟨"w1"⟩, "docs", .folder, none, 0, none, none, ⟨"p1"⟩⟩
private def fileDocsA : File.File :=
  ⟨⟨"f1"⟩, ⟨"w1"⟩, "docs/a.md", .file, some "docs/a.md", 3, none, some ⟨"u1"⟩, ⟨"p1"⟩⟩
private def fileOther : File.File :=
  ⟨⟨"f2"⟩, ⟨"w1"⟩, "b.md", .file, some "b.md", 3, none, none, ⟨"p2"⟩⟩
private def toC : File.RenameFile := ⟨"c.md", .file, some "c.md", 4, none⟩
private def renamedA : File.File :=
  { fileDocsA with path := "c.md", storageKey := some "c.md", sizeBytes := 4 }

example : ∃ f ∈ [fileDocsA, fileOther], f.path = "docs/a.md" ∧ renamedA.id = f.id ∧
    renamedA.workspace = f.workspace ∧ renamedA.owner = f.owner ∧
    renamedA.createdBy = f.createdBy ∧ renamedA.path = toC.path ∧
    renamedA ∈ [renamedA, fileOther] :=
  rename_file_keeps_the_rows_identity "docs/a.md" toC [fileDocsA, fileOther] [renamedA, fileOther]
    renamedA (by decide +kernel)
example : File.renameFile "nowhere.md" toC [fileDocsA, fileOther] = .missing :=
  (rename_file_is_missing_iff_no_row _ _ _).mpr (by decide +kernel)
/- Renaming onto an occupied path is the unique-key violation, not a rename. -/
example : File.renameFile "docs/a.md" { toC with path := "b.md" } [fileDocsA, fileOther] =
    .conflict := by decide +kernel
example : toC.path = "docs/a.md" ∨ ∀ g ∈ [fileDocsA, fileOther], g.path ≠ toC.path :=
  rename_file_never_takes_an_occupied_path "docs/a.md" toC [fileDocsA, fileOther]
    [renamedA, fileOther] renamedA (by decide +kernel)
example : fileOther ∈ [renamedA, fileOther] :=
  rename_file_leaves_other_rows_alone "docs/a.md" toC [fileDocsA, fileOther]
    [renamedA, fileOther] renamedA fileOther (by decide +kernel) (by simp) (by decide +kernel)
/- Deleting the folder row keeps the file under it; the subtree delete removes both. -/
example : fileDocsA ∈ File.deleteFile "docs" [dirDocs, fileDocsA] :=
  (delete_file_removes_exactly_that_path _ _ _).mpr ⟨by simp, by decide⟩
example : File.deleteByPrefix "docs" [dirDocs, fileDocsA] = [] := by decide +kernel
example : (⟨⟨"k2"⟩, ⟨"w1"⟩, "b", "# b", true, none, ⟨"p1"⟩⟩ : Skill.Skill) ∈
    Skill.deleteSkill "a" [⟨⟨"k1"⟩, ⟨"w1"⟩, "a", "# a", true, none, ⟨"p1"⟩⟩,
      ⟨⟨"k2"⟩, ⟨"w1"⟩, "b", "# b", true, none, ⟨"p1"⟩⟩] :=
  (delete_skill_removes_exactly_that_name _ _ _).mpr ⟨by simp, by decide⟩

end RenameWitnesses

/-! ## The agent field parsers and the assignment body -/

private theorem trim_has_a_visible_char {s : String}
    (h : (Agent.jsTrim s).toList.isEmpty = false) :
    ∃ c ∈ (Agent.jsTrim s).toList, Connector.isJsWhitespace c = false := by
  unfold Agent.jsTrim at h ⊢
  rw [String.toList_ofList] at h ⊢
  generalize hm : List.dropWhile Connector.isJsWhitespace
    (List.dropWhile Connector.isJsWhitespace s.toList).reverse = m at h ⊢
  have hne : m ≠ [] := by
    intro he
    simp [he] at h
  refine ⟨m.head hne, List.mem_reverse.mpr (List.head_mem hne), ?_⟩
  have := List.head_dropWhile_not Connector.isJsWhitespace (l :=
    (List.dropWhile Connector.isJsWhitespace s.toList).reverse) (by rw [hm]; exact hne)
  simpa [hm] using this

private theorem not_blank_of_visible {s : String}
    (h : ∃ c ∈ s.toList, Connector.isJsWhitespace c = false) : File.notBlank s = true := by
  obtain ⟨c, hc, hw⟩ := h
  unfold File.notBlank
  refine List.any_eq_true.mpr ⟨c, hc, ?_⟩
  simp only [bne_iff_ne, ne_eq]
  rintro rfl
  simp [Connector.isJsWhitespace] at hw

/-- Every name `AgentNameRequestSchema` accepts passes the `agents_name_not_blank` check and the HTTP
bound, so an agent row carrying it is valid: the route's parser is at least as strict as the
table. -/
@[aw_spec (tier := T2) (ts := "packages/contracts/src/agents/resource.ts#AgentNameRequestSchema")
  (ts := "packages/core/src/db/schema/agents.ts#agents")]
theorem accepted_agent_name_passes_the_table_check (r : Agent.RawField) (n : String)
    (h : Agent.parseName r = .ok n) :
    File.notBlank n = true ∧ Agent.utf16Length n ≤ 200 ∧
      ∀ a : Agent.Agent, a.name = n → a.valid = true := by
  cases r with
  | str s =>
    simp only [Agent.parseName] at h
    split at h
    · cases h
    · rename_i hne
      split at h
      · cases h
      · rename_i hlen
        simp only [Except.ok.injEq] at h
        subst h
        have hnb := not_blank_of_visible (trim_has_a_visible_char (by simpa using hne))
        refine ⟨hnb, by simpa [Agent.bounds] using hlen, fun a ha => ?_⟩
        simp [Agent.Agent.valid, ha, hnb]
  | null => simp [Agent.parseName] at h
  | nonString d => simp [Agent.parseName] at h

/-- Every model id `AgentModelRequestSchema` accepts is `null` (the workspace default) or a trimmed,
non-blank string within `AGENT_MODEL_MAX_LENGTH`. -/
@[aw_spec (tier := T2) (ts := "packages/contracts/src/agents/resource.ts#AgentModelRequestSchema")
  (ts := "packages/contracts/src/agents.ts#AGENT_MODEL_MAX_LENGTH")]
theorem accepted_agent_model_is_default_or_visible (r : Agent.RawField) (m : Option String)
    (h : Agent.parseModel r = .ok m) :
    m = none ∨ ∃ t, m = some t ∧ File.notBlank t = true ∧ Agent.utf16Length t ≤ 200 := by
  cases r with
  | null =>
    simp only [Agent.parseModel, Except.ok.injEq] at h
    exact Or.inl h.symm
  | str s =>
    simp only [Agent.parseModel] at h
    split at h
    · cases h
    · rename_i hne
      split at h
      · cases h
      · rename_i hlen
        simp only [Except.ok.injEq] at h
        subst h
        exact Or.inr ⟨_, rfl, not_blank_of_visible (trim_has_a_visible_char (by simpa using hne)),
          by simpa [Agent.bounds] using hlen⟩
  | nonString d => simp [Agent.parseModel] at h

/-- Every instruction block `AgentInstructionsRequestSchema` accepts is the string sent, unchanged, and
within `AGENT_INSTRUCTIONS_MAX_LENGTH`. -/
@[aw_spec (tier := T2) (ts := "packages/contracts/src/agents/resource.ts#AgentInstructionsRequestSchema")
  (ts := "packages/contracts/src/agents.ts#AGENT_INSTRUCTIONS_MAX_LENGTH")]
theorem accepted_instructions_are_the_string_sent (r : Agent.RawField) (i : String)
    (h : Agent.parseInstructions r = .ok i) :
    r = .str i ∧ Agent.utf16Length i ≤ 100000 := by
  cases r with
  | str s =>
    simp only [Agent.parseInstructions] at h
    split at h
    · cases h
    · rename_i hlen
      simp only [Except.ok.injEq] at h
      subst h
      exact ⟨rfl, by simpa [Agent.bounds] using hlen⟩
  | null => simp [Agent.parseInstructions] at h
  | nonString d => simp [Agent.parseInstructions] at h

private theorem filterMap_ids (fs : List Grant.RawFileEntry)
    (h : ∀ e ∈ fs, (Grant.fileEntry? e).isSome = true) :
    (fs.filterMap Grant.fileEntry?).map (·.file) = fs.map (·.fileId) := by
  induction fs with
  | nil => rfl
  | cons e es ih =>
    have he := h e (List.mem_cons_self ..)
    have ih' := ih fun x hx => h x (List.mem_cons_of_mem _ hx)
    obtain ⟨g, hg⟩ := Option.isSome_iff_exists.mp he
    have hid : g.file = e.fileId := by
      unfold Grant.fileEntry? at hg
      split at hg
      · cases hg
      · obtain ⟨a, -, rfl⟩ := Option.map_eq_some_iff.mp hg
        rfl
    simp [hg, ih', hid]

/-- A body `AgentResourceAssignmentsSchema` accepts has no unknown key, a non-empty id and a
closed-set access on every file entry, and non-empty skill and connector ids, and the parsed
assignment keeps every id in order, repeats included (the schema does not refuse duplicates;
`replace` does, for files). -/
@[aw_spec (tier := T2) (ts := "packages/contracts/src/agents.ts#AgentResourceAssignmentsSchema")
  (doc := "docs/sdk/04-api-specification.md#59-agents--awagents")]
theorem accepted_assignment_body_keeps_every_id (b : Grant.RawAssignments)
    (a : Grant.Assignments) (h : Grant.assignmentsBody b = some a) :
    b.extra = [] ∧ (∀ e ∈ b.files, e.fileId ≠ "" ∧ (e.access = "read" ∨ e.access = "read-write")) ∧
      (∀ k ∈ b.skillIds, k ≠ "") ∧ (∀ c ∈ b.connectorIds, c ≠ "") ∧
      a.files.map (·.file) = b.files.map (·.fileId) ∧ a.skills = b.skillIds ∧
      a.connectors = b.connectorIds := by
  unfold Grant.assignmentsBody at h
  split at h
  · rename_i hc
    simp only [Option.some.injEq] at h
    subst h
    simp only [Bool.and_eq_true, List.isEmpty_iff, List.all_eq_true, Bool.not_eq_true'] at hc
    obtain ⟨⟨⟨hx, hf⟩, hs⟩, hco⟩ := hc
    refine ⟨hx, fun e he => ?_, fun k hk => by simpa using hs k hk,
      fun c hc => by simpa using hco c hc, filterMap_ids _ hf, rfl, rfl⟩
    have hs := hf e he
    unfold Grant.fileEntry? at hs
    split at hs
    · cases hs
    · rename_i hid
      refine ⟨by simpa using hid, ?_⟩
      rw [Option.isSome_map] at hs
      obtain ⟨acc, hacc⟩ := Option.isSome_iff_exists.mp hs
      have := WireEnum.toWire_ofWire? hacc
      cases acc <;> simp_all [WireEnum.toWire, Grant.FileAccess.toWire]
  · cases h

section ParserWitnesses

example : File.notBlank "Support" = true ∧ Agent.utf16Length "Support" ≤ 200 ∧
    ∀ a : Agent.Agent, a.name = "Support" → a.valid = true :=
  accepted_agent_name_passes_the_table_check (.str "  Support ") _ rfl
example : some "claude-sonnet-4-5" = none ∨ ∃ t, some "claude-sonnet-4-5" = some t ∧
    File.notBlank t = true ∧ Agent.utf16Length t ≤ 200 :=
  accepted_agent_model_is_default_or_visible (.str " claude-sonnet-4-5") _ rfl
example : (Agent.RawField.str "  keep  " = .str "  keep  ") ∧
    Agent.utf16Length "  keep  " ≤ 100000 :=
  accepted_instructions_are_the_string_sent _ _ rfl

private def dupBody : Grant.RawAssignments :=
  ⟨[⟨"f1", "read"⟩, ⟨"f1", "read-write"⟩], ["k1"], [], [], []⟩

/- The schema accepts a body whose file ids repeat; `replace` then refuses it. -/
example : Grant.assignmentsBody dupBody =
    some ⟨[⟨"f1", .read⟩, ⟨"f1", .readWrite⟩], ["k1"], []⟩ := by decide +kernel
example : dupBody.extra = [] ∧
    (∀ e ∈ dupBody.files, e.fileId ≠ "" ∧ (e.access = "read" ∨ e.access = "read-write")) ∧
    (∀ k ∈ dupBody.skillIds, k ≠ "") ∧ (∀ c ∈ dupBody.connectorIds, c ≠ "") ∧
    (([⟨"f1", .read⟩, ⟨"f1", .readWrite⟩] : List Grant.FileEntry)).map (·.file) =
      dupBody.files.map (·.fileId) ∧
    ["k1"] = dupBody.skillIds ∧ ([] : List String) = dupBody.connectorIds :=
  accepted_assignment_body_keeps_every_id dupBody ⟨[⟨"f1", .read⟩, ⟨"f1", .readWrite⟩], ["k1"], []⟩
    (by decide +kernel)
example : Grant.assignmentsBody { dupBody with files := [⟨"f1", "write"⟩] } = none := by decide +kernel
example : Grant.assignmentsBody { dupBody with skillIds := [""] } = none := by decide +kernel
example : Grant.assignmentsBody { dupBody with extra := ["policy"] } = none := by decide +kernel

end ParserWitnesses

end AgentWorkspace.Theorems.Invariants.ConceptCatalog
