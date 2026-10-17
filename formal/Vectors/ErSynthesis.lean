import AgentWorkspace.Er.Refinement
import Vectors.Common

/-!
Vectors for the `er-synthesis` family. What the TypeScript can check is today's schema, so every
vector states a fact about it that a theorem of the family rests on, and the conformance suite
replays it against the live Drizzle table objects:

* `clusters.json`: per table, its cluster, tenancy, root key and checks (which ones are closed
  sets, and which clusters give each other check a meaning);
* `keys.json`: per foreign key, its shape, tenancy class and whether it is tenant-paired, and the
  key of the target it becomes;
* `owners.json`: per table with an owner column, the column, its nullability and its key;
* `divergence.json`: the current side of every schema cell where the target differs (a changed
  key, an added key, added and dropped columns and checks, a renamed table, the unexecutable
  `SET NULL` keys, the closed set that escapes the value gate, the ledger's provider set, the
  checks only the target has), so the suite fails when a
  proposed cleanup lands and the model has to follow;
* `refusals.json`: per cluster, the one check only it gives a meaning to that whole-schema
  consistency must enforce, with the table the Drizzle schema declares it on;
* `diagram.json`: the generated target ER diagram, which `docs/formal/concepts.md` must carry
  verbatim;
* `glossary.json`: every glossary term with its aliases and tables, which the concept page must
  list.
-/

namespace Vectors.ErSynthesis

open Lean AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Er AgentWorkspace.Er.Refinement

private def wf : String := "AgentWorkspace.Theorems.WellFormed.ErSynthesis."
private def inv : String := "AgentWorkspace.Theorems.Invariants.ErSynthesis."
private def ref : String := "AgentWorkspace.Theorems.Refinement.ErSynthesis."
private def mt : String := "AgentWorkspace.Theorems.Meta.ErSynthesis."

def strs (xs : List String) : Json := Json.arr (xs.map Json.str).toArray

def keyJson (S : Schema) (t : TableName) (fk : ForeignKey) : Json :=
  Json.mkObj [("name", fk.name), ("columns", strs fk.columns),
    ("refTable", TableName.toWire fk.refTable), ("refColumns", strs fk.refColumns),
    ("onDelete", fk.onDelete.toSql), ("class", (classify S t fk).toWire)]

/-! ## clusters.json -/

def clusterVector (t : TableName) : Vector :=
  let s := catalogue t
  let others := s.checks.filterMap fun
    | .other n => some (Json.mkObj [("name", n),
        ("clusters", strs ((Current.refinedBy t n).map WireEnum.toWire))])
    | .oneOf .. => none
  let closed := s.checks.filterMap fun
    | .oneOf n _ _ => some n
    | .other _ => none
  { id := s!"cluster/{TableName.toWire t}",
    input := Json.mkObj [("table", TableName.toWire t)],
    expected := Json.mkObj [
      ("cluster", WireEnum.toWire (Current.clusterOf t)),
      ("tenancy", s.tenancy.toWire),
      ("rootKey", match s.foreignKeys.find? Current.isRootKey with
        | some fk => Json.str fk.name
        | none => Json.null),
      ("workspaceIdNotNull", s.isNotNull "workspace_id"),
      ("closedSets", strs closed),
      ("otherChecks", Json.arr others.toArray)],
    witnesses := [wf ++ "clusters_partition_the_tables", wf ++ "cluster_wires",
      wf ++ "every_other_check_is_refined", wf ++ "only_the_default_model_pairs_are_refined_twice",
      wf ++ "check_semantics_follow_the_owning_cluster"] ++
      (if s.tenancy == .scoped then [inv ++ "tenant_row_has_exactly_one_workspace"] else []) }

/-! ## keys.json -/

def keyVector (t : TableName) (fk : ForeignKey) : Vector :=
  let img := fkImage t fk
  { id := s!"key/{TableName.toWire t}/{fk.name}",
    input := Json.mkObj [("table", TableName.toWire t), ("name", fk.name)],
    expected := Json.mkObj [
      ("current", keyJson catalogue t fk),
      ("composite", decide (2 ≤ fk.columns.length)),
      ("tenantPaired", isPaired catalogue t fk),
      ("tenancyConstraint", isTenancyConstraint catalogue t fk),
      ("target", keyJson Target.schema t img),
      ("changed", img != fk)],
    witnesses := [ref ++ "every_key_has_an_image", ref ++ "keys_diverge_exactly_at",
        ref ++ "tenancy_classes_are_unchanged"] ++
      (if 2 ≤ fk.columns.length then
        [inv ++ "every_composite_key_is_tenant_paired", inv ++ "composite_reference_stays_in_workspace"]
       else []) ++
      (if isTenancyConstraint catalogue t fk then
        [ref ++ "every_tenancy_constraint_is_kept", inv ++ "no_cross_workspace_reference"]
       else []) }

/-! ## owners.json -/

def ownerVector (t : TableName) (c : String) : Vector :=
  let key := (catalogue t).foreignKeys.find? (Current.isOwnerKey c)
  { id := s!"owner/{TableName.toWire t}",
    input := Json.mkObj [("table", TableName.toWire t)],
    expected := Json.mkObj [("column", c), ("notNull", (catalogue t).isNotNull c),
      ("key", match key with | some fk => Json.str fk.name | none => Json.null),
      ("targetColumn", match Target.ownerColumn? t with | some c => Json.str c | none => Json.null)],
    witnesses := [inv ++ "owner_reference_names_exactly_one_principal",
        inv ++ "owner_is_mandatory_except_for_audit_actors", ref ++ "owner_columns_diverge_exactly_at"] ++
      (if t == .auditEvents then [] else [inv ++ "owned_row_has_exactly_one_owner"]) }

/-! ## divergence.json -/

def changedKeyVectors : List Vector :=
  changedKeys.map fun (t, n) =>
    let fk := ((catalogue t).foreignKey? n).getD default
    { id := s!"changed-key/{TableName.toWire t}/{n}",
      input := Json.mkObj [("kind", "changed-key"), ("table", TableName.toWire t), ("name", n)],
      expected := Json.mkObj [("current", keyJson catalogue t fk),
        ("target", keyJson Target.schema t (fkImage t fk))],
      witnesses := [ref ++ "keys_diverge_exactly_at", ref ++ "every_key_has_an_image"] }

def addedKeyVectors : List Vector :=
  addedKeys.map fun (t, n) =>
    let fk := ((Target.schema t).foreignKey? n).getD default
    { id := s!"added-key/{TableName.toWire t}/{n}",
      input := Json.mkObj [("kind", "added-key"), ("table", TableName.toWire t), ("name", n)],
      expected := Json.mkObj [("target", keyJson Target.schema t fk)],
      witnesses := [ref ++ "keys_added_exactly_at", ref ++ "added_keys_are_tenancy_constraints"] }

def columnVectors : List Vector :=
  columnChanges.map fun (t, added, dropped) =>
    { id := s!"columns/{TableName.toWire t}",
      input := Json.mkObj [("kind", "columns"), ("table", TableName.toWire t)],
      expected := Json.mkObj [("added", strs added), ("dropped", strs dropped)],
      witnesses := [ref ++ "columns_diverge_exactly_at"] }

def checkVectors : List Vector :=
  checkChanges.map fun (t, added, dropped) =>
    { id := s!"checks/{TableName.toWire t}",
      input := Json.mkObj [("kind", "checks"), ("table", TableName.toWire t)],
      expected := Json.mkObj [("added", strs added), ("dropped", strs dropped)],
      witnesses := [ref ++ "checks_diverge_exactly_at"] }

def tableNameVectors : List Vector :=
  (allTables.filter fun t => Target.tableName t != t.toWire).map fun t =>
    { id := s!"table-name/{TableName.toWire t}",
      input := Json.mkObj [("kind", "table-name"), ("table", TableName.toWire t)],
      expected := Json.mkObj [("current", TableName.toWire t), ("target", Target.tableName t)],
      witnesses := [ref ++ "table_names_diverge_exactly_at"] }

def pairJson (l : List (TableName × String)) : Json :=
  Json.arr (l.map fun (t, n) => Json.mkObj [("table", TableName.toWire t), ("name", n)]).toArray

/-- The value list of the principal-kind closed set under schema `S`. -/
def valuesOf (S : Schema) : Json :=
  strs (((S .workspacePrincipals).oneOfCheck? "workspace_principals_kind_valid").map (·.2) |>.getD [])

def gateVectors : List Vector :=
  [{ id := "set-null",
     input := Json.mkObj [("kind", "set-null")],
     expected := Json.mkObj [("current", pairJson (unsoundSetNull catalogue)),
       ("target", pairJson (unsoundSetNull Target.schema))],
     witnesses := [ref ++ "set_null_diverges_exactly_at", ref ++ "deleting_a_default_agent_diverges"] },
   { id := "value-gate",
     input := Json.mkObj [("kind", "value-gate")],
     expected := Json.mkObj [("current", pairJson (unrenderable catalogue)),
       ("target", pairJson (unrenderable Target.schema)),
       ("currentValues", valuesOf catalogue), ("targetValues", valuesOf Target.schema)],
     witnesses := [ref ++ "value_gate_diverges_exactly_at"] }]

/-- The value list of closed set `n` of table `t` under schema `S`. -/
def closedValues (S : Schema) (t : TableName) (n : String) : Json :=
  strs (((S t).oneOfCheck? n).map (·.2) |>.getD [])

def ledgerVectors : List Vector :=
  [{ id := "ledger-provider",
     input := Json.mkObj [("kind", "ledger-provider")],
     expected := Json.mkObj [
       ("runsValues", closedValues catalogue .runs "runs_provider_valid"),
       ("targetValues", closedValues Target.schema .runUsageRecords
         "run_usage_records_provider_valid")],
     witnesses := [ref ++ "ledger_providers_are_the_run_providers",
       ref ++ "every_run_provider_is_a_valid_ledger_provider",
       ref ++ "diverges_at_an_unknown_ledger_provider"] }]

def targetCheckVectors : List Vector :=
  [("two-subjects", TargetCells.twoSubjects, "target_refuses_two_subjects"),
   ("subject-in-another-column", TargetCells.subjectInAnotherColumn,
     "target_refuses_a_subject_in_another_column")].map fun (id, st, thm) =>
    { id := s!"target-check/{id}",
      input := Json.mkObj [("kind", "target-check"), ("table", "shares")],
      expected := Json.mkObj [("violations", strs (Target.violations st))],
      witnesses := [ref ++ thm] }

/-! ## refusals.json -/

def refusalVectors : List Vector :=
  Refusals.cells.map fun (c, _, t, n) =>
    { id := s!"refusal/{WireEnum.toWire c}",
      input := Json.mkObj [("cluster", WireEnum.toWire c), ("table", TableName.toWire t)],
      expected := Json.mkObj [("check", n),
        ("clusters", strs ((Current.refinedBy t n).map WireEnum.toWire))],
      witnesses := [inv ++ "every_cluster_check_is_enforced"] }

/-! ## diagram.json and glossary.json -/

def diagramVectors : List Vector :=
  [{ id := "target-er-diagram",
     input := Json.mkObj [("document", "docs/formal/concepts.md")],
     expected := Json.mkObj [("mermaid", Target.erDiagram)],
     witnesses := [wf ++ "er_diagram_draws_each_relationship_once",
       wf ++ "target_tables_are_well_formed", ref ++ "table_names_diverge_exactly_at"] }]

def glossaryVectors : List Vector :=
  Target.glossary.map fun term =>
    { id := s!"term/{term.name}",
      input := Json.mkObj [("term", term.name)],
      expected := Json.mkObj [("aliases", strs term.aliases),
        ("tables", strs (term.tables.map TableName.toWire))],
      witnesses := [mt ++ "glossary_names_are_unique", mt ++ "every_alias_names_one_term",
        mt ++ "every_table_is_home_to_one_term"] }

def files : List (String × Json) :=
  [("clusters.json", file "er-synthesis"
      "Every table's cluster, tenancy, root key and check ownership, replayed against Drizzle."
      (allTables.map clusterVector)),
   ("keys.json", file "er-synthesis"
      "Every foreign key: its shape, tenancy class, pairing, and the target key it becomes."
      (allTables.flatMap fun t => (catalogue t).foreignKeys.map (keyVector t))),
   ("owners.json", file "er-synthesis"
      "Every owner column: its nullability and its tenant-paired key to workspace_principals."
      (allTables.filterMap fun t => (Current.ownerColumn? t).map (ownerVector t))),
   ("divergence.json", file "er-synthesis"
      "The current side of every schema cell where the target differs."
      (changedKeyVectors ++ addedKeyVectors ++ columnVectors ++ checkVectors ++ tableNameVectors ++
        gateVectors ++ ledgerVectors ++ targetCheckVectors)),
   ("refusals.json", file "er-synthesis"
      "Per cluster, one check only it refines that whole-schema consistency enforces."
      refusalVectors),
   ("diagram.json", file "er-synthesis"
      "The generated target ER diagram, carried verbatim by docs/formal/concepts.md."
      diagramVectors),
   ("glossary.json", file "er-synthesis"
      "Every glossary term, its aliases today and its tables, listed by docs/formal/concepts.md."
      glossaryVectors)]

end Vectors.ErSynthesis
