import AgentWorkspace.Prelude.Codec
import AgentWorkspace.Prelude.Ids

/-!
# `packages/contracts/src/identifiers.ts`

The four exports of the shared identifier module:

| Export              | Model                                                        |
| ------------------- | ------------------------------------------------------------ |
| `UUID_PATTERN`      | `Uuid.isCanonical` (`Prelude/Ids.lean`, reused, not redefined) |
| `isUuid`            | `Identifiers.isUuid` over any JSON value                     |
| `UuidSchema`        | `Identifiers.uuidCodec`                                      |
| `IsoDateTimeSchema` | `Identifiers.isoDateTimeCodec`, `Identifiers.isIsoDateTime`  |

**Current and target.** The code accepts the canonical form of **any** UUID version in either
case (`UUID_PATTERN` has no version nibble and the `/i` flag); the database mints lower-case v4
(`gen_random_uuid()`, `packages/core/src/db/schema/columns.ts`). SPEC §4 says "UUID v4 text".
`isUuidCurrent` is today's rule and `isUuidV4Target` the documented one; the refinement theorems
relate them.

**`z.iso.datetime()`** in Zod 4.6 (`regexes.datetime` with `offset: false`, `local: false`, no
`precision`) is
`^<date>T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z$`, where `<date>` is a calendar-checked
`YYYY-MM-DD` that admits `-02-29` only in a Gregorian leap year (the year-`0000` case included).
Seconds are required, only `Z` is accepted (no offset, no lower-case `z`), and the fraction has
any number of digits but at least one.
-/

namespace AgentWorkspace.Contracts.Identifiers

open AgentWorkspace

/-! ## UUIDs -/

/-- `UuidSchema = z.string().regex(UUID_PATTERN)`: a string in the canonical form. -/
@[aw_spec (ts := "packages/contracts/src/identifiers.ts#UuidSchema")]
def uuidCodec : Codec String := Codec.stringWhere Uuid.isCanonical

/-- `isUuid(value: unknown)`: `typeof value === 'string' && UUID_PATTERN.test(value)`. -/
@[aw_spec (ts := "packages/contracts/src/identifiers.ts#isUuid")]
def isUuid : JValue → Bool
  | .str s => Uuid.isCanonical s
  | _ => false

/-- Today's identifier rule: the canonical form, any version, either case. -/
@[aw_spec (ts := "packages/contracts/src/identifiers.ts#UUID_PATTERN")]
def isUuidCurrent (s : String) : Bool := Uuid.isCanonical s

/-- Every character of a canonical id is a hexadecimal digit or a hyphen (shared by the T0 length
theorem and the T3 path-character theorem). -/
theorem canonical_chars (s : String) (h : Uuid.isCanonical s = true) :
    ∀ c ∈ s.toList, Uuid.isHexDigit c = true ∨ c = '-' := by
  simp only [Uuid.isCanonical, Bool.and_eq_true, beq_iff_eq] at h
  obtain ⟨hlen, hall⟩ := h
  intro c hc
  obtain ⟨i, hi, rfl⟩ := List.getElem_of_mem hc
  have hz : i < (s.toList.zip Uuid.shape).length := by rw [List.length_zip]; omega
  have := List.all_eq_true.mp hall _ (List.getElem_mem hz)
  simp only [List.getElem_zip] at this
  split at this
  · exact Or.inl this
  · exact Or.inr (by simpa using this)

/-- The documented rule, SPEC §4 "UUID v4 text": the canonical form whose version nibble
(character 14) is `4` and whose variant nibble (character 19) is `8`, `9`, `a` or `b`. -/
@[aw_spec (doc := "docs/sdk/04-api-specification.md#4-conventions")]
def isUuidV4Target (s : String) : Bool :=
  Uuid.isCanonical s && s.toList[14]? == some '4' &&
    (s.toList[19]?.all fun c => c ∈ ['8', '9', 'a', 'b', 'A', 'B'])

/-- Lower-case ASCII letters, leaving every other character alone. -/
def lowerAscii (s : String) : String :=
  String.ofList (s.toList.map fun c => if Text.isAsciiUpper c then Char.ofNat (c.toNat + 32) else c)

/-- The positions of the four hyphens of the canonical `8-4-4-4-12` form. -/
def hyphenPositions : List Nat := [8, 13, 18, 23]

/-- Replace the character at position `i` (no change past the end). -/
def setChar (s : String) (i : Nat) (c : Char) : String := String.ofList (s.toList.set i c)

/-! ## ISO-8601 instants -/

/-- A Gregorian leap year, which is exactly what the Zod date pattern's `-02-29` branch admits:
the last two digits a non-zero multiple of four, or the whole year a multiple of 400. -/
def isLeapYear (y : Nat) : Bool := y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)

/-- The days in month `m` of year `y` (0 for a month outside 1–12). -/
def daysInMonth (y m : Nat) : Nat :=
  match m with
  | 1 | 3 | 5 | 7 | 8 | 10 | 12 => 31
  | 4 | 6 | 9 | 11 => 30
  | 2 => if isLeapYear y then 29 else 28
  | _ => 0

/-- What may follow the seconds: `Z` alone, or `.` then one or more digits then `Z`. -/
def secondsTail : List Char → Bool
  | ['Z'] => true
  | '.' :: rest => Text.digitsPlusThenEnd 'Z' rest
  | _ => false

/-- `IsoDateTimeSchema = z.iso.datetime()`, transcribed fragment by fragment. -/
@[aw_spec (ts := "packages/contracts/src/identifiers.ts#IsoDateTimeSchema")]
def isIsoDateTime (s : String) : Bool :=
  match s.toList with
  | y1 :: y2 :: y3 :: y4 :: '-' :: m1 :: m2 :: '-' :: d1 :: d2 :: 'T' :: h1 :: h2 :: ':' ::
      n1 :: n2 :: ':' :: s1 :: s2 :: rest =>
    let digits := [y1, y2, y3, y4, m1, m2, d1, d2, h1, h2, n1, n2, s1, s2]
    let year := Text.digitsValue [y1, y2, y3, y4]
    let month := Text.digitsValue [m1, m2]
    let day := Text.digitsValue [d1, d2]
    digits.all Text.isAsciiDigit && 1 ≤ day && day ≤ daysInMonth year month &&
      Text.digitsValue [h1, h2] ≤ 23 && Text.digitsValue [n1, n2] ≤ 59 &&
      Text.digitsValue [s1, s2] ≤ 59 && secondsTail rest
  | _ => false

/-- `IsoDateTimeSchema`. -/
@[aw_spec (ts := "packages/contracts/src/identifiers.ts#IsoDateTimeSchema")]
def isoDateTimeCodec : Codec String := Codec.stringWhere isIsoDateTime

end AgentWorkspace.Contracts.Identifiers
