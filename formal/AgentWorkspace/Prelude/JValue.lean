import Lean.Data.Json
import AgentWorkspace.Trace.Spec

/-!
# JSON values as the wire carries them

`JValue` is the JSON value a contract schema receives: what `JSON.parse` hands Zod. Every contract
codec (`Prelude/Codec.lean`) decodes a `JValue`, and vectors convert it to `Lean.Json`.

**Why not `Lean.Json`.** `Lean.Json` keeps an object as a red-black tree, which has no decidable
equality and no structural recursion a proof can follow. `JValue` keeps an object as an ordered
list of `(key, value)` pairs, so equality is decidable and a decoder is a structural function that
`decide` and `simp` evaluate.

**Numbers.** `num m e` is the exact decimal `m · 10⁻ᵉ`, the shape of `Lean.JsonNumber`. Integers and
decimal literals are therefore exact, with no binary rounding. Two spellings of one number
(`num 10 1` and `num 1 0`) are different `JValue`s; a decoder that wants an integer reads it with
`asInt?`, which compares by value. JavaScript parses every number to a binary64 double, so the
model and the code agree on integers up to `2⁵³ − 1` (the range Zod's `.int()` admits) and on
every decimal a vector uses; they may differ on literals a double cannot represent. `NaN` and the
infinities have no JSON spelling.

**Duplicate keys.** `JSON.parse` keeps the *last* of two equal keys; `lookup` does the same.
`Lean.Json` cannot carry duplicates, so vectors never contain them.
-/

namespace AgentWorkspace

/-- A JSON value: `null`, a boolean, an exact decimal number `mantissa · 10⁻ᵉˣᵖᵒⁿᵉⁿᵗ`, a string, an
array, or an object as an ordered list of fields. -/
@[aw_spec (doc := "docs/sdk/04-api-specification.md#4-conventions")]
inductive JValue where
  | null
  | bool (b : Bool)
  | num (mantissa : Int) (exponent : Nat)
  | str (s : String)
  | arr (items : List JValue)
  | obj (fields : List (String × JValue))
  deriving Repr, Inhabited

namespace JValue

/-- An object's fields, in order. -/
abbrev Fields := List (String × JValue)

mutual
/-- Decidable equality, by structural recursion through arrays and objects. -/
def decEq : (a b : JValue) → Decidable (a = b)
  | .null, .null => isTrue rfl
  | .bool a, .bool b =>
    if h : a = b then isTrue (h ▸ rfl) else isFalse (by intro e; cases e; exact h rfl)
  | .num m e, .num m' e' =>
    if h : m = m' ∧ e = e' then isTrue (by rw [h.1, h.2])
    else isFalse (by intro x; cases x; exact h ⟨rfl, rfl⟩)
  | .str a, .str b =>
    if h : a = b then isTrue (h ▸ rfl) else isFalse (by intro e; cases e; exact h rfl)
  | .arr a, .arr b =>
    match decEqList a b with
    | isTrue h => isTrue (h ▸ rfl)
    | isFalse h => isFalse (by intro e; cases e; exact h rfl)
  | .obj a, .obj b =>
    match decEqFields a b with
    | isTrue h => isTrue (h ▸ rfl)
    | isFalse h => isFalse (by intro e; cases e; exact h rfl)
  | .null, .bool _ | .null, .num _ _ | .null, .str _ | .null, .arr _ | .null, .obj _ =>
    isFalse (by intro e; cases e)
  | .bool _, .null | .bool _, .num _ _ | .bool _, .str _ | .bool _, .arr _ | .bool _, .obj _ =>
    isFalse (by intro e; cases e)
  | .num _ _, .null | .num _ _, .bool _ | .num _ _, .str _ | .num _ _, .arr _
  | .num _ _, .obj _ => isFalse (by intro e; cases e)
  | .str _, .null | .str _, .bool _ | .str _, .num _ _ | .str _, .arr _ | .str _, .obj _ =>
    isFalse (by intro e; cases e)
  | .arr _, .null | .arr _, .bool _ | .arr _, .num _ _ | .arr _, .str _ | .arr _, .obj _ =>
    isFalse (by intro e; cases e)
  | .obj _, .null | .obj _, .bool _ | .obj _, .num _ _ | .obj _, .str _ | .obj _, .arr _ =>
    isFalse (by intro e; cases e)

/-- Decidable equality of arrays. -/
def decEqList : (a b : List JValue) → Decidable (a = b)
  | [], [] => isTrue rfl
  | [], _ :: _ => isFalse (by intro e; cases e)
  | _ :: _, [] => isFalse (by intro e; cases e)
  | x :: xs, y :: ys =>
    match decEq x y, decEqList xs ys with
    | isTrue h1, isTrue h2 => isTrue (h1 ▸ h2 ▸ rfl)
    | isFalse h1, _ => isFalse (by intro e; cases e; exact h1 rfl)
    | _, isFalse h2 => isFalse (by intro e; cases e; exact h2 rfl)

/-- Decidable equality of field lists. -/
def decEqFields : (a b : Fields) → Decidable (a = b)
  | [], [] => isTrue rfl
  | [], _ :: _ => isFalse (by intro e; cases e)
  | _ :: _, [] => isFalse (by intro e; cases e)
  | (k, x) :: xs, (k', y) :: ys =>
    if hk : k = k' then
      match decEq x y, decEqFields xs ys with
      | isTrue h1, isTrue h2 => isTrue (hk ▸ h1 ▸ h2 ▸ rfl)
      | isFalse h1, _ => isFalse (by intro e; cases e; exact h1 rfl)
      | _, isFalse h2 => isFalse (by intro e; cases e; exact h2 rfl)
    else isFalse (by intro e; cases e; exact hk rfl)
end

instance : DecidableEq JValue := decEq

/-! ## Reading a value -/

/-- The fields of an object; `none` for every other kind of value (arrays included, as Zod's
object check refuses them). -/
def obj? : JValue → Option Fields
  | .obj fs => some fs
  | _ => none

/-- The items of an array. -/
def arr? : JValue → Option (List JValue)
  | .arr xs => some xs
  | _ => none

/-- The text of a string. -/
def str? : JValue → Option String
  | .str s => some s
  | _ => none

/-- The value of a number that is an integer, compared by value (`1`, `1.0` and `10e-1` are all
`1`); `none` for a fraction and for every non-number. -/
def asInt? : JValue → Option Int
  | .num m e => if m % (10 ^ e : Int) = 0 then some (m / (10 ^ e : Int)) else none
  | _ => none

/-- An integer as a JSON number. -/
def ofInt (n : Int) : JValue := .num n 0

/-- The value under `key`, the last one when the key repeats (as `JSON.parse` keeps it). -/
def lookup (key : String) (fs : Fields) : Option JValue :=
  fs.foldl (fun acc kv => if kv.1 = key then some kv.2 else acc) none

/-- The keys of an object, in order. -/
def keys (fs : Fields) : List String := fs.map Prod.fst

theorem asInt?_ofInt (n : Int) : asInt? (ofInt n) = some n := by
  simp [asInt?, ofInt]

private theorem foldl_lookup_mem (key : String) (fs : Fields) (acc : Option JValue) (v : JValue)
    (h : fs.foldl (fun acc kv => if kv.1 = key then some kv.2 else acc) acc = some v) :
    acc = some v ∨ (key, v) ∈ fs := by
  induction fs generalizing acc with
  | nil => simp at h; exact Or.inl h
  | cons kv rest ih =>
    simp only [List.foldl_cons] at h
    rcases ih _ h with h' | h'
    · split at h'
      · rename_i hk
        cases h'
        right
        obtain ⟨k, w⟩ := kv
        simp only at hk
        subst hk
        exact List.mem_cons_self
      · exact Or.inl h'
    · exact Or.inr (List.mem_cons_of_mem _ h')

/-- A key that is found is one of the object's keys. -/
theorem mem_keys_of_lookup {key : String} {fs : Fields} {v : JValue}
    (h : lookup key fs = some v) : key ∈ keys fs := by
  rcases foldl_lookup_mem key fs none v h with h' | h'
  · cases h'
  · exact List.mem_map.mpr ⟨_, h', rfl⟩

/-- A key that is not among the object's keys is not found. -/
theorem lookup_eq_none_of_not_mem {key : String} {fs : Fields} (h : key ∉ keys fs) :
    lookup key fs = none := by
  cases hl : lookup key fs with
  | none => rfl
  | some v => exact absurd (mem_keys_of_lookup hl) h

/-- Looking a key up in a field list that ends with it finds that last value. -/
theorem lookup_append_singleton (key : String) (fs : Fields) (v : JValue) :
    lookup key (fs ++ [(key, v)]) = some v := by
  simp [lookup, List.foldl_append]

/-! ## Conversion to `Lean.Json` (for the vectors) -/

open Lean in
mutual
/-- The `Lean.Json` value (object keys end up sorted; a later duplicate key wins). -/
def toJson : JValue → Json
  | .null => .null
  | .bool b => .bool b
  | .num m e => .num ⟨m, e⟩
  | .str s => .str s
  | .arr xs => .arr (toJsonList xs).toArray
  | .obj fs => Json.mkObj (toJsonFields fs)

/-- `toJson` over an array's items. -/
def toJsonList : List JValue → List Json
  | [] => []
  | x :: xs => toJson x :: toJsonList xs

/-- `toJson` over an object's fields. -/
def toJsonFields : Fields → List (String × Json)
  | [] => []
  | (k, v) :: fs => (k, toJson v) :: toJsonFields fs
end

open Lean in
instance : ToJson JValue := ⟨toJson⟩

end JValue
end AgentWorkspace
