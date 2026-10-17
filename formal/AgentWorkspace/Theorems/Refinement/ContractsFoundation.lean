import AgentWorkspace.Contracts.Identifiers
import AgentWorkspace.Contracts.Problem
import AgentWorkspace.Concepts.Agent
import AgentWorkspace.Concepts.ModelConnection
import AgentWorkspace.Theorems.Normative.ContractsFoundation

/-!
T4 — today's shared contracts against the documented target.

* **Identifiers.** SPEC §4 says "UUID v4 text"; `UUID_PATTERN` accepts every version in either
  case. Every v4 id is accepted today (the target refines the current rule), and the two diverge at
  the nil UUID, at a v7 and a v1 id, and at an upper-case spelling. Because of the `/i` flag one id
  has two accepted spellings, which the server compares as different strings (suspicious point 14
  of the D1 scope).
* **Error envelopes.** SPEC §4's target is one envelope, `ApiProblemSchema`, on every route.
  The target refines today's `readProblem` (whatever it reads, today reads the same). Today's
  `readProblem` and the target differ on exactly the bodies that parse as the RBAC
  `detail` or the bare-code spelling, and agree on every other body.
* **One string semantics.** Phase 1 carries three private copies of the JavaScript string
  predicates (`Connector.isJsWhitespace`, `ModelConnection.isJsTrimmed`, `Agent.jsTrim`,
  `Agent.utf16Length`). Each equals the shared `Prelude/Text` predicate on every input, so the
  concept modules can delegate to it without changing any theorem.
-/

namespace AgentWorkspace.Theorems.Refinement.ContractsFoundation

open AgentWorkspace AgentWorkspace.JValue
open AgentWorkspace.Contracts.Identifiers AgentWorkspace.Contracts.Problem

/-! ## Identifiers -/

/-- Every id of the documented v4 form gets through today's two exported gates unchanged:
`UuidSchema` parses the JSON string to itself and `isUuid` accepts it. -/
@[aw_spec (tier := T4) (doc := "docs/sdk/04-api-specification.md#4-conventions")
  (ts := "packages/contracts/src/identifiers.ts#UuidSchema")
  (ts := "packages/contracts/src/identifiers.ts#isUuid")]
theorem uuid_v4_target_refines_current (s : String) (h : isUuidV4Target s = true) :
    uuidCodec.decode (.str s) = some s ∧ isUuid (.str s) = true := by
  simp only [isUuidV4Target, Bool.and_eq_true] at h
  exact ⟨by simp [uuidCodec, Codec.stringWhere, h.1.1], h.1.1⟩

example : uuidCodec.decode (.str "123e4567-e89b-42d3-a456-426614174000") =
    some "123e4567-e89b-42d3-a456-426614174000" :=
  (uuid_v4_target_refines_current _ (by decide)).1

/-- Today's rule and the documented v4 rule diverge: the nil UUID, a v7 id and a v1 id are
accepted today although none is v4, and an upper-case v4 id is accepted by both. -/
@[aw_spec (tier := T4) (doc := "docs/sdk/04-api-specification.md#4-conventions")
  (ts := "packages/contracts/src/identifiers.ts#UUID_PATTERN")]
theorem uuid_current_diverges_from_v4_target :
    isUuidCurrent "00000000-0000-0000-0000-000000000000" = true ∧
      isUuidV4Target "00000000-0000-0000-0000-000000000000" = false ∧
      isUuidCurrent "01890a5d-ac96-774b-bcce-b302099a8057" = true ∧
      isUuidV4Target "01890a5d-ac96-774b-bcce-b302099a8057" = false ∧
      isUuidCurrent "c232ab00-9414-11ec-b3c8-9f6bdeced846" = true ∧
      isUuidV4Target "c232ab00-9414-11ec-b3c8-9f6bdeced846" = false ∧
      isUuidV4Target "123E4567-E89B-42D3-A456-426614174000" = true := by
  decide

/-- The v4 target reads the variant nibble too: an id with version `4` but a variant nibble outside
`8`–`b` (here `c`, the reserved Microsoft variant) is accepted today and is not v4 text. -/
@[aw_spec (tier := T4) (doc := "docs/sdk/04-api-specification.md#4-conventions")
  (ts := "packages/contracts/src/identifiers.ts#UUID_PATTERN")]
theorem uuid_current_accepts_a_non_rfc_variant :
    isUuidCurrent "123e4567-e89b-42d3-c456-426614174000" = true ∧
      isUuidV4Target "123e4567-e89b-42d3-c456-426614174000" = false ∧
      isUuidV4Target "123e4567-e89b-42d3-b456-426614174000" = true := by
  decide

/-- One id has two accepted spellings: the lower- and upper-case forms are both accepted, are
different strings, and name the same UUID. -/
@[aw_spec (tier := T4) (doc := "docs/formal/domains/d1-runs.md#suspicious-points-noticed-while-reading")
  (ts := "packages/contracts/src/identifiers.ts#isUuid")]
theorem uuid_accepts_two_spellings_of_one_id :
    isUuidCurrent "123e4567-e89b-12d3-a456-426614174000" = true ∧
      isUuidCurrent "123E4567-E89B-12D3-A456-426614174000" = true ∧
      "123e4567-e89b-12d3-a456-426614174000" ≠ "123E4567-E89B-12D3-A456-426614174000" ∧
      lowerAscii "123E4567-E89B-12D3-A456-426614174000" =
        "123e4567-e89b-12d3-a456-426614174000" := by
  decide

/-! ## Error envelopes -/

/-- The target refines today's reader: every body the single-envelope target reads, today's
`readProblem` reads to the same problem. -/
@[aw_spec (tier := T4) (doc := "docs/sdk/04-api-specification.md#4-conventions")
  (doc := "docs/sdk/site/guides/errors.mdx#three-envelope-spellings-one-shape")
  (ts := "packages/sdk/src/http.ts#readProblem")]
theorem normalise_target_refines_current (j : JValue) (b : ApiProblemBody)
    (h : normaliseTarget j = some b) : normaliseCurrent j = some b := by
  simp only [normaliseTarget] at h
  simp [normaliseCurrent, Codec.firstOf, h]

example : normaliseCurrent (apiProblemCodec.encode ⟨⟨"x", "y", none, none⟩⟩) = some ⟨"x", "y", none, none⟩ :=
  normalise_target_refines_current _ _ (by decide)

/-- Today's reader and the single-envelope target give different answers on exactly the bodies
that parse as the RBAC `detail` envelope or the bare-code envelope; on every other body, standard
envelopes and refused bodies alike, the two agree. -/
@[aw_spec (tier := T4) (doc := "docs/sdk/04-api-specification.md#4-conventions")
  (doc := "docs/sdk/site/guides/errors.mdx#three-envelope-spellings-one-shape")
  (ts := "packages/sdk/src/http.ts#readProblem")]
theorem normalise_current_differs_from_target_iff (j : JValue) :
    normaliseCurrent j ≠ normaliseTarget j ↔
      (apiProblemDetailCodec.decode j).isSome ∨ (apiProblemBareCodeCodec.decode j).isSome := by
  obtain ⟨hsd, hsb, -⟩ := Normative.ContractsFoundation.envelopes_are_pairwise_disjoint j
  simp only [normaliseCurrent, normaliseTarget, Codec.firstOf, Option.or_none, readStandard,
    readDetail, readBare] at *
  cases hs : apiProblemCodec.decode j <;> cases hd : apiProblemDetailCodec.decode j <;>
    cases hb : apiProblemBareCodeCodec.decode j <;> simp_all

example : normaliseCurrent (apiProblemCodec.encode ⟨⟨"x", "y", none, none⟩⟩) =
    normaliseTarget (apiProblemCodec.encode ⟨⟨"x", "y", none, none⟩⟩) :=
  Classical.not_not.mp fun h => by
    rcases (normalise_current_differs_from_target_iff _).mp h with h' | h' <;> revert h' <;> decide

example : normaliseCurrent (.obj [("error", .str "invalid_limit")]) ≠
    normaliseTarget (.obj [("error", .str "invalid_limit")]) :=
  (normalise_current_differs_from_target_iff _).mpr (Or.inr (by decide))

/-- Today's reader and the target diverge exactly on the two legacy spellings: the RBAC `detail`
envelope and the bare-code envelope are read today and refused by the target. -/
@[aw_spec (tier := T4) (doc := "docs/sdk/04-api-specification.md#4-conventions")
  (doc := "docs/sdk/site/guides/errors.mdx#three-envelope-spellings-one-shape")
  (ts := "packages/sdk/src/http.ts#readProblem")]
theorem normalise_current_diverges_on_legacy_spellings :
    normaliseTarget (.obj [("error", .obj [("code", .str "last_owner"), ("detail", .str "x")])]) =
        none ∧
      normaliseCurrent (.obj [("error", .obj [("code", .str "last_owner"), ("detail", .str "x")])]) =
        some ⟨"last_owner", "x", none, none⟩ ∧
      normaliseTarget (.obj [("error", .str "invalid_limit")]) = none ∧
      normaliseCurrent (.obj [("error", .str "invalid_limit")]) = some ⟨"invalid_limit", "", none, none⟩ := by
  decide

/-! ## The Phase-1 copies of the string predicates -/

/-- The shared whitespace predicate is the one `ModelConnection` and `Connector` each define, on
every character. -/
@[aw_spec (tier := T4) (doc := "docs/formal/domains/d1-runs.md#contracts")
  (ts := "packages/contracts/src/runs.ts#StartRunRequestSchema")]
theorem text_whitespace_is_the_phase1_whitespace (c : Char) :
    Text.isJsWhitespace c = Concepts.ModelConnection.isJsTrimmed c ∧
      Text.isJsWhitespace c = Concepts.Connector.isJsWhitespace c := by
  refine ⟨rfl, ?_⟩
  simp only [Text.isJsWhitespace, Concepts.Connector.isJsWhitespace, List.contains_cons,
    List.contains_nil, Bool.or_false]
  rw [Bool.eq_iff_iff]
  simp only [Bool.or_eq_true, beq_iff_eq, Bool.and_eq_true, decide_eq_true_eq]
  omega

private theorem sum_units_eq_foldr :
    ∀ cs : List Char, (cs.map Text.utf16Units).sum =
      cs.foldr (fun c n => (if 0x10000 ≤ c.toNat then 2 else 1) + n) 0
  | [] => rfl
  | c :: cs => by
    simp only [List.map_cons, List.sum_cons, List.foldr_cons, sum_units_eq_foldr cs,
      Text.utf16Units]
    split <;> split <;> omega

/-- The shared UTF-16 length is `Agent.utf16Length` on every string. -/
@[aw_spec (tier := T4) (doc := "docs/formal/domains/d1-runs.md#contracts")
  (ts := "packages/contracts/src/runs.ts#MAX_PROMPT_CHARS")]
theorem text_utf16_length_is_the_agent_length (s : String) :
    Text.utf16Length s = Concepts.Agent.utf16Length s :=
  sum_units_eq_foldr s.toList

/-- The shared `trim` is `Agent.jsTrim` on every string. -/
@[aw_spec (tier := T4) (doc := "docs/formal/domains/d1-runs.md#contracts")
  (ts := "packages/contracts/src/runs.ts#StartRunRequestSchema")]
theorem text_trim_is_the_agent_trim (s : String) : Text.jsTrim s = Concepts.Agent.jsTrim s := by
  have h : Text.isJsWhitespace = Concepts.Connector.isJsWhitespace :=
    funext fun c => (text_whitespace_is_the_phase1_whitespace c).2
  simp only [Text.jsTrim, Text.jsTrimList, Concepts.Agent.jsTrim, h]

end AgentWorkspace.Theorems.Refinement.ContractsFoundation
