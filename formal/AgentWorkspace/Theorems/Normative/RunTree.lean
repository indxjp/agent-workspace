import AgentWorkspace.Concepts.RunTree

/-!
# T1 — one user message, one run tree, one cost (ADR-0104 acceptance)

* **One root.** A well-formed tree has exactly one run with no parent, and every node resolves to it.
* **One cost.** The rolled-up cost of the root is the sum of every node's own cost, so a read-time
  sum needs no stored total.
* **One workspace.** A child is in its root's workspace.
* **Depth at most 1.** No run is its own parent, and a child run has no children.

The read-time sum is `treeCostOf` (`GET /api/runs/:id`), and a child run gets no member server,
`teamMemberServerFor` (issue #1517), which is what keeps the depth at most 1.
-/

namespace AgentWorkspace.Theorems.Normative.RunTree

open AgentWorkspace AgentWorkspace.Concepts.RunTree

/-- A well-formed run tree has exactly one root: one run with no parent, and every run with no
parent is that one. -/
@[aw_spec (tier := T1) (doc := "docs/adr/0104-a-team-is-a-resource.md#acceptance-u42a-2026-10-31")]
theorem wellFormed_one_root {t : List RunNode} (w : WellFormed t) :
    ∃ r ∈ t, r.parent = none ∧ ∀ n ∈ t, n.parent = none → n = r := by
  obtain ⟨x, hx⟩ := List.exists_mem_of_ne_nil t w.nonempty
  obtain ⟨hr, hrp, _⟩ := rootOf_spec w hx
  refine ⟨rootOf t x, hr, hrp, fun n hn hnp => ?_⟩
  rw [← rootOf_of_root t hnp]
  exact w.oneTree n hn x hx

/-- The rolled-up cost of the root is the sum of the costs of every run of the tree. -/
@[aw_spec (tier := T1) (doc := "docs/adr/0104-a-team-is-a-resource.md#acceptance-u42a-2026-10-31")
  (doc := "docs/sdk/04-api-specification.md#512-runs-and-the-event-stream--awruns")
  (ts := "apps/web/server/runs/tree-cost.ts#treeCostOf")]
theorem treeCost_eq_sum {t : List RunNode} (w : WellFormed t) {r : RunNode} (hr : r ∈ t)
    (hroot : r.parent = none) :
    treeCost t r = (t.map RunNode.cost).sum := by
  unfold treeCost
  rw [List.filter_eq_self.mpr]
  intro n hn
  have h := w.oneTree n hn r hr
  rw [rootOf_of_root t hroot] at h
  simp [h]

/-- A run is in its root's workspace: a child never leaves the workspace of the run that
started it. -/
@[aw_spec (tier := T1) (doc := "docs/adr/0104-a-team-is-a-resource.md#acceptance-u42a-2026-10-31")]
theorem child_workspace_eq_root {t : List RunNode} (w : WellFormed t) {n : RunNode} (hn : n ∈ t) :
    n.workspace = (rootOf t n).workspace :=
  (rootOf_spec w hn).2.2.symm

/-- Resolving a root again gives the same root. -/
@[aw_spec (tier := T1) (doc := "docs/adr/0104-a-team-is-a-resource.md#acceptance-u42a-2026-10-31")]
theorem rootOf_idempotent {t : List RunNode} (w : WellFormed t) {n : RunNode} (hn : n ∈ t) :
    rootOf t (rootOf t n) = rootOf t n :=
  rootOf_of_root t (rootOf_spec w hn).2.1

/-- No run is its own parent. -/
@[aw_spec (tier := T1) (doc := "docs/adr/0104-a-team-is-a-resource.md#acceptance-u42a-2026-10-31")]
theorem no_self_parent {t : List RunNode} (w : WellFormed t) {n : RunNode} (hn : n ∈ t) :
    n.parent ≠ some n.id := by
  intro h
  have := w.parentIsRoot n hn n hn h
  rw [this] at h
  cases h

/-- The depth is at most 1: a child run has no children, so a member never starts a member. -/
@[aw_spec (tier := T1) (doc := "docs/adr/0104-a-team-is-a-resource.md#acceptance-u42a-2026-10-31")
  (ts := "apps/web/server/compose/run-request-tool-connectors.ts#teamMemberServerFor")]
theorem child_has_no_children {t : List RunNode} (w : WellFormed t) {n : RunNode} (hn : n ∈ t)
    {p : RunId} (hp : n.parent = some p) :
    childrenOf t n.id = [] := by
  unfold childrenOf
  rw [List.filter_eq_nil_iff]
  intro m hm hc
  have hmp : m.parent = some n.id := by simpa using hc
  have := w.parentIsRoot m hm n hn hmp
  rw [this] at hp
  cases hp

end AgentWorkspace.Theorems.Normative.RunTree
