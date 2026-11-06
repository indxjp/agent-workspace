import AgentWorkspace.Prelude.Ids

/-!
# RunTree — one user message, one run tree (ADR-0104 acceptance)

An agent team in `handoff` mode answers one user message with a **run tree**: the lead's run (the
root) and the child runs its member tools started. Each child names the lead run in
`parent_run_id`, keeps its own cost, and belongs to the root's workspace. The tree is one trace, one
cost and one evaluation (ADR-0104, decisions 6–9 of its acceptance).

`runs.parent_run_id` carries the parent link (U4.2b), and the member endpoint starts child runs
under the fan-out limit `AGENT_TEAM_CHILD_RUNS_MAX` (U4.2c, issue #1517).

**Choices.**

* A tree is the list of its nodes, and `parent` is an id looked up in that list, as
  `parent_run_id` is a column looked up in `runs`. The model does not use an inductive tree,
  because the storage has none: a tree is whatever the parent links make of the rows.
* The depth is at most 1 (a member may not be a team, and a member run gets no member tools), so
  `rootOf` follows one parent link. `WellFormed.parentIsRoot` is what makes that enough, and it also
  rules out a self-parent and every cycle.
* "One user message" is `WellFormed.oneTree`: every node resolves to the same root. That a
  well-formed tree has exactly one root is then a theorem, not an assumption.
* `treeCost` is the read-time sum over the nodes whose root is the given root (`GET /api/runs/:id`
  answers it as `treeCost`). There is no stored total, so the sum cannot disagree with its parts.
* A cost is a natural number of the smallest currency unit; the wire's decimal `cost_usd` is that
  number scaled.

The theorems are in `Theorems/Normative/RunTree.lean`.
-/

-- shortcut: Nat cost in the smallest unit; upgrade to the wire's decimal if a vector needs it

namespace AgentWorkspace.Concepts.RunTree

open AgentWorkspace

/-- At most this many child runs per root run (ADR-0104 acceptance, decision 6). -/
@[aw_spec (doc := "docs/adr/0104-a-team-is-a-resource.md#acceptance-u42a-2026-10-31")
  (ts := "packages/contracts/src/agent-teams.ts#AGENT_TEAM_CHILD_RUNS_MAX")]
def maxChildren : Nat := 16

/-- One run as the tree sees it: its id, its workspace, the lead run that started it (`none` for a
root) and its own settled cost. -/
@[aw_spec (doc := "docs/adr/0104-a-team-is-a-resource.md#acceptance-u42a-2026-10-31")
  (doc := "docs/sdk/04-api-specification.md#512-runs-and-the-event-stream--awruns")]
structure RunNode where
  id : RunId
  workspace : WorkspaceId
  parent : Option RunId
  cost : Nat
  deriving DecidableEq, Repr

/-- The node a parent link names: the first node of the tree with that id. -/
def lookup (t : List RunNode) (r : RunId) : Option RunNode :=
  t.find? (fun n => n.id == r)

/-- A node's root: the node itself when it has no parent, otherwise the node its parent link names.
One step suffices because the depth is at most 1; a dangling link (which `WellFormed` rules out)
falls back to the node itself. -/
@[aw_spec (doc := "docs/adr/0104-a-team-is-a-resource.md#acceptance-u42a-2026-10-31")]
def rootOf (t : List RunNode) (n : RunNode) : RunNode :=
  match n.parent with
  | none => n
  | some p => (lookup t p).getD n

/-- The child runs of a run: the nodes whose parent link names it. -/
def childrenOf (t : List RunNode) (r : RunId) : List RunNode :=
  t.filter (fun n => n.parent == some r)

/-- The rolled-up cost of the tree of `root`: the sum of the costs of the nodes whose root it is,
read at query time. -/
@[aw_spec (doc := "docs/adr/0104-a-team-is-a-resource.md#acceptance-u42a-2026-10-31")
  (doc := "docs/sdk/04-api-specification.md#512-runs-and-the-event-stream--awruns")]
def treeCost (t : List RunNode) (root : RunNode) : Nat :=
  ((t.filter (fun n => rootOf t n == root)).map RunNode.cost).sum

/-- A well-formed run tree, the nodes one user message produced:

* `nonempty` — there is at least the root;
* `nodup` — run ids are distinct, as `runs.id` is a key;
* `parentExists` — every parent link names a node of the tree;
* `parentIsRoot` — the node a link names has no parent itself: depth at most 1, so no self-parent
  and no cycle;
* `sameWorkspace` — a child is in its parent's workspace (the tenant-paired foreign key);
* `oneTree` — every node resolves to the same root;
* `fanOut` — a run has at most `maxChildren` child runs. -/
@[aw_spec (doc := "docs/adr/0104-a-team-is-a-resource.md#acceptance-u42a-2026-10-31")]
structure WellFormed (t : List RunNode) : Prop where
  nonempty : t ≠ []
  nodup : (t.map RunNode.id).Nodup
  parentExists : ∀ n ∈ t, ∀ p, n.parent = some p → ∃ m ∈ t, m.id = p
  parentIsRoot : ∀ n ∈ t, ∀ m ∈ t, n.parent = some m.id → m.parent = none
  sameWorkspace : ∀ n ∈ t, ∀ m ∈ t, n.parent = some m.id → n.workspace = m.workspace
  oneTree : ∀ n ∈ t, ∀ m ∈ t, rootOf t n = rootOf t m
  fanOut : ∀ r, (childrenOf t r).length ≤ maxChildren

/-- A link that resolves names a node of the tree with that id. -/
theorem lookup_some {t : List RunNode} {r : RunId} {m : RunNode} (h : lookup t r = some m) :
    m ∈ t ∧ m.id = r := by
  unfold lookup at h
  exact ⟨List.mem_of_find?_eq_some h, by simpa using List.find?_some h⟩

/-- In a well-formed tree, every node's root is a node of the tree, has no parent, and is in the
node's workspace. -/
theorem rootOf_spec {t : List RunNode} (w : WellFormed t) {n : RunNode} (hn : n ∈ t) :
    rootOf t n ∈ t ∧ (rootOf t n).parent = none ∧ (rootOf t n).workspace = n.workspace := by
  unfold rootOf
  cases hp : n.parent with
  | none => exact ⟨hn, hp, rfl⟩
  | some p =>
    obtain ⟨m, hm, hid⟩ := w.parentExists n hn p hp
    cases hl : lookup t p with
    | none =>
      rw [lookup, List.find?_eq_none] at hl
      exact absurd (hl m hm) (by simp [hid])
    | some m' =>
      simp only [hl, Option.getD_some]
      obtain ⟨hm', hid'⟩ := lookup_some hl
      have hp'' : n.parent = some m'.id := by rw [hp, hid']
      exact ⟨hm', w.parentIsRoot n hn m' hm' hp'', (w.sameWorkspace n hn m' hm' hp'').symm⟩

/-- A node with no parent is its own root. -/
theorem rootOf_of_root (t : List RunNode) {n : RunNode} (h : n.parent = none) : rootOf t n = n := by
  simp [rootOf, h]

end AgentWorkspace.Concepts.RunTree
