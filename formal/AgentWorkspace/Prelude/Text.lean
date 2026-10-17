import AgentWorkspace.Trace.Spec

/-!
# String predicates the contract patterns need

A contract constrains strings in three ways, and each has a JavaScript meaning that is not Lean's:

- **Length.** Zod's `.min`, `.max` and `.length` read `String.prototype.length`, which counts
  UTF-16 code units. A Lean `String` is a sequence of Unicode scalar values, so a character above
  `U+FFFF` (an emoji, say) is one Lean character but two JavaScript units. `utf16Length` counts
  JavaScript's way.
- **Trim.** `String.prototype.trim` removes the ECMAScript *WhiteSpace* and *LineTerminator*
  characters from both ends: tab, vertical tab, form feed, space, no-break space, the byte-order
  mark, every `Zs` character, line feed, carriage return, and `U+2028`/`U+2029`. It does **not**
  remove `U+0085` (next line) or `U+180E` (Mongolian vowel separator, no longer `Zs`). The same
  set is the regular-expression class `\s`. `jsTrim` and `isJsWhitespace` follow that list.
- **Regular expressions.** A pattern is transcribed as an explicit predicate over the character
  list, one clause per regex fragment. Without the `u` flag, `\d` is `[0-9]` only and `\w` is
  `[A-Za-z0-9_]`; `$` without the `m` flag matches only at the very end, so a trailing newline is
  refused.

Lone UTF-16 surrogates, which a JavaScript string may hold and `JSON.parse` may produce, have no
Lean `String` counterpart; the model does not represent them (see the unit report's gaps).
-/

namespace AgentWorkspace.Text

/-! ## Length in UTF-16 code units -/

/-- The UTF-16 code units one character occupies: two above the Basic Multilingual Plane. -/
def utf16Units (c : Char) : Nat := if c.toNat ≤ 0xFFFF then 1 else 2

/-- `String.prototype.length`: the number of UTF-16 code units. -/
@[aw_spec (doc := "docs/formal/domains/d1-runs.md#contracts")]
def utf16Length (s : String) : Nat := (s.toList.map utf16Units).sum

/-- Zod's `.min(lo)` / `.max(hi)` on a string: the length in code units lies within the bounds. -/
def lengthWithin (lo : Nat) (hi : Option Nat) (s : String) : Bool :=
  lo ≤ utf16Length s && (hi.all fun h => utf16Length s ≤ h)

/-! ## Character classes -/

/-- `\d` without the `u` flag: an ASCII digit. -/
def isAsciiDigit (c : Char) : Bool := '0' ≤ c && c ≤ '9'

/-- `[a-z]`. -/
def isAsciiLower (c : Char) : Bool := 'a' ≤ c && c ≤ 'z'

/-- `[A-Z]`. -/
def isAsciiUpper (c : Char) : Bool := 'A' ≤ c && c ≤ 'Z'

/-- `[A-Za-z]`. -/
def isAsciiAlpha (c : Char) : Bool := isAsciiLower c || isAsciiUpper c

/-- `[A-Za-z0-9]`. -/
def isAsciiAlnum (c : Char) : Bool := isAsciiAlpha c || isAsciiDigit c

/-- `\w` without the `u` flag: `[A-Za-z0-9_]`. -/
def isWordChar (c : Char) : Bool := isAsciiAlnum c || c == '_'

/-- The ECMAScript *WhiteSpace* and *LineTerminator* code points: what `trim` removes and what
`\s` matches. -/
@[aw_spec (doc := "docs/formal/domains/d1-runs.md#contracts")]
def isJsWhitespace (c : Char) : Bool :=
  let n := c.toNat
  n == 0x09 || n == 0x0A || n == 0x0B || n == 0x0C || n == 0x0D || n == 0x20 || n == 0xA0 ||
    n == 0x1680 || (0x2000 ≤ n && n ≤ 0x200A) || n == 0x2028 || n == 0x2029 || n == 0x202F ||
    n == 0x205F || n == 0x3000 || n == 0xFEFF

/-- The code points `isJsWhitespace` admits, listed one by one (25 of them). -/
def jsWhitespaceCodePoints : List Nat :=
  [0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
    0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF]

/-! ## Trim and blankness -/

/-- `String.prototype.trim`, on the character list. -/
def jsTrimList (cs : List Char) : List Char :=
  ((cs.dropWhile isJsWhitespace).reverse.dropWhile isJsWhitespace).reverse

/-- `String.prototype.trim`. -/
def jsTrim (s : String) : String := String.ofList (jsTrimList s.toList)

/-- `s.trim().length === 0`: the string is empty or only whitespace. -/
def isBlank (s : String) : Bool := s.toList.all isJsWhitespace

/-! ## Regex fragments -/

/-- Every character satisfies `p` (`^[class]*$`). -/
def allChars (p : Char → Bool) (s : String) : Bool := s.toList.all p

/-- The value of a list of ASCII digits, most significant first. -/
def digitsValue (cs : List Char) : Nat :=
  cs.foldl (fun n c => 10 * n + (c.toNat - '0'.toNat)) 0

/-- `\d*` then the single character `last`, and nothing after it. -/
def digitsThenEnd (last : Char) : List Char → Bool
  | [] => false
  | [c] => c == last
  | c :: rest => isAsciiDigit c && digitsThenEnd last rest

/-- `\d+` then the single character `last`, and nothing after it. -/
def digitsPlusThenEnd (last : Char) : List Char → Bool
  | [] => false
  | c :: rest => isAsciiDigit c && digitsThenEnd last rest

theorem digitsThenEnd_single (last c : Char) : digitsThenEnd last [c] = (c == last) := by
  simp only [digitsThenEnd]

theorem digitsThenEnd_cons_cons (last c d : Char) (rest : List Char) :
    digitsThenEnd last (c :: d :: rest) = (isAsciiDigit c && digitsThenEnd last (d :: rest)) := by
  rw [digitsThenEnd.eq_def]

end AgentWorkspace.Text
