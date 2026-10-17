import AgentWorkspace.Concepts.Agent

/-!
# PolicyCeiling — the most any agent of a deployment may do (ADR-0102 SD6, C13, C14)

A **ceiling** is a project's policy (`ProjectPolicySchema`): permission switches it turns off,
limits no agent may exceed, and allowlists of engines, model ids and connector names. An absent
key caps nothing. The caller's role is not an input: the Owner is judged like anyone else.

* `violations e c` is `policyWidenings`: where the configuration `e` asks for more than the
  ceiling `c` allows, in C14's fixed order — permissions in `AGENT_PERMISSION_KEYS` order,
  `limits.maxTurns`, `limits.maxBudgetUsd`, `engine:<id>`, `model:<id>`, then each distinct
  connector outside `tools`, ascending.
* `meet e c` is `meetPolicyCeiling`: the configuration at or below both. It narrows permissions,
  limits and tools; the engine and the model cannot be narrowed, so the caller refuses them.

A `none` limit is the agent's `null` ("the engine's default" or "no cap"): it never widens, and it
composes at the ceiling's value. A ceiling never holds a `none` limit; an absent cap is `none`.

The theorems are in `Theorems/{Normative,Invariants,Refinement}/PolicyCeiling.lean`; the vectors in
`formal/Vectors/PolicyCeiling.lean` replay against the contracts functions.
-/

-- ponytail: Nat budget and code-point order, vectors use integers and ASCII; upgrade to Rat/UTF-16 if a vector needs it

namespace AgentWorkspace.Concepts.PolicyCeiling

open AgentWorkspace AgentWorkspace.Concepts.Agent

/-- A parsed `ProjectPolicy`. `caps` are the permission keys the ceiling sets `false`; `none` for
a limit or an allowlist means the key is absent. `minEvalScore` is `promotion.minEvalScore`, the
promotion gate's bar (`Release.gate`): `violations` and `meet` never read it (80-12). -/
@[aw_spec (ts := "packages/contracts/src/policy-ceiling.ts#ProjectPolicySchema")
  (doc := "docs/adr/0102-content-owners-edit-engineers-build-admins-narrow-stop-and-approve.md#slice-2-acceptance")]
structure Ceiling where
  caps : List String
  maxTurns : Option Nat
  maxBudget : Option Nat
  engines : Option (List String)
  models : Option (List String)
  tools : Option (List String)
  minEvalScore : Option Nat
  deriving DecidableEq, Repr, Inhabited

/-- `EffectivePolicyConfiguration`: what a ceiling judges at one step. A `none` limit is `null`;
a `none` model means there is no model to judge at this step. -/
@[aw_spec (ts := "packages/contracts/src/policy-ceiling.ts#EffectivePolicyConfiguration")]
structure Config where
  permissions : Permissions
  maxTurns : Option Nat
  maxBudget : Option Nat
  engine : String
  model : Option String
  tools : List String
  deriving DecidableEq, Repr, Inhabited

/-- One permission switch, by its `AGENT_PERMISSION_KEYS` name. -/
def perm (p : Permissions) : String → Bool
  | "readFiles" => p.readFiles
  | "writeFiles" => p.writeFiles
  | "runCommands" => p.runCommands
  | "unrestrictedNetwork" => p.unrestrictedNetwork
  | _ => false

/-- One `details` entry of `403 policy_cannot_widen` (`PolicyWidening`). -/
@[aw_spec (ts := "packages/contracts/src/policy-ceiling.ts#PolicyWidening")]
inductive Widening where
  | permission (key : String)
  | maxTurns
  | maxBudget
  | engine (id : String)
  | model (id : String)
  | tool (name : String)
  deriving DecidableEq, Repr

namespace Widening

/-- The entry as the wire spells it. -/
def wire : Widening → String
  | permission k => "permissions." ++ k
  | maxTurns => "limits.maxTurns"
  | maxBudget => "limits.maxBudgetUsd"
  | engine id => "engine:" ++ id
  | model id => "model:" ++ id
  | tool n => "tool:" ++ n

/-- An entry the meet cannot narrow away: an engine or a model. -/
def fixed : Widening → Bool
  | engine _ | model _ => true
  | _ => false

end Widening

/-- `exceeds`: an explicit value above a present cap. A `none` value never exceeds. -/
def exceeds : Option Nat → Option Nat → Bool
  | some v, some cap => cap < v
  | _, _ => false

/-- The list without repeats, keeping each value's last occurrence. -/
def distinct : List String → List String
  | [] => []
  | x :: xs => if x ∈ distinct xs then distinct xs else x :: distinct xs

/-- Insert into an ascending list (`byCodeUnit`, here code points). -/
def insertAscending (s : String) : List String → List String
  | [] => [s]
  | x :: xs => if s < x then s :: x :: xs else x :: insertAscending s xs

/-- The distinct values, ascending. -/
def sortedDistinct (l : List String) : List String :=
  (distinct l).foldr insertAscending []

/-- `policyWidenings`, as structured entries in C14 order. -/
def widenings (e : Config) : Option Ceiling → List Widening
  | none => []
  | some c =>
    (permissionKeys.filter fun k => perm e.permissions k && c.caps.contains k).map .permission ++
    (if exceeds e.maxTurns c.maxTurns then [.maxTurns] else []) ++
    (if exceeds e.maxBudget c.maxBudget then [.maxBudget] else []) ++
    (match c.engines with
     | some es => if es.contains e.engine then [] else [.engine e.engine]
     | none => []) ++
    (match e.model, c.models with
     | some m, some ms => if ms.contains m then [] else [.model m]
     | _, _ => []) ++
    (match c.tools with
     | some ts => ((sortedDistinct e.tools).filter fun t => !ts.contains t).map .tool
     | none => [])

/-- C14's canonical key order for `e`: every entry `violations e _` could name, in the order it
names them. -/
def keyOrderEntries (e : Config) : List Widening :=
  permissionKeys.map .permission ++ [.maxTurns] ++ [.maxBudget] ++ [.engine e.engine] ++
    e.model.toList.map .model ++ (sortedDistinct e.tools).map .tool

/-- `keyOrderEntries`, as the wire spells them. -/
def keyOrder (e : Config) : List String := (keyOrderEntries e).map Widening.wire

/-- `policyWidenings`: where `e` asks for more than `c` allows, in C14's order. Empty means
nothing widens. -/
@[aw_spec (ts := "packages/contracts/src/policy-ceiling.ts#policyWidenings")
  (doc := "docs/adr/0102-content-owners-edit-engineers-build-admins-narrow-stop-and-approve.md#slice-2-acceptance")]
def violations (e : Config) (c : Option Ceiling) : List String :=
  (widenings e c).map Widening.wire

/-- Every field of `e` is at or under `c`, judged field by field (no list of details). -/
@[aw_spec (ts := "packages/contracts/src/policy-ceiling.ts#policyWidenings")]
def within (e : Config) : Option Ceiling → Bool
  | none => true
  | some c =>
    permissionKeys.all (fun k => !(perm e.permissions k && c.caps.contains k)) &&
    !exceeds e.maxTurns c.maxTurns && !exceeds e.maxBudget c.maxBudget &&
    (match c.engines with
     | some es => es.contains e.engine
     | none => true) &&
    (match e.model, c.models with
     | some m, some ms => ms.contains m
     | _, _ => true) &&
    (match c.tools with
     | some ts => e.tools.all ts.contains
     | none => true)

/-! ## Lemmas the theorems build on -/

/-- `distinct` keeps exactly the values of its input. -/
theorem mem_distinct {a : String} {l : List String} : a ∈ distinct l ↔ a ∈ l := by
  induction l with
  | nil => simp [distinct]
  | cons x xs ih =>
    unfold distinct
    split
    · rename_i h
      constructor
      · intro ha; exact List.mem_cons_of_mem _ (ih.mp ha)
      · intro ha
        rcases List.mem_cons.mp ha with rfl | ha
        · exact h
        · exact ih.mpr ha
    · simp [ih]

/-- `distinct` has no repeats. -/
theorem nodup_distinct (l : List String) : (distinct l).Nodup := by
  induction l with
  | nil => simp [distinct]
  | cons x xs ih =>
    unfold distinct
    split
    · exact ih
    · rename_i h
      exact List.nodup_cons.mpr ⟨h, ih⟩

/-- Inserting is a permutation of consing. -/
theorem perm_insertAscending (s : String) (l : List String) :
    (insertAscending s l).Perm (s :: l) := by
  induction l with
  | nil => simp [insertAscending]
  | cons x xs ih =>
    unfold insertAscending
    split
    · exact List.Perm.refl _
    · exact (List.Perm.cons x ih).trans (List.Perm.swap s x xs)

/-- Insertion sort is a permutation of its input. -/
theorem perm_foldr_insertAscending (l : List String) :
    (l.foldr insertAscending []).Perm l := by
  induction l with
  | nil => simp
  | cons x xs ih =>
    simp only [List.foldr_cons]
    exact (perm_insertAscending x _).trans (List.Perm.cons x ih)

/-- `sortedDistinct` keeps exactly the values of its input. -/
theorem mem_sortedDistinct {a : String} {l : List String} : a ∈ sortedDistinct l ↔ a ∈ l :=
  ((perm_foldr_insertAscending (distinct l)).mem_iff).trans mem_distinct

/-- `sortedDistinct` has no repeats. -/
theorem nodup_sortedDistinct (l : List String) : (sortedDistinct l).Nodup :=
  (perm_foldr_insertAscending (distinct l)).nodup_iff.mpr (nodup_distinct l)

/-- Two entries the wire spells the same are the same entry. -/
theorem wire_injective : Function.Injective Widening.wire := by
  intro a b h
  have h' := congrArg String.toList h
  cases a <;> cases b <;> simp [Widening.wire] at h' ⊢ <;> exact String.ext h'

/-- The entries come in the canonical key order. -/
theorem widenings_sublist_keyOrder (e : Config) (c : Option Ceiling) :
    (widenings e c).Sublist (keyOrderEntries e) := by
  cases c with
  | none => exact List.nil_sublist _
  | some c =>
    unfold widenings keyOrderEntries
    refine List.Sublist.append (List.Sublist.append (List.Sublist.append (List.Sublist.append
      (List.Sublist.append ?_ ?_) ?_) ?_) ?_) ?_
    · exact List.filter_sublist.map _
    · split <;> simp
    · split <;> simp
    · split
      · split <;> simp
      · simp
    · cases e.model <;> cases c.models <;> simp <;> split <;> simp
    · split
      · exact List.filter_sublist.map _
      · simp

/-- The canonical key order names each entry once. -/
theorem nodup_keyOrderEntries (e : Config) : (keyOrderEntries e).Nodup := by
  have ht : ((sortedDistinct e.tools).map Widening.tool).Nodup :=
    List.Pairwise.map _ (fun _ _ hab h => hab (by cases h; rfl)) (nodup_sortedDistinct e.tools)
  unfold keyOrderEntries
  cases e.model <;>
    simp [ht, List.mem_map, permissionKeys] <;>
    intros <;> simp_all

/-- `cappedLimit`: the smaller of the two, and a `none` value composes at the cap. -/
def capped (v : Option Nat) : Option Nat → Option Nat
  | none => v
  | some cap => some (match v with
    | none => cap
    | some x => min x cap)

/-- `meetPolicyCeiling`: permissions on only where the ceiling does not cap them, limits capped,
tools kept in input order only where allowed; the engine and the model unchanged. -/
@[aw_spec (ts := "packages/contracts/src/policy-ceiling.ts#meetPolicyCeiling")
  (doc := "docs/adr/0102-content-owners-edit-engineers-build-admins-narrow-stop-and-approve.md#slice-2-acceptance")]
def meet (e : Config) : Option Ceiling → Config
  | none => e
  | some c =>
    { e with
      permissions :=
        { readFiles := e.permissions.readFiles && !c.caps.contains "readFiles",
          writeFiles := e.permissions.writeFiles && !c.caps.contains "writeFiles",
          runCommands := e.permissions.runCommands && !c.caps.contains "runCommands",
          unrestrictedNetwork :=
            e.permissions.unrestrictedNetwork && !c.caps.contains "unrestrictedNetwork" },
      maxTurns := capped e.maxTurns c.maxTurns,
      maxBudget := capped e.maxBudget c.maxBudget,
      tools := match c.tools with
        | some ts => e.tools.filter ts.contains
        | none => e.tools }

/-- A limit no wider than another, where `none` is ⊤ (no cap). -/
def limitLe : Option Nat → Option Nat → Prop
  | _, none => True
  | none, some _ => False
  | some x, some y => x ≤ y

/-- `a` asks for no more than `b`: every switch on in `a` is on in `b`, limits no higher (`none`
is ⊤), tools a sublist, and the same engine and model. -/
def Config.le (a b : Config) : Prop :=
  (∀ k, perm a.permissions k = true → perm b.permissions k = true) ∧
  limitLe a.maxTurns b.maxTurns ∧ limitLe a.maxBudget b.maxBudget ∧
  a.tools.Sublist b.tools ∧ a.engine = b.engine ∧ a.model = b.model

/-- An allowlist no wider than another, where `none` is ⊤ (the key is absent). -/
def allowLe : Option (List String) → Option (List String) → Prop
  | _, none => True
  | none, some _ => False
  | some a, some b => ∀ x ∈ a, x ∈ b

/-- A promotion bar no lower than another, where `none` is ⊥ (no bar). -/
def barGe : Option Nat → Option Nat → Prop
  | _, none => True
  | none, some _ => False
  | some x, some y => y ≤ x

/-- Ceiling `a` is at least as tight as `b`: it caps every switch `b` caps, its limits are no
higher, each of its allowlists is within `b`'s, and its promotion bar is no lower. -/
def Ceiling.le (a b : Ceiling) : Prop :=
  (∀ k ∈ b.caps, k ∈ a.caps) ∧ limitLe a.maxTurns b.maxTurns ∧ limitLe a.maxBudget b.maxBudget ∧
  allowLe a.engines b.engines ∧ allowLe a.models b.models ∧ allowLe a.tools b.tools ∧
  barGe a.minEvalScore b.minEvalScore

end AgentWorkspace.Concepts.PolicyCeiling
