import ErSnapshot
import AgentWorkspace.Er.Refinement

/-!
T0 — the whole-schema view and the target are coherent definitions.

* The five clusters partition the tables, every one of the 106 checks that are not closed sets
  has a meaning, exactly two of them have two (and `Invariants.ErSynthesis.shared_checks_agree`
  shows the two agree), and the whole-schema semantics always uses the owning cluster's.
* The target schema is well formed table by table, every check it has gets a meaning, and its
  ER diagram draws each relationship once.
-/

namespace AgentWorkspace.Theorems.WellFormed.ErSynthesis

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Er

/-- The cluster wire spellings, in declaration order. -/
@[aw_spec (tier := T0) (doc := "docs/formal/00-orchestrator-prompt.md#7-phases-and-units")]
theorem cluster_wires :
    (WireEnum.all : List Current.Cluster).map WireEnum.toWire =
      ["identity", "catalog", "configuration", "work", "publication"] := by decide +kernel

/-- Every table of the snapshot belongs to exactly one of the five concept clusters. -/
@[aw_spec (tier := T0)
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")
  (ts := "packages/core/src/db/schema/index.ts")]
theorem clusters_partition_the_tables :
    (allTables.all fun t =>
      ((WireEnum.all : List Current.Cluster).filter (·.tables.contains t)).length == 1) = true ∧
      ((WireEnum.all : List Current.Cluster).map (·.tables.length)).sum =
        Snapshot.tableCount := by decide +kernel

/-- Today's schema has 108 checks that are not closed sets, and every one of them is given a
meaning by at least one cluster. -/
@[aw_spec (tier := T0)
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")
  (ts := "packages/core/src/db/schema/index.ts")]
theorem every_other_check_is_refined :
    Current.otherChecks.length = 108 ∧
      (Current.otherChecks.all fun (t, n) => !(Current.refinedBy t n).isEmpty) = true := by decide +kernel

/-- Exactly two checks are given a meaning by two clusters: the default-model pairs of workspaces
and projects, which the configuration cluster refines beside the table's own cluster. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/workspaces.ts#workspaces")
  (ts := "packages/core/src/db/schema/projects.ts#projects")]
theorem only_the_default_model_pairs_are_refined_twice :
    Current.otherChecks.filter (fun (t, n) => (Current.refinedBy t n).length != 1) =
      [(.projects, "projects_default_model_pair"),
       (.workspaces, "workspaces_default_model_pair")] ∧
      Current.refinedBy .workspaces "workspaces_default_model_pair" = [.identity, .configuration] ∧
      Current.refinedBy .projects "projects_default_model_pair" = [.configuration, .work] := by
  decide +kernel

/-- The whole-schema meaning of every check is the one its table's own cluster gives it. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/index.ts")]
theorem check_semantics_follow_the_owning_cluster :
    (Current.otherChecks.all fun (t, n) => (Current.refinedBy t n).contains (Current.clusterOf t)) =
      true := by decide +kernel

/-- Every table of the target schema is well formed: unique names, a `NOT NULL` primary key, keys
PostgreSQL accepts, well-formed unique keys and checks, and the tenancy rule. -/
@[aw_spec (tier := T0) (doc := "docs/formal/concepts.md#the-target-er-model")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#TENANT_EXEMPT")]
theorem target_tables_are_well_formed (t : TableName) :
    tableWellFormed Target.schema t = true := by
  cases t <;> decide +kernel

/-- Every check of the target that is not a closed set has a meaning: one the target gives it, or
the one today's owning cluster gives it. -/
@[aw_spec (tier := T0) (doc := "docs/formal/concepts.md#the-target-er-model")]
theorem target_checks_all_have_a_meaning :
    (allTables.all fun t => (Target.schema t).checks.all fun
      | .other n => (Target.targetCheck? n default).isSome || !(Current.refinedBy t n).isEmpty
      | .oneOf .. => true) = true := by decide +kernel

/-- The target ER diagram draws each foreign key at most once, and draws every key except the 53
references to the tenant root and the 10 single-column `SET NULL` siblings. -/
@[aw_spec (tier := T0) (doc := "docs/formal/concepts.md#the-target-er-model")]
theorem er_diagram_draws_each_relationship_once :
    ((Target.drawn Target.schema).map (·.2.name)).Nodup ∧
      (Target.drawn Target.schema).length + 53 + 10 =
        (allTables.map fun t => (Target.schema t).foreignKeys.length).sum := by decide +kernel

end AgentWorkspace.Theorems.WellFormed.ErSynthesis
