import AgentWorkspace.Contracts.Identifiers
import AgentWorkspace.Contracts.Problem
import AgentWorkspace.Theorems.WellFormed.ContractsFoundation
import Vectors.Common

/-!
Vectors for the shared contract foundation (`packages/contracts/src/{identifiers,problem}.ts`) and
the JavaScript string semantics the codecs rely on. Replayed by
`tests/formal/contracts-foundation.test.ts` against the real exports of
`@indx-workspace/contracts` and against the JavaScript runtime's own `length` and `trim`.

- `uuid.json`: `isUuid` and `UuidSchema` on every position mutation of one id, the anchors, case,
  other versions, look-alike characters, non-strings, and a seeded sample of random ids.
- `iso-date-time.json`: `IsoDateTimeSchema` on every month × day cell (00–32) of a common and a
  leap year, February 29th across 400+ years, every hour, minute and second edge, and the other
  forms.
- `problem-envelopes.json`: the three envelope schemas on valid, invalid and additive-field
  bodies; the expected parse output is the model's decoded value, encoded. `normalised` is the
  strict envelopes alone, `read` is what `readProblem` answers.
- `common-problem-codes.json`: `COMMON_PROBLEM_CODES`, key by key and in order, and codes that are
  not in it.
- `codec-combinators.json`: `Codec.int`, `Codec.nullable`, `Codec.array`, `Obj.strip`/`Obj.extras`
  and `Obj.tagged` through the `Sample` transcriptions of four real schemas.
- `text.json`: UTF-16 length, `trim` and blankness, and the whole Basic Multilingual Plane's
  whitespace set.
-/

namespace Vectors.ContractsFoundation

open Lean AgentWorkspace AgentWorkspace.Contracts.Identifiers AgentWorkspace.Contracts.Problem

private def t0 (n : String) : String := s!"AgentWorkspace.Theorems.WellFormed.ContractsFoundation.{n}"
private def t1 (n : String) : String := s!"AgentWorkspace.Theorems.Normative.ContractsFoundation.{n}"
private def t3 (n : String) : String := s!"AgentWorkspace.Theorems.Adversarial.ContractsFoundation.{n}"
private def t4 (n : String) : String := s!"AgentWorkspace.Theorems.Refinement.ContractsFoundation.{n}"
private def t5 (n : String) : String := s!"AgentWorkspace.Theorems.Meta.ContractsFoundation.{n}"

/-- A deterministic linear congruential generator (Numerical Recipes constants). -/
private def lcg (s : Nat) : Nat := (1664525 * s + 1013904223) % 4294967296

/-- `n` pseudo-random numbers below `bound` from `seed`. -/
private def sample (seed bound n : Nat) : List Nat :=
  (List.range n).foldl (fun (acc : List Nat × Nat) _ =>
    let s := lcg acc.2
    (acc.1 ++ [s % bound], s)) ([], seed) |>.1

/-- `n` in decimal, left-padded with zeros to `w` digits. -/
private def pad (w n : Nat) : String :=
  let s := toString n
  String.ofList (List.replicate (w - s.length) '0') ++ s

private def hexDigits : List Char := "0123456789abcdefABCDEF".toList

/-! ## UUIDs -/

private def uuidVector (id : String) (input : JValue) (witnesses : List String) : Vector :=
  { id, input := input.toJson,
    expected := Json.mkObj [("isUuid", isUuid input),
      ("uuidSchema", (uuidCodec.decode input).isSome)],
    witnesses }

private def randomUuid (seed : Nat) : String :=
  let picks := sample seed hexDigits.length 32
  let cs := picks.map fun i => hexDigits.getD i '0'
  let (a, r1) := cs.splitAt 8
  let (b, r2) := r1.splitAt 4
  let (c, r3) := r2.splitAt 4
  let (d, e) := r3.splitAt 4
  String.ofList (a ++ ['-'] ++ b ++ ['-'] ++ c ++ ['-'] ++ d ++ ['-'] ++ e)

def uuidVectors : List Vector :=
  let base := "123e4567-e89b-12d3-a456-426614174000"
  let positions := (List.range 36).map fun i =>
    uuidVector s!"position/{i}/g" (.str (setChar base i 'g'))
      [t0 "uuid_refuses_a_non_hex_character_at_every_position"]
  let hyphens := hyphenPositions.map fun i =>
    uuidVector s!"hyphen/{i}/digit" (.str (setChar base i '0'))
      [t0 "uuid_refuses_a_digit_in_place_of_each_hyphen"]
  let upper := ((List.range 36).filter (· ∉ hyphenPositions)).map fun i =>
    uuidVector s!"position/{i}/upper" (.str (setChar base i 'F'))
      [t0 "uuid_accepts_upper_case_at_every_digit_position"]
  let named : List (String × String × List String) :=
    [("sample", base, [t0 "uuid_schema_accepts_exactly_what_is_uuid_accepts", t3 "accepted_id_has_no_path_character"]),
     ("upper-case", "123E4567-E89B-12D3-A456-426614174000",
       [t4 "uuid_accepts_two_spellings_of_one_id"]),
     ("mixed-case", "123e4567-E89B-12d3-A456-426614174000",
       [t4 "uuid_accepts_two_spellings_of_one_id"]),
     ("nil", "00000000-0000-0000-0000-000000000000", [t4 "uuid_current_diverges_from_v4_target"]),
     ("max", "ffffffff-ffff-ffff-ffff-ffffffffffff", [t4 "uuid_current_diverges_from_v4_target"]),
     ("v7", "01890a5d-ac96-774b-bcce-b302099a8057", [t4 "uuid_current_diverges_from_v4_target"]),
     ("v1", "c232ab00-9414-11ec-b3c8-9f6bdeced846", [t4 "uuid_current_diverges_from_v4_target"]),
     ("v4", "123e4567-e89b-42d3-a456-426614174000", [t4 "uuid_v4_target_refines_current"]),
     ("v4-variant-c", "123e4567-e89b-42d3-c456-426614174000",
       [t4 "uuid_current_accepts_a_non_rfc_variant"]),
     ("short", "123e4567-e89b-12d3-a456-42661417400",
       [t0 "uuid_refuses_wrong_lengths_and_decorations", t0 "uuid_is_36_characters"]),
     ("long", "123e4567-e89b-12d3-a456-4266141740000",
       [t0 "uuid_refuses_wrong_lengths_and_decorations", t0 "uuid_is_36_characters"]),
     ("trailing-newline", base ++ "\n", [t0 "uuid_refuses_wrong_lengths_and_decorations"]),
     ("leading-space", " " ++ base, [t0 "uuid_is_36_characters"]),
     ("braces", "{" ++ base ++ "}", [t0 "uuid_refuses_wrong_lengths_and_decorations"]),
     ("urn", "urn:uuid:" ++ base, [t0 "uuid_refuses_wrong_lengths_and_decorations"]),
     ("unhyphenated", "123e4567e89b12d3a456426614174000",
       [t0 "uuid_refuses_wrong_lengths_and_decorations"]),
     ("empty", "", [t0 "uuid_refuses_wrong_lengths_and_decorations"]),
     ("fullwidth-digit", setChar base 0 (Char.ofNat 0xFF11),
       [t0 "uuid_refuses_a_non_hex_character_at_every_position"]),
     ("unicode-hyphen", setChar base 8 (Char.ofNat 0x2010),
       [t0 "uuid_refuses_a_digit_in_place_of_each_hyphen"]),
     ("nul", setChar base 35 (Char.ofNat 0), [t3 "accepted_id_has_no_path_character"]),
     ("slash", setChar base 35 '/', [t3 "accepted_id_has_no_path_character"]),
     ("dot-dot", "../../../../../../../../../../../..", [t3 "accepted_id_has_no_path_character"]),
     ("percent", setChar base 35 '%', [t3 "accepted_id_has_no_path_character"])]
  let namedVs := named.map fun (id, s, w) => uuidVector s!"named/{id}" (.str s) w
  let nonStrings : List (String × JValue) :=
    [("null", .null), ("true", .bool true), ("number", .num 123 0), ("array", .arr [.str base]),
      ("object", .obj [("id", .str base)])]
  let nonStringVs := nonStrings.map fun (id, j) =>
    uuidVector s!"non-string/{id}" j [t0 "identifier_schemas_refuse_non_strings",
      t0 "uuid_schema_accepts_exactly_what_is_uuid_accepts"]
  let randoms := (List.range 24).map fun k =>
    uuidVector s!"random/{k}" (.str (randomUuid (k * 7919 + 17)))
      [t0 "uuid_schema_accepts_exactly_what_is_uuid_accepts"]
  positions ++ hyphens ++ upper ++ namedVs ++ nonStringVs ++ randoms

/-! ## ISO-8601 instants -/

private def isoVector (id : String) (input : JValue) (witnesses : List String) : Vector :=
  { id, input := input.toJson,
    expected := Json.mkObj [("valid", (isoDateTimeCodec.decode input).isSome)], witnesses }

def isoVectors : List Vector :=
  let grid := [2023, 2024].flatMap fun y => (List.range 14).flatMap fun m => (List.range 33).map
    fun d =>
      let s := s!"{pad 4 y}-{pad 2 m}-{pad 2 d}T00:00:00Z"
      isoVector s!"calendar/{s}" (.str s) [t0 "iso_date_time_month_lengths",
        t0 "iso_date_time_field_bounds"]
  let centuries := (List.range 100).map (· * 100)
  let around := (List.range 209).map (· + 1896)
  let sampled := sample 2026 10000 60
  let years := (centuries ++ around ++ sampled).eraseDups
  let leap := years.map fun y =>
    let s := s!"{pad 4 y}-02-29T12:00:00Z"
    isoVector s!"leap/{s}" (.str s) [t0 "iso_date_time_leap_days",
      t0 "february_leap_rule_for_every_year"]
  let hours := (List.range 25).map fun h =>
    let s := s!"2026-09-23T{pad 2 h}:00:00Z"
    isoVector s!"hour/{s}" (.str s) [t0 "iso_date_time_field_bounds"]
  let minutes := (List.range 61).map fun n =>
    let s := s!"2026-09-23T10:{pad 2 n}:00Z"
    isoVector s!"minute/{s}" (.str s) [t0 "iso_date_time_field_bounds"]
  let seconds := (List.range 61).map fun n =>
    let s := s!"2026-09-23T10:00:{pad 2 n}Z"
    isoVector s!"second/{s}" (.str s) [t0 "iso_date_time_field_bounds",
      t1 "iso_date_time_is_utc"]
  let forms : List (String × List String) :=
    [("2026-09-23T10:00:00+00:00", [t0 "iso_date_time_refuses_other_forms", t1 "iso_date_time_is_utc"]),
     ("2026-09-23T10:00:00-05:00", [t0 "iso_date_time_refuses_other_forms", t1 "iso_date_time_is_utc"]),
     ("2026-09-23T10:00:00z", [t0 "iso_date_time_refuses_other_forms"]),
     ("2026-09-23t10:00:00Z", [t0 "iso_date_time_refuses_other_forms"]),
     ("2026-09-23T10:00:00", [t0 "iso_date_time_refuses_other_forms"]),
     ("2026-09-23T10:00Z", [t0 "iso_date_time_refuses_other_forms"]),
     ("2026-09-23 10:00:00Z", [t0 "iso_date_time_refuses_other_forms"]),
     ("2026-09-23T10:00:00Z\n", [t0 "iso_date_time_refuses_other_forms"]),
     (" 2026-09-23T10:00:00Z", [t0 "iso_date_time_refuses_other_forms"]),
     ("2026-09-23", [t0 "iso_date_time_refuses_other_forms"]),
     ("26-09-23T10:00:00Z", [t0 "iso_date_time_refuses_other_forms"]),
     ("+02026-09-23T10:00:00Z", [t0 "iso_date_time_refuses_other_forms"]),
     ("2026-9-23T10:00:00Z", [t0 "iso_date_time_refuses_other_forms"]),
     ("2026-09-23T10:00:00.Z", [t0 "iso_date_time_fraction"]),
     ("2026-09-23T10:00:00.1Z", [t0 "iso_date_time_fraction", t1 "iso_date_time_is_utc"]),
     ("2026-09-23T10:00:00.123Z", [t0 "iso_date_time_fraction", t1 "iso_date_time_is_utc"]),
     ("2026-09-23T10:00:00.123456789012Z", [t0 "iso_date_time_fraction"]),
     ("2026-09-23T10:00:00.12aZ", [t0 "iso_date_time_fraction"]),
     ("2026-09-23T10:00:00,5Z", [t0 "iso_date_time_fraction"]),
     ("2026-09-23T10:00:00.5+01:00", [t0 "iso_date_time_refuses_other_forms"]),
     ("２026-09-23T10:00:00Z", [t0 "iso_date_time_refuses_other_forms"]),
     ("", [t0 "iso_date_time_refuses_other_forms"])]
  let formVs := forms.map fun (s, w) => isoVector s!"form/{(Json.str s).compress}" (.str s) w
  let nonStrings : List (String × JValue) :=
    [("null", .null), ("number", .num 1758621600000 0), ("object", .obj [])]
  let nonStringVs := nonStrings.map fun (id, j) =>
    isoVector s!"non-string/{id}" j [t0 "identifier_schemas_refuse_non_strings"]
  grid ++ leap ++ hours ++ minutes ++ seconds ++ formVs ++ nonStringVs

/-! ## Problem envelopes -/

private def optJson {α : Type} (o : Option α) (f : α → JValue) : Json :=
  match o with
  | some a => (f a).toJson
  | none => Json.null

private def bodyJson (b : ApiProblemBody) : JValue := encodeBody b

private def envelopeVector (id : String) (input : JValue) (witnesses : List String) : Vector :=
  { id, input := input.toJson,
    expected := Json.mkObj [
      ("standard", optJson (apiProblemCodec.decode input) apiProblemCodec.encode),
      ("detail", optJson (apiProblemDetailCodec.decode input) apiProblemDetailCodec.encode),
      ("bare", optJson (apiProblemBareCodeCodec.decode input) apiProblemBareCodeCodec.encode),
      ("normalised", optJson (normaliseCurrent input) bodyJson),
      ("read", optJson (normaliseLenient input) bodyJson)],
    witnesses }

private def std (fs : JValue.Fields) : JValue := .obj [("error", .obj fs)]

def envelopeVectors : List Vector :=
  let astral := String.singleton (Char.ofNat 0x1F600)
  let longCode := String.ofList (List.replicate 300 'x')
  let rt := [t0 "problem_envelopes_parse_exactly_the_values_with_a_code",
    t1 "standard_envelope_is_read_as_itself", t1 "envelopes_are_pairwise_disjoint",
    t4 "normalise_target_refines_current"]
  let rtDetails := t0 "api_problem_accepts_any_details_list" :: rt
  let valid : List (String × JValue × List String) :=
    [("standard/minimal", std [("code", .str "forbidden"), ("message", .str "No.")], rt),
     ("standard/details", std [("code", .str "invalid_field"), ("message", .str "Bad."),
        ("details", .arr [.str "name is required", .str "x"])], rtDetails),
     ("standard/empty-details", std [("code", .str "x"), ("message", .str "y"),
        ("details", .arr [])], rtDetails),
     ("standard/empty-message", std [("code", .str "x"), ("message", .str "")], rt),
     ("standard/astral-code", std [("code", .str astral), ("message", .str "y")],
        [t0 "problem_code_min_one"]),
     ("standard/whitespace-code", std [("code", .str " "), ("message", .str "y")],
        [t0 "problem_code_min_one"]),
     ("standard/reordered", std [("message", .str "y"), ("code", .str "x")], rt),
     ("detail/minimal", std [("code", .str "last_owner"),
        ("detail", .str "The last owner cannot leave.")],
        [t0 "problem_envelopes_parse_exactly_the_values_with_a_code", t1 "detail_becomes_message",
          t4 "normalise_current_differs_from_target_iff"]),
     ("long-code/standard", std [("code", .str longCode), ("message", .str "")],
        [t0 "problem_code_has_no_upper_bound"]),
     ("long-code/detail", std [("code", .str longCode), ("detail", .str "")],
        [t0 "problem_code_has_no_upper_bound"]),
     ("long-code/bare", .obj [("error", .str longCode)], [t0 "problem_code_has_no_upper_bound"]),
     ("standard/deprecated-detail", std [("code", .str "forbidden"), ("message", .str "No."),
        ("detail", .str "No.")],
        [t0 "problem_envelopes_parse_exactly_the_values_with_a_code",
          t1 "standard_envelope_is_read_as_itself", t1 "envelopes_are_pairwise_disjoint"]),
     ("standard/message-and-detail-differ", std [("code", .str "x"), ("message", .str "y"),
        ("detail", .str "z")],
        [t0 "problem_envelopes_parse_exactly_the_values_with_a_code",
          t1 "standard_envelope_is_read_as_itself", t1 "envelopes_are_pairwise_disjoint",
          t0 "api_problem_detail_refuses_unknown_inner_key"]),
     ("bare/code-only", .obj [("error", .str "invalid_limit")],
        [t0 "problem_envelopes_parse_exactly_the_values_with_a_code", t1 "bare_message_defaults_to_empty",
          t4 "normalise_current_differs_from_target_iff"]),
     ("bare/with-message", .obj [("error", .str "driver_unavailable"),
        ("message", .str "No docker.")],
        [t0 "problem_envelopes_parse_exactly_the_values_with_a_code", t1 "bare_message_defaults_to_empty"])]
  let invalid : List (String × JValue × List String) :=
    [("empty-code/standard", std [("code", .str ""), ("message", .str "x")],
        [t0 "problem_code_min_one", t3 "accepted_problem_has_a_code"]),
     ("empty-code/detail", std [("code", .str ""), ("detail", .str "x")],
        [t0 "problem_code_min_one", t3 "accepted_problem_has_a_code"]),
     ("empty-code/bare", .obj [("error", .str "")],
        [t0 "problem_code_min_one", t3 "accepted_problem_has_a_code"]),
     ("missing/message", std [("code", .str "x")],
        [t0 "problem_envelopes_refuse_missing_and_mistyped_fields"]),
     ("missing/code", std [("message", .str "x")],
        [t0 "problem_envelopes_refuse_missing_and_mistyped_fields"]),
     ("null/details", std [("code", .str "x"), ("message", .str "y"), ("details", .null)],
        [t0 "problem_envelopes_refuse_missing_and_mistyped_fields"]),
     ("null/message", std [("code", .str "x"), ("message", .null)],
        [t0 "problem_envelopes_refuse_missing_and_mistyped_fields"]),
     ("null/bare-message", .obj [("error", .str "x"), ("message", .null)],
        [t0 "problem_envelopes_refuse_missing_and_mistyped_fields"]),
     ("mistyped/bare-message", .obj [("error", .str "x"), ("message", .num 1 0)],
        [t0 "problem_envelopes_refuse_missing_and_mistyped_fields"]),
     ("mistyped/detail-item", std [("code", .str "x"), ("message", .str "y"),
        ("details", .arr [.num 1 0])],
        [t0 "problem_envelopes_refuse_missing_and_mistyped_fields"]),
     ("mistyped/details-string", std [("code", .str "x"), ("message", .str "y"),
        ("details", .str "a")],
        [t0 "problem_envelopes_refuse_missing_and_mistyped_fields"]),
     ("mistyped/code-number", std [("code", .num 400 0), ("message", .str "y")],
        [t0 "problem_envelopes_refuse_missing_and_mistyped_fields"]),
     ("detail-with-details", std [("code", .str "x"), ("detail", .str "y"),
        ("details", .arr [])], [t1 "envelopes_are_pairwise_disjoint",
          t0 "api_problem_detail_refuses_unknown_inner_key"]),
     ("bare-with-code", .obj [("error", .str "x"), ("code", .str "y")],
        [t0 "problem_envelopes_refuse_unknown_top_level_key"]),
     ("foreign/html", .str "<html>Bad Gateway</html>", [t1 "foreign_bodies_are_unrecognised"]),
     ("foreign/null", .null, [t1 "foreign_bodies_are_unrecognised"]),
     ("foreign/empty-object", .obj [], [t1 "foreign_bodies_are_unrecognised"]),
     ("foreign/flat", .obj [("code", .str "x"), ("message", .str "y")],
        [t1 "foreign_bodies_are_unrecognised"]),
     ("foreign/array", .arr [std [("code", .str "x"), ("message", .str "y")]],
        [t0 "problem_envelopes_refuse_missing_and_mistyped_fields"]),
     ("foreign/error-array", .obj [("error", .arr [])],
        [t0 "problem_envelopes_refuse_missing_and_mistyped_fields"]),
     ("foreign/error-null", .obj [("error", .null)],
        [t0 "problem_envelopes_refuse_missing_and_mistyped_fields"])]
  let extraKeys := ["status", "requestId", "traceId", "type", "title", "__proto__", "Code",
    "detail"]
  let additiveTop := (extraKeys ++ ["message"]).map fun k =>
    ("additive/top/" ++ k, .obj [("error", encodeBody ⟨"forbidden", "No.", none, none⟩), (k, .str "v")],
      [t5 "additive_top_level_field_loses_the_code",
        t0 "problem_envelopes_refuse_unknown_top_level_key"])
  let additiveInner := (extraKeys.filter (· ≠ "detail")).map fun k =>
    ("additive/inner/" ++ k, std [("code", .str "forbidden"), ("message", .str "No."),
      (k, .str "v")],
      [t5 "additive_inner_field_loses_the_code", t0 "api_problem_refuses_unknown_inner_key"])
  let additiveDetail := ((extraKeys.filter (· ≠ "detail")) ++ ["details"]).map fun k =>
    ("additive/detail-inner/" ++ k, std [("code", .str "last_owner"), ("detail", .str "No."),
      (k, .str "v")],
      [t0 "api_problem_detail_refuses_unknown_inner_key"])
  let additiveBare := extraKeys.map fun k =>
    ("additive/bare/" ++ k, .obj [("error", .str "invalid_limit"), (k, .str "v")],
      [t0 "problem_envelopes_refuse_unknown_top_level_key"])
  (valid ++ invalid ++ additiveTop ++ additiveInner ++ additiveDetail ++ additiveBare).map fun (id, j, w) =>
    envelopeVector id j w

/-! ## `COMMON_PROBLEM_CODES` -/

def commonCodeVectors : List Vector :=
  let order : Vector :=
    { id := "keys-in-order", input := Json.null,
      expected := Json.mkObj [("keys", toJson (WireEnum.wires CommonProblemCode))],
      witnesses := [t1 "common_codes_match_errors_guide"] }
  let rows := (WireEnum.all : List CommonProblemCode).map fun c =>
    ({ id := s!"code/{WireEnum.toWire c}", input := Json.mkObj [("code", WireEnum.toWire c)],
       expected := Json.mkObj [("status", c.status)],
       witnesses := [t1 "common_codes_match_errors_guide",
         t1 "common_code_statuses_are_documented"] } : Vector)
  let absent := ["api_key_not_permitted", "token_out_of_scope", "not_found", "Forbidden",
      "unrecognised_error_body", "invalid_run_id", ""].map fun c =>
    ({ id := s!"absent/{(Json.str c).compress}", input := Json.mkObj [("code", c)],
       expected := Json.mkObj [("status", Json.null)],
       witnesses := [t1 "api_key_not_permitted_is_not_shared"] } : Vector)
  order :: rows ++ absent

/-! ## The combinators no foundation contract uses -/

open AgentWorkspace.Theorems.WellFormed.ContractsFoundation in
/-- One combinator vector: the schema's name (the test maps it to the real Zod schema), the body,
and the model's parsed output (`null` when the model refuses the body). -/
private def combinatorVector (schema id : String) (body : JValue) (witness : String) : Vector :=
  let decode : JValue → Option JValue := match schema with
    | "RevokeRunTokensResponseSchema" => Sample.revokeResponse
    | "StreamResetFrameDataSchema" => Sample.streamReset
    | "RelayedEventDataSchema" => Sample.relayedEvent
    | _ => Sample.subtreeMove
  { id := s!"{schema}/{id}", input := Json.mkObj [("schema", schema), ("body", body.toJson)],
    expected := Json.mkObj [("output", optJson (decode body) fun v => v)],
    witnesses := [t0 witness] }

def combinatorVectors : List Vector :=
  let revoke (n : JValue) : JValue := .obj [("revoked", n), ("outcome", .str "revoked")]
  let int := "codec_int_admits_safe_integers_only"
  let ints : List (String × JValue) :=
    [("zero", .num 0 0), ("one", .num 1 0), ("max-safe", .num 9007199254740991 0),
      ("max-safe-plus-one", .num 9007199254740992 0), ("1e20", .num 100000000000000000000 0),
      ("minus-one", .num (-1) 0), ("one-and-a-half", .num 15 1), ("one-point-zero", .num 10 1),
      ("tiny-fraction", .num 1 3), ("string", .str "1"), ("null", .null), ("bool", .bool true)]
  let revokeVs := ints.map fun (id, n) =>
    combinatorVector "RevokeRunTokensResponseSchema" s!"revoked/{id}" (revoke n) int
  let revokeOther : List (String × JValue) :=
    [("outcome/unknown", .obj [("revoked", .num 1 0), ("outcome", .str "gone")]),
     ("outcome/missing", .obj [("revoked", .num 1 0)]),
     ("extra-key", .obj [("revoked", .num 1 0), ("outcome", .str "not-found"), ("x", .null)])]
  let revokeOtherVs := revokeOther.map fun (id, j) =>
    combinatorVector "RevokeRunTokensResponseSchema" id j int
  let nul := "codec_nullable_is_not_optional"
  let reset : List (String × JValue) :=
    [("null", .obj [("reason", .str "r"), ("resumedAfter", .null)]),
     ("string", .obj [("reason", .str "r"), ("resumedAfter", .str "7")]),
     ("empty-string", .obj [("reason", .str "r"), ("resumedAfter", .str "")]),
     ("number", .obj [("reason", .str "r"), ("resumedAfter", .num 7 0)]),
     ("absent", .obj [("reason", .str "r")]),
     ("reason-null", .obj [("reason", .null), ("resumedAfter", .null)])]
  let resetVs := reset.map fun (id, j) => combinatorVector "StreamResetFrameDataSchema" id j nul
  let loose := "obj_loose_object_passes_unknown_keys_through"
  let relayed : List (String × JValue) :=
    [("kind-only", .obj [("kind", .str "text")]),
     ("extras", .obj [("kind", .str "text"), ("n", .num 2 0), ("x", .null),
       ("nested", .obj [("a", .arr [.bool true])])]),
     ("kind-empty", .obj [("kind", .str "")]), ("kind-missing", .obj [("n", .num 2 0)]),
     ("kind-number", .obj [("kind", .num 1 0)]), ("array", .arr []), ("string", .str "text"),
     ("null", .null)]
  let relayedVs := relayed.map fun (id, j) => combinatorVector "RelayedEventDataSchema" id j loose
  let tag := "obj_discriminated_union_dispatches_on_the_tag"
  let arr := "codec_array_refuses_on_any_bad_item"
  let partialBody (rest : JValue.Fields) : JValue :=
    .obj ([("status", .str "partial"), ("moved", .num 1 0), ("total", .num 3 0)] ++ rest)
  let move : List (String × JValue × String) :=
    [("ok", .obj [("status", .str "ok"), ("moved", .num 3 0)], tag),
     ("ok-with-total",
       .obj [("status", .str "ok"), ("moved", .num 3 0), ("total", .num 3 0)], tag),
     ("partial", partialBody [], tag),
     ("partial-remaining-empty", partialBody [("remaining", .arr [])], arr),
     ("partial-remaining", partialBody [("remaining", .arr [.str "a", .str "b/c"])], arr),
     ("partial-remaining-empty-item", partialBody [("remaining", .arr [.str "a", .str ""])], arr),
     ("partial-remaining-null", partialBody [("remaining", .null)], arr),
     ("partial-remaining-string", partialBody [("remaining", .str "a")], arr),
     ("status-upper", .obj [("status", .str "OK"), ("moved", .num 3 0)], tag),
     ("status-missing", .obj [("moved", .num 3 0)], tag),
     ("status-number", .obj [("status", .num 1 0), ("moved", .num 3 0)], tag),
     ("moved-negative", .obj [("status", .str "ok"), ("moved", .num (-1) 0)], int),
     ("not-object", .arr [], tag)]
  let moveVs := move.map fun (id, j, w) => combinatorVector "SubtreeMoveOutcomeSchema" id j w
  revokeVs ++ revokeOtherVs ++ resetVs ++ relayedVs ++ moveVs

/-! ## Text -/

def textVectors : List Vector :=
  let samples : List String :=
    ["", "a", "abc", " a ", "\t\n\u000B\u000C\r a \u00A0\u1680\u2000\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF",
      "\u0085x\u0085", "\u180Ex\u180E", "\u200Bx\u200B", "\u2060x", String.singleton (Char.ofNat 0x1F600),
      "a" ++ String.singleton (Char.ofNat 0x1F600) ++ "b", String.singleton (Char.ofNat 0x10000),
      String.singleton (Char.ofNat 0xFFFF), String.singleton (Char.ofNat 0x10FFFF), "\u3000",
      "   ", "café", "é\u0301", "x\u0000y"]
  let sampleVs := samples.map fun s =>
    ({ id := s!"sample/{(Json.str s).compress}", input := Json.str s,
       expected := Json.mkObj [("utf16Length", Text.utf16Length s), ("trim", Text.jsTrim s),
         ("blank", Text.isBlank s)],
       witnesses := [t0 "utf16_length_between_chars_and_twice", t0 "utf16_units_at_the_plane_edges",
         t0 "js_trim_empty_iff_blank", t0 "js_trim_examples",
         t4 "text_utf16_length_is_the_agent_length", t4 "text_trim_is_the_agent_trim"] } : Vector)
  let bmp : Vector :=
    { id := "whitespace/bmp", input := Json.mkObj [("from", 0), ("to", 0xFFFF)],
      expected := Json.mkObj [("whitespace", toJson ((List.range 0x10000).filter fun n =>
        Text.isJsWhitespace (Char.ofNat n)))],
      witnesses := [t0 "js_whitespace_is_the_listed_set",
        t4 "text_whitespace_is_the_phase1_whitespace"] }
  bmp :: sampleVs

def files : List (String × Json) :=
  [("uuid.json", file "contracts-foundation"
      "isUuid and UuidSchema: every position, the anchors, case, versions, non-strings, a seeded sample"
      uuidVectors),
   ("iso-date-time.json", file "contracts-foundation"
      "IsoDateTimeSchema: the calendar grid, leap years, time-field edges and the other forms"
      isoVectors),
   ("problem-envelopes.json", file "contracts-foundation"
      "The three problem envelopes on valid, invalid and additive-field bodies" envelopeVectors),
   ("common-problem-codes.json", file "contracts-foundation"
      "COMMON_PROBLEM_CODES key by key, in order, and codes outside it" commonCodeVectors),
   ("codec-combinators.json", file "contracts-foundation"
      "int, nullable, array, loose object and discriminated union, through four real schemas"
      combinatorVectors),
   ("text.json", file "contracts-foundation"
      "UTF-16 length, trim and blankness, and the BMP whitespace set" textVectors)]

end Vectors.ContractsFoundation
