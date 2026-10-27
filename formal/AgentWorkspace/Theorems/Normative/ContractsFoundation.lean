import AgentWorkspace.Contracts.Identifiers
import AgentWorkspace.Contracts.Problem

/-!
T1 — the SPEC §4 conventions and the errors guide's rules that live in the shared contracts.

* **Timestamps are UTC** (SPEC §4 "Timestamps"): an accepted instant ends in `Z` and holds no
  offset sign.
* **Three envelope spellings, one shape** (errors guide): the three envelopes are pairwise
  disjoint, so the order `readProblem` tries them in never changes its answer; `detail` becomes
  `message`, a missing bare `message` becomes `''`, a standard envelope is read as itself, and a
  body that is none of the three is unrecognised.
* **`COMMON_PROBLEM_CODES`** (errors guide table): the codes and statuses are the guide's rows,
  every status is a failure status SPEC §4 lists, and `api_key_not_permitted` is not shared.
-/

namespace AgentWorkspace.Theorems.Normative.ContractsFoundation

open AgentWorkspace AgentWorkspace.JValue AgentWorkspace.Text
open AgentWorkspace.Contracts.Identifiers AgentWorkspace.Contracts.Problem

/-! ## Timestamps are UTC -/

private theorem digitsThenEnd_facts (last : Char) :
    ∀ cs : List Char, Text.digitsThenEnd last cs = true →
      cs.getLast? = some last ∧ ∀ c ∈ cs, Text.isAsciiDigit c = true ∨ c = last
  | [], h => by cases h
  | [c], h => by
    simp only [Text.digitsThenEnd_single, beq_iff_eq] at h
    subst h
    simp
  | c :: d :: cs, h => by
    simp only [Text.digitsThenEnd_cons_cons, Bool.and_eq_true] at h
    obtain ⟨hc, hr⟩ := h
    obtain ⟨hl, hm⟩ := digitsThenEnd_facts last (d :: cs) hr
    refine ⟨by simpa [List.getLast?_cons] using hl, ?_⟩
    intro x hx
    rcases List.mem_cons.mp hx with rfl | hx
    · exact Or.inl hc
    · exact hm x hx

private theorem secondsTail_facts (rest : List Char) (h : secondsTail rest = true) :
    rest.getLast? = some 'Z' ∧
      ∀ c ∈ rest, Text.isAsciiDigit c = true ∨ c ∈ ['-', 'T', ':', '.', 'Z'] := by
  unfold secondsTail at h
  split at h
  · simp
  · rename_i tail
    unfold Text.digitsPlusThenEnd at h
    split at h
    · cases h
    · rename_i c cs
      simp only [Bool.and_eq_true] at h
      obtain ⟨hl, hm⟩ := digitsThenEnd_facts 'Z' cs h.2
      refine ⟨?_, ?_⟩
      · simp [List.getLast?_cons, hl]
      · intro x hx
        simp only [List.mem_cons] at hx
        rcases hx with rfl | rfl | hx
        · simp
        · exact Or.inl h.1
        · rcases hm x hx with h' | rfl
          · exact Or.inl h'
          · simp
  · cases h

/-- An instant `IsoDateTimeSchema` accepts is written in UTC: it ends in `Z`, and every character
is a digit or one of `- T : . Z`, so no `+hh:mm` or `-hh:mm` offset and no lower-case designator
can appear. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#4-conventions")
  (ts := "packages/contracts/src/identifiers.ts#IsoDateTimeSchema")]
theorem iso_date_time_is_utc (s : String) (h : isIsoDateTime s = true) :
    s.toList.getLast? = some 'Z' ∧
      ∀ c ∈ s.toList, Text.isAsciiDigit c = true ∨ c ∈ ['-', 'T', ':', '.', 'Z'] := by
  unfold isIsoDateTime at h
  split at h
  · rename_i y1 y2 y3 y4 m1 m2 d1 d2 h1 h2 n1 n2 s1 s2 rest heq
    simp only [Bool.and_eq_true] at h
    obtain ⟨⟨⟨⟨⟨⟨hd, -⟩, -⟩, -⟩, -⟩, -⟩, ht⟩ := h
    obtain ⟨hl, hm⟩ := secondsTail_facts rest ht
    rw [heq]
    refine ⟨?_, ?_⟩
    · simp [List.getLast?_cons, hl]
    · intro c hc
      simp only [List.mem_cons] at hc
      rcases hc with h | h | h | h | h | h | h | h | h | h | h | h | h | h | h | h | h | h | h |
          hc <;>
        first
        | exact hm c hc
        | (subst h
           first
           | (right; simp; done)
           | (left; apply List.all_eq_true.mp hd; simp))
  · cases h

example : ("2026-09-23T10:00:00.5Z".toList.getLast? = some 'Z') :=
  (iso_date_time_is_utc "2026-09-23T10:00:00.5Z" (by decide +kernel)).1

/-! ## Three envelope spellings, one shape -/

private theorem standard_shape {j : JValue} {p : ApiProblem}
    (h : apiProblemCodec.decode j = some p) :
    ∃ fs fs', j = .obj fs ∧ lookup "error" fs = some (.obj fs') ∧ "message" ∈ keys fs' := by
  obtain ⟨fs, rfl, -, hb⟩ := Obj.strict_some_keys h
  cases hr : Obj.req bodyCodec "error" fs with
  | none => simp [hr] at hb
  | some b =>
    obtain ⟨v, hv, hd⟩ := Obj.req_some hr
    obtain ⟨fs', rfl, -, hbody⟩ := Obj.strict_some_keys (show decodeBody v = some b from hd)
    refine ⟨fs, fs', rfl, hv, ?_⟩
    simp only [decodeBodyFields, Option.bind_eq_bind] at hbody
    cases hc : Obj.req codeCodec "code" fs' with
    | none => simp [hc] at hbody
    | some c =>
      cases hm : Obj.req Codec.string "message" fs' with
      | none => simp [hc, hm] at hbody
      | some m =>
        obtain ⟨_, hl, -⟩ := Obj.req_some hm
        exact mem_keys_of_lookup hl

private theorem detail_shape {j : JValue} {d : ApiProblemDetail}
    (h : apiProblemDetailCodec.decode j = some d) :
    ∃ fs fs', j = .obj fs ∧ lookup "error" fs = some (.obj fs') ∧
      ∀ k ∈ keys fs', k ∈ ["code", "detail"] := by
  obtain ⟨fs, rfl, -, hb⟩ := Obj.strict_some_keys h
  obtain ⟨v, hv, hd⟩ := Obj.req_some hb
  obtain ⟨fs', rfl, hk, -⟩ := Obj.strict_some_keys (show decodeDetailBody v = some d from hd)
  exact ⟨fs, fs', rfl, hv, hk⟩

private theorem bare_shape {j : JValue} {b : ApiProblemBareCode}
    (h : apiProblemBareCodeCodec.decode j = some b) :
    ∃ fs s, j = .obj fs ∧ lookup "error" fs = some (.str s) := by
  obtain ⟨fs, rfl, -, hb⟩ := Obj.strict_some_keys h
  cases hc : Obj.req codeCodec "error" fs with
  | none => simp [decodeBareFields, hc] at hb
  | some c =>
    obtain ⟨v, hv, hd⟩ := Obj.req_some hc
    cases v <;> simp [codeCodec, Codec.stringLen, Codec.stringWhere] at hd
    exact ⟨fs, _, rfl, hv⟩

/-- No JSON value is accepted by two of the three envelope schemas: the standard envelope needs
`message`, which the older RBAC envelope's strict `{ code, detail }` refuses (a standard body may
carry the deprecated `detail` beside `message`, never instead of it), and the bare envelope's
`error` is a string. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/site/guides/errors.mdx#three-envelope-spellings-one-shape")
  (doc := "docs/sdk/04-api-specification.md#4-conventions")
  (ts := "packages/contracts/src/problem.ts#ApiProblemSchema")
  (ts := "packages/contracts/src/problem.ts#ApiProblemDetailSchema")
  (ts := "packages/contracts/src/problem.ts#ApiProblemBareCodeSchema")]
theorem envelopes_are_pairwise_disjoint (j : JValue) :
    ¬((apiProblemCodec.decode j).isSome ∧ (apiProblemDetailCodec.decode j).isSome) ∧
      ¬((apiProblemCodec.decode j).isSome ∧ (apiProblemBareCodeCodec.decode j).isSome) ∧
      ¬((apiProblemDetailCodec.decode j).isSome ∧ (apiProblemBareCodeCodec.decode j).isSome) := by
  refine ⟨?_, ?_, ?_⟩
  · rintro ⟨h1, h2⟩
    obtain ⟨p, hp⟩ := Option.isSome_iff_exists.mp h1
    obtain ⟨d, hd⟩ := Option.isSome_iff_exists.mp h2
    obtain ⟨fs, fs', rfl, hl, hmsg⟩ := standard_shape hp
    obtain ⟨gs, gs', he, hl', hk⟩ := detail_shape hd
    cases he
    rw [hl] at hl'
    cases hl'
    exact absurd (hk _ hmsg) (by decide +kernel)
  · rintro ⟨h1, h2⟩
    obtain ⟨p, hp⟩ := Option.isSome_iff_exists.mp h1
    obtain ⟨b, hb⟩ := Option.isSome_iff_exists.mp h2
    obtain ⟨fs, fs', rfl, hl, -⟩ := standard_shape hp
    obtain ⟨gs, s, he, hl'⟩ := bare_shape hb
    cases he
    rw [hl] at hl'
    cases hl'
  · rintro ⟨h1, h2⟩
    obtain ⟨d, hd⟩ := Option.isSome_iff_exists.mp h1
    obtain ⟨b, hb⟩ := Option.isSome_iff_exists.mp h2
    obtain ⟨fs, fs', rfl, hl, -⟩ := detail_shape hd
    obtain ⟨gs, s, he, hl'⟩ := bare_shape hb
    cases he
    rw [hl] at hl'
    cases hl'

private theorem read_disjoint (j : JValue) :
    ¬((readStandard j).isSome ∧ (readDetail j).isSome) ∧
      ¬((readStandard j).isSome ∧ (readBare j).isSome) ∧
      ¬((readDetail j).isSome ∧ (readBare j).isSome) := by
  simpa [readStandard, readDetail, readBare, Option.isSome_map] using
    envelopes_are_pairwise_disjoint j

/-- The order in which `readProblem` tries the three envelopes never changes its answer: trying
them in the reverse order gives the same result on every body. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/site/guides/errors.mdx#three-envelope-spellings-one-shape")
  (ts := "packages/sdk/src/http.ts#readProblem")]
theorem normalise_is_order_free (j : JValue) :
    normaliseCurrent j = Codec.firstOf [readBare, readDetail, readStandard] j := by
  obtain ⟨h12, h13, h23⟩ := read_disjoint j
  unfold normaliseCurrent
  simp only [Codec.firstOf, Option.or_none]
  cases hs : readStandard j <;> cases hd : readDetail j <;> cases hb : readBare j <;>
    simp_all

/-- A standard envelope is read as its own body. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/site/guides/errors.mdx#three-envelope-spellings-one-shape")
  (ts := "packages/sdk/src/http.ts#readProblem")]
theorem standard_envelope_is_read_as_itself (p : ApiProblem) (h : apiProblemCodec.valid p = true) :
    normaliseCurrent (apiProblemCodec.encode p) = some p.error := by
  simp [normaliseCurrent, Codec.firstOf, readStandard, apiProblemCodec.decode_encode p h]

example : normaliseCurrent (apiProblemCodec.encode ⟨⟨"forbidden", "No.", none, none⟩⟩) =
    some ⟨"forbidden", "No.", none, none⟩ :=
  standard_envelope_is_read_as_itself _ (by decide +kernel)

/-- An RBAC envelope is read with its `detail` as the `message`, and no details. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/site/guides/errors.mdx#three-envelope-spellings-one-shape")
  (ts := "packages/sdk/src/http.ts#readProblem")]
theorem detail_becomes_message (d : ApiProblemDetail) (h : apiProblemDetailCodec.valid d = true) :
    normaliseCurrent (apiProblemDetailCodec.encode d) =
      some { code := d.code, message := d.detail, details := none } := by
  have hd := apiProblemDetailCodec.decode_encode d h
  have hs : readStandard (apiProblemDetailCodec.encode d) = none := by
    cases hr : readStandard (apiProblemDetailCodec.encode d) with
    | none => rfl
    | some _ =>
      exact absurd ⟨by simp [hr], by simp [readDetail, hd]⟩
        (read_disjoint (apiProblemDetailCodec.encode d)).1
  simp [normaliseCurrent, Codec.firstOf, hs, readDetail, hd]

example : normaliseCurrent (apiProblemDetailCodec.encode ⟨"last_owner", "The last owner."⟩) =
    some ⟨"last_owner", "The last owner.", none, none⟩ :=
  detail_becomes_message _ (by decide +kernel)

/-- A bare envelope is read with its `message`, or `''` when the server sent none. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/site/guides/errors.mdx#three-envelope-spellings-one-shape")
  (ts := "packages/sdk/src/http.ts#readProblem")]
theorem bare_message_defaults_to_empty (b : ApiProblemBareCode)
    (h : apiProblemBareCodeCodec.valid b = true) :
    normaliseCurrent (apiProblemBareCodeCodec.encode b) =
      some { code := b.error, message := b.message.getD "", details := none } := by
  have hb := apiProblemBareCodeCodec.decode_encode b h
  have hr := read_disjoint (apiProblemBareCodeCodec.encode b)
  have hs : readStandard (apiProblemBareCodeCodec.encode b) = none := by
    cases hr' : readStandard (apiProblemBareCodeCodec.encode b) with
    | none => rfl
    | some _ => exact absurd ⟨by simp [hr'], by simp [readBare, hb]⟩ hr.2.1
  have hd : readDetail (apiProblemBareCodeCodec.encode b) = none := by
    cases hr' : readDetail (apiProblemBareCodeCodec.encode b) with
    | none => rfl
    | some _ => exact absurd ⟨by simp [hr'], by simp [readBare, hb]⟩ hr.2.2
  simp [normaliseCurrent, Codec.firstOf, hs, hd, readBare, hb]

example : normaliseCurrent (apiProblemBareCodeCodec.encode ⟨"invalid_limit", none⟩) =
    some ⟨"invalid_limit", "", none, none⟩ :=
  bare_message_defaults_to_empty _ (by decide +kernel)

/-- A body that is none of the three envelopes (an HTML page, `null`, an empty object, a top-level
`code`) is not read as a problem: the SDK then reports `unrecognised_error_body`. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/site/guides/errors.mdx#three-envelope-spellings-one-shape")
  (ts := "packages/sdk/src/http.ts#readProblem")]
theorem foreign_bodies_are_unrecognised :
    normaliseCurrent (.str "<html>Bad Gateway</html>") = none ∧ normaliseCurrent .null = none ∧
      normaliseCurrent (.obj []) = none ∧
      normaliseCurrent (.obj [("code", .str "x"), ("message", .str "y")]) = none := by
  decide +kernel

/-! ## `COMMON_PROBLEM_CODES` -/

/-- The shared codes and their statuses are, row for row, the errors guide's table. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/site/guides/errors.mdx#common_problem_codes")
  (ts := "packages/contracts/src/problem.ts#COMMON_PROBLEM_CODES")]
theorem common_codes_match_errors_guide :
    (WireEnum.all : List CommonProblemCode).map (fun c => (WireEnum.toWire c, c.status)) =
      documentedCommonCodes := by
  decide +kernel

/-- Every shared code travels under a failure status SPEC §4 lists. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#4-conventions")
  (ts := "packages/contracts/src/problem.ts#COMMON_PROBLEM_CODES")]
theorem common_code_statuses_are_documented (c : CommonProblemCode) :
    documentedFailureStatus c.status = true := by
  cases c <;> decide +kernel

/-- `api_key_not_permitted` is not one of the shared codes: it belongs to the workspace and
invitation routes. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/site/guides/errors.mdx#common_problem_codes")
  (ts := "packages/contracts/src/problem.ts#COMMON_PROBLEM_CODES")]
theorem api_key_not_permitted_is_not_shared :
    WireEnum.ofWire? (α := CommonProblemCode) "api_key_not_permitted" = none := by
  decide +kernel

end AgentWorkspace.Theorems.Normative.ContractsFoundation
