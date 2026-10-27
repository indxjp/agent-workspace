import AgentWorkspace.Contracts.Identifiers
import AgentWorkspace.Contracts.Problem

/-!
T0 — the shared contract foundation is well formed: the identifier and error-envelope codecs
round-trip, and each refuses input at every bound and every pattern position.

* **Text.** `utf16Length` counts a character above `U+FFFF` as two units and never fewer units
  than characters; the JavaScript whitespace set is exactly its 25 listed code points among the
  ones a vector can name, and `trim` empties a string exactly when it is blank.
* **UUIDs.** `UuidSchema` and `isUuid` accept the same JSON values; a canonical id is 36
  characters; a non-hex character at any of the 36 positions, or a digit in place of any hyphen, is
  refused; an upper-case digit at any hex position is accepted.
* **Instants.** `IsoDateTimeSchema` checks every month's length and the Gregorian
  leap rule, and refuses offsets, missing seconds, out-of-range fields and an empty fraction.
* **Envelopes.** Each of the three problem envelopes parses to exactly the values with a code of
  at least one unit, accepts any `details` list (the empty one included), accepts a code
  of any length from one unit up, and refuses an empty code, a missing field and `null` for an
  optional field. Each refuses an unknown key at the top level; the standard and RBAC envelopes
  also refuse one inside `error` (the literal key sets `code`/`message`/`details`/`detail` and
  `code`/`detail`; the bare envelope has no inner object). A repeated key reads as its last
  occurrence, as `JSON.parse` keeps it.
* **Combinators.** `int`, `nullable`, `array`, loose objects and discriminated unions, through
  transcriptions of real schemas that use them.
-/

namespace AgentWorkspace.Theorems.WellFormed.ContractsFoundation

open AgentWorkspace AgentWorkspace.JValue AgentWorkspace.Text
open AgentWorkspace.Contracts.Identifiers AgentWorkspace.Contracts.Problem

/-! ## Text -/

private theorem utf16Units_bounds (c : Char) : 1 ≤ utf16Units c ∧ utf16Units c ≤ 2 := by
  unfold utf16Units; split <;> omega

private theorem sum_units_bounds :
    ∀ cs : List Char, cs.length ≤ (cs.map utf16Units).sum ∧ (cs.map utf16Units).sum ≤ 2 * cs.length
  | [] => by simp
  | c :: cs => by
    have := utf16Units_bounds c
    have := sum_units_bounds cs
    simp only [List.map_cons, List.sum_cons, List.length_cons]
    omega

/-- A string's JavaScript `length` lies between its character count and twice that count. -/
@[aw_spec (tier := T0) (doc := "docs/formal/domains/d1-runs.md#contracts")
  (ts := "packages/contracts/src/runs.ts#MAX_PROMPT_CHARS")]
theorem utf16_length_between_chars_and_twice (s : String) :
    s.toList.length ≤ utf16Length s ∧ utf16Length s ≤ 2 * s.toList.length :=
  sum_units_bounds s.toList

/-- A character above `U+FFFF` counts as two UTF-16 units and one in the Basic Multilingual Plane
as one, at both edges of the plane. -/
@[aw_spec (tier := T0) (doc := "docs/formal/domains/d1-runs.md#contracts")
  (ts := "packages/contracts/src/runs.ts#MAX_PROMPT_CHARS")]
theorem utf16_units_at_the_plane_edges :
    utf16Units (Char.ofNat 0xFFFF) = 1 ∧ utf16Units (Char.ofNat 0x10000) = 2 ∧
      utf16Units (Char.ofNat 0x1F600) = 2 ∧ utf16Units 'a' = 1 := by
  decide +kernel

/-- Both bounds of a string schema are checked in UTF-16 units, including the upper bound. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#MAX_PROMPT_CHARS")]
theorem length_within_checks_maximum (lo hi : Nat) (s : String) :
    lengthWithin lo (some hi) s = true ↔
      lo ≤ utf16Length s ∧ utf16Length s ≤ hi := by
  simp [lengthWithin]

example : lengthWithin 1 (some 2) (String.ofList [Char.ofNat 0x1F600]) = true ∧
    lengthWithin 1 (some 1) (String.ofList [Char.ofNat 0x1F600]) = false := by
  decide +kernel

/-- The JavaScript whitespace predicate holds for each of its 25 listed code points and for none
of the look-alikes `trim` keeps: next line `U+0085`, the Mongolian vowel separator `U+180E`, the
zero-width space `U+200B`, the word joiner `U+2060`, and the letters and digits. -/
@[aw_spec (tier := T0) (doc := "docs/formal/domains/d1-runs.md#contracts")
  (ts := "packages/contracts/src/runs.ts#StartRunRequestSchema")]
theorem js_whitespace_is_the_listed_set :
    jsWhitespaceCodePoints.all (fun n => isJsWhitespace (Char.ofNat n)) = true ∧
      jsWhitespaceCodePoints.length = 25 ∧ jsWhitespaceCodePoints.Nodup ∧
      ([0x85, 0x180E, 0x200B, 0x2060, 0x41, 0x30, 0x5F, 0x1F].all
        fun n => !isJsWhitespace (Char.ofNat n)) = true := by
  decide +kernel

private theorem dropWhile_eq_nil_iff (p : Char → Bool) :
    ∀ cs : List Char, cs.dropWhile p = [] ↔ cs.all p = true
  | [] => by simp
  | c :: cs => by
    simp only [List.dropWhile_cons, List.all_cons, Bool.and_eq_true]
    cases hc : p c <;> simp [dropWhile_eq_nil_iff p cs]

private theorem all_dropWhile (p : Char → Bool) :
    ∀ cs : List Char, (cs.dropWhile p).all p = cs.all p
  | [] => rfl
  | c :: cs => by
    simp only [List.dropWhile_cons, List.all_cons]
    cases hc : p c <;> simp [hc, all_dropWhile p cs]

/-- `trim` empties a string exactly when every character of it is JavaScript whitespace. -/
@[aw_spec (tier := T0) (doc := "docs/formal/domains/d1-runs.md#contracts")
  (ts := "packages/contracts/src/runs.ts#StartRunRequestSchema")]
theorem js_trim_empty_iff_blank (s : String) : jsTrimList s.toList = [] ↔ isBlank s = true := by
  unfold jsTrimList isBlank
  rw [List.reverse_eq_nil_iff, dropWhile_eq_nil_iff, List.all_reverse, all_dropWhile]

example : isBlank "\u3000 \t" = true ∧ isBlank " a " = false := by decide +kernel

/-- `trim` removes leading and trailing whitespace of every kind the set lists and keeps the
characters JavaScript does not treat as whitespace. -/
@[aw_spec (tier := T0) (doc := "docs/formal/domains/d1-runs.md#contracts")
  (ts := "packages/contracts/src/runs.ts#StartRunRequestSchema")]
theorem js_trim_examples :
    jsTrim " \t\n a b \r\u00A0\u2028\uFEFF" = "a b" ∧ jsTrim "\u0085x\u180E" = "\u0085x\u180E" ∧
      jsTrim "\u3000" = "" := by
  decide +kernel

/-! ## UUIDs -/

/-- The id used by the per-position theorems. -/
def sampleUuid : String := "123e4567-e89b-12d3-a456-426614174000"

/-- `UuidSchema` accepts exactly the JSON values `isUuid` accepts, and returns the accepted string
unchanged: the two exports are one rule. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/identifiers.ts#UuidSchema")
  (ts := "packages/contracts/src/identifiers.ts#isUuid")]
theorem uuid_schema_accepts_exactly_what_is_uuid_accepts (j : JValue) (s : String) :
    uuidCodec.decode j = some s ↔ j = .str s ∧ isUuid j = true := by
  unfold uuidCodec
  rw [Codec.stringWhere_decode_eq_some_iff]
  constructor
  · rintro ⟨rfl, h⟩; exact ⟨rfl, h⟩
  · rintro ⟨rfl, h⟩; exact ⟨rfl, h⟩

example : uuidCodec.decode (.str sampleUuid) = some sampleUuid :=
  (uuid_schema_accepts_exactly_what_is_uuid_accepts _ _).mpr ⟨rfl, by decide⟩

private theorem canonical_length (s : String) (h : Uuid.isCanonical s = true) :
    s.toList.length = 36 := by
  simp only [Uuid.isCanonical, Bool.and_eq_true, beq_iff_eq] at h
  rw [h.1]; decide +kernel

private theorem hex_small (c : Char) (h : Uuid.isHexDigit c = true) : c.toNat ≤ 0xFFFF := by
  simp only [Uuid.isHexDigit, Bool.or_eq_true, Bool.and_eq_true, decide_eq_true_eq] at h
  have hf : c ≤ 'f' := by
    rcases h with (⟨_, h2⟩ | ⟨_, h2⟩) | ⟨_, h2⟩
    · exact Char.le_trans h2 (by decide +kernel)
    · exact h2
    · exact Char.le_trans h2 (by decide +kernel)
  have h1 : c.val.toNat ≤ ('f' : Char).val.toNat := UInt32.le_iff_toNat_le.mp (Char.le_def.mp hf)
  have h2 : ('f' : Char).val.toNat = 102 := by decide +kernel
  show c.val.toNat ≤ 0xFFFF
  omega

private theorem length_of_bmp :
    ∀ cs : List Char, (∀ c ∈ cs, c.toNat ≤ 0xFFFF) → (cs.map utf16Units).sum = cs.length
  | [], _ => rfl
  | c :: cs, h => by
    have hc := h c List.mem_cons_self
    have ih := length_of_bmp cs (fun d hd => h d (List.mem_cons_of_mem _ hd))
    simp only [List.map_cons, List.sum_cons, List.length_cons, ih, utf16Units, hc, ite_true]
    omega

/-- An accepted id is exactly 36 characters and 36 UTF-16 units long. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/identifiers.ts#UUID_PATTERN")]
theorem uuid_is_36_characters (s : String) (h : Uuid.isCanonical s = true) :
    s.toList.length = 36 ∧ utf16Length s = 36 := by
  have hl := canonical_length s h
  refine ⟨hl, ?_⟩
  unfold utf16Length
  rw [length_of_bmp _ ?_, hl]
  intro c hc
  rcases canonical_chars s h c hc with hx | rfl
  · exact hex_small c hx
  · decide +kernel

example : utf16Length sampleUuid = 36 := (uuid_is_36_characters _ (by decide +kernel)).2

/-- A non-hexadecimal character at any one of the 36 positions of an accepted id is refused. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/identifiers.ts#UUID_PATTERN")]
theorem uuid_refuses_a_non_hex_character_at_every_position :
    ∀ i < 36, Uuid.isCanonical (setChar sampleUuid i 'g') = false := by
  decide +kernel

/-- A digit in place of any of the four hyphens is refused. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/identifiers.ts#UUID_PATTERN")]
theorem uuid_refuses_a_digit_in_place_of_each_hyphen :
    ∀ i ∈ hyphenPositions, Uuid.isCanonical (setChar sampleUuid i '0') = false := by
  decide +kernel

/-- An upper-case hexadecimal letter at any digit position is accepted: the `/i` flag. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/identifiers.ts#UUID_PATTERN")
  (ts := "packages/contracts/src/identifiers.ts#isUuid")]
theorem uuid_accepts_upper_case_at_every_digit_position :
    ∀ i < 36, i ∉ hyphenPositions → Uuid.isCanonical (setChar sampleUuid i 'F') = true := by
  decide +kernel

/-- The anchors hold: a missing or extra character, a trailing newline, braces, a `urn:uuid:`
prefix, the unhyphenated form and the empty string are refused. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/identifiers.ts#UUID_PATTERN")]
theorem uuid_refuses_wrong_lengths_and_decorations :
    Uuid.isCanonical "123e4567-e89b-12d3-a456-42661417400" = false ∧
      Uuid.isCanonical "123e4567-e89b-12d3-a456-4266141740000" = false ∧
      Uuid.isCanonical "123e4567-e89b-12d3-a456-426614174000\n" = false ∧
      Uuid.isCanonical "{123e4567-e89b-12d3-a456-426614174000}" = false ∧
      Uuid.isCanonical "urn:uuid:123e4567-e89b-12d3-a456-426614174000" = false ∧
      Uuid.isCanonical "123e4567e89b12d3a456426614174000" = false ∧
      Uuid.isCanonical "" = false := by
  decide +kernel

/-- `UuidSchema`, `isUuid` and `IsoDateTimeSchema` refuse every JSON value that is not a string. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/identifiers.ts#UuidSchema")
  (ts := "packages/contracts/src/identifiers.ts#isUuid")
  (ts := "packages/contracts/src/identifiers.ts#IsoDateTimeSchema")]
theorem identifier_schemas_refuse_non_strings (j : JValue) (h : ∀ s, j ≠ .str s) :
    uuidCodec.decode j = none ∧ isUuid j = false ∧ isoDateTimeCodec.decode j = none := by
  refine ⟨Codec.stringWhere_decode_nonstring _ j h, ?_, Codec.stringWhere_decode_nonstring _ j h⟩
  cases j <;> first | rfl | exact absurd rfl (h _)

example : uuidCodec.decode .null = none ∧ isUuid .null = false ∧ isoDateTimeCodec.decode .null = none :=
  identifier_schemas_refuse_non_strings .null (by intro s h; cases h)

/-! ## ISO-8601 instants -/

/-- The last day of every month of a common year is accepted and the day after it is refused. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/identifiers.ts#IsoDateTimeSchema")]
theorem iso_date_time_month_lengths :
    ["2023-01-31", "2023-02-28", "2023-03-31", "2023-04-30", "2023-05-31", "2023-06-30",
        "2023-07-31", "2023-08-31", "2023-09-30", "2023-10-31", "2023-11-30",
        "2023-12-31"].all (fun d => isIsoDateTime (d ++ "T00:00:00Z")) = true ∧
      ["2023-01-32", "2023-02-29", "2023-03-32", "2023-04-31", "2023-05-32", "2023-06-31",
        "2023-07-32", "2023-08-32", "2023-09-31", "2023-10-32", "2023-11-31",
        "2023-12-32"].all (fun d => !isIsoDateTime (d ++ "T00:00:00Z")) = true := by
  decide +kernel

/-- February 29th is accepted exactly in the Gregorian leap years: 2024, 2000 and 0000, but not
2023, 1900 or 2100. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/identifiers.ts#IsoDateTimeSchema")]
theorem iso_date_time_leap_days :
    isIsoDateTime "2024-02-29T00:00:00Z" = true ∧ isIsoDateTime "2000-02-29T00:00:00Z" = true ∧
      isIsoDateTime "0000-02-29T00:00:00Z" = true ∧ isIsoDateTime "2023-02-29T00:00:00Z" = false ∧
      isIsoDateTime "1900-02-29T00:00:00Z" = false ∧
      isIsoDateTime "2100-02-29T00:00:00Z" = false := by
  decide +kernel

/-- For every year, February has 29 days exactly under the Gregorian divisibility rule. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/identifiers.ts#IsoDateTimeSchema")]
theorem february_leap_rule_for_every_year (y : Nat) :
    daysInMonth y 2 = 29 ↔
      y % 4 = 0 ∧ (y % 100 ≠ 0 ∨ y % 400 = 0) := by
  simp only [daysInMonth, isLeapYear, Bool.and_eq_true, beq_iff_eq,
    Bool.or_eq_true, bne_iff_ne]
  split <;> simp_all

/-- Month 00 and 13, day 00, hour 24, minute 60 and second 60 are refused; 23:59:59 is accepted. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/identifiers.ts#IsoDateTimeSchema")]
theorem iso_date_time_field_bounds :
    isIsoDateTime "2026-00-01T00:00:00Z" = false ∧ isIsoDateTime "2026-13-01T00:00:00Z" = false ∧
      isIsoDateTime "2026-01-00T00:00:00Z" = false ∧ isIsoDateTime "2026-01-01T24:00:00Z" = false ∧
      isIsoDateTime "2026-01-01T00:60:00Z" = false ∧ isIsoDateTime "2026-01-01T00:00:60Z" = false ∧
      isIsoDateTime "2026-12-31T23:59:59Z" = true := by
  decide +kernel

/-- Only the `Z` form is accepted: an offset, a lower-case `z` or `t`, a missing designator, a
missing seconds field, a space for `T` and a trailing newline are refused. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/identifiers.ts#IsoDateTimeSchema")]
theorem iso_date_time_refuses_other_forms :
    isIsoDateTime "2026-09-23T10:00:00+00:00" = false ∧
      isIsoDateTime "2026-09-23T10:00:00z" = false ∧ isIsoDateTime "2026-09-23t10:00:00Z" = false ∧
      isIsoDateTime "2026-09-23T10:00:00" = false ∧ isIsoDateTime "2026-09-23T10:00Z" = false ∧
      isIsoDateTime "2026-09-23 10:00:00Z" = false ∧
      isIsoDateTime "2026-09-23T10:00:00Z\n" = false ∧ isIsoDateTime "2026-09-23" = false := by
  decide +kernel

/-- A fraction of seconds needs at least one digit and may have many. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/identifiers.ts#IsoDateTimeSchema")]
theorem iso_date_time_fraction :
    isIsoDateTime "2026-09-23T10:00:00.Z" = false ∧
      isIsoDateTime "2026-09-23T10:00:00.1Z" = true ∧
      isIsoDateTime "2026-09-23T10:00:00.123456789012Z" = true ∧
      isIsoDateTime "2026-09-23T10:00:00.12aZ" = false := by
  decide +kernel

/-! ## Problem envelopes -/

private theorem code_valid_iff (s : String) : codeCodec.valid s = true ↔ 1 ≤ utf16Length s := by
  simp [codeCodec, Codec.stringLen, Codec.stringWhere, Text.lengthWithin]

/-- Each envelope parses to exactly the values whose code is at least one UTF-16 unit long: every
such value is the output of some body (its own encoding), and no other value is. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/problem.ts#ApiProblemSchema")
  (ts := "packages/contracts/src/problem.ts#ApiProblemDetailSchema")
  (ts := "packages/contracts/src/problem.ts#ApiProblemBareCodeSchema")]
theorem problem_envelopes_parse_exactly_the_values_with_a_code
    (p : ApiProblem) (d : ApiProblemDetail) (b : ApiProblemBareCode) :
    ((∃ j, apiProblemCodec.decode j = some p) ↔ 1 ≤ utf16Length p.error.code) ∧
      ((∃ j, apiProblemDetailCodec.decode j = some d) ↔ 1 ≤ utf16Length d.code) ∧
      ((∃ j, apiProblemBareCodeCodec.decode j = some b) ↔ 1 ≤ utf16Length b.error) := by
  refine ⟨⟨fun ⟨_, h⟩ => (code_valid_iff _).mp (apiProblemCodec.valid_of_decode h),
      fun h => ⟨_, apiProblemCodec.decode_encode p ((code_valid_iff _).mpr h)⟩⟩,
    ⟨fun ⟨_, h⟩ => (code_valid_iff _).mp (apiProblemDetailCodec.valid_of_decode h),
      fun h => ⟨_, apiProblemDetailCodec.decode_encode d ((code_valid_iff _).mpr h)⟩⟩,
    ⟨fun ⟨_, h⟩ => (code_valid_iff _).mp (apiProblemBareCodeCodec.valid_of_decode h),
      fun h => ⟨_, apiProblemBareCodeCodec.decode_encode b ((code_valid_iff _).mpr h)⟩⟩⟩

example : ¬ ∃ j, apiProblemBareCodeCodec.decode j = some ⟨"", none⟩ := fun h =>
  absurd ((problem_envelopes_parse_exactly_the_values_with_a_code default default ⟨"", none⟩).2.2.mp h)
    (by decide +kernel)

/-- `details` is any list of strings, the empty list included (`z.array(z.string())` has no
length bound), and is read back unchanged. -/
@[aw_spec (tier := T0) (doc := "docs/sdk/04-api-specification.md#4-conventions")
  (ts := "packages/contracts/src/problem.ts#ApiProblemSchema")]
theorem api_problem_accepts_any_details_list (d : List String) :
    apiProblemCodec.decode (.obj [("error", .obj [("code", .str "x"), ("message", .str ""),
      ("details", .arr (d.map JValue.str))])]) = some ⟨⟨"x", "", some d, none⟩⟩ := by
  -- Read the decoder field by field rather than through the codec law, so the statement is
  -- checked against the decoder itself.
  have hitems : Codec.decodeAll Codec.string.decode (d.map JValue.str) = some d :=
    Codec.decodeAll_map_encode Codec.string d (by simp [Codec.string, Codec.stringWhere])
  have hcode : codeCodec.decode (.str "x") = some "x" := by decide +kernel
  have hmsg : Codec.string.decode (.str "") = some "" := rfl
  simp [apiProblemCodec, Obj.strict, Obj.onlyKeys, Obj.req, Obj.opt, lookup, obj?, bodyCodec,
    decodeBody, decodeBodyFields, bodyKeys, detailsCodec, Codec.array, hitems, hcode, hmsg]

example : apiProblemCodec.decode (.obj [("error", .obj [("code", .str "x"), ("message", .str ""),
    ("details", .arr [])])]) = some ⟨⟨"x", "", some [], none⟩⟩ :=
  api_problem_accepts_any_details_list []

/-- The one-unit bound on `code`: an empty code is refused by all three envelopes, and a
one-character code (even one astral character, two units) is accepted. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/problem.ts#ApiProblemSchema")
  (ts := "packages/contracts/src/problem.ts#ApiProblemDetailSchema")
  (ts := "packages/contracts/src/problem.ts#ApiProblemBareCodeSchema")]
theorem problem_code_min_one :
    apiProblemCodec.decode (.obj [("error", .obj [("code", .str ""), ("message", .str "x")])]) =
        none ∧
      apiProblemDetailCodec.decode
        (.obj [("error", .obj [("code", .str ""), ("detail", .str "x")])]) = none ∧
      apiProblemBareCodeCodec.decode (.obj [("error", .str "")]) = none ∧
      (apiProblemCodec.decode
        (.obj [("error", .obj [("code", .str "x"), ("message", .str "")])])).isSome ∧
      (apiProblemBareCodeCodec.decode (.obj [("error", .str (String.singleton (Char.ofNat 0x1F600)))])).isSome := by
  decide +kernel

/-- Missing and mistyped fields are refused: a missing `message` or `code`, `details: null`
(optional is not nullable), a non-string detail, a bare `error` string where the standard envelope
wants an object, a `null` bare `message`, a non-object body, and an array body. -/
@[aw_spec (tier := T0) (doc := "docs/sdk/04-api-specification.md#4-conventions")
  (ts := "packages/contracts/src/problem.ts#ApiProblemSchema")
  (ts := "packages/contracts/src/problem.ts#ApiProblemBareCodeSchema")]
theorem problem_envelopes_refuse_missing_and_mistyped_fields :
    apiProblemCodec.decode (.obj [("error", .obj [("code", .str "x")])]) = none ∧
      apiProblemCodec.decode (.obj [("error", .obj [("message", .str "x")])]) = none ∧
      apiProblemCodec.decode
        (.obj [("error", .obj [("code", .str "x"), ("message", .str "y"), ("details", .null)])]) =
        none ∧
      apiProblemCodec.decode (.obj [("error", .obj [("code", .str "x"), ("message", .str "y"),
        ("details", .arr [.num 1 0])])]) = none ∧
      apiProblemCodec.decode (.obj [("error", .str "boom")]) = none ∧
      apiProblemBareCodeCodec.decode (.obj [("error", .str "x"), ("message", .null)]) = none ∧
      apiProblemCodec.decode (.str "boom") = none ∧
      apiProblemCodec.decode (.arr []) = none ∧ apiProblemCodec.decode (.obj []) = none := by
  decide +kernel

/-- The standard envelope refuses an unknown key inside `error`, whatever the key's value, for
every valid body. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/problem.ts#ApiProblemSchema")]
theorem api_problem_refuses_unknown_inner_key (b : ApiProblemBody) (k : String) (v : JValue)
    (hk : k ∉ ["code", "message", "details", "detail"]) :
    apiProblemCodec.decode (.obj [("error", .obj ((match encodeBody b with
      | .obj fs => fs | _ => []) ++ [(k, v)]))]) = none := by
  have hk' : k ∉ bodyKeys := by simpa [bodyKeys] using hk
  have hinner : decodeBody (.obj ((match encodeBody b with | .obj fs => fs | _ => []) ++ [(k, v)]))
      = none :=
    Obj.strict_unknown_key _ _ _ k v (List.mem_append_right _ (List.mem_singleton_self _)) hk'
  simp [apiProblemCodec, Obj.strict, Obj.onlyKeys, Obj.req, lookup, obj?, bodyCodec, hinner]

example : apiProblemCodec.decode (.obj [("error", .obj [("code", .str "x"), ("message", .str "y"),
    ("status", .num 400 0)])]) = none :=
  api_problem_refuses_unknown_inner_key ⟨"x", "y", none, none⟩ "status" (.num 400 0) (by decide +kernel)

/-- The RBAC envelope refuses an unknown key inside `error` beside `code` and `detail`, whatever
the key's value, for every code and detail (its inner object is `.strict()` too). -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/problem.ts#ApiProblemDetailSchema")]
theorem api_problem_detail_refuses_unknown_inner_key (code detail k : String) (v : JValue)
    (hk : k ∉ ["code", "detail"]) :
    apiProblemDetailCodec.decode
      (.obj [("error", .obj [("code", .str code), ("detail", .str detail), (k, v)])]) = none := by
  have hinner : decodeDetailBody (.obj [("code", .str code), ("detail", .str detail), (k, v)]) =
      none :=
    Obj.strict_unknown_key _ _ _ k v (by simp) hk
  rw [apiProblemDetailCodec_decode_eq]
  simp [Obj.strict, Obj.onlyKeys, obj?, Obj.req, lookup, detailBodyCodec, hinner]

example : apiProblemDetailCodec.decode (.obj [("error", .obj [("code", .str "last_owner"),
    ("detail", .str "x"), ("details", .arr [])])]) = none :=
  api_problem_detail_refuses_unknown_inner_key "last_owner" "x" "details" (.arr []) (by decide +kernel)

/-- `code` has a lower bound only: a code of any length from one UTF-16 unit up is accepted by
each of the three envelopes and read back unchanged. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/problem.ts#ApiProblemSchema")
  (ts := "packages/contracts/src/problem.ts#ApiProblemDetailSchema")
  (ts := "packages/contracts/src/problem.ts#ApiProblemBareCodeSchema")]
theorem problem_code_has_no_upper_bound (s : String) (hs : 1 ≤ utf16Length s) :
    apiProblemCodec.decode (.obj [("error", .obj [("code", .str s), ("message", .str "")])]) =
        some ⟨⟨s, "", none, none⟩⟩ ∧
      apiProblemDetailCodec.decode (.obj [("error", .obj [("code", .str s), ("detail", .str "")])]) =
        some ⟨s, ""⟩ ∧
      apiProblemBareCodeCodec.decode (.obj [("error", .str s)]) = some ⟨s, none⟩ := by
  have hv : codeCodec.valid s = true := (code_valid_iff s).mpr hs
  exact ⟨apiProblemCodec.decode_encode ⟨⟨s, "", none, none⟩⟩ hv,
    apiProblemDetailCodec.decode_encode ⟨s, ""⟩ hv, apiProblemBareCodeCodec.decode_encode ⟨s, none⟩ hv⟩

example : apiProblemBareCodeCodec.decode (.obj [("error", .str "a_code_far_longer_than_any_bound_of_32_units")]) =
    some ⟨"a_code_far_longer_than_any_bound_of_32_units", none⟩ :=
  (problem_code_has_no_upper_bound _ (by decide +kernel)).2.2

/-- A repeated key is read as its last occurrence, as `JSON.parse` (the SDK's `response.json()`)
keeps it: at the top level of the bare envelope and inside the standard envelope's `error`. -/
@[aw_spec (tier := T0) (ts := "packages/sdk/src/http.ts#problemFromResponse")
  (ts := "packages/contracts/src/problem.ts#ApiProblemSchema")]
theorem problem_envelope_repeated_key_last_wins :
    apiProblemBareCodeCodec.decode (.obj [("error", .str "first"), ("error", .str "last")]) =
        some ⟨"last", none⟩ ∧
      apiProblemCodec.decode (.obj [("error", .obj [("code", .str "first"), ("message", .str "m"),
        ("code", .str "last")])]) = some ⟨⟨"last", "m", none, none⟩⟩ ∧
      apiProblemBareCodeCodec.decode (.obj [("error", .str "x"), ("error", .str "")]) = none := by
  decide +kernel

/-- Each envelope refuses a key beside `error` at the top level, for every body: the standard and
RBAC envelopes refuse every other key, `message` included; the bare envelope refuses every key but
its optional `message`. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/problem.ts#ApiProblemSchema")
  (ts := "packages/contracts/src/problem.ts#ApiProblemDetailSchema")
  (ts := "packages/contracts/src/problem.ts#ApiProblemBareCodeSchema")]
theorem problem_envelopes_refuse_unknown_top_level_key (e : JValue) (k : String) (v : JValue)
    (hk : k ≠ "error") :
    apiProblemCodec.decode (.obj [("error", e), (k, v)]) = none ∧
      apiProblemDetailCodec.decode (.obj [("error", e), (k, v)]) = none ∧
      (k ≠ "message" → apiProblemBareCodeCodec.decode (.obj [("error", e), (k, v)]) = none) := by
  have hk1 : k ∉ ["error"] := by simpa using hk
  have hmem : (k, v) ∈ [("error", e), (k, v)] := List.mem_cons_of_mem _ List.mem_cons_self
  rw [apiProblemCodec_decode_eq, apiProblemDetailCodec_decode_eq,
    apiProblemBareCodeCodec_decode_eq]
  refine ⟨Obj.strict_unknown_key _ _ _ k v hmem hk1, Obj.strict_unknown_key _ _ _ k v hmem hk1,
    fun hm => Obj.strict_unknown_key _ _ _ k v hmem ?_⟩
  simp [hk, hm]

example : apiProblemCodec.decode (.obj [("error", encodeBody ⟨"x", "y", none, none⟩),
    ("message", .str "m")]) = none :=
  (problem_envelopes_refuse_unknown_top_level_key _ "message" (.str "m") (by decide +kernel)).1

example : apiProblemBareCodeCodec.decode (.obj [("error", .str "x"), ("code", .str "y")]) = none :=
  (problem_envelopes_refuse_unknown_top_level_key (.str "x") "code" (.str "y") (by decide +kernel)).2.2
    (by decide +kernel)

/-! ## The combinators no foundation contract uses

`Codec.int`, `Codec.nullable`, `Codec.array`, `Obj.strip`/`Obj.extras` and `Obj.tagged` are not
used by `identifiers.ts` or `problem.ts`, but the domain contracts use them. Each is pinned here
through a transcription of one real schema that uses it (in `Sample`); `codec-combinators.json`
replays the same transcriptions against those schemas. -/

namespace Sample

/-- `z.number().int().nonnegative()`, as `RevokeRunTokensResponseSchema.revoked`,
`RunUsageSchema`'s counters and `SubtreeMoveOutcomeSchema.moved` use it. -/
def count : Codec Int := Codec.int (some 0) none

/-- `z.string().nullable()`, as `StreamResetFrameDataSchema.resumedAfter` uses it. -/
def nullableString : Codec (Option String) := Codec.nullable Codec.string (by intro a h; cases h)

/-- `z.array(z.string().min(1))`, as `SubtreeMoveOutcomeSchema.remaining` uses it. -/
def pathList : Codec (List String) := Codec.array (Codec.stringLen 1 none)

/-- `z.enum(['revoked', 'already-revoked', 'not-found'])`. -/
def revokeOutcome : Codec String :=
  Codec.stringWhere fun s => ["revoked", "already-revoked", "not-found"].contains s

/-- `RevokeRunTokensResponseSchema`, strict; the parsed output as JSON. -/
def revokeResponse : JValue → Option JValue :=
  Obj.strict ["revoked", "outcome"] fun fs => do
    let n ← Obj.req count "revoked" fs
    let o ← Obj.req revokeOutcome "outcome" fs
    pure (.obj [("revoked", count.encode n), ("outcome", .str o)])

/-- `StreamResetFrameDataSchema`, strict; the parsed output as JSON. -/
def streamReset : JValue → Option JValue :=
  Obj.strict ["reason", "resumedAfter"] fun fs => do
    let r ← Obj.req Codec.string "reason" fs
    let a ← Obj.req nullableString "resumedAfter" fs
    pure (.obj [("reason", .str r), ("resumedAfter", nullableString.encode a)])

/-- `RelayedEventDataSchema = z.looseObject({ kind: z.string().min(1) })`: `kind` is checked and
every other key passes through unvalidated. -/
def relayedEvent : JValue → Option JValue :=
  Obj.strip fun fs => (Obj.req (Codec.stringLen 1 none) "kind" fs).map fun k =>
    .obj (("kind", .str k) :: Obj.extras ["kind"] fs)

/-- `SubtreeMoveOutcomeSchema = z.discriminatedUnion('status', [ok, partial])`, each branch
strict; the parsed output as JSON. -/
def subtreeMove (j : JValue) : Option JValue :=
  j.obj?.bind <| Obj.tagged "status"
    [("ok", fun fs => Obj.strict ["status", "moved"] (fun fs => do
        let m ← Obj.req count "moved" fs
        pure (.obj [("status", .str "ok"), ("moved", count.encode m)])) (.obj fs)),
     ("partial", fun fs => Obj.strict ["status", "moved", "total", "remaining"] (fun fs => do
        let m ← Obj.req count "moved" fs
        let t ← Obj.req count "total" fs
        let r ← Obj.opt pathList "remaining" fs
        pure (.obj ([("status", .str "partial"), ("moved", count.encode m),
          ("total", count.encode t)] ++ Obj.optField pathList "remaining" r))) (.obj fs))]

end Sample

/-- `z.number().int()` admits exactly the safe integers within its bounds: `2⁵³ − 1` is accepted
and `2⁵³` refused at the top, `-(2⁵³ − 1)` accepted and `-2⁵³` refused at the bottom;
`.nonnegative()` refuses `-1`; a fractional number and a numeric string are refused; `1.0` is the
integer `1`. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#RevokeRunTokensResponseSchema")
  (ts := "packages/contracts/src/runs.ts#RunUsageSchema")]
theorem codec_int_admits_safe_integers_only :
    Sample.count.decode (.num 9007199254740991 0) = some 9007199254740991 ∧
      Sample.count.decode (.num 9007199254740992 0) = none ∧
      Sample.count.decode (.num 0 0) = some 0 ∧ Sample.count.decode (.num (-1) 0) = none ∧
      Sample.count.decode (.num 15 1) = none ∧ Sample.count.decode (.num 10 1) = some 1 ∧
      Sample.count.decode (.str "1") = none ∧
      (Codec.int none none).decode (.num (-9007199254740991) 0) = some (-9007199254740991) ∧
      (Codec.int none none).decode (.num (-9007199254740992) 0) = none := by
  decide +kernel

/-- `.nullable()` reads `null` as the absent value and a string as itself, refuses a number, and
does not make the key optional: a missing `resumedAfter` is refused. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/run-events.ts#StreamResetFrameDataSchema")]
theorem codec_nullable_is_not_optional :
    Sample.streamReset (.obj [("reason", .str "r"), ("resumedAfter", .null)]) =
        some (.obj [("reason", .str "r"), ("resumedAfter", .null)]) ∧
      Sample.streamReset (.obj [("reason", .str "r"), ("resumedAfter", .str "7")]) =
        some (.obj [("reason", .str "r"), ("resumedAfter", .str "7")]) ∧
      Sample.streamReset (.obj [("reason", .str "r"), ("resumedAfter", .num 7 0)]) = none ∧
      Sample.streamReset (.obj [("reason", .str "r")]) = none := by
  decide +kernel

/-- `z.array(s)` accepts the empty array, refuses the whole array when any one item is refused
(here an empty path), and refuses a non-array. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/files.ts#SubtreeMoveOutcomeSchema")]
theorem codec_array_refuses_on_any_bad_item :
    Sample.pathList.decode (.arr []) = some [] ∧
      Sample.pathList.decode (.arr [.str "a", .str "b"]) = some ["a", "b"] ∧
      Sample.pathList.decode (.arr [.str "a", .str ""]) = none ∧
      Sample.pathList.decode (.arr [.str "", .str "a"]) = none ∧
      Sample.pathList.decode (.str "a") = none := by
  decide +kernel

/-- `z.looseObject` checks its shape and passes every other key through (a strict object with the
same shape refuses the same body); a missing or empty `kind` and a non-object are refused. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/run-events.ts#RelayedEventDataSchema")]
theorem obj_loose_object_passes_unknown_keys_through :
    Sample.relayedEvent (.obj [("kind", .str "text"), ("n", .num 2 0), ("x", .null)]) =
        some (.obj [("kind", .str "text"), ("n", .num 2 0), ("x", .null)]) ∧
      Obj.strict ["kind"] (Obj.req (Codec.stringLen 1 none) "kind")
        (.obj [("kind", .str "text"), ("n", .num 2 0)]) = none ∧
      Sample.relayedEvent (.obj [("kind", .str "")]) = none ∧
      Sample.relayedEvent (.obj [("n", .num 2 0)]) = none ∧
      Sample.relayedEvent (.arr []) = none := by
  decide +kernel

/-- `z.discriminatedUnion('status', …)` hands the body to the branch its tag names, and that
branch's own strictness applies (`total` is refused on `ok`); an unknown, missing or non-string tag
is refused. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/files.ts#SubtreeMoveOutcomeSchema")]
theorem obj_discriminated_union_dispatches_on_the_tag :
    Sample.subtreeMove (.obj [("status", .str "ok"), ("moved", .num 3 0)]) =
        some (.obj [("status", .str "ok"), ("moved", .num 3 0)]) ∧
      Sample.subtreeMove (.obj [("status", .str "partial"), ("moved", .num 1 0),
        ("total", .num 3 0)]) =
        some (.obj [("status", .str "partial"), ("moved", .num 1 0), ("total", .num 3 0)]) ∧
      Sample.subtreeMove (.obj [("status", .str "ok"), ("moved", .num 3 0),
        ("total", .num 3 0)]) = none ∧
      Sample.subtreeMove (.obj [("status", .str "OK"), ("moved", .num 3 0)]) = none ∧
      Sample.subtreeMove (.obj [("moved", .num 3 0)]) = none ∧
      Sample.subtreeMove (.obj [("status", .num 1 0), ("moved", .num 3 0)]) = none := by
  decide +kernel

end AgentWorkspace.Theorems.WellFormed.ContractsFoundation
