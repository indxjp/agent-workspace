import AgentWorkspace.Contracts.Problem

/-!
T5 — a property of the specification itself: SPEC §4's versioning rule and the strictness of the
error envelopes do not fit together.

SPEC §4 "Versioning" classes an additive response field as a **minor** change of the contracts and
the SDK. Every problem envelope is `.strict()` at both levels, so a body to which a control plane
adds any field (a request id, a trace id, a `status`) parses as none of the three envelopes. An SDK
that read the envelopes as they stand lost the `code` and reported `unrecognised_error_body`;
finding CF-2 in the unit report. `readProblem` now drops the keys an envelope does not know before
parsing (`normaliseLenient`), so these theorems hold of the strict envelopes, not of the SDK.
-/

namespace AgentWorkspace.Theorems.Meta.ContractsFoundation

open AgentWorkspace AgentWorkspace.JValue
open AgentWorkspace.Contracts.Problem

/-- Adding any field beside `error` to a valid standard envelope makes every strict envelope
refuse the body (`readProblem` keeps the code only by pruning first, CF-2). -/
@[aw_spec (tier := T5) (doc := "docs/sdk/04-api-specification.md#4-conventions")
  (doc := "docs/sdk/site/guides/errors.mdx#three-envelope-spellings-one-shape")
  (ts := "packages/contracts/src/problem.ts#ApiProblemSchema")
  (ts := "packages/sdk/src/http.ts#readProblem")]
theorem additive_top_level_field_loses_the_code (b : ApiProblemBody) (k : String) (v : JValue)
    (hk : k ≠ "error") :
    normaliseCurrent (.obj [("error", encodeBody b), (k, v)]) = none := by
  have hmem : (k, v) ∈ [("error", encodeBody b), (k, v)] :=
    List.mem_cons_of_mem _ List.mem_cons_self
  have hk1 : k ∉ ["error"] := by simpa using hk
  have hs : apiProblemCodec.decode (.obj [("error", encodeBody b), (k, v)]) = none := by
    rw [apiProblemCodec_decode_eq]; exact Obj.strict_unknown_key _ _ _ k v hmem hk1
  have hd : apiProblemDetailCodec.decode (.obj [("error", encodeBody b), (k, v)]) = none := by
    rw [apiProblemDetailCodec_decode_eq]; exact Obj.strict_unknown_key _ _ _ k v hmem hk1
  have hb : apiProblemBareCodeCodec.decode (.obj [("error", encodeBody b), (k, v)]) = none := by
    rw [apiProblemBareCodeCodec_decode_eq]
    unfold Obj.strict
    simp only [obj?, Option.bind_some]
    split
    · have hl : lookup "error" [("error", encodeBody b), (k, v)] = some (encodeBody b) := by
        simp [lookup, hk]
      have hc : codeCodec.decode (encodeBody b) = none := by
        simp [encodeBody, codeCodec, Codec.stringLen, Codec.stringWhere]
      simp [decodeBareFields, Obj.req, hl, hc]
    · rfl
  simp [normaliseCurrent, Codec.firstOf, readStandard, readDetail, readBare, hs, hd, hb]

example : normaliseCurrent (.obj [("error", encodeBody ⟨"forbidden", "No.", none, none⟩),
    ("requestId", .str "r-1")]) = none :=
  additive_top_level_field_loses_the_code _ "requestId" _ (by decide)

/-- Adding any field outside `code`, `message`, `details` and the deprecated `detail` inside a valid standard envelope's
`error` object makes every strict envelope refuse the body (`readProblem` keeps the code only by
pruning first, CF-2). -/
@[aw_spec (tier := T5) (doc := "docs/sdk/04-api-specification.md#4-conventions")
  (doc := "docs/sdk/site/guides/errors.mdx#three-envelope-spellings-one-shape")
  (ts := "packages/contracts/src/problem.ts#ApiProblemSchema")
  (ts := "packages/sdk/src/http.ts#readProblem")]
theorem additive_inner_field_loses_the_code (code message : String) (k : String) (v : JValue)
    (hk : k ∉ ["code", "message", "details", "detail"]) :
    normaliseCurrent (.obj [("error", .obj [("code", .str code), ("message", .str message),
      (k, v)])]) = none := by
  have hmem : (k, v) ∈ [("code", .str code), ("message", .str message), (k, v)] := by simp
  have hinner : decodeBody (.obj [("code", .str code), ("message", .str message), (k, v)]) =
      none := Obj.strict_unknown_key _ _ _ k v hmem (by simpa [bodyKeys] using hk)
  have hs : apiProblemCodec.decode
      (.obj [("error", .obj [("code", .str code), ("message", .str message), (k, v)])]) = none := by
    rw [apiProblemCodec_decode_eq]
    simp [Obj.strict, Obj.onlyKeys, obj?, Obj.req, lookup, bodyCodec, hinner]
  have hdb : decodeDetailBody (.obj [("code", .str code), ("message", .str message), (k, v)]) =
      none :=
    Obj.strict_unknown_key _ _ _ "message" (.str message) (by simp) (by decide)
  have hd : apiProblemDetailCodec.decode
      (.obj [("error", .obj [("code", .str code), ("message", .str message), (k, v)])]) = none := by
    rw [apiProblemDetailCodec_decode_eq]
    simp [Obj.strict, Obj.onlyKeys, obj?, Obj.req, lookup, detailBodyCodec, hdb]
  have hb : apiProblemBareCodeCodec.decode
      (.obj [("error", .obj [("code", .str code), ("message", .str message), (k, v)])]) = none := by
    rw [apiProblemBareCodeCodec_decode_eq]
    simp [Obj.strict, Obj.onlyKeys, obj?, decodeBareFields, Obj.req, lookup, codeCodec,
      Codec.stringLen, Codec.stringWhere]
  simp [normaliseCurrent, Codec.firstOf, readStandard, readDetail, readBare, hs, hd, hb]

example : normaliseCurrent (.obj [("error", .obj [("code", .str "x"), ("message", .str "y"),
    ("status", .num 400 0)])]) = none :=
  additive_inner_field_loses_the_code "x" "y" "status" _ (by decide)

end AgentWorkspace.Theorems.Meta.ContractsFoundation
