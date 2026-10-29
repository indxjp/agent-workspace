import ErSnapshot
import AgentWorkspace.Er.Core

/-!
T0 — the table catalogue is well formed.

One theorem per table (`table_<name>_is_well_formed`) and one per foreign key
(`<constraint>_is_<class>`) is generated from `catalogue` by the `aw_er_catalogue_theorems`
command below, so the catalogue and its theorems cannot drift apart: adding a table or a key to
`Er/Core.lean` adds its theorem, and a key whose tenancy class changes fails its own theorem by
name. `aw_er_snapshot_theorems` generates one more theorem per table and per constraint whose
right-hand side is read from the latest snapshot (`Er.Snapshot.file`, generated), so every cell of the catalogue
(types, nullability, closed-set values, keys, actions) is pinned to what `drizzle-kit` recorded.
The remaining theorems state catalogue-wide facts.
-/

namespace AgentWorkspace.Theorems.WellFormed.ErCore

open AgentWorkspace AgentWorkspace.Er.Core

/-! ## Generated per-table and per-key theorems -/

section Generator

open Lean Elab Command

/-- A `/-- … -/` docstring node for generated declarations. -/
private def mkDocComment (text : String) : TSyntax ``Lean.Parser.Command.docComment :=
  ⟨mkNode ``Lean.Parser.Command.docComment #[mkAtom "/--", mkAtom (text ++ " -/")]⟩

/-- The constructor name of a table, from its SQL name (`agent_files` → `agentFiles`). -/
private def ctorName (sql : String) : Name :=
  match sql.splitOn "_" with
  | [] => .anonymous
  | w :: ws => Name.mkSimple (w ++ String.join (ws.map String.capitalize))

private def classSentence : FkClass → String
  | .rootReference => "is the table's reference to the tenant root `workspaces`"
  | .globalReference =>
    "references a global identity table without `workspace_id`, so it carries no workspace"
  | .tenantPaired =>
    "is tenant-paired: the child's and the parent's tenant columns sit at the same position of " ++
      "the key, so the database forces both rows into one workspace"
  | .siblingPaired =>
    "is covered by a tenant-paired sibling on the same column, which pins the same parent row " ++
      "in the child's workspace"
  | .unpaired => "is unpaired"

private def classSuffix : FkClass → String
  | .rootReference => "root_reference"
  | .globalReference => "global_reference"
  | .tenantPaired => "tenant_paired"
  | .siblingPaired => "sibling_paired"
  | .unpaired => "unpaired"

private def classTerm : FkClass → Name
  | .rootReference => ``FkClass.rootReference
  | .globalReference => ``FkClass.globalReference
  | .tenantPaired => ``FkClass.tenantPaired
  | .siblingPaired => ``FkClass.siblingPaired
  | .unpaired => ``FkClass.unpaired

private def erDoc : String := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces"
private def tablesDoc : String := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables"
private def isolationDoc : String := "docs/formal/inventory.md#4-tenant-isolation-predicates"
private def tenancyTest : String := "packages/core/src/db/schema/tenancy.test.ts#"

/-- The document and the `tenancy.test.ts` rule each foreign-key class is cited to. -/
private def classCitation : FkClass → String × String
  | .rootReference => (isolationDoc, tenancyTest ++ "TENANT_COLUMN")
  | .globalReference => (isolationDoc, tenancyTest ++ "TENANT_EXEMPT")
  | .tenantPaired => (erDoc, tenancyTest ++ "tenantPairingFault")
  | .siblingPaired => (isolationDoc, tenancyTest ++ "referenceIdentityOf")
  | .unpaired => (isolationDoc, tenancyTest ++ "tenantPairingFault")

/-- Elaborates one T0 theorem per table and per foreign key of `catalogue`. -/
elab "aw_er_catalogue_theorems" : command => do
  for t in allTables do
    let s := catalogue t
    let sql := TableName.toWire t
    let tIdent := mkIdent (``TableName ++ ctorName sql)
    let path := "packages/core/src/db/schema/" ++ s.source
    let tableTs := Syntax.mkStrLit (path ++ "#" ++ s.tsExport)
    let thm := mkIdent (Name.mkSimple s!"table_{sql}_is_well_formed")
    let doc := mkDocComment s!"The specification of `{sql}` is well formed: unique column and \
      constraint names, a `NOT NULL` primary key, well-formed keys and checks, and the tenancy \
      rule for a {s.tenancy.toWire} table."
    elabCommand (← `(command|
      $doc:docComment
      @[aw_spec (tier := $(mkIdent `T0)) (doc := $(Syntax.mkStrLit tablesDoc)) (ts := $tableTs)]
      theorem $thm : tableWellFormed catalogue $tIdent = true := by decide +kernel))
    for fk in s.foreignKeys do
      let cls := classify catalogue t fk
      let fkTs := Syntax.mkStrLit (path ++ "#" ++ (if fk.inline then s.tsExport else fk.name))
      let (clsDoc, clsTs) := classCitation cls
      let thm := mkIdent (Name.mkSimple s!"{fk.name}_is_{classSuffix cls}")
      let doc := mkDocComment s!"The foreign key `{fk.name}` of `{sql}` is well formed and \
        {classSentence cls}."
      elabCommand (← `(command|
        $doc:docComment
        @[aw_spec (tier := $(mkIdent `T0)) (doc := $(Syntax.mkStrLit clsDoc)) (ts := $fkTs)
          (ts := $(Syntax.mkStrLit clsTs))]
        theorem $thm :
            fkVerdict catalogue $tIdent $(Syntax.mkStrLit fk.name) =
              some (true, $(mkIdent (classTerm cls))) := by decide +kernel))

/-! ### The catalogue against the `drizzle-kit` snapshot

`aw_er_snapshot_theorems` reads the latest snapshot (`migrations/meta/` + `Er.Snapshot.file`) while this file elaborates
and states, for every table, column, key and check the snapshot records, that `catalogue` says the
same: one theorem per table (columns with type and nullability, primary key, and the number of
foreign keys, unique keys and checks) and one per constraint (foreign-key columns, target and
`ON DELETE`; unique-key columns, kind and partial filter; closed-set column and values, or that
the check is not a closed set). The right-hand sides come from the snapshot, not from `catalogue`,
so changing any cell of `catalogue` (a value list, a nullability, a type, an action) fails a named
theorem. Only the order of the columns is taken from `catalogue`, because JSON objects are
unordered. -/

/-- One table as the snapshot records it. -/
private structure SnapTable where
  name : String
  columns : List Column
  primaryKey : List String
  foreignKeys : List (String × List String × TableName × List String × OnDelete)
  uniques : List (String × List String × UniqueKind × List String × List String)
  checks : List (String × Option (String × List String))

private def objEntries (j : Json) (what : String) : Except String (List (String × Json)) :=
  match j with
  | .obj kvs => pure kvs.toList
  | _ => throw s!"{what}: expected an object"

private def strList (j : Json) (what : String) : Except String (List String) := do
  let arr ← j.getArr?
  arr.toList.mapM fun x => x.getStr? |>.mapError (s!"{what}: " ++ ·)

private def tableOf (s : String) : Except String TableName :=
  match TableName.ofSqlName? s with
  | some t => pure t
  | none => throw s!"the snapshot names a table the model lacks: {s}"

/-- `"t"."c"` gives `c`. -/
private def columnRef (table s : String) : Option String :=
  let pre := "\"" ++ table ++ "\".\""
  if s.startsWith pre && s.endsWith "\"" then
    let c := String.ofList ((s.toList.drop pre.length).dropLast)
    if c.any (· == '"') then none else some c
  else none

/-- `'a', 'b'` gives `[a, b]`, if every item is a plain quoted literal. -/
private def quotedValues (s : String) : Option (List String) :=
  (s.splitOn ", ").mapM fun v =>
    if v.length ≥ 2 && v.startsWith "'" && v.endsWith "'" then
      let x := String.ofList ((v.toList.drop 1).dropLast)
      if x.any (fun ch => ch == '\'' || ch == '(' || ch == ')') then none else some x
    else none

/-- A closed-set check body, `"t"."c" in ('a', …)`, optionally guarded by `"t"."c" is null or`. -/
private def parseOneOf (table value : String) : Option (String × List String) := do
  let [lhs, rhs] := value.splitOn " in (" | none
  let lhs ← match lhs.splitOn " is null or " with
    | [a, b] => if a == b then some b else none
    | [a] => some a
    | _ => none
  let c ← columnRef table lhs
  guard (rhs.endsWith ")")
  let vs ← quotedValues (String.ofList rhs.toList.dropLast)
  pure (c, vs)

private def parseTable (j : Json) : Except String SnapTable := do
  let name ← j.getObjValAs? String "name"
  let cols ← objEntries (j.getObjValD "columns") s!"{name}.columns"
  let columns ← cols.mapM fun (_, c) => do
    let n ← c.getObjValAs? String "name"
    let ty ← c.getObjValAs? String "type"
    let some sqlType := SqlType.ofSql? ty | throw s!"{name}.{n}: unknown type {ty}"
    let notNull ← c.getObjValAs? Bool "notNull"
    pure (⟨n, sqlType, notNull⟩ : Column)
  let composite ← objEntries (j.getObjValD "compositePrimaryKeys") s!"{name} pk"
  let primaryKey ← match composite with
    | [(_, pk)] => strList (pk.getObjValD "columns") s!"{name} pk"
    | [] => cols.filterMapM fun (_, c) => do
        if (← c.getObjValAs? Bool "primaryKey") then pure (some (← c.getObjValAs? String "name"))
        else pure none
    | _ => throw s!"{name}: more than one composite primary key"
  let fks ← objEntries (j.getObjValD "foreignKeys") s!"{name}.foreignKeys"
  let foreignKeys ← fks.mapM fun (_, fk) => do
    let n ← fk.getObjValAs? String "name"
    let od ← fk.getObjValAs? String "onDelete"
    let some onDelete := WireEnum.ofWire? (α := OnDelete) od | throw s!"{n}: ON DELETE {od}"
    let cols ← strList (fk.getObjValD "columnsFrom") n
    let ref ← tableOf (← fk.getObjValAs? String "tableTo")
    let refCols ← strList (fk.getObjValD "columnsTo") n
    pure (n, cols, ref, refCols, onDelete)
  let ucs ← objEntries (j.getObjValD "uniqueConstraints") s!"{name}.uniqueConstraints"
  let constraints ← ucs.mapM fun (_, u) => do
    let n ← u.getObjValAs? String "name"
    let cols ← strList (u.getObjValD "columns") n
    pure (n, cols, UniqueKind.constraint, ([] : List String), ([] : List String))
  let idxs ← objEntries (j.getObjValD "indexes") s!"{name}.indexes"
  let indexes ← idxs.filterMapM fun (_, ix) => do
    if !(← ix.getObjValAs? Bool "isUnique") then return none
    let n ← ix.getObjValAs? String "name"
    let cs ← (← ix.getObjValAs? (Array Json) "columns").toList.mapM
      (·.getObjValAs? String "expression")
    -- Each clause is `"t"."c" is null` or `"t"."c" is not null`; `true` marks `is not null`.
    let filter ← match ix.getObjValD "where" with
      | .str w => (w.splitOn " and ").mapM fun clause =>
          let (body, notNull) := match clause.splitOn " is not null" with
            | [c, ""] => (some c, true)
            | _ => match clause.splitOn " is null" with
              | [c, ""] => (some c, false)
              | _ => (none, false)
          match body.bind (columnRef name) with
          | some c => pure (c, notNull)
          | none => throw s!"{n}: WHERE clause {clause}"
      | _ => pure []
    let partialNull := filter.filterMap fun (c, notNull) => if notNull then none else some c
    let partialNotNull := filter.filterMap fun (c, notNull) => if notNull then some c else none
    pure (some (n, cs, UniqueKind.index, partialNull, partialNotNull))
  let cks ← objEntries (j.getObjValD "checkConstraints") s!"{name}.checkConstraints"
  let checks ← cks.mapM fun (_, c) => do
    let n ← c.getObjValAs? String "name"
    let v ← c.getObjValAs? String "value"
    pure (n, parseOneOf name v)
  pure { name, columns, primaryKey, foreignKeys, uniques := constraints ++ indexes, checks }

private partial def findRoot (d : System.FilePath) : IO (Option System.FilePath) := do
  if ← (d / "migrations" / "meta" / Er.Snapshot.file).pathExists then return some d
  match d.parent with
  | some p => if p == d then return none else findRoot p
  | none => return none

private def tableTerm (t : TableName) : Term := mkIdent (``TableName ++ ctorName (TableName.toWire t))

private def strsTerm (xs : List String) : CommandElabM Term :=
  `([$((xs.map fun x => (Syntax.mkStrLit x : Term)).toArray),*])

private def sqlTypeTerm : SqlType → CommandElabM Term
  | .numeric p q => `(SqlType.numeric $(quote p) $(quote q))
  | .uuid => `(SqlType.uuid)
  | .text => `(SqlType.text)
  | .boolean => `(SqlType.boolean)
  | .smallint => `(SqlType.smallint)
  | .integer => `(SqlType.integer)
  | .bigint => `(SqlType.bigint)
  | .jsonb => `(SqlType.jsonb)
  | .bytea => `(SqlType.bytea)
  | .timestamptz => `(SqlType.timestamptz)
  | .uuidArray => `(SqlType.uuidArray)
  | .textArray => `(SqlType.textArray)
  | .tsvector => `(SqlType.tsvector)

private def onDeleteTerm : OnDelete → CommandElabM Term
  | .noAction => `(OnDelete.noAction)
  | .restrict => `(OnDelete.restrict)
  | .cascade => `(OnDelete.cascade)
  | .setNull => `(OnDelete.setNull)

private def uniqueKindTerm : UniqueKind → CommandElabM Term
  | .constraint => `(UniqueKind.constraint)
  | .index => `(UniqueKind.index)

private def boolTerm (b : Bool) : CommandElabM Term := if b then `(true) else `(false)

private def loadSnapshot (root : System.FilePath) : IO (Except String (List SnapTable)) := do
  let text ← IO.FS.readFile (root / "migrations" / "meta" / Er.Snapshot.file)
  return do
    let top ← objEntries (← Json.parse text) "snapshot"
    let some tables := top.lookup "tables" | throw "the snapshot has no tables"
    (← objEntries tables "tables").mapM fun (_, t) => parseTable t

/-- Elaborates the snapshot-agreement theorems (see the section comment). -/
elab "aw_er_snapshot_theorems" : command => do
  let file ← IO.FS.realPath (← getFileName)
  let fromFile ← findRoot (file.parent.getD ".")
  let fromCwd ← findRoot (← IO.currentDir)
  let some root := fromFile <|> fromCwd
    | throwError "aw_er_snapshot_theorems: migrations/meta/{Er.Snapshot.file} not found"
  let snap ← match ← loadSnapshot root with
    | .ok ts => pure ts
    | .error e => throwError "aw_er_snapshot_theorems: {e}"
  unless snap.length == allTables.length do
    throwError "the snapshot has {snap.length} tables, the model {allTables.length}"
  for t in allTables do
    let s := catalogue t
    let sql := TableName.toWire t
    let some st := snap.find? (·.name == sql)
      | throwError "the snapshot has no table {sql}"
    let path := "packages/core/src/db/schema/" ++ s.source
    let source ← IO.FS.readFile (root / path)
    let cite (n : String) : StrLit :=
      Syntax.mkStrLit (path ++ "#" ++ (if (source.splitOn n).length > 1 then n else s.tsExport))
    let tT := tableTerm t
    -- Columns in the model's order, then any the model lacks.
    let ordered := s.columns.filterMap (fun c => st.columns.find? (·.name == c.name)) ++
      st.columns.filter (fun c => !s.hasColumn c.name)
    let colTerms ← ordered.mapM fun c => do
      `(Column.mk $(Syntax.mkStrLit c.name) $(← sqlTypeTerm c.type) $(← boolTerm c.notNull))
    let thm := mkIdent (Name.mkSimple s!"table_{sql}_matches_snapshot")
    let doc := mkDocComment s!"`{sql}` has the columns (name, type, `NOT NULL`), primary key and \
      numbers of foreign keys, unique keys and checks that `drizzle-kit` records for it."
    elabCommand (← `(command|
      $doc:docComment
      @[aw_spec (tier := $(mkIdent `T0)) (doc := $(Syntax.mkStrLit tablesDoc))
        (ts := $(cite s.tsExport))]
      theorem $thm :
          (catalogue $tT).columns = [$colTerms.toArray,*] ∧
            (catalogue $tT).primaryKey = $(← strsTerm st.primaryKey) ∧
            (catalogue $tT).foreignKeys.length = $(quote st.foreignKeys.length) ∧
            (catalogue $tT).uniques.length = $(quote st.uniques.length) ∧
            (catalogue $tT).checks.length = $(quote st.checks.length) := by decide +kernel))
    for (n, cols, ref, refCols, od) in st.foreignKeys do
      let thm := mkIdent (Name.mkSimple s!"{n}_matches_snapshot")
      let doc := mkDocComment s!"The foreign key `{n}` of `{sql}` has the columns, target and \
        `ON DELETE` action that `drizzle-kit` records for it."
      elabCommand (← `(command|
        $doc:docComment
        @[aw_spec (tier := $(mkIdent `T0)) (doc := $(Syntax.mkStrLit tablesDoc)) (ts := $(cite n))]
        theorem $thm :
            (catalogue $tT).foreignKeySignature? $(Syntax.mkStrLit n) =
              some ($(← strsTerm cols), $(tableTerm ref), $(← strsTerm refCols),
                $(← onDeleteTerm od)) := by decide +kernel))
    for (n, cols, kind, partialNull, partialNotNull) in st.uniques do
      let thm := mkIdent (Name.mkSimple s!"{n}_matches_snapshot")
      let doc := mkDocComment s!"The unique key `{n}` of `{sql}` has the columns, kind and partial \
        filter that `drizzle-kit` records for it."
      elabCommand (← `(command|
        $doc:docComment
        @[aw_spec (tier := $(mkIdent `T0)) (doc := $(Syntax.mkStrLit tablesDoc)) (ts := $(cite n))]
        theorem $thm :
            (catalogue $tT).uniqueSignature? $(Syntax.mkStrLit n) =
              some ($(← strsTerm cols), $(← uniqueKindTerm kind), $(← strsTerm partialNull),
                $(← strsTerm partialNotNull)) := by
          decide +kernel))
    for (n, closed) in st.checks do
      let thm := mkIdent (Name.mkSimple s!"{n}_matches_snapshot")
      match closed with
      | some (c, vs) =>
        let doc := mkDocComment s!"The check `{n}` of `{sql}` holds `{c}` to exactly the closed \
          set of values that `drizzle-kit` records for it."
        elabCommand (← `(command|
          $doc:docComment
          @[aw_spec (tier := $(mkIdent `T0)) (doc := $(Syntax.mkStrLit tablesDoc))
            (ts := $(cite n)) (ts := "packages/core/src/db/schema/one-of.ts#oneOf")]
          theorem $thm :
              (catalogue $tT).oneOfCheck? $(Syntax.mkStrLit n) =
                some ($(Syntax.mkStrLit c), $(← strsTerm vs)) := by decide +kernel))
      | none =>
        let doc := mkDocComment s!"The check `{n}` of `{sql}` is recorded, and not as a closed \
          set, because the body `drizzle-kit` records for it is not `column IN (…)`."
        elabCommand (← `(command|
          $doc:docComment
          @[aw_spec (tier := $(mkIdent `T0)) (doc := $(Syntax.mkStrLit tablesDoc)) (ts := $(cite n))]
          theorem $thm :
              (catalogue $tT).check? $(Syntax.mkStrLit n) =
                some (Check.other $(Syntax.mkStrLit n)) := by decide +kernel))

end Generator

aw_er_catalogue_theorems

aw_er_snapshot_theorems

/-! ## Catalogue-wide facts -/

/-- The schema has exactly the tables of the latest `drizzle-kit` snapshot: the model's SQL table
names are the generated `Er.Snapshot.tableNames`, up to order. -/
@[aw_spec (tier := T0) (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")
  (ts := "packages/core/src/db/schema/index.ts")]
theorem table_names_match_schema :
    (WireEnum.wires TableName).Perm Er.Snapshot.tableNames := by
  decide +kernel

/-- Decoding the JSON encoding of any table name gives that table back. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/index.ts")]
theorem table_name_json_round_trips (t : TableName) :
    WireEnum.fromJsonValue? (WireEnum.toJsonValue t) = some t :=
  WireEnum.fromJsonValue?_toJsonValue t

/-- A string that is not one of the table names names no table. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/index.ts")]
theorem unknown_table_name_is_rejected (s : String) (h : s ∉ WireEnum.wires TableName) :
    WireEnum.ofWire? (α := TableName) s = none :=
  (WireEnum.ofWire?_eq_none_iff s).mpr h

example : WireEnum.ofWire? (α := TableName) "agent" = none :=
  unknown_table_name_is_rejected "agent" (by decide +kernel)

/-- Every table's specification describes that table. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/index.ts")]
theorem catalogue_describes_each_table (t : TableName) : (catalogue t).table = t := by
  cases t <;> rfl

/-- Every table of the catalogue is well formed. -/
@[aw_spec (tier := T0) (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")
  (ts := "packages/core/src/db/schema/index.ts")]
theorem every_table_is_well_formed (t : TableName) : tableWellFormed catalogue t = true := by
  cases t <;> decide +kernel

/-- No foreign key of the catalogue is unpaired: every reference between two tenant-carrying
tables is tenant-paired, by itself or by a sibling. -/
@[aw_spec (tier := T0) (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")]
theorem catalogue_pairing_is_complete : pairingComplete catalogue = true := by
  decide +kernel

/-- Every constraint name (foreign key, unique key, check) is unique across the whole schema. -/
@[aw_spec (tier := T0) (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")
  (ts := "packages/core/src/db/schema/index.ts")]
theorem constraint_names_are_unique : (allConstraintNames catalogue).Nodup := by
  decide +kernel

/-- The catalogue declares as many columns, foreign keys, unique keys and checks as the latest
snapshot records (the generated `Er.Snapshot` totals). -/
@[aw_spec (tier := T0) (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")
  (ts := "packages/core/src/db/schema/index.ts")]
theorem catalogue_constraint_counts :
    (allTables.flatMap fun t => (catalogue t).columns).length = Er.Snapshot.columnCount ∧
      (allTables.flatMap fun t => (catalogue t).foreignKeys).length = Er.Snapshot.foreignKeyCount ∧
      (allTables.flatMap fun t => (catalogue t).uniques).length = Er.Snapshot.uniqueCount ∧
      (allTables.flatMap fun t => (catalogue t).checks).length = Er.Snapshot.checkCount := by
  decide +kernel

/-- A table has an identifier kind exactly when its primary key is the single column `id`. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/columns.ts#primaryKeyId")]
theorem id_kind_iff_id_primary_key (t : TableName) :
    (TableName.idKind? t).isSome = ((catalogue t).primaryKey == ["id"]) := by
  cases t <;> decide +kernel

/-- Distinct tables have distinct identifier kinds, so a typed id names one table. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/columns.ts#primaryKeyId")]
theorem id_kind_names_one_table (t u : TableName) (k : IdKind)
    (ht : TableName.idKind? t = some k) (hu : TableName.idKind? u = some k) : t = u := by
  cases t <;> cases u <;> simp_all [TableName.idKind?] <;> subst_vars <;> contradiction

example : TableName.idKind? .agents = some .agent ∧ TableName.idKind? .agents = some .agent :=
  ⟨rfl, rfl⟩

/-- Every identifier kind names some table. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/columns.ts#primaryKeyId")]
theorem every_id_kind_names_a_table (k : IdKind) : ∃ t, TableName.idKind? t = some k := by
  cases k
  all_goals first
    | exact ⟨.workspaces, rfl⟩ | exact ⟨.users, rfl⟩ | exact ⟨.userIdentities, rfl⟩
    | exact ⟨.memberships, rfl⟩ | exact ⟨.workspacePrincipals, rfl⟩ | exact ⟨.apiKeys, rfl⟩
    | exact ⟨.invitations, rfl⟩ | exact ⟨.browserTokens, rfl⟩ | exact ⟨.cliSessions, rfl⟩
    | exact ⟨.agents, rfl⟩
    | exact ⟨.agentFiles, rfl⟩ | exact ⟨.agentGrants, rfl⟩ | exact ⟨.agentMcpServers, rfl⟩
    | exact ⟨.agentSkills, rfl⟩ | exact ⟨.agentStorageGrants, rfl⟩ | exact ⟨.agentVersions, rfl⟩
    | exact ⟨.agentVersionStorageGrants, rfl⟩
    | exact ⟨.agentVersionEvaluations, rfl⟩ | exact ⟨.agentPointerMoves, rfl⟩
    | exact ⟨.endpointClients, rfl⟩ | exact ⟨.oauthTokens, rfl⟩ | exact ⟨.skills, rfl⟩
    | exact ⟨.skillRevisions, rfl⟩ | exact ⟨.files, rfl⟩ | exact ⟨.fileTexts, rfl⟩
    | exact ⟨.mcpServers, rfl⟩ | exact ⟨.modelConnections, rfl⟩ | exact ⟨.runtimeProfiles, rfl⟩
    | exact ⟨.runtimeVerifications, rfl⟩ | exact ⟨.secrets, rfl⟩ | exact ⟨.projects, rfl⟩ | exact ⟨.sessions, rfl⟩
    | exact ⟨.runs, rfl⟩ | exact ⟨.runTokens, rfl⟩ | exact ⟨.runUsageRecords, rfl⟩
    | exact ⟨.runFeedback, rfl⟩
    | exact ⟨.shares, rfl⟩ | exact ⟨.shareViews, rfl⟩ | exact ⟨.auditEvents, rfl⟩
    | exact ⟨.triggers, rfl⟩ | exact ⟨.triggerDeliveries, rfl⟩
    | exact ⟨.builderToolCalls, rfl⟩ | exact ⟨.storageConnections, rfl⟩ | exact ⟨.storageMigrationRuns, rfl⟩
    | exact ⟨.workspaceFeatures, rfl⟩

/-- Every closed-set check constrains a `text` column. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/one-of.ts#oneOf")]
theorem closed_set_checks_constrain_text_columns :
    allTables.all (fun t => (catalogue t).checks.all fun
      | .oneOf _ c _ => ((catalogue t).column? c).map (·.type) == some .text
      | .other _ => true) = true := by
  decide +kernel

/-- `renderValueList` accepts a list exactly when it is non-empty, duplicate-free and made of
safe slugs. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/one-of.ts#renderValueList")]
theorem render_value_list_accepts_iff (vs : List String) :
    (renderValueList? vs).isSome = true ↔ vs ≠ [] ∧ vs.all isSafeValue = true ∧ vs.Nodup := by
  unfold renderValueList?
  by_cases h1 : vs = [] <;> by_cases h2 : vs.all isSafeValue = true <;> by_cases h3 : vs.Nodup <;>
    simp [h1, h2, h3]

example : renderValueList? ["read", "read-write"] = some "('read', 'read-write')" := by decide +kernel

/-- The snake gate admits `awaiting_approval` and refuses a hyphen, a doubled or trailing
underscore, and a mix of the two shapes. -/
example : renderSnakeValueList? ["running", "awaiting_approval"] =
      some "('running', 'awaiting_approval')" ∧
    renderSnakeValueList? ["openai-compatible"] = none ∧
    isSafeSnakeValue "awaiting_" = false ∧ isSafeSnakeValue "awaiting__approval" = false ∧
    renderOneOf? "runs_status_valid" ["awaiting_approval"] = some "('awaiting_approval')" ∧
    renderOneOf? "runs_provider_valid" ["awaiting_approval"] = none := by decide +kernel

/-- A 64-character slug is exactly at `MAX_VALUE_LENGTH`, and the gate accepts it. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/one-of.ts#MAX_VALUE_LENGTH")]
theorem slug_of_64_characters_is_safe :
    isSafeValue (String.ofList (List.replicate 64 'a')) = true := by
  decide +kernel

/-- A 65-character slug is one over `MAX_VALUE_LENGTH`, and the gate refuses it although every
character is allowed. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/one-of.ts#MAX_VALUE_LENGTH")]
theorem slug_of_65_characters_is_refused :
    isSafeValue (String.ofList (List.replicate 65 'a')) = false ∧
      (String.ofList (List.replicate 65 'a')).toList.all isSafeValueChar = true := by
  decide +kernel

/-- A foreign key to a global identity table that includes `workspace_id` is a fault: the target
has no tenant column to pair it with, so `classify` calls it unpaired. -/
@[aw_spec (tier := T0) (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#isTenantScoped")]
theorem global_reference_with_workspace_column_is_unpaired (S : Schema) (t : TableName)
    (fk : ForeignKey) (hg : (S fk.refTable).tenancy = .global)
    (hw : fk.columns.contains "workspace_id" = true) : classify S t fk = .unpaired := by
  unfold classify
  rw [hg]
  simp only [hw, ite_true]

example : classify catalogue .agents
    { name := "agents_creator_user_fk", columns := ["created_by", "workspace_id"],
      refTable := .users, refColumns := ["id", "id"], onDelete := .noAction, inline := false } =
      .unpaired :=
  global_reference_with_workspace_column_is_unpaired _ _ _ rfl (by decide +kernel)

/-- Every `*_id` column of the schema is covered by a foreign key or is one of the five declared
non-references (`NON_REFERENCE_ID_COLUMNS`) with the type the declaration pins, and no declared
column is also covered by a foreign key. -/
@[aw_spec (tier := T0) (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#NON_REFERENCE_ID_COLUMNS")]
theorem every_id_column_is_a_reference_or_declared :
    idColumnsCovered catalogue nonReferenceIdColumns = true := by
  decide +kernel

/-- The `*_id` columns no foreign key covers are exactly the declared non-references, all `text`
but three: the provider's response id, the two polymorphic subject ids, the deployment master-key
id, the SDK's resume id, the run that made an agent, the runtime driver a verification is for,
and the `uuid` that groups the codes and tokens of one OAuth grant, and the `uuid` a file's, or a
session-state blob's, object is stored under. -/
@[aw_spec (tier := T0) (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#NON_REFERENCE_ID_COLUMNS")]
theorem uncovered_id_columns :
    allTables.flatMap (fun t => ((catalogue t).columns.filter fun c =>
        isIdColumn c.name && !(catalogue t).foreignKeys.any (·.columns.contains c.name)).map
          fun c => (t, c.name, c.type)) =
      [(.agents, "created_by_run_id", .text),
        (.auditEvents, "subject_id", .text), (.builderToolCalls, "run_id", .text),
        (.builderToolCalls, "call_id", .text), (.builderToolCalls, "trace_id", .text),
        (.builderToolCalls, "model_id", .text), (.files, "object_id", .uuid),
        (.oauthTokens, "family_id", .uuid),
        (.runUsageRecords, "provider_response_id", .text),
        (.runtimeVerifications, "driver_id", .text), (.secrets, "master_key_id", .text),
        (.sessionStateBlobs, "object_id", .uuid), (.sessions, "engine_session_id", .text),
        (.shares, "subject_id", .text)] := by
  decide +kernel

private theorem hex_digit_is_ascii (c : Char) (h : Uuid.isHexDigit c = true) : c.toNat < 128 := by
  simp only [Uuid.isHexDigit, Bool.or_eq_true, Bool.and_eq_true, decide_eq_true_eq] at h
  have : c.toNat ≤ 'f'.toNat := by
    rcases h with (⟨_, h⟩ | ⟨_, h⟩) | ⟨_, h⟩
    · exact Nat.le_trans h (by decide +kernel)
    · exact h
    · exact Nat.le_trans h (by decide +kernel)
  have hf : 'f'.toNat = 102 := rfl
  omega

private theorem ascii_hex_digits : ∀ n, n < 128 → Uuid.isHexDigit (Char.ofNat n) = true →
    Char.ofNat n ∈ "0123456789abcdefABCDEF".toList := by
  decide +kernel

private theorem hex_digit_mem (c : Char) (h : Uuid.isHexDigit c = true) :
    c ∈ "0123456789abcdefABCDEF".toList := by
  have := ascii_hex_digits c.toNat (hex_digit_is_ascii c h)
  rw [Char.ofNat_toNat] at this
  exact this h

/-- Every character of a canonical UUID is a hexadecimal digit `0-9`, `a-f`, `A-F` or a hyphen,
the alphabet of `UUID_PATTERN` with its `/i` flag. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/identifiers.ts#UUID_PATTERN")]
theorem canonical_uuid_is_hex_and_hyphens (s : String) (h : Uuid.isCanonical s = true) :
    ∀ c ∈ s.toList, c ∈ "0123456789abcdefABCDEF-".toList := by
  simp only [Uuid.isCanonical, Bool.and_eq_true, beq_iff_eq] at h
  obtain ⟨hlen, hall⟩ := h
  intro c hc
  obtain ⟨i, hi, rfl⟩ := List.getElem_of_mem hc
  have hi' : i < Uuid.shape.length := hlen ▸ hi
  have hz : i < (s.toList.zip Uuid.shape).length := by rw [List.length_zip]; omega
  have := List.all_eq_true.mp hall _ (List.getElem_mem hz)
  simp only [List.getElem_zip] at this
  split at this
  · have hm := hex_digit_mem _ this
    have hsub : ∀ x, x ∈ "0123456789abcdefABCDEF".toList → x ∈ "0123456789abcdefABCDEF-".toList := by
      decide +kernel
    exact hsub _ hm
  · simp only [beq_iff_eq] at this
    rw [this]
    decide +kernel

example : ∀ c ∈ "123e4567-e89b-12d3-a456-426614174000".toList,
    c ∈ "0123456789abcdefABCDEF-".toList :=
  canonical_uuid_is_hex_and_hyphens _ (by decide +kernel)

/-- A string of the canonical shape with a `g` in a digit position, at the start or at the end,
is not a canonical UUID. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/identifiers.ts#UUID_PATTERN")
  (ts := "packages/contracts/src/identifiers.ts#isUuid")]
theorem uuid_with_a_non_hex_digit_is_refused :
    Uuid.isCanonical "g23e4567-e89b-12d3-a456-426614174000" = false ∧
      Uuid.isCanonical "123e4567-e89b-12d3-a456-42661417400g" = false ∧
      Uuid.isCanonical "123e4567-e89b-12d3-a456-426614174000" = true := by
  decide +kernel

/-! ## The wire spellings of the catalogue's closed unions -/

/-- The foreign-key classes are spelled, in order, `root-reference`, `global-reference`,
`tenant-paired`, `sibling-paired` and `unpaired` in the vectors, after the buckets of
`tenancy.test.ts`. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/tenancy.test.ts#referenceIdentityOf")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")]
theorem fk_class_wires :
    WireEnum.wires FkClass =
      ["root-reference", "global-reference", "tenant-paired", "sibling-paired", "unpaired"] := by
  decide +kernel

/-- The tenancy classes are spelled `root`, `global` and `scoped`. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/tenancy.test.ts#TENANT_EXEMPT")]
theorem tenancy_wires : WireEnum.wires Tenancy = ["root", "global", "scoped"] := by
  decide +kernel

/-- The `ON DELETE` actions are spelled as `drizzle-kit` records them: `no action`, `restrict`,
`cascade` and `set null`. -/
@[aw_spec (tier := T0) (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")
  (ts := "migrations/meta/0039_snapshot.json#onDelete")]
theorem on_delete_wires :
    WireEnum.wires OnDelete = ["no action", "restrict", "cascade", "set null"] := by
  decide +kernel

/-- The unique-key kinds are spelled `constraint` (an entry of the snapshot's `uniqueConstraints`) and
`index` (an index the snapshot marks `isUnique`). -/
@[aw_spec (tier := T0) (ts := "migrations/meta/0039_snapshot.json#uniqueConstraints")
  (ts := "migrations/meta/0039_snapshot.json#isUnique")]
theorem unique_kind_wires : WireEnum.wires UniqueKind = ["constraint", "index"] := by
  decide +kernel

/-! ## Tenancy facts of the catalogue -/

/-- Every tenant-scoped table has exactly one reference to the tenant root. -/
@[aw_spec (tier := T0) (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#TENANT_COLUMN")]
theorem scoped_tables_reference_the_root_once (t : TableName)
    (h : (catalogue t).tenancy = .scoped) :
    ((catalogue t).foreignKeys.filter fun fk => classify catalogue t fk == .rootReference).length
      = 1 := by
  cases t <;> first | (exfalso; revert h; decide +kernel) | decide +kernel

example : (catalogue .agents).tenancy = .scoped := rfl

/-- Every reference to the tenant root is `ON DELETE CASCADE`, so deleting a workspace deletes
its rows (a schema fact `tenancy.test.ts` does not check). -/
@[aw_spec (tier := T0) (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")
  (ts := "migrations/meta/0039_snapshot.json#onDelete")]
theorem every_root_reference_cascades :
    allTables.all (fun t => (catalogue t).foreignKeys.all fun fk =>
      classify catalogue t fk != .rootReference || fk.onDelete == .cascade) = true := by
  decide +kernel

/-! ## Negative well-formedness: each rule refuses the fault it names

Each theorem edits one cell of `catalogue` so that exactly one conjunct of `tableWellFormed`,
`fkWellFormed` or `tenancyWellFormed` fails, and states that the edited table is ill formed. A
predicate loosened to drop that conjunct would call the edited table well formed and break the
theorem. -/

namespace Mutant

/-- `agent_files.file_id` retyped `text`, while `files.id` stays `uuid`. -/
def fileIdAsText : Schema :=
  catalogue.update .agentFiles fun s => s.mapColumn "file_id" fun c => { c with type := .text }

/-- `agent_files.id` made nullable. -/
def nullableId : Schema :=
  catalogue.update .agentFiles fun s => s.mapColumn "id" fun c => { c with notNull := false }

/-- `agent_files` with a second `access` column. -/
def duplicateColumn : Schema :=
  catalogue.update .agentFiles fun s => { s with columns := s.columns ++ [⟨"access", .text, true⟩] }

/-- `agent_files` with a second constraint named `agent_files_access_valid`. -/
def duplicateConstraint : Schema :=
  catalogue.update .agentFiles fun s =>
    { s with checks := s.checks ++ [.other "agent_files_access_valid"] }

/-- The `agent_files` entry claims to describe `agents`. -/
def wrongTable : Schema := catalogue.update .agentFiles fun s => { s with table := .agents }

/-- `agent_files` with no primary key. -/
def emptyPrimaryKey : Schema := catalogue.update .agentFiles fun s => { s with primaryKey := [] }

/-- `agent_files_agent_workspace_fk` declared inline although it has two columns. -/
def inlineComposite : Schema :=
  catalogue.update .agentFiles fun s =>
    s.mapForeignKey "agent_files_agent_workspace_fk" fun fk => { fk with inline := true }

/-- `agent_files_agent_workspace_fk` aimed at `agents (model_connection_id, workspace_id)`, which
is not a key of `agents`. -/
def nonKeyTarget : Schema :=
  catalogue.update .agentFiles fun s =>
    s.mapForeignKey "agent_files_agent_workspace_fk" fun fk =>
      { fk with refColumns := ["model_connection_id", "workspace_id"] }

/-- `agent_files_agent_workspace_fk` with two child columns and one parent column. -/
def arityMismatch : Schema :=
  catalogue.update .agentFiles fun s =>
    s.mapForeignKey "agent_files_agent_workspace_fk" fun fk => { fk with refColumns := ["id"] }

/-- `agent_files_agent_workspace_fk` naming `agent_id` twice. -/
def repeatedFkColumn : Schema :=
  catalogue.update .agentFiles fun s =>
    s.mapForeignKey "agent_files_agent_workspace_fk" fun fk =>
      { fk with columns := ["agent_id", "agent_id"] }

/-- `agent_files` with a unique key over a column it lacks. -/
def uniqueOverMissingColumn : Schema :=
  catalogue.update .agentFiles fun s =>
    { s with uniques := s.uniques ++ [⟨"agent_files_nope_key", ["nope"], .constraint, [], []⟩] }

/-- `agent_files` with a unique key over no columns. -/
def emptyUnique : Schema :=
  catalogue.update .agentFiles fun s =>
    { s with uniques := s.uniques ++ [⟨"agent_files_empty_key", [], .constraint, [], []⟩] }

/-- `agent_files` with a partial unique key filtered on a column it lacks. -/
def partialOverMissingColumn : Schema :=
  catalogue.update .agentFiles fun s =>
    { s with uniques := s.uniques ++ [⟨"agent_files_partial_key", ["agent_id"], .index, ["nope"], []⟩] }

/-- `agent_files` with a partial unique key whose `IS NOT NULL` filter names a column outside the
key. -/
def notNullFilterOutsideKey : Schema :=
  catalogue.update .agentFiles fun s =>
    { s with uniques := s.uniques ++ [⟨"agent_files_set_key", ["agent_id"], .index, [], ["file_id"]⟩] }

/-- `agent_files_access_valid` over a column the table lacks. -/
def checkOverMissingColumn : Schema :=
  catalogue.update .agentFiles fun s =>
    { s with checks := [.oneOf "agent_files_access_valid" "mode" ["read", "read-write"]] }

/-- `agent_files_access_valid` with no values. -/
def checkWithoutValues : Schema :=
  catalogue.update .agentFiles fun s =>
    { s with checks := [.oneOf "agent_files_access_valid" "access" []] }

/-- `agent_files_access_valid` listing `read` twice. -/
def checkWithRepeatedValue : Schema :=
  catalogue.update .agentFiles fun s =>
    { s with checks := [.oneOf "agent_files_access_valid" "access" ["read", "read"]] }

/-- `agent_files.workspace_id` made nullable. -/
def nullableWorkspace : Schema :=
  catalogue.update .agentFiles fun s =>
    s.mapColumn "workspace_id" fun c => { c with notNull := false }

/-- `agent_files.workspace_id` retyped `text`. -/
def textWorkspace : Schema :=
  catalogue.update .agentFiles fun s =>
    s.mapColumn "workspace_id" fun c => { c with type := .text }

/-- `agent_files` without its reference to `workspaces`. -/
def noRootReference : Schema :=
  catalogue.update .agentFiles fun s =>
    { s with foreignKeys := s.foreignKeys.filter fun fk =>
        fk.name != "agent_files_workspace_id_workspaces_id_fk" }

/-- `agent_files` with a second reference to `workspaces`. -/
def twoRootReferences : Schema :=
  catalogue.update .agentFiles fun s =>
    { s with foreignKeys := s.foreignKeys ++
        [{ name := "agent_files_workspace_again_fk", columns := ["workspace_id"],
           refTable := .workspaces, refColumns := ["id"], onDelete := .cascade, inline := false }] }

/-- `workspaces` given a `workspace_id` column. -/
def rootWithWorkspaceColumn : Schema :=
  catalogue.update .workspaces fun s =>
    { s with columns := s.columns ++ [⟨"workspace_id", .uuid, false⟩] }

/-- `workspaces` keyed by `slug` instead of `id`. -/
def rootKeyedBySlug : Schema :=
  catalogue.update .workspaces fun s => { s with primaryKey := ["slug"] }

/-- `users` given a `workspace_id` column. -/
def globalWithWorkspaceColumn : Schema :=
  catalogue.update .users fun s =>
    { s with columns := s.columns ++ [⟨"workspace_id", .uuid, false⟩] }

end Mutant

/-- A foreign key whose child column is `text` and whose parent column is `uuid` is ill formed
(PostgreSQL refuses it), although it is still tenant-paired. -/
@[aw_spec (tier := T0) (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")
  (ts := "packages/core/src/db/schema/agent-files.ts#agent_files_file_workspace_fk")]
theorem fk_type_mismatch_is_ill_formed :
    fkVerdict Mutant.fileIdAsText .agentFiles "agent_files_file_workspace_fk" =
        some (false, .tenantPaired) ∧
      tableWellFormed Mutant.fileIdAsText .agentFiles = false := by
  decide +kernel

/-- A foreign key whose target columns are not a primary or total unique key of the parent is
ill formed. -/
@[aw_spec (tier := T0) (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#hasUniqueKeyOver")]
theorem fk_to_a_non_key_is_ill_formed :
    fkVerdict Mutant.nonKeyTarget .agentFiles "agent_files_agent_workspace_fk" =
        some (false, .tenantPaired) ∧
      tableWellFormed Mutant.nonKeyTarget .agentFiles = false := by
  decide +kernel

/-- An inline (column-level) foreign key over two columns is ill formed. -/
@[aw_spec (tier := T0)
  (ts := "packages/core/src/db/schema/agent-files.ts#agent_files_agent_workspace_fk")]
theorem inline_composite_fk_is_ill_formed :
    fkVerdict Mutant.inlineComposite .agentFiles "agent_files_agent_workspace_fk" =
        some (false, .tenantPaired) ∧
      tableWellFormed Mutant.inlineComposite .agentFiles = false := by
  decide +kernel

/-- A foreign key with more child columns than parent columns, or naming a child column twice,
is ill formed. -/
@[aw_spec (tier := T0)
  (ts := "packages/core/src/db/schema/agent-files.ts#agent_files_agent_workspace_fk")]
theorem fk_arity_and_repetition_are_ill_formed :
    (fkVerdict Mutant.arityMismatch .agentFiles "agent_files_agent_workspace_fk").map (·.1) =
        some false ∧
      (fkVerdict Mutant.repeatedFkColumn .agentFiles "agent_files_agent_workspace_fk").map (·.1) =
        some false ∧
      tableWellFormed Mutant.arityMismatch .agentFiles = false ∧
      tableWellFormed Mutant.repeatedFkColumn .agentFiles = false := by
  decide +kernel

/-- A table whose primary key is nullable, or empty, is ill formed. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/columns.ts#primaryKeyId")]
theorem nullable_or_empty_primary_key_is_ill_formed :
    tableWellFormed Mutant.nullableId .agentFiles = false ∧
      tableWellFormed Mutant.emptyPrimaryKey .agentFiles = false := by
  decide +kernel

/-- A table with two columns, or two constraints, of the same name is ill formed, and so is a
specification filed under another table's name. -/
@[aw_spec (tier := T0) (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")
  (ts := "packages/core/src/db/schema/index.ts")]
theorem duplicate_names_are_ill_formed :
    tableWellFormed Mutant.duplicateColumn .agentFiles = false ∧
      tableWellFormed Mutant.duplicateConstraint .agentFiles = false ∧
      tableWellFormed Mutant.wrongTable .agentFiles = false := by
  decide +kernel

/-- A unique key over no columns, over a column the table lacks, filtered on a column the table
lacks, or with an `IS NOT NULL` filter outside its columns is ill formed. -/
@[aw_spec (tier := T0) (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")
  (ts := "packages/core/src/db/schema/invitations.ts#invitations_workspace_email_pending_key")]
theorem malformed_unique_keys_are_ill_formed :
    tableWellFormed Mutant.uniqueOverMissingColumn .agentFiles = false ∧
      tableWellFormed Mutant.emptyUnique .agentFiles = false ∧
      tableWellFormed Mutant.partialOverMissingColumn .agentFiles = false ∧
      tableWellFormed Mutant.notNullFilterOutsideKey .agentFiles = false := by
  decide +kernel

/-- A closed-set check over a column the table lacks, with no values, or with a repeated value
is ill formed. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/one-of.ts#oneOf")]
theorem malformed_closed_set_checks_are_ill_formed :
    tableWellFormed Mutant.checkOverMissingColumn .agentFiles = false ∧
      tableWellFormed Mutant.checkWithoutValues .agentFiles = false ∧
      tableWellFormed Mutant.checkWithRepeatedValue .agentFiles = false := by
  decide +kernel

/-- A scoped table breaks the tenancy rule when its `workspace_id` is nullable, is not `uuid`,
or when it has no reference, or two, to the tenant root. -/
@[aw_spec (tier := T0) (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#TENANT_COLUMN")]
theorem scoped_tenancy_faults_are_refused :
    tenancyWellFormed Mutant.nullableWorkspace .agentFiles = false ∧
      tenancyWellFormed Mutant.textWorkspace .agentFiles = false ∧
      tenancyWellFormed Mutant.noRootReference .agentFiles = false ∧
      tenancyWellFormed Mutant.twoRootReferences .agentFiles = false ∧
      tableWellFormed Mutant.noRootReference .agentFiles = false := by
  decide +kernel

/-- An exempt table breaks the tenancy rule when it carries a `workspace_id`, and the root does
when it is keyed by anything other than `id`. -/
@[aw_spec (tier := T0) (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#TENANT_EXEMPT")]
theorem exempt_tenancy_faults_are_refused :
    tenancyWellFormed Mutant.rootWithWorkspaceColumn .workspaces = false ∧
      tenancyWellFormed Mutant.rootKeyedBySlug .workspaces = false ∧
      tenancyWellFormed Mutant.globalWithWorkspaceColumn .users = false := by
  decide +kernel


/-! ## Boundaries the positive theorems cannot notice -/

namespace Mutant

/-- `agent_files`'s reference to `workspaces` widened to the composite key
`(workspace_id, agent_id) → workspaces (id, id)`: it still pairs `workspace_id` with `id`, but
it is no longer the single `workspace_id` column. -/
def compositeRootReference : Schema :=
  catalogue.update .agentFiles fun s =>
    s.mapForeignKey "agent_files_workspace_id_workspaces_id_fk" fun fk =>
      { fk with columns := ["workspace_id", "agent_id"], refColumns := ["id", "id"] }

end Mutant

/-- "The only reference to the tenant root may be the single `workspace_id` column": a composite
key to `workspaces`, even one that pairs `workspace_id` with `id`, is not a root reference but
`unpaired`, so the table loses its root reference and the schema its pairing. -/
@[aw_spec (tier := T0) (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#TENANT_COLUMN")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")]
theorem composite_root_reference_is_unpaired :
    (fkVerdict Mutant.compositeRootReference .agentFiles
        "agent_files_workspace_id_workspaces_id_fk").map (·.2) = some .unpaired ∧
      tenancyWellFormed Mutant.compositeRootReference .agentFiles = false ∧
      pairingComplete Mutant.compositeRootReference = false := by
  decide +kernel

/-- Rule 3 says "covered by a foreign key or declared, never both": declaring
`agents.model_connection_id`, which two foreign keys cover, as a non-reference fails the gate,
although the declaration names an existing column of the right type. -/
@[aw_spec (tier := T0) (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#NON_REFERENCE_ID_COLUMNS")]
theorem declared_reference_column_is_refused :
    (catalogue .agents).column? "model_connection_id" =
        some ⟨"model_connection_id", .uuid, false⟩ ∧
      idColumnsCovered catalogue ((.agents, "model_connection_id", .uuid) :: nonReferenceIdColumns)
        = false := by
  decide +kernel

/-- `SAFE_VALUE` at its edges: a trailing hyphen, a double hyphen, a leading digit or hyphen, an
underscore and the empty string are refused; single hyphens between runs of letters and digits,
and a one-letter value, are accepted. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/one-of.ts#SAFE_VALUE")]
theorem safe_value_boundaries :
    isSafeValue "a-" = false ∧ isSafeValue "a--b" = false ∧ isSafeValue "1a" = false ∧
      isSafeValue "-a" = false ∧ isSafeValue "a_b" = false ∧ isSafeValue "" = false ∧
      isSafeValue "a" = true ∧ isSafeValue "a-b" = true ∧ isSafeValue "a1-b2-c3" = true := by
  decide +kernel

end AgentWorkspace.Theorems.WellFormed.ErCore
