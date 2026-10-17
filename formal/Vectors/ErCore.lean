import AgentWorkspace.Er.Core
import Vectors.Common

/-!
Vectors for the `er-core` family: the table catalogue as data (replayed against the live Drizzle
table objects and the latest snapshot, `Er.Snapshot.file`), the `oneOf` value gate, and the UUID
shape.
-/

namespace Vectors.ErCore

open Lean AgentWorkspace AgentWorkspace.Er.Core

private def wf : String := "AgentWorkspace.Theorems.WellFormed.ErCore."

def strs (xs : List String) : Json := Json.arr (xs.map Json.str).toArray

def classSuffix : FkClass → String
  | .rootReference => "root_reference"
  | .globalReference => "global_reference"
  | .tenantPaired => "tenant_paired"
  | .siblingPaired => "sibling_paired"
  | .unpaired => "unpaired"

def columnJson (c : Column) : Json :=
  Json.mkObj [("name", c.name), ("type", c.type.toSql), ("notNull", c.notNull)]

def fkJson (t : TableName) (fk : ForeignKey) : Json :=
  Json.mkObj [("name", fk.name), ("columns", strs fk.columns),
    ("refTable", TableName.toWire fk.refTable), ("refColumns", strs fk.refColumns),
    ("onDelete", fk.onDelete.toSql), ("inline", fk.inline),
    ("class", (classify catalogue t fk).toWire), ("setNullSound", setNullSound catalogue t fk)]

def uniqueJson (u : UniqueKey) : Json :=
  Json.mkObj [("name", u.name), ("columns", strs u.columns),
    ("kind", match u.kind with | .constraint => "constraint" | .index => "index"),
    ("partialNullColumns", strs u.partialNullColumns)]

def checkJson : Check → Json
  | .oneOf n c vs =>
    Json.mkObj [("name", n), ("oneOf", Json.mkObj [("column", c), ("values", strs vs)])]
  | .other n => Json.mkObj [("name", n), ("oneOf", Json.null)]

def tableVector (t : TableName) : Vector :=
  let s := catalogue t
  let sql := TableName.toWire t
  { id := s!"table/{sql}",
    input := Json.mkObj [("table", sql)],
    expected := Json.mkObj [
      ("tenancy", s.tenancy.toWire), ("source", s.source), ("tsExport", s.tsExport),
      ("primaryKey", strs s.primaryKey),
      ("columns", Json.arr (s.columns.map columnJson).toArray),
      ("foreignKeys", Json.arr (s.foreignKeys.map (fkJson t)).toArray),
      ("uniques", Json.arr (s.uniques.map uniqueJson).toArray),
      ("checks", Json.arr (s.checks.map checkJson).toArray)],
    witnesses := [wf ++ s!"table_{sql}_is_well_formed", wf ++ s!"table_{sql}_matches_snapshot",
        wf ++ "fk_class_wires", wf ++ "tenancy_wires", wf ++ "on_delete_wires",
        wf ++ "unique_kind_wires",
        wf ++ "every_table_is_well_formed", wf ++ "catalogue_pairing_is_complete"] ++
      s.foreignKeys.map (fun fk => wf ++ s!"{fk.name}_is_{classSuffix (classify catalogue t fk)}") ++
      s.foreignKeys.map (fun fk => wf ++ s!"{fk.name}_matches_snapshot") ++
      s.uniques.map (fun u => wf ++ s!"{u.name}_matches_snapshot") ++
      s.checks.map (fun c => wf ++ s!"{c.name}_matches_snapshot") }

def catalogueVectors : List Vector :=
  [{ id := "catalogue/tables",
     input := Json.mkObj [],
     expected := Json.mkObj [("tables", strs (WireEnum.wires TableName)),
       ("snapshot", Json.str Er.Snapshot.file)],
     witnesses := [wf ++ "table_names_match_schema",
       "AgentWorkspace.Theorems.Normative.ErCore.workspace_is_the_tenant_root"] }]

/-- Every closed-set value list in the catalogue, then lists the gate must refuse. -/
def valueLists : List (List String) :=
  let fromCatalogue := allTables.flatMap fun t => (catalogue t).checks.filterMap fun
    | .oneOf _ _ vs => some vs
    | .other _ => none
  fromCatalogue.eraseDups ++
    [[], ["a"], ["a", "a"], ["read", "read"], ["A"], ["1a"], ["-a"], ["a-"], ["a--b"], ["a_b"],
      ["api_key"], ["a b"], ["a'b"], ["x'); drop table users; --"], ["é"], [""],
      [String.ofList (List.replicate 64 'a')], [String.ofList (List.replicate 65 'a')],
      ["a1-b2-c3"], ["z9"], ["ok", "Not"], ["aB"], ["a-B"], ["abC1"], ["a_"], ["ab'"]]

def oneOfVectors : List Vector :=
  valueLists.map fun vs =>
    { id := s!"one-of/{(strs vs).compress}",
      input := Json.mkObj [("values", strs vs)],
      expected := Json.mkObj [("rendered", match renderValueList? vs with
        | some s => Json.str s
        | none => Json.null)],
      witnesses := [wf ++ "render_value_list_accepts_iff", wf ++ "safe_value_boundaries",
        wf ++ "slug_of_64_characters_is_safe",
        wf ++ "slug_of_65_characters_is_refused",
        "AgentWorkspace.Theorems.Adversarial.ErCore.quoted_value_is_refused",
        "AgentWorkspace.Theorems.Adversarial.ErCore.safe_value_has_only_slug_characters",
        "AgentWorkspace.Theorems.Adversarial.ErCore.upper_case_value_is_refused",
        "AgentWorkspace.Theorems.Meta.ErCore.only_principal_kind_escapes_the_value_gate"] }

/-- `NON_REFERENCE_ID_COLUMNS`: the `*_id` columns no foreign key covers, with their SQL types. -/
def referenceVectors : List Vector :=
  [{ id := "references/non-reference-id-columns",
     input := Json.mkObj [],
     expected := Json.mkObj [("nonReferenceIdColumns", Json.arr (nonReferenceIdColumns.map
       fun (t, c, ty) => Json.mkObj [("table", TableName.toWire t), ("column", c),
         ("type", ty.toSql)]).toArray)],
     witnesses := [wf ++ "every_id_column_is_a_reference_or_declared", wf ++ "uncovered_id_columns",
       wf ++ "declared_reference_column_is_refused",
       "AgentWorkspace.Theorems.Adversarial.ErCore.deleted_reference_is_caught"] }]

def uuidSamples : List String :=
  ["123e4567-e89b-12d3-a456-426614174000", "123E4567-E89B-12D3-A456-426614174000",
    "00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff",
    "123e4567e89b12d3a456426614174000", "123e4567-e89b-12d3-a456-42661417400",
    "123e4567-e89b-12d3-a456-4266141740000", "g23e4567-e89b-12d3-a456-426614174000",
    "{123e4567-e89b-12d3-a456-426614174000}", " 123e4567-e89b-12d3-a456-426614174000",
    "123e4567-e89b-12d3-a456_426614174000", "123e4567-e89b-12d3-a4560426614174000", "",
    "123e4567-e89b-12d3-a456-42661417400\u0000", "１23e4567-e89b-12d3-a456-426614174000",
    "123e4567-e89b-12d3-a456-42661417400g", "123e4567-e89b-12d3-a456-42661417400G",
    "123e4567-e89b-12d3-a456-42661417400F"]

def uuidVectors : List Vector :=
  uuidSamples.map fun s =>
    { id := s!"uuid/{(Json.str s).compress}",
      input := Json.str s,
      expected := Json.mkObj [("canonical", Uuid.isCanonical s)],
      witnesses := [wf ++ "canonical_uuid_is_hex_and_hyphens",
        wf ++ "uuid_with_a_non_hex_digit_is_refused"] }

def files : List (String × Json) :=
  [("tables.json",
      file "er-core" "Every table of the schema: tenancy, columns, keys, checks and FK classes"
        (allTables.map tableVector)),
   ("catalogue.json", file "er-core" "The set of table names" catalogueVectors),
   ("one-of.json", file "er-core" "renderValueList over every catalogue value list and edge cases"
     oneOfVectors),
   ("references.json", file "er-core"
     "The *_id columns that are declared non-references (tenancy.test.ts rule 3)" referenceVectors),
   ("uuid.json", file "er-core" "UUID_PATTERN / isUuid over canonical forms and near misses"
     uuidVectors)]

end Vectors.ErCore
