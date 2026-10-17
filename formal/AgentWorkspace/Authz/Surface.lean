import AgentWorkspace.Prelude.WireEnum

/-!
# The path surface (`classifyPath`, spec §34)

`apps/web/server/auth/paths.ts` sorts every pathname into exactly one of three surfaces: `api`
(`/api/**`, protected), `public` (`/p/**`, never authenticated) and `page` (the browser shell).
`decide()` calls it before parsing the path: `public` is allowed with no facts, `page` is refused.

The classifier reads the pathname under **every plausible reading**: backslashes as slashes, dot
segments removed (RFC 3986 §5.2.4 plus empty-segment collapse), and up to four rounds of
`decodeURIComponent`. It is `api` if **any** reading, lower-cased, is under `/api`; `public` only if
**every** reading, case-sensitively, is under `/p`; otherwise `page`. A pathname that is empty, not
absolute or not decodable is `api` (denied).

Modelling notes:

- Strings are processed as `List Char` (code points). A JavaScript string is UTF-16; every
  well-formed string has the same code-point sequence, and `decodeURIComponent` refuses the
  surrogate code points a Lean `Char` cannot hold.
- `decodeURIComponent` is the ECMAScript `Decode` with an empty reserved set: `%HH` with two hex
  digits, multi-byte UTF-8 sequences checked for their continuation bytes, overlong forms, surrogates
  and the `U+10FFFF` bound; anything else throws (`none` here).
- `toLowerCase()` is modelled as ASCII lower-casing. It is only used for the `/api` prefix test,
  and no non-ASCII code point lower-cases to a string that is exactly `a`, `p`, `i` or `/`
  (`U+0130` becomes `i` followed by `U+0307`, which cannot end the prefix), so the two agree on that
  test.
-/

namespace AgentWorkspace.Authz.Surface

open AgentWorkspace

/-- `Surface`: the three surfaces of spec §34. -/
@[aw_spec (ts := "apps/web/server/auth/paths.ts#Surface") (doc := "docs/spec.md#34-api-design")]
inductive Surface where
  | api | «public» | page
  deriving DecidableEq, Repr, Inhabited

/-- The TypeScript spelling of a surface. -/
def Surface.toWire : Surface → String
  | .api => "api" | .«public» => "public" | .page => "page"

instance : WireEnum Surface where
  all := [.api, .«public», .page]
  toWire := Surface.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by
    intro a b h
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-! ## String helpers over `List Char` -/

/-- Split on `/`, exactly as JavaScript's `split('/')` (an empty input is one empty segment). -/
def splitSlash : List Char → List (List Char)
  | [] => [[]]
  | c :: cs =>
    match splitSlash cs with
    | [] => [[c]]
    | seg :: segs => if c = '/' then [] :: seg :: segs else (c :: seg) :: segs

/-- Join segments with `/`. -/
def joinSlash : List (List Char) → List Char
  | [] => []
  | [s] => s
  | s :: ss => s ++ '/' :: joinSlash ss

/-- `replace(/\\/gu, '/')`. -/
def replaceBackslash (s : List Char) : List Char :=
  s.map fun c => if c = '\\' then '/' else c

/-- The stack step of `removeDotSegments`. -/
def dotStep (out : List (List Char)) (seg : List Char) : List (List Char) :=
  if seg = [] ∨ seg = ['.'] then out
  else if seg = ['.', '.'] then out.dropLast
  else out ++ [seg]

/-- `removeDotSegments`: RFC 3986 §5.2.4 plus duplicate-slash collapse and trailing-slash removal. -/
@[aw_spec (ts := "apps/web/server/auth/paths.ts#removeDotSegments")]
def removeDotSegments (s : List Char) : List Char :=
  '/' :: joinSlash ((splitSlash s).foldl dotStep [])

/-- ASCII lower-casing (see the module note on `toLowerCase`). -/
def asciiLower (s : List Char) : List Char := s.map Char.toLower

/-- The value of one hexadecimal digit. -/
def hexVal (c : Char) : Option Nat :=
  if '0' ≤ c ∧ c ≤ '9' then some (c.toNat - '0'.toNat)
  else if 'a' ≤ c ∧ c ≤ 'f' then some (c.toNat - 'a'.toNat + 10)
  else if 'A' ≤ c ∧ c ≤ 'F' then some (c.toNat - 'A'.toNat + 10)
  else none

/-- One `%HH` escape at the head of the input: its byte and the rest. -/
def takeEscape : List Char → Option (Nat × List Char)
  | '%' :: h :: l :: rest =>
    match hexVal h, hexVal l with
    | some a, some b => some (a * 16 + b, rest)
    | _, _ => none
  | _ => none

/-- `n` continuation-byte escapes (`10xxxxxx`), or `none`. -/
def takeContinuations : Nat → List Char → Option (List Nat × List Char)
  | 0, cs => some ([], cs)
  | n + 1, cs =>
    match takeEscape cs with
    | some (b, rest) =>
      if b / 64 = 2 then
        match takeContinuations n rest with
        | some (bs, rest') => some (b :: bs, rest')
        | none => none
      else none
    | none => none

/-- Fold continuation bytes into a code point. -/
def addContinuations (acc : Nat) : List Nat → Nat
  | [] => acc
  | b :: bs => addContinuations (acc * 64 + b % 64) bs

/-- The code point a UTF-8 sequence (`lead` and its continuation bytes) encodes, when it is a
well-formed, shortest-form, non-surrogate scalar value (ECMAScript `Decode` step 4.d). -/
def utf8CodePoint (lead : Nat) (conts : List Nat) : Option Nat :=
  match conts.length with
  | 1 =>
    let cp := addContinuations (lead % 32) conts
    if 0x80 ≤ cp then some cp else none
  | 2 =>
    let cp := addContinuations (lead % 16) conts
    if 0x800 ≤ cp ∧ ¬ (0xD800 ≤ cp ∧ cp ≤ 0xDFFF) then some cp else none
  | 3 =>
    let cp := addContinuations (lead % 8) conts
    if 0x10000 ≤ cp ∧ cp ≤ 0x10FFFF then some cp else none
  | _ => none

/-- How many continuation bytes a lead byte announces; `none` for `10xxxxxx` and `11111xxx`. -/
def continuationCount (lead : Nat) : Option Nat :=
  if lead < 0x80 then some 0
  else if lead < 0xC0 then none
  else if lead < 0xE0 then some 1
  else if lead < 0xF0 then some 2
  else if lead < 0xF8 then some 3
  else none

/-- `decodeURIComponent` with fuel (the input length bounds the steps). -/
def decodeAux : Nat → List Char → Option (List Char)
  | 0, _ => none
  | _ + 1, [] => some []
  | fuel + 1, c :: cs =>
    if c = '%' then
      match takeEscape (c :: cs) with
      | none => none
      | some (lead, rest) =>
        match continuationCount lead with
        | none => none
        | some 0 =>
          match decodeAux fuel rest with
          | some out => some (Char.ofNat lead :: out)
          | none => none
        | some n =>
          match takeContinuations n rest with
          | none => none
          | some (conts, rest') =>
            match utf8CodePoint lead conts with
            | none => none
            | some cp =>
              match decodeAux fuel rest' with
              | some out => some (Char.ofNat cp :: out)
              | none => none
    else
      match decodeAux fuel cs with
      | some out => some (c :: out)
      | none => none

/-- `decodeURIComponent`: `none` where JavaScript throws `URIError`. -/
@[aw_spec (ts := "apps/web/server/auth/paths.ts#candidateForms")]
def decodeURIComponent (s : List Char) : Option (List Char) :=
  decodeAux (s.length + 1) s

/-- `MAX_DECODE_ROUNDS`. -/
@[aw_spec (ts := "apps/web/server/auth/paths.ts#MAX_DECODE_ROUNDS")]
def maxDecodeRounds : Nat := 4

/-- The rounds of `candidateForms`: each round adds the separated form and its dot-resolved form,
then decodes; an undecodable round fails the whole read, an unchanged one stops. -/
def formsAux : Nat → List Char → Option (List (List Char))
  | 0, _ => some []
  | n + 1, current =>
    let separated := replaceBackslash current
    let here := [separated, removeDotSegments separated]
    match decodeURIComponent separated with
    | none => none
    | some decoded =>
      if decoded = separated then some here
      else (formsAux n decoded).map (here ++ ·)

/-- `candidateForms`: every reading of the pathname, or `none` when it cannot be read. -/
@[aw_spec (ts := "apps/web/server/auth/paths.ts#candidateForms")]
def candidateForms (raw : List Char) : Option (List (List Char)) :=
  formsAux maxDecodeRounds raw

/-- `isUnder`: the prefix itself, or anything below it (`/apiary` is not under `/api`). -/
@[aw_spec (ts := "apps/web/server/auth/paths.ts#isUnder")]
def isUnder (path prefix_ : List Char) : Bool :=
  path == prefix_ || (prefix_ ++ ['/']).isPrefixOf path

/-- `API_PREFIX`. -/
def apiPrefix : List Char := ['/', 'a', 'p', 'i']
/-- `PUBLIC_PREFIX`. -/
def publicPrefix : List Char := ['/', 'p']

/-- `classifyPath`, over the characters of the pathname. -/
def classifyChars (raw : List Char) : Surface :=
  match raw with
  | [] => .api
  | c :: _ =>
    if c ≠ '/' then .api
    else
      match candidateForms raw with
      | none => .api
      | some forms =>
        if forms.any (fun f => isUnder (asciiLower f) apiPrefix) then .api
        else if forms.all (fun f => isUnder f publicPrefix) then .«public»
        else .page

/-- `classifyPath`: the surface of a pathname. -/
@[aw_spec (ts := "apps/web/server/auth/paths.ts#classifyPath") (doc := "docs/spec.md#34-api-design")]
def classifyPath (path : String) : Surface := classifyChars path.toList

end AgentWorkspace.Authz.Surface
