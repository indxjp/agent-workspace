import AgentWorkspace.Contracts.Identifiers
import AgentWorkspace.Contracts.Problem

/-!
T3 — what hostile input cannot get through the shared contracts.

The attacker controls every byte of a path id and every byte of an error body (a hostile
upstream, a proxy, or a man in the middle of a plain-HTTP deployment). Quantified over all such
inputs:

* **An accepted id carries no path, query or control character.** Whatever `isUuid` or
  `UuidSchema` accepts is made of hexadecimal digits and hyphens only, so no `/`, `\`, `.`, `%`,
  `?`, `#`, `:`, whitespace or NUL can reach a store lookup or a path through an id.
* **An accepted error body always has a code.** Whatever body `readProblem` accepts yields a
  non-empty `code`; a hostile body cannot make a client branch on an empty code.
* **Nothing smuggled survives.** A standard envelope that is accepted has `error` as its only
  top-level key and only `code`, `message`, `details` and the deprecated `detail` inside it.
-/

namespace AgentWorkspace.Theorems.Adversarial.ContractsFoundation

open AgentWorkspace AgentWorkspace.JValue AgentWorkspace.Text
open AgentWorkspace.Contracts.Identifiers AgentWorkspace.Contracts.Problem

/-- The characters an attacker would use to escape an id: path separators, dot, percent, query and
fragment markers, colon, whitespace and NUL. -/
def pathSignificant : List Char :=
  ['/', '\\', '.', '%', '?', '#', ':', ' ', '\t', '\n', '\r', Char.ofNat 0, '+', '&', ';']

/-- No path-significant or control character appears in an id that `isUuid` accepts, whatever
JSON value the attacker sends. -/
@[aw_spec (tier := T3) (doc := "docs/sdk/04-api-specification.md#4-conventions")
  (ts := "packages/contracts/src/identifiers.ts#isUuid")
  (ts := "packages/contracts/src/identifiers.ts#UUID_PATTERN")]
theorem accepted_id_has_no_path_character (j : JValue) (s : String) (hj : j = .str s)
    (h : isUuid j = true) : ∀ c ∈ s.toList, c ∉ pathSignificant := by
  subst hj
  intro c hc hbad
  have hsafe : ∀ d ∈ pathSignificant, Uuid.isHexDigit d = false ∧ d ≠ '-' := by decide +kernel
  obtain ⟨hx, hd⟩ := hsafe c hbad
  rcases canonical_chars s h c hc with h' | h'
  · rw [hx] at h'; cases h'
  · exact hd h'

example : ∀ c ∈ "123e4567-e89b-12d3-a456-426614174000".toList, c ∉ pathSignificant :=
  accepted_id_has_no_path_character _ _ rfl (by decide +kernel)

/-- Every body `readProblem` accepts, over all JSON an attacker can send, yields a code of at
least one UTF-16 unit. -/
@[aw_spec (tier := T3) (doc := "docs/sdk/04-api-specification.md#4-conventions")
  (doc := "docs/sdk/site/guides/errors.mdx#apiproblemerror-the-server-answered-and-refused")
  (ts := "packages/sdk/src/http.ts#readProblem")
  (ts := "packages/contracts/src/problem.ts#ApiProblemSchema")]
theorem accepted_problem_has_a_code (j : JValue) (b : ApiProblemBody)
    (h : normaliseCurrent j = some b) : 1 ≤ utf16Length b.code := by
  have hcode : codeCodec.valid b.code = true := by
    simp only [normaliseCurrent, Codec.firstOf, Option.or_none] at h
    cases hs : readStandard j with
    | some b' =>
      rw [hs] at h; simp only [Option.some_or] at h; cases h
      obtain ⟨p, hp, rfl⟩ := Option.map_eq_some_iff.mp hs
      exact apiProblemCodec.valid_of_decode hp
    | none =>
      rw [hs] at h; simp only [Option.none_or] at h
      cases hd : readDetail j with
      | some b' =>
        rw [hd] at h; simp only [Option.some_or] at h; cases h
        obtain ⟨d, hdd, rfl⟩ := Option.map_eq_some_iff.mp hd
        exact apiProblemDetailCodec.valid_of_decode hdd
      | none =>
        rw [hd] at h; simp only [Option.none_or] at h
        obtain ⟨bb, hbb, rfl⟩ := Option.map_eq_some_iff.mp h
        exact apiProblemBareCodeCodec.valid_of_decode hbb
  simp only [codeCodec, Codec.stringLen, Codec.stringWhere, Text.lengthWithin, Option.all_none,
    Bool.and_true, decide_eq_true_eq] at hcode
  exact hcode

example : 1 ≤ utf16Length "forbidden" :=
  accepted_problem_has_a_code (apiProblemCodec.encode ⟨⟨"forbidden", "No.", none, none⟩⟩)
    ⟨"forbidden", "No.", none, none⟩ (by decide +kernel)

/-- An accepted standard envelope, whatever the attacker sent, has `error` as its only top-level
key and only `code`, `message`, `details` and the deprecated `detail` inside it: no extra field
reaches the client. -/
@[aw_spec (tier := T3) (doc := "docs/sdk/04-api-specification.md#4-conventions")
  (ts := "packages/contracts/src/problem.ts#ApiProblemSchema")]
theorem accepted_standard_envelope_has_no_extra_key (j : JValue) (p : ApiProblem)
    (h : apiProblemCodec.decode j = some p) :
    ∃ fs fs', j = .obj fs ∧ (∀ k ∈ keys fs, k = "error") ∧ lookup "error" fs = some (.obj fs') ∧
      ∀ k ∈ keys fs', k ∈ ["code", "message", "details", "detail"] := by
  rw [apiProblemCodec_decode_eq] at h
  obtain ⟨fs, rfl, hk, hb⟩ := Obj.strict_some_keys h
  cases hr : Obj.req bodyCodec "error" fs with
  | none => simp [hr] at hb
  | some b =>
    obtain ⟨v, hv, hd⟩ := Obj.req_some hr
    obtain ⟨fs', rfl, hk', -⟩ := Obj.strict_some_keys (show decodeBody v = some b from hd)
    exact ⟨fs, fs', rfl, fun k hkm => by simpa using hk k hkm, hv,
      fun k hkm => by simpa [bodyKeys] using hk' k hkm⟩

example : ∃ fs fs', apiProblemCodec.encode ⟨⟨"x", "y", none, none⟩⟩ = .obj fs ∧
    (∀ k ∈ keys fs, k = "error") ∧ lookup "error" fs = some (.obj fs') ∧
    ∀ k ∈ keys fs', k ∈ ["code", "message", "details", "detail"] :=
  accepted_standard_envelope_has_no_extra_key _ ⟨⟨"x", "y", none, none⟩⟩ (by decide +kernel)

end AgentWorkspace.Theorems.Adversarial.ContractsFoundation
