import AgentWorkspace.Trace.Spec

/-!
# Closed wire enumerations

Every closed string union in `packages/contracts` (`RUN_STATUSES`, `MEMBERSHIP_ROLES`, …) is an
`inductive` with a `WireEnum` instance: the ordered list of its members (the TypeScript `as const`
array order), the wire spelling of each, and proofs that the list is complete, duplicate-free and
that the spelling is injective. Decoding is derived, so the codec round-trip is one generic theorem.
-/

namespace AgentWorkspace

/-- A closed enumeration with a canonical member order and an injective wire spelling. -/
class WireEnum (α : Type) where
  /-- The members, in the order the TypeScript `as const` array lists them. -/
  all : List α
  /-- The JSON string for a member. -/
  toWire : α → String
  complete : ∀ a, a ∈ all
  nodup : all.Nodup
  toWire_injective : ∀ a b, toWire a = toWire b → a = b

namespace WireEnum

/-- Decode a wire string; `none` for anything that is not exactly a member's spelling. -/
def ofWire? {α : Type} [WireEnum α] (s : String) : Option α :=
  (all : List α).find? (fun a => toWire a == s)

/-- The wire spellings, in canonical order. -/
def wires (α : Type) [WireEnum α] : List String :=
  (all : List α).map toWire

variable {α : Type} [WireEnum α]

theorem ofWire?_toWire (a : α) : ofWire? (toWire a) = some a := by
  unfold ofWire?
  match h : (all : List α).find? (fun x => toWire x == toWire a) with
  | none =>
    exfalso
    have := List.find?_eq_none.mp h a (complete a)
    simp at this
  | some x =>
    have hx := List.find?_some h
    simp at hx
    rw [toWire_injective x a hx]

theorem toWire_ofWire? {s : String} {a : α} (h : ofWire? s = some a) : toWire a = s := by
  unfold ofWire? at h
  have := List.find?_some h
  simpa using this

theorem ofWire?_eq_none_iff (s : String) : ofWire? (α := α) s = none ↔ s ∉ wires α := by
  constructor
  · intro h hs
    simp only [wires, List.mem_map] at hs
    obtain ⟨a, _, rfl⟩ := hs
    rw [ofWire?_toWire] at h
    cases h
  · intro h
    cases hd : ofWire? (α := α) s with
    | none => rfl
    | some a =>
      exfalso
      apply h
      simp only [wires, List.mem_map]
      exact ⟨a, complete a, toWire_ofWire? hd⟩

end WireEnum
end AgentWorkspace
