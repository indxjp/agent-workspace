import AgentWorkspace.Prelude.JValue
import AgentWorkspace.Prelude.Text
import AgentWorkspace.Prelude.WireEnum

/-!
# Codecs that mirror Zod schemas

A `Codec α` is one Zod schema: `decode` is `schema.safeParse(json)` (with `none` for a failure and
`some` of the parsed output for a success), `encode` renders a model value as the JSON the server
sends, and `valid` is the refinement a model value must meet to be sendable. Every codec carries
two laws, so a contract module gets its round trip and its soundness from the combinators:

- `decode_encode`: a valid value survives `encode` then `decode` unchanged;
- `valid_of_decode`: whatever decodes is valid.

The combinators and the Zod behaviour each one transcribes:

| Zod                                   | Here                                                    |
| ------------------------------------- | ------------------------------------------------------- |
| `z.string()`                          | `Codec.string`                                          |
| `.min(n)` / `.max(n)` / `.length(n)`  | `Codec.stringWhere (Text.lengthWithin …)`, UTF-16 units |
| `.regex(r)`, `z.iso.datetime()`, …    | `Codec.stringWhere p`, `p` transcribing the pattern     |
| `z.boolean()`                         | `Codec.bool`                                            |
| `z.number().int()`, `.min`, `.max`    | `Codec.int lo hi`, inside the safe-integer range        |
| `z.enum(ARRAY)`                       | `Codec.enum` from a `WireEnum`                          |
| `.nullable()`                         | `Codec.nullable`: `null` ↦ `none`                       |
| `z.array(s)`                          | `Codec.array c` (no contract bounds an array)           |
| `.optional()` inside an object        | `Obj.opt`: key **absent** ↦ `none`; `null` is not absent |
| `z.object({…}).strict()`              | `Obj.strict keys body`: an unknown key fails            |
| `z.object({…})` (default)             | `Obj.strip body`: unknown keys are dropped              |
| `z.looseObject({…})`                  | `Obj.strip` plus `Obj.extras` to keep the unknown keys  |
| `z.discriminatedUnion(key, […])`      | `Obj.tagged key branches`                               |
| `z.union([…])` (first success wins)   | `Codec.firstOf`                                         |
| `.readonly()`                         | nothing: it freezes the output and validates nothing    |

`exactOptionalPropertyTypes` (root `tsconfig.json`) makes an absent key and a key holding
`undefined` different types; JSON has no `undefined`, so on the wire "optional" means "absent", and
`Obj.opt` refuses `null` unless the field is also `.nullable()`.
-/

namespace AgentWorkspace

/-- One Zod schema: its decoder, the JSON a model value is sent as, the refinement a model value
meets, and the two laws that tie them. -/
structure Codec (α : Type) where
  /-- The JSON the server sends for a model value. -/
  encode : α → JValue
  /-- `schema.safeParse`: `some output` on success, `none` on failure. -/
  decode : JValue → Option α
  /-- The refinements a value must meet (lengths, patterns, bounds). -/
  valid : α → Bool
  /-- A valid value round-trips. -/
  decode_encode : ∀ a, valid a = true → decode (encode a) = some a
  /-- Whatever decodes is valid. -/
  valid_of_decode : ∀ {j : JValue} {a : α}, decode j = some a → valid a = true

namespace Codec

/-! ## Strings -/

/-- A string schema with the refinement `p` (`z.string()` followed by length and pattern checks). -/
def stringWhere (p : String → Bool) : Codec String where
  encode := .str
  decode
    | .str s => if p s then some s else none
    | _ => none
  valid := p
  decode_encode := by intro a h; simp [h]
  valid_of_decode := by
    intro j a h
    cases j <;> simp at h
    obtain ⟨hp, rfl⟩ := h
    exact hp

/-- `z.string()`. -/
def string : Codec String := stringWhere fun _ => true

/-- `z.string().min(lo).max(hi)`, lengths in UTF-16 code units. -/
def stringLen (lo : Nat) (hi : Option Nat) : Codec String := stringWhere (Text.lengthWithin lo hi)

theorem stringWhere_decode_str (p : String → Bool) (s : String) :
    (stringWhere p).decode (.str s) = if p s then some s else none := rfl

/-- A string schema accepts exactly the strings meeting its refinement, and returns them unchanged. -/
theorem stringWhere_decode_eq_some_iff (p : String → Bool) (j : JValue) (s : String) :
    (stringWhere p).decode j = some s ↔ j = .str s ∧ p s = true := by
  cases j <;> simp [stringWhere]
  constructor
  · rintro ⟨hp, rfl⟩; exact ⟨rfl, hp⟩
  · rintro ⟨rfl, hp⟩; exact ⟨hp, rfl⟩

theorem stringWhere_decode_nonstring (p : String → Bool) (j : JValue)
    (h : ∀ s, j ≠ .str s) : (stringWhere p).decode j = none := by
  cases j <;> first | rfl | exact absurd rfl (h _)

/-! ## Booleans and integers -/

/-- `z.boolean()`. -/
def bool : Codec Bool where
  encode := .bool
  decode
    | .bool b => some b
    | _ => none
  valid _ := true
  decode_encode := by intro a _; rfl
  valid_of_decode := by intro _ _ _; rfl

/-- `Number.MAX_SAFE_INTEGER`, the bound Zod's `.int()` enforces. -/
def maxSafeInteger : Int := 2 ^ 53 - 1

/-- An integer within optional bounds and within the safe-integer range. -/
def intWithin (lo hi : Option Int) (n : Int) : Bool :=
  decide (-maxSafeInteger ≤ n) && decide (n ≤ maxSafeInteger) &&
    (lo.all fun l => decide (l ≤ n)) && (hi.all fun h => decide (n ≤ h))

/-- `z.number().int()` with optional `.min(lo)` / `.max(hi)` (`.nonnegative()` is `lo = 0`).
A number with a fractional part is refused; `1.0` is the integer `1`. -/
def int (lo hi : Option Int) : Codec Int where
  encode := JValue.ofInt
  decode j := (JValue.asInt? j).bind fun n => if intWithin lo hi n then some n else none
  valid := intWithin lo hi
  decode_encode := by intro a h; simp [JValue.asInt?_ofInt, h]
  valid_of_decode := by
    intro j a h
    cases hj : JValue.asInt? j with
    | none => simp [hj] at h
    | some n =>
      simp only [hj, Option.bind_some] at h
      split at h <;> simp_all

/-! ## Enumerations -/

/-- `z.enum(ARRAY)` for an `as const` array modelled as a `WireEnum`. -/
def enum (α : Type) [WireEnum α] : Codec α where
  encode a := .str (WireEnum.toWire a)
  decode
    | .str s => WireEnum.ofWire? s
    | _ => none
  valid _ := true
  decode_encode := by intro a _; exact WireEnum.ofWire?_toWire a
  valid_of_decode := by intro _ _ _; rfl

/-! ## Nullable -/

/-- `.nullable()`: `null` decodes to `none`, anything else through the inner schema. The inner
codec must never send `null` itself, or the two would be confused. -/
def nullable {α : Type} (c : Codec α) (hnn : ∀ a, c.encode a ≠ .null) : Codec (Option α) where
  encode
    | none => .null
    | some a => c.encode a
  decode j := if j = .null then some none else (c.decode j).map some
  valid
    | none => true
    | some a => c.valid a
  decode_encode := by
    intro a h
    cases a with
    | none => simp
    | some a => simp [hnn a, c.decode_encode a h]
  valid_of_decode := by
    intro j a h
    by_cases hj : j = .null
    · simp [hj] at h; subst h; rfl
    · simp only [hj, ite_false] at h
      cases hd : c.decode j with
      | none => simp [hd] at h
      | some b =>
        simp [hd] at h
        subst h
        exact c.valid_of_decode hd

/-! ## Arrays -/

/-- Decode every item, failing if one fails (`z.array(s)` reports the first bad item). -/
def decodeAll {α : Type} (dec : JValue → Option α) : List JValue → Option (List α)
  | [] => some []
  | j :: js => (dec j).bind fun a => (decodeAll dec js).map (a :: ·)

theorem decodeAll_map_encode {α : Type} (c : Codec α) (xs : List α)
    (h : xs.all c.valid = true) : decodeAll c.decode (xs.map c.encode) = some xs := by
  induction xs with
  | nil => rfl
  | cons x xs ih =>
    simp only [List.all_cons, Bool.and_eq_true] at h
    simp [decodeAll, c.decode_encode x h.1, ih h.2]

theorem decodeAll_valid {α : Type} (c : Codec α) :
    ∀ (js : List JValue) (xs : List α), decodeAll c.decode js = some xs → xs.all c.valid = true
  | [], xs, h => by simp [decodeAll] at h; subst h; rfl
  | j :: js, xs, h => by
    simp only [decodeAll] at h
    cases hd : c.decode j with
    | none => simp [hd] at h
    | some a =>
      cases hr : decodeAll c.decode js with
      | none => simp [hd, hr] at h
      | some as =>
        simp [hd, hr] at h
        subst h
        simp [c.valid_of_decode hd, decodeAll_valid c js as hr]

/-- `z.array(c)`: every item through `c`. No contract bounds an array's length today
(`.min`/`.max` on an array appear nowhere in `packages/contracts`), so the combinator has no
bounds; add them when a contract needs them. -/
def array {α : Type} (c : Codec α) : Codec (List α) where
  encode xs := .arr (xs.map c.encode)
  decode
    | .arr js => decodeAll c.decode js
    | _ => none
  valid xs := xs.all c.valid
  decode_encode := by
    intro xs h
    simp [decodeAll_map_encode c xs h]
  valid_of_decode := by
    intro j xs h
    cases j <;> simp at h
    rename_i js
    exact decodeAll_valid c js xs h

/-! ## Unions -/

/-- `z.union([a, b, …])`: the first decoder that succeeds wins. -/
def firstOf {α : Type} : List (JValue → Option α) → JValue → Option α
  | [], _ => none
  | d :: ds, j => (d j).or (firstOf ds j)

/-- When at most one decoder can succeed on any input, the order of a `firstOf` does not matter
for a two-element union. -/
theorem firstOf_swap {α : Type} (d₁ d₂ : JValue → Option α)
    (hdisj : ∀ j, (d₁ j).isSome = true → (d₂ j).isSome = true → False) (j : JValue) :
    firstOf [d₁, d₂] j = firstOf [d₂, d₁] j := by
  simp only [firstOf, Option.or_none]
  cases h₁ : d₁ j <;> cases h₂ : d₂ j <;> simp_all

end Codec

/-! ## Objects -/

namespace Obj

open JValue

/-- Every key is one of `allowed`. -/
def onlyKeys (allowed : List String) (fs : Fields) : Bool := fs.all fun kv => allowed.contains kv.1

/-- `z.object(shape).strict()`: a non-object fails, an object with a key outside `allowed` fails,
otherwise `body` reads the fields. -/
def strict {α : Type} (allowed : List String) (body : Fields → Option α) (j : JValue) : Option α :=
  j.obj?.bind fun fs => if onlyKeys allowed fs then body fs else none

/-- `z.object(shape)` (Zod's default): a non-object fails; unknown keys are ignored (the parsed
output drops them). -/
def strip {α : Type} (body : Fields → Option α) (j : JValue) : Option α := j.obj?.bind body

/-- The fields whose key is not in `known`: what `z.looseObject` passes through. -/
def extras (known : List String) (fs : Fields) : Fields := fs.filter fun kv => !known.contains kv.1

/-- A required field: present, and accepted by its schema. -/
def req {α : Type} (c : Codec α) (key : String) (fs : Fields) : Option α :=
  (lookup key fs).bind c.decode

/-- An `.optional()` field: absent is `some none`; present (even `null`) must decode. -/
def opt {α : Type} (c : Codec α) (key : String) (fs : Fields) : Option (Option α) :=
  match lookup key fs with
  | none => some none
  | some v => (c.decode v).map some

/-- A `z.discriminatedUnion(key, …)` body: read the string tag under `key` and hand the fields to
the branch registered for it; an unknown or missing tag fails. -/
def tagged {α : Type} (key : String) (branches : List (String × (Fields → Option α)))
    (fs : Fields) : Option α :=
  ((lookup key fs).bind str?).bind fun t => (branches.lookup t).bind fun b => b fs

/-- A required field, as sent. -/
def field {α : Type} (c : Codec α) (key : String) (a : α) : Fields := [(key, c.encode a)]

/-- An optional field, as sent: absent when `none`. -/
def optField {α : Type} (c : Codec α) (key : String) : Option α → Fields
  | none => []
  | some a => [(key, c.encode a)]

theorem strict_not_object {α : Type} (allowed : List String) (body : Fields → Option α)
    (j : JValue) (h : j.obj? = none) : strict allowed body j = none := by
  simp [strict, h]

theorem strict_obj {α : Type} (allowed : List String) (body : Fields → Option α) (fs : Fields)
    (h : onlyKeys allowed fs = true) : strict allowed body (.obj fs) = body fs := by
  simp [strict, obj?, h]

/-- A strict object refuses any object that carries a key outside its shape. -/
theorem strict_unknown_key {α : Type} (allowed : List String) (body : Fields → Option α)
    (fs : Fields) (k : String) (v : JValue) (hmem : (k, v) ∈ fs) (hk : k ∉ allowed) :
    strict allowed body (.obj fs) = none := by
  have : onlyKeys allowed fs = false := by
    simp only [onlyKeys, List.all_eq_false]
    exact ⟨(k, v), hmem, by simpa using hk⟩
  simp [strict, obj?, this]

/-- What a strict object accepts has only keys from its shape. -/
theorem strict_some_keys {α : Type} {allowed : List String} {body : Fields → Option α}
    {j : JValue} {a : α} (h : strict allowed body j = some a) :
    ∃ fs, j = .obj fs ∧ (∀ k ∈ keys fs, k ∈ allowed) ∧ body fs = some a := by
  cases j <;> simp [strict, obj?] at h
  rename_i fs
  obtain ⟨hk, h⟩ := h
  refine ⟨fs, rfl, ?_, h⟩
  intro k hkm
  simp only [keys, List.mem_map] at hkm
  obtain ⟨kv, hkv, rfl⟩ := hkm
  simp only [onlyKeys, List.all_eq_true] at hk
  simpa using hk kv hkv

theorem req_some {α : Type} {c : Codec α} {key : String} {fs : Fields} {a : α}
    (h : req c key fs = some a) : ∃ v, lookup key fs = some v ∧ c.decode v = some a := by
  unfold req at h
  cases hl : lookup key fs with
  | none => simp [hl] at h
  | some v => exact ⟨v, rfl, by simpa [hl] using h⟩

theorem req_valid {α : Type} {c : Codec α} {key : String} {fs : Fields} {a : α}
    (h : req c key fs = some a) : c.valid a = true := by
  obtain ⟨_, _, hd⟩ := req_some h
  exact c.valid_of_decode hd

theorem opt_valid {α : Type} {c : Codec α} {key : String} {fs : Fields} {a : α}
    (h : opt c key fs = some (some a)) : c.valid a = true := by
  unfold opt at h
  split at h
  · cases h
  · rename_i v _
    cases hd : c.decode v with
    | none => simp [hd] at h
    | some b =>
      simp [hd] at h
      subst h
      exact c.valid_of_decode hd

/-- An absent optional key reads as `none`, whatever the schema. -/
theorem opt_absent {α : Type} (c : Codec α) (key : String) (fs : Fields)
    (h : key ∉ keys fs) : opt c key fs = some none := by
  simp [opt, lookup_eq_none_of_not_mem h]

/-- A required key that is absent fails the object. -/
theorem req_absent {α : Type} (c : Codec α) (key : String) (fs : Fields)
    (h : key ∉ keys fs) : req c key fs = none := by
  simp [req, lookup_eq_none_of_not_mem h]

/-- A tagged body with a known tag is its branch. -/
theorem tagged_branch {α : Type} (key : String) (branches : List (String × (Fields → Option α)))
    (fs : Fields) (t : String) (b : Fields → Option α) (ht : lookup key fs = some (.str t))
    (hb : branches.lookup t = some b) : tagged key branches fs = b fs := by
  simp [tagged, ht, str?, hb]

/-- A tagged body whose tag is missing fails. -/
theorem tagged_missing {α : Type} (key : String) (branches : List (String × (Fields → Option α)))
    (fs : Fields) (h : key ∉ keys fs) : tagged key branches fs = none := by
  simp [tagged, lookup_eq_none_of_not_mem h]

/-! ## Witnesses for the lemmas above (the combinators' Zod behaviour is pinned by the T0
theorems in `Theorems/WellFormed/ContractsFoundation.lean`) -/

example : tagged "kind" [("s", fun fs => Obj.req Codec.string "v" fs)]
    [("kind", .str "s"), ("v", .str "x")] = some "x" := by
  rw [tagged_branch "kind" _ _ "s" (fun fs => Obj.req Codec.string "v" fs) rfl rfl]
  rfl

example : tagged "kind" [("s", fun fs => Obj.req Codec.string "v" fs)] [("v", .str "x")] = none :=
  tagged_missing _ _ _ (by decide)

example : opt Codec.string "a" [] = some none := opt_absent _ _ _ (by decide)

example : req Codec.string "a" [] = none := req_absent _ _ _ (by decide)

end Obj
end AgentWorkspace
