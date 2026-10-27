import AgentWorkspace.Er.Target

/-!
T5 — the concept glossary gives one meaning per term.

`Er.Target.glossary` is the data behind `docs/formal/concepts.md`. These theorems are properties of
the glossary itself: its names are unique, every alias of today resolves to exactly one term,
every word that today conflates two concepts is split into distinct terms (and names at most one
of them), and every table is the home of exactly one term.
-/

namespace AgentWorkspace.Theorems.Meta.ErSynthesis

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Er.Target

/-- No two glossary terms share a name. -/
@[aw_spec (tier := T5) (doc := "docs/formal/concepts.md#glossary")]
theorem glossary_names_are_unique : (glossary.map (·.name)).Nodup := by decide +kernel

/-- Every alias found today resolves to exactly one glossary term, and no alias is the name of
another term. -/
@[aw_spec (tier := T5) (doc := "docs/formal/concepts.md#glossary")]
theorem every_alias_names_one_term :
    (glossary.all fun t => t.aliases.all fun a => resolve a == [t.name]) = true := by decide +kernel

/-- Every word that today denotes more than one concept is split into at least two distinct
glossary terms, and in the target vocabulary the word names at most one of them. -/
@[aw_spec (tier := T5) (doc := "docs/formal/concepts.md#conflations-today")]
theorem every_conflation_is_resolved :
    (conflations.all fun (w, ts) => 2 ≤ ts.length && decide ts.Nodup &&
      ts.all (fun n => (term? n).isSome) && (resolve w).length ≤ 1) = true := by decide +kernel

/-- Every table is the home of exactly one glossary term. -/
@[aw_spec (tier := T5) (doc := "docs/formal/concepts.md#glossary")
  (ts := "packages/core/src/db/schema/index.ts")]
theorem every_table_is_home_to_one_term :
    (allTables.all fun t => (glossary.filter (·.tables.contains t)).length == 1) = true := by
  decide +kernel

/-- Identity, permission and tenant selection are three glossary terms, none an alias of another. -/
@[aw_spec (tier := T5) (doc := "docs/architecture.md#runtime-and-trust-boundaries")
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#three-separate-questions-three-separate-mechanisms")]
theorem identity_permission_and_tenant_selection_are_distinct :
    resolve "identity" = ["identity"] ∧ resolve "permission" = ["permission"] ∧
      resolve "tenant selection" = ["tenant selection"] := by decide +kernel

end AgentWorkspace.Theorems.Meta.ErSynthesis
