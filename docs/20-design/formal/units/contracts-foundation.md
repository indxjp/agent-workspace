# Unit `contracts-foundation` — JSON, codecs, strings, identifiers and problems (D1, level foundA)

The foundation every domain's contract module reuses: a JSON value with decidable equality, codec
combinators that mirror Zod with proved laws, JavaScript's string semantics, and the two shared
contract modules `packages/contracts/src/identifiers.ts` and `problem.ts`.

| File                                                                                                         | What it holds                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `formal/AgentWorkspace/Prelude/JValue.lean`                                                                  | `JValue` (null, bool, exact decimal `num m e` = m·10⁻ᵉ, string, array, object as an ordered field list), `DecidableEq`, `lookup` (last duplicate wins, as `JSON.parse`), `asInt?`, `toJson`                                                                                                                    |
| `formal/AgentWorkspace/Prelude/Codec.lean`                                                                   | `Codec α` (`encode`, `decode`, `valid`, laws `decode_encode` and `valid_of_decode`); `stringWhere`, `stringLen`, `bool`, `int`, `enum`, `nullable`, `array` (unbounded: no contract bounds an array), `firstOf`; `Obj.strict`, `strip`, `extras`, `req`, `opt`, `tagged`, `field`, `optField` and their lemmas |
| `formal/AgentWorkspace/Prelude/Text.lean`                                                                    | `utf16Length`, `lengthWithin`, ASCII classes, `isJsWhitespace` (the 25 code points `trim` and `\s` use), `jsTrim`, `isBlank`, `digitsValue`, `digitsThenEnd`                                                                                                                                                   |
| `formal/AgentWorkspace/Contracts/Identifiers.lean`                                                           | `uuidCodec`, `isUuid`, `isUuidCurrent` / `isUuidV4Target`, `isIsoDateTime` (Zod 4.6's `z.iso.datetime()` fragment by fragment), `isoDateTimeCodec`                                                                                                                                                             |
| `formal/AgentWorkspace/Contracts/Problem.lean`                                                               | the three envelopes and codecs, `normaliseCurrent` (the SDK's `readProblem`) / `normaliseTarget`, `CommonProblemCode` (`WireEnum`) and `status`, `documentedCommonCodes`                                                                                                                                       |
| `formal/AgentWorkspace/Theorems/{WellFormed,Normative,Adversarial,Refinement,Meta}/ContractsFoundation.lean` | 58 theorems                                                                                                                                                                                                                                                                                                    |
| `formal/Vectors/ContractsFoundation.lean` → `formal/generated/vectors/contracts-foundation/`                 | six files, 1 732 vectors                                                                                                                                                                                                                                                                                       |
| `tests/formal/contracts-foundation.test.ts`                                                                  | replays every vector against `@indx-workspace/contracts` (root, `/runs`, `/run-events`, `/files`) and the JavaScript runtime, and every envelope vector through the real SDK client's `readProblem` (1 801 tests)                                                                                              |

Build: `cd formal && lake build AgentWorkspace.Theorems.WellFormed.ContractsFoundation AgentWorkspace.Theorems.Normative.ContractsFoundation AgentWorkspace.Theorems.Adversarial.ContractsFoundation AgentWorkspace.Theorems.Refinement.ContractsFoundation AgentWorkspace.Theorems.Meta.ContractsFoundation Vectors.ContractsFoundation`

## How to model one Zod schema (copy this)

1. **Structure.** One Lean field per Zod key: `T` for required, `Option T` for `.optional()` (absent),
   `Option T` via `Codec.nullable` for `.nullable()`; `.optional().nullable()` is `Option (Option T)`.
   Derive `DecidableEq, Repr`.
2. **Field codecs.** `z.string().min(1)` is `Codec.stringLen 1 none`; a pattern is
   `Codec.stringWhere p` with `p` in `Prelude/Text` style; enums are `Codec.enum α`.
3. **Decoder.** `Obj.strict [keys] fun fs => do let a ← Obj.req c "a" fs; let b ← Obj.opt d "b" fs; pure ⟨a, b⟩`.
   **Encoder.** `.obj (Obj.field c "a" x.a ++ Obj.optField d "b" x.b)`. `valid` = the field refinements.
4. **Laws.** `decode_encode`: `cases` each optional field, then `simp_all [Obj.strict, Obj.onlyKeys,
Obj.field, Obj.optField, Obj.req, Obj.opt, lookup, obj?, c.decode_encode, …]`.
   `valid_of_decode`: `Obj.strict_some_keys h`, then `cases` each `Obj.req`, and `Obj.req_valid`.
   Add `theorem x_decode_eq : xCodec.decode = Obj.strict … := rfl` so later proofs can `rw`.
5. **Theorems.** Do not restate `decode_encode` as a theorem: state what it buys (the image of the
   decoder, e.g. `problem_envelopes_parse_exactly_the_values_with_a_code`, or an ∀-acceptance such as
   `api_problem_accepts_any_details_list`); rejections at every bound by `decide` on concrete
   `JValue`s; unknown keys for **all** keys by `Obj.strict_unknown_key`. Every combinator's Zod
   semantics is pinned by a T0 theorem over a real schema (`codec_int_admits_safe_integers_only`, …).
6. **Vectors.** Expected = `{ ok: (c.decode j).isSome, parsed: c.encode <$> c.decode j }`; the
   suite asserts `safeParse(input).success` and `toEqual(parsed)`.

Worked example (`ApiProblemBareCodeSchema = z.object({ error: z.string().min(1), message: z.string().optional() }).strict()`):

```lean
structure ApiProblemBareCode where
  error : String
  message : Option String          -- .optional(): absent ↦ none; null is refused
def decodeBareFields (fs : Fields) : Option ApiProblemBareCode := do
  let error ← Obj.req codeCodec "error" fs
  let message ← Obj.opt Codec.string "message" fs
  pure { error, message }
def apiProblemBareCodeCodec : Codec ApiProblemBareCode where
  encode b := .obj (Obj.field codeCodec "error" b.error ++ Obj.optField Codec.string "message" b.message)
  decode := Obj.strict ["error", "message"] decodeBareFields
  valid b := codeCodec.valid b.error
  decode_encode := by intro ⟨e, m⟩ h; cases m <;> simp_all [decodeBareFields, Obj.strict, …]
  valid_of_decode := …   -- Obj.strict_some_keys, then Obj.req_valid
```

## Modelling decisions

- **Numbers are exact decimals.** Model and JavaScript agree on integers up to 2⁵³−1 (Zod's
  `.int()` range, `Codec.maxSafeInteger`) and on every decimal a vector uses.
- **`UUID_PATTERN` is reused** from `Prelude/Ids.lean` (`Uuid.isCanonical`), not redefined.
- **Today and target.** `isUuidCurrent` (any version, either case) vs `isUuidV4Target` (SPEC §4);
  `normaliseCurrent` (three spellings) vs `normaliseTarget` (`ApiProblemSchema` only).
- **`readProblem`** (`packages/sdk/src/http.ts:144`) is not exported; it is modelled here because it
  is defined only by the three contract schemas, and its order-independence is a theorem. The suite
  replays `normaliseCurrent` through `createClient` with a stub `fetch` answering 400 (the SDK is not
  a root dependency, so the test imports `packages/sdk/src/index.ts` by relative path).
- **Key sets are pinned by literal lists.** Every inner-key theorem states the allowed keys as a
  literal (`["code", "message", "details"]`, `["code", "detail"]`), never through `bodyKeys`, so
  loosening the model's set breaks a theorem.
- **The Phase 1 copies** of the JavaScript string predicates (`Connector.isJsWhitespace`,
  `ModelConnection.isJsTrimmed`, `Agent.jsTrim`, `Agent.utf16Length`) are proved equal to
  `Prelude/Text` (T4), so they can delegate to it.

## Theorems (58: 33 T0, 10 T1, 3 T3, 10 T4, 2 T5)

- **T0.** Text: `utf16_length_between_chars_and_twice`, `utf16_units_at_the_plane_edges`,
  `length_within_checks_maximum` (both UTF-16 bounds for every string),
  `js_whitespace_is_the_listed_set`, `js_trim_empty_iff_blank`, `js_trim_examples`. UUID:
  `uuid_schema_accepts_exactly_what_is_uuid_accepts` (∀ JSON: the schema's output is the input and
  its acceptance is `isUuid`), `uuid_is_36_characters`,
  `uuid_refuses_a_non_hex_character_at_every_position` (all 36), `…_digit_in_place_of_each_hyphen`,
  `uuid_accepts_upper_case_at_every_digit_position` (all 32), `uuid_refuses_wrong_lengths_and_decorations`,
  `identifier_schemas_refuse_non_strings`. Instants: `iso_date_time_month_lengths`,
  `…_leap_days`, `february_leap_rule_for_every_year` (the Gregorian rule for every year),
  `…_field_bounds`, `…_refuses_other_forms`, `…_fraction`. Envelopes:
  `problem_envelopes_parse_exactly_the_values_with_a_code` (the image of each decoder),
  `api_problem_accepts_any_details_list` (∀ list, `[]` included), `problem_code_min_one`,
  `problem_envelopes_refuse_missing_and_mistyped_fields`,
  `api_problem_refuses_unknown_inner_key` and `api_problem_detail_refuses_unknown_inner_key` (∀ key
  outside the literal set), `problem_envelopes_refuse_unknown_top_level_key` (∀ key ≠ `error`; the
  standard and RBAC envelopes refuse `message` too), `problem_code_has_no_upper_bound`,
  `problem_envelope_repeated_key_last_wins`. Combinators (through `Sample` transcriptions of real
  schemas): `codec_int_admits_safe_integers_only`, `codec_nullable_is_not_optional`,
  `codec_array_refuses_on_any_bad_item`, `obj_loose_object_passes_unknown_keys_through`,
  `obj_discriminated_union_dispatches_on_the_tag`.
- **T1.** `iso_date_time_is_utc`; `envelopes_are_pairwise_disjoint` (∀ JSON);
  `normalise_is_order_free`; `standard_envelope_is_read_as_itself`; `detail_becomes_message`;
  `bare_message_defaults_to_empty`; `foreign_bodies_are_unrecognised`;
  `common_codes_match_errors_guide` (keys in order with their statuses);
  `common_code_statuses_are_documented`; `api_key_not_permitted_is_not_shared`.
- **T3.** `accepted_id_has_no_path_character`; `accepted_problem_has_a_code`;
  `accepted_standard_envelope_has_no_extra_key`.
- **T4.** `uuid_v4_target_refines_current`; `uuid_current_diverges_from_v4_target`;
  `uuid_current_accepts_a_non_rfc_variant`; `uuid_accepts_two_spellings_of_one_id`;
  `normalise_target_refines_current` (target reads `b` ⇒ today reads `b`);
  `normalise_current_differs_from_target_iff` (∀ JSON: they differ **iff** the body parses as the
  RBAC or bare envelope); `normalise_current_diverges_on_legacy_spellings`;
  `text_whitespace_is_the_phase1_whitespace`; `text_utf16_length_is_the_agent_length`;
  `text_trim_is_the_agent_trim`.
- **T5.** `additive_top_level_field_loses_the_code`; `additive_inner_field_loses_the_code`.

## Mutation pass (27 mutations, 27 killed in the recorded verifier pass)

The recorded pass covered the 27 mutations below. A later independent targeted pass killed all
three previously missed mutations: removing the 400-year exception and removing the ordinary
divisible-by-four branch both fail `february_leap_rule_for_every_year`; removing the upper bound
from `lengthWithin` fails `length_within_checks_maximum`. Each mutated source was restored byte for
byte, and the unmutated T0 target rebuilt successfully.

| Mutation                                     | Killed by                                                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `invalid_body` 400 → 422                     | `common_codes_match_errors_guide`                                                                                             |
| `code` min 1 → 0                             | `problem_code_min_one`, `accepted_problem_has_a_code`                                                                         |
| drop the 400-year leap rule                  | `iso_date_time_leap_days`                                                                                                     |
| `bodyKeys` gains `detail`                    | `envelopes_are_pairwise_disjoint`                                                                                             |
| whitespace drops U+FEFF                      | `js_whitespace_is_the_listed_set`, `js_trim_examples`, `text_whitespace_is_the_phase1_whitespace`                             |
| bare `message` default `''` → `'unknown'`    | `bare_message_defaults_to_empty`, `normalise_current_diverges_on_legacy_spellings`                                            |
| hour bound 23 → 24                           | `iso_date_time_field_bounds`                                                                                                  |
| UTF-16 plane edge `≤` → `<`                  | `utf16_units_at_the_plane_edges`, `uuid_is_36_characters`, `text_utf16_length_is_the_agent_length`                            |
| swap two codes in key order                  | `common_codes_match_errors_guide`                                                                                             |
| lower-case `z` accepted                      | `iso_date_time_is_utc`, `iso_date_time_refuses_other_forms`                                                                   |
| `isUuid` accepts `null`                      | `uuid_schema_accepts_exactly_what_is_uuid_accepts`, `identifier_schemas_refuse_non_strings`                                   |
| RBAC read gives `details: []`                | `detail_becomes_message`, `normalise_current_diverges_on_legacy_spellings`                                                    |
| v4 target ignores the variant nibble         | `uuid_current_accepts_a_non_rfc_variant` (added after it survived)                                                            |
| optional `null` read as absent               | `Obj.opt_valid`/`opt_absent` laws; `problem_envelopes_refuse_missing_and_mistyped_fields`                                     |
| `decodeAll` skips a bad item                 | `codec_array_refuses_on_any_bad_item`                                                                                         |
| `bodyKeys` gains `trace`                     | `api_problem_refuses_unknown_inner_key`, `accepted_standard_envelope_has_no_extra_key`, `additive_inner_field_loses_the_code` |
| RBAC inner keys gain `details`               | `api_problem_detail_refuses_unknown_inner_key`                                                                                |
| `code` gains `.max(32)`                      | `problem_code_has_no_upper_bound`, `accepted_problem_has_a_code`                                                              |
| `lookup` keeps the first duplicate           | `problem_envelope_repeated_key_last_wins` (with the Prelude lemmas stubbed)                                                   |
| `request_body_too_large` 413 → 400           | `common_codes_match_errors_guide`                                                                                             |
| `intWithin` drops `n ≤ 2⁵³ − 1`              | `codec_int_admits_safe_integers_only`                                                                                         |
| `intWithin` drops `-(2⁵³ − 1) ≤ n`           | `codec_int_admits_safe_integers_only`                                                                                         |
| `details` must be non-empty                  | `api_problem_accepts_any_details_list` (with the private body lemmas stubbed)                                                 |
| `extras` keeps the known keys                | `obj_loose_object_passes_unknown_keys_through`                                                                                |
| `tagged` falls back to the first branch      | `obj_discriminated_union_dispatches_on_the_tag`                                                                               |
| `req` reads an absent key as `null`          | `codec_nullable_is_not_optional`                                                                                              |
| standard envelope allows top-level `message` | `problem_envelopes_refuse_unknown_top_level_key`                                                                              |

## Findings

- **CF-1 (documentation).** SPEC §4 "Identifiers: UUID v4 text" vs `UUID_PATTERN`
  (`packages/contracts/src/identifiers.ts:8`, comment lines 3–7 "any version") and the `/i`
  flag: the nil UUID, v1, v7, a non-RFC variant and upper case are all accepted
  (`uuid_current_diverges_from_v4_target`, `uuid_current_accepts_a_non_rfc_variant`). Proposed:
  amend SPEC §4 to "canonical RFC 9562 UUID text, any version, either case; the server mints
  lower-case v4". Relates to suspicious point 14 (`uuid_accepts_two_spellings_of_one_id`).
- **CF-2 (correctness, needs the Owner).** SPEC §4 "Versioning: additive response fields = minor"
  vs strict envelopes (`problem.ts:11–23`, `37–49`, `56–62`) and `readProblem`
  (`packages/sdk/src/http.ts:144–152`): any added error-body field (a request id, `status`) makes
  every older SDK report `unrecognised_error_body` and lose the code
  (`additive_top_level_field_loses_the_code`, `additive_inner_field_loses_the_code`). The same holds
  for every `.strict()` success schema (a `ContractViolationError`). Proposed: either state in SPEC
  §4 that response schemas are strict and additive fields need a coordinated SDK release, or let the
  error envelopes strip unknown keys so the code survives (a contract change).
  **Since:** `readProblem` drops the keys an envelope does not know before parsing it, so an added
  error-body field keeps the code (`normaliseLenient`, the `read` field of `problem-envelopes.json`);
  the contracts schemas stay strict, and the success schemas remain open (F-084).
- **CF-3 (documentation, low).** `code` is `z.string().min(1)` (`problem.ts:14`, `40`, `58`):
  `" "` and any text are accepted (vector `standard/whitespace-code`), while SPEC §4 and the schema
  comment call it "stable, machine-readable". Proposed: a `^[a-z][a-z0-9_]*$` pattern (a contract
  change), or document that any non-empty string is legal.
- **CF-4 (naming, low).** Three Phase 1 copies of the JavaScript string predicates
  (`Concepts/Connector.lean:227`, `Concepts/ModelConnection.lean:128–137`,
  `Concepts/Agent.lean:65–71`). Now proved equal to `Prelude/Text`; proposed: delegate to it at
  integration.

## Coverage

| Item                                                                                                                   | Covered by                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-1 `UUID_PATTERN`                                                                                                     | T0 `uuid_refuses_a_non_hex_character_at_every_position`, `uuid_refuses_a_digit_in_place_of_each_hyphen`, `uuid_accepts_upper_case_at_every_digit_position`, `uuid_is_36_characters`, `uuid_refuses_wrong_lengths_and_decorations`; T3 `accepted_id_has_no_path_character`; V `uuid.json`                                                                                     |
| C-2 `isUuid`                                                                                                           | T0 `uuid_schema_accepts_exactly_what_is_uuid_accepts`, `identifier_schemas_refuse_non_strings`; V `uuid.json`                                                                                                                                                                                                                                                                |
| C-3 `UuidSchema`                                                                                                       | T0 `uuid_schema_accepts_exactly_what_is_uuid_accepts`; V `uuid.json` (parse output = input)                                                                                                                                                                                                                                                                                  |
| C-4 `IsoDateTimeSchema`                                                                                                | T0 `iso_date_time_*` (5), `identifier_schemas_refuse_non_strings`; T1 `iso_date_time_is_utc`; V `iso-date-time.json` (1 459)                                                                                                                                                                                                                                                 |
| C-5 `ApiProblemSchema` / `ApiProblem`                                                                                  | T0 `problem_envelopes_parse_exactly_the_values_with_a_code`, `api_problem_accepts_any_details_list`, `problem_code_min_one`, `problem_envelopes_refuse_*`, `api_problem_refuses_unknown_inner_key`; T3 `accepted_standard_envelope_has_no_extra_key`; V `problem-envelopes.json`                                                                                             |
| C-6 `ApiProblemDetailSchema`                                                                                           | T0 `problem_envelopes_parse_exactly_the_values_with_a_code`, `api_problem_detail_refuses_unknown_inner_key`; T1 `detail_becomes_message`; V                                                                                                                                                                                                                                  |
| C-7 `ApiProblemBareCodeSchema`                                                                                         | T0 `problem_envelopes_parse_exactly_the_values_with_a_code`, `problem_envelopes_refuse_unknown_top_level_key`; T1 `bare_message_defaults_to_empty`; V                                                                                                                                                                                                                        |
| C-8 `COMMON_PROBLEM_CODES` / `CommonProblemCode`                                                                       | T1 `common_codes_match_errors_guide`, `common_code_statuses_are_documented`, `api_key_not_permitted_is_not_shared`; V `common-problem-codes.json`                                                                                                                                                                                                                            |
| S-19 identifiers "UUID v4 text"                                                                                        | T4 `uuid_v4_target_refines_current`, `uuid_current_diverges_from_v4_target`, `uuid_current_accepts_a_non_rfc_variant`; finding CF-1                                                                                                                                                                                                                                          |
| S-20 timestamps UTC                                                                                                    | T1 `iso_date_time_is_utc`; "`null` means has not happened" not modelled here: the nullable instants are `RunResourceSchema` fields (contracts-runs unit)                                                                                                                                                                                                                     |
| S-21 money                                                                                                             | not modelled here: `RunCostSchema` belongs to the runs contracts unit (F-067)                                                                                                                                                                                                                                                                                                |
| S-22 wrapped items                                                                                                     | not modelled here: `RunResponseSchema` etc. belong to the runs contracts unit                                                                                                                                                                                                                                                                                                |
| S-23 `ApiProblemSchema` is the target                                                                                  | T1 `standard_envelope_is_read_as_itself`; T4 `normalise_target_refines_current`, `normalise_current_differs_from_target_iff`, `normalise_current_diverges_on_legacy_spellings`                                                                                                                                                                                               |
| S-24 the RBAC `{ code, detail }` spelling                                                                              | T1 `envelopes_are_pairwise_disjoint`, `normalise_is_order_free`, `detail_becomes_message`; T4 `normalise_current_diverges_on_legacy_spellings`                                                                                                                                                                                                                               |
| S-25 code stable, message safe, details per-field                                                                      | T3 `accepted_problem_has_a_code`; T0 details are strings (`problem_envelopes_refuse_missing_and_mistyped_fields`); "message is safe prose" not modelled here (a server property: Behaviour, suspicious point 16); finding CF-3                                                                                                                                               |
| S-26 status list                                                                                                       | T1 `common_code_statuses_are_documented` for the shared codes; route statuses belong to Behaviour/Runs                                                                                                                                                                                                                                                                       |
| SPEC §4 Versioning (not numbered)                                                                                      | T5 `additive_top_level_field_loses_the_code`, `additive_inner_field_loses_the_code`; finding CF-2                                                                                                                                                                                                                                                                            |
| Suspicious point 8 (body-error vocabulary)                                                                             | the shared table's `malformed_body`/`unsupported_media_type`/`request_body_too_large` rows are pinned (C-8); the run routes' use of `invalid_body` belongs to Behaviour/Runs                                                                                                                                                                                                 |
| Zod combinators the domain contracts use (`.int()`, `.nullable()`, `z.array`, `z.looseObject`, `z.discriminatedUnion`) | T0 `codec_int_admits_safe_integers_only`, `codec_nullable_is_not_optional`, `codec_array_refuses_on_any_bad_item`, `obj_loose_object_passes_unknown_keys_through`, `obj_discriminated_union_dispatches_on_the_tag`; V `codec-combinators.json` (against `RevokeRunTokensResponseSchema`, `StreamResetFrameDataSchema`, `RelayedEventDataSchema`, `SubtreeMoveOutcomeSchema`) |
| Suspicious point 14 (id spelling)                                                                                      | T4 `uuid_accepts_two_spellings_of_one_id` (the witness); the string comparison is in Authz/Behaviour                                                                                                                                                                                                                                                                         |

## Gaps

- The replay of `readProblem` sees `details` through `ApiProblemError.details`, which maps an
  absent `details` to `[]`, so absent and empty are not told apart there (the schema replay does).
- `Codec.array` has no length bounds: no schema in `packages/contracts` uses `.min`/`.max` on an
  array; add them with a theorem when one does. The `Sample` transcriptions in
  `Theorems/WellFormed/ContractsFoundation.lean` pin the combinators only; the runs, run-events and
  files contract units own the full schemas.
- Integration (outside this unit's owns): `formal/AgentWorkspace.lean` does not import these modules
  and `formal/Vectors/Main.lean` does not register `Vectors.ContractsFoundation`, so
  `lake build AgentWorkspace` and `lake exe vectors` skip the unit until the integrator adds them.
- Lone UTF-16 surrogates (legal in a JavaScript string) have no Lean `String`; duplicate JSON keys
  cannot be emitted through `Lean.Json` (their last-wins reading is a theorem, not a vector);
  the lower safe-integer bound is a theorem only (every contract integer is `.nonnegative()` or `.positive()`).
