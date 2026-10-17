import AgentWorkspace.Prelude.Codec

/-!
# `packages/contracts/src/problem.ts`

The error envelopes and the shared problem-code table.

| Export                                       | Model                                                     |
| -------------------------------------------- | --------------------------------------------------------- |
| `ApiProblemSchema` / `ApiProblem`            | `ApiProblem`, `ApiProblemBody`, `apiProblemCodec`         |
| `ApiProblemDetailSchema`                     | `ApiProblemDetail`, `apiProblemDetailCodec`               |
| `ApiProblemBareCodeSchema`                   | `ApiProblemBareCode`, `apiProblemBareCodeCodec`           |
| `COMMON_PROBLEM_CODES` / `CommonProblemCode` | `CommonProblemCode` (a `WireEnum` in key order), `status` |

All three envelopes are `.strict().readonly()` at every level: an unknown key anywhere fails.

`normaliseCurrent` is the three schemas alone tried in order, `detail` read as `message`, a
missing bare `message` read as `''`. `normaliseLenient` is the normalisation the SDK applies
(`readProblem`, `packages/sdk/src/http.ts`, not exported): the same, but each schema is tried on
the body with the keys it names as unrecognised dropped first, so a field a newer server adds
does not cost the caller the code (finding CF-2). `normaliseTarget` is SPEC §4's target, where
`ApiProblemSchema` is the only envelope.
-/

namespace AgentWorkspace.Contracts.Problem

open AgentWorkspace JValue

/-! ## Field schemas -/

/-- `code: z.string().min(1)`. -/
def codeCodec : Codec String := Codec.stringLen 1 none

/-- `details: z.array(z.string()).readonly()`. -/
def detailsCodec : Codec (List String) := Codec.array Codec.string

theorem string_valid (s : String) : Codec.string.valid s = true := rfl

theorem details_valid (v : List String) : detailsCodec.valid v = true := by
  simp [detailsCodec, Codec.array, Codec.string, Codec.stringWhere]

theorem string_decode_encode (s : String) : Codec.string.decode (Codec.string.encode s) = some s :=
  Codec.string.decode_encode s rfl

theorem details_decode_encode (v : List String) :
    detailsCodec.decode (detailsCodec.encode v) = some v :=
  detailsCodec.decode_encode v (details_valid v)

/-! ## `ApiProblemSchema` -/

/-- The inner object of the standard envelope: `{ code, message, details?, detail? }`. -/
@[aw_spec (doc := "docs/sdk/04-api-specification.md#4-conventions")
  (ts := "packages/contracts/src/problem.ts#ApiProblemSchema")]
structure ApiProblemBody where
  code : String
  message : String
  /-- `none` when the key is absent. -/
  details : Option (List String)
  /-- The deprecated duplicate of `message` the RBAC layer and the audit route still send until the next
  major release (ADR-0078 D7) (SDK unit 6, #238); `none` when the key is absent. -/
  detail : Option String := none
  deriving DecidableEq, Repr, Inhabited

/-- `ApiProblem`: `{ error: { code, message, details?, detail? } }`. -/
@[aw_spec (ts := "packages/contracts/src/problem.ts#ApiProblem")]
structure ApiProblem where
  error : ApiProblemBody
  deriving DecidableEq, Repr, Inhabited

/-- The keys of the standard inner object. -/
def bodyKeys : List String := ["code", "message", "details", "detail"]

def encodeBody (b : ApiProblemBody) : JValue :=
  .obj (Obj.field codeCodec "code" b.code ++ Obj.field Codec.string "message" b.message ++
    Obj.optField detailsCodec "details" b.details ++ Obj.optField Codec.string "detail" b.detail)

def decodeBodyFields (fs : Fields) : Option ApiProblemBody := do
  let code ← Obj.req codeCodec "code" fs
  let message ← Obj.req Codec.string "message" fs
  let details ← Obj.opt detailsCodec "details" fs
  let detail ← Obj.opt Codec.string "detail" fs
  pure { code, message, details, detail }

def decodeBody : JValue → Option ApiProblemBody := Obj.strict bodyKeys decodeBodyFields

/-- A body the server may send: a non-empty code (`message` and `details` are any strings). -/
def validBody (b : ApiProblemBody) : Bool := codeCodec.valid b.code

private theorem decodeBody_encodeBody (b : ApiProblemBody) (h : validBody b = true) :
    decodeBody (encodeBody b) = some b := by
  obtain ⟨code, message, details, detail⟩ := b
  cases details <;> cases detail <;>
    simp_all [decodeBody, encodeBody, decodeBodyFields, bodyKeys, Obj.strict, Obj.onlyKeys,
      Obj.field, Obj.optField, Obj.req, Obj.opt, lookup, obj?, validBody,
      codeCodec.decode_encode, string_decode_encode, details_decode_encode]

private theorem validBody_of_decode {j : JValue} {b : ApiProblemBody}
    (h : decodeBody j = some b) : validBody b = true := by
  obtain ⟨fs, -, -, hb⟩ := Obj.strict_some_keys h
  simp only [decodeBodyFields, Option.bind_eq_bind] at hb
  cases hc : Obj.req codeCodec "code" fs with
  | none => simp [hc] at hb
  | some c =>
    cases hm : Obj.req Codec.string "message" fs with
    | none => simp [hc, hm] at hb
    | some m =>
      cases hd : Obj.opt detailsCodec "details" fs with
      | none => simp [hc, hm, hd] at hb
      | some d =>
        cases ht : Obj.opt Codec.string "detail" fs with
        | none => simp [hc, hm, hd, ht] at hb
        | some t =>
          simp [hc, hm, hd, ht] at hb
          subst hb
          exact Obj.req_valid hc

/-- The codec of the inner object. -/
def bodyCodec : Codec ApiProblemBody where
  encode := encodeBody
  decode := decodeBody
  valid := validBody
  decode_encode := decodeBody_encodeBody
  valid_of_decode := validBody_of_decode

/-- `ApiProblemSchema`: `z.object({ error: … }).strict().readonly()`. -/
@[aw_spec (ts := "packages/contracts/src/problem.ts#ApiProblemSchema")]
def apiProblemCodec : Codec ApiProblem where
  encode p := .obj (Obj.field bodyCodec "error" p.error)
  decode := Obj.strict ["error"] fun fs => (Obj.req bodyCodec "error" fs).map ApiProblem.mk
  valid p := validBody p.error
  decode_encode := by
    intro ⟨b⟩ h
    simp [Obj.strict, Obj.onlyKeys, Obj.field, Obj.req, lookup, obj?,
      bodyCodec.decode_encode b h]
  valid_of_decode := by
    intro j p h
    obtain ⟨fs, -, -, hb⟩ := Obj.strict_some_keys h
    cases hr : Obj.req bodyCodec "error" fs with
    | none => simp [hr] at hb
    | some b =>
      simp [hr] at hb
      subst hb
      have hv := Obj.req_valid hr
      exact hv

/-! ## `ApiProblemDetailSchema` -/

/-- The RBAC layer's envelope before SDK unit 6 (#238): `{ error: { code, detail } }`. A current
server answers the standard envelope instead; an older deployment still answers this one. -/
@[aw_spec (doc := "docs/sdk/04-api-specification.md#4-conventions")
  (ts := "packages/contracts/src/problem.ts#ApiProblemDetailSchema")]
structure ApiProblemDetail where
  code : String
  detail : String
  deriving DecidableEq, Repr, Inhabited

def encodeDetailBody (d : ApiProblemDetail) : JValue :=
  .obj (Obj.field codeCodec "code" d.code ++ Obj.field Codec.string "detail" d.detail)

def decodeDetailBody : JValue → Option ApiProblemDetail :=
  Obj.strict ["code", "detail"] fun fs => do
    let code ← Obj.req codeCodec "code" fs
    let detail ← Obj.req Codec.string "detail" fs
    pure { code, detail }

private theorem decodeDetailBody_encode (d : ApiProblemDetail) (h : codeCodec.valid d.code = true) :
    decodeDetailBody (encodeDetailBody d) = some d := by
  obtain ⟨code, detail⟩ := d
  simp_all [decodeDetailBody, encodeDetailBody, Obj.strict, Obj.onlyKeys, Obj.field, Obj.req,
    lookup, obj?, codeCodec.decode_encode, string_decode_encode]

private theorem detail_valid_of_decode {j : JValue} {d : ApiProblemDetail}
    (h : decodeDetailBody j = some d) : codeCodec.valid d.code = true := by
  obtain ⟨fs, -, -, hb⟩ := Obj.strict_some_keys h
  cases hc : Obj.req codeCodec "code" fs with
  | none => simp [hc] at hb
  | some c =>
    cases hm : Obj.req Codec.string "detail" fs with
    | none => simp [hc, hm] at hb
    | some m =>
      simp [hc, hm] at hb
      subst hb
      exact Obj.req_valid hc

/-- The codec of the RBAC inner object. -/
def detailBodyCodec : Codec ApiProblemDetail where
  encode := encodeDetailBody
  decode := decodeDetailBody
  valid d := codeCodec.valid d.code
  decode_encode := decodeDetailBody_encode
  valid_of_decode := detail_valid_of_decode

/-- `ApiProblemDetailSchema`: `z.object({ error: … }).strict().readonly()`. -/
@[aw_spec (ts := "packages/contracts/src/problem.ts#ApiProblemDetailSchema")]
def apiProblemDetailCodec : Codec ApiProblemDetail where
  encode d := .obj (Obj.field detailBodyCodec "error" d)
  decode := Obj.strict ["error"] fun fs => Obj.req detailBodyCodec "error" fs
  valid d := codeCodec.valid d.code
  decode_encode := by
    intro d h
    simp [Obj.strict, Obj.onlyKeys, Obj.field, Obj.req, lookup, obj?,
      detailBodyCodec.decode_encode d h]
  valid_of_decode := by
    intro j d h
    obtain ⟨fs, -, -, hb⟩ := Obj.strict_some_keys h
    have hv := Obj.req_valid hb
    exact hv

/-! ## `ApiProblemBareCodeSchema` -/

/-- The bare envelope of `POST /api/runtimes/test` (and of `GET /api/audit-events` before SDK unit
6): `{ error: '<code>', message? }`. -/
@[aw_spec (doc := "docs/sdk/04-api-specification.md#4-conventions")
  (ts := "packages/contracts/src/problem.ts#ApiProblemBareCodeSchema")]
structure ApiProblemBareCode where
  error : String
  /-- `none` when the key is absent. -/
  message : Option String
  deriving DecidableEq, Repr, Inhabited

def decodeBareFields (fs : Fields) : Option ApiProblemBareCode := do
  let error ← Obj.req codeCodec "error" fs
  let message ← Obj.opt Codec.string "message" fs
  pure { error, message }

/-- `ApiProblemBareCodeSchema`: `z.object({ error: min 1, message?: string }).strict().readonly()`. -/
@[aw_spec (ts := "packages/contracts/src/problem.ts#ApiProblemBareCodeSchema")]
def apiProblemBareCodeCodec : Codec ApiProblemBareCode where
  encode b := .obj (Obj.field codeCodec "error" b.error ++ Obj.optField Codec.string "message" b.message)
  decode := Obj.strict ["error", "message"] decodeBareFields
  valid b := codeCodec.valid b.error
  decode_encode := by
    intro ⟨e, m⟩ h
    cases m <;>
      simp_all [decodeBareFields, Obj.strict, Obj.onlyKeys, Obj.field, Obj.optField, Obj.req,
        Obj.opt, lookup, obj?, codeCodec.decode_encode, string_decode_encode]
  valid_of_decode := by
    intro j b h
    obtain ⟨fs, -, -, hb⟩ := Obj.strict_some_keys h
    cases hc : Obj.req codeCodec "error" fs with
    | none => simp [decodeBareFields, hc] at hb
    | some c =>
      cases hm : Obj.opt Codec.string "message" fs with
      | none => simp [decodeBareFields, hc, hm] at hb
      | some m =>
        simp [decodeBareFields, hc, hm] at hb
        subst hb
        exact Obj.req_valid hc

/-! ## The decoders, unfolded -/

theorem apiProblemCodec_decode_eq :
    apiProblemCodec.decode =
      Obj.strict ["error"] fun fs => (Obj.req bodyCodec "error" fs).map ApiProblem.mk := rfl

theorem apiProblemDetailCodec_decode_eq :
    apiProblemDetailCodec.decode = Obj.strict ["error"] fun fs => Obj.req detailBodyCodec "error" fs :=
  rfl

theorem apiProblemBareCodeCodec_decode_eq :
    apiProblemBareCodeCodec.decode = Obj.strict ["error", "message"] decodeBareFields := rfl

/-! ## Normalisation (the SDK's `readProblem`) -/

/-- The standard envelope's body, read from a standard envelope. -/
def readStandard (j : JValue) : Option ApiProblemBody := (apiProblemCodec.decode j).map (·.error)

/-- The older RBAC envelope, `detail` read as `message`. -/
def readDetail (j : JValue) : Option ApiProblemBody :=
  (apiProblemDetailCodec.decode j).map fun d => { code := d.code, message := d.detail, details := none }

/-- The bare envelope, a missing `message` read as `''`. -/
def readBare (j : JValue) : Option ApiProblemBody :=
  (apiProblemBareCodeCodec.decode j).map fun b =>
    { code := b.error, message := b.message.getD "", details := none }

/-- The strict envelopes tried in order: standard, then RBAC detail, then bare; `none` is the
SDK's `unrecognised_error_body` for a body no envelope reads as it stands. -/
@[aw_spec (doc := "docs/sdk/site/guides/errors.mdx#three-envelope-spellings-one-shape")
  (ts := "packages/sdk/src/http.ts#readProblem")]
def normaliseCurrent (j : JValue) : Option ApiProblemBody :=
  Codec.firstOf [readStandard, readDetail, readBare] j

/-- `parseProblemEnvelope`'s pruning: drop the top-level keys outside `top` and, when the
envelope's `error` is an object schema (`inner` is its keys), the keys outside `inner` from an
`error` object. These are exactly the keys Zod names in `unrecognized_keys` issues; dropping none
leaves the body as it was, so a body the strict schema reads is read unchanged. -/
def pruneEnvelope (top : List String) (inner : Option (List String)) : JValue → JValue
  | .obj fs => .obj ((fs.filter fun kv => top.contains kv.1).map fun kv =>
      match kv, inner with
      | ("error", .obj es), some keys => ("error", .obj (es.filter fun e => keys.contains e.1))
      | kv, _ => kv)
  | j => j

/-- `readProblem`: each envelope tried in order on the body pruned of the keys that envelope does
not know; `none` is the SDK's `unrecognised_error_body`. -/
@[aw_spec (doc := "docs/sdk/site/guides/errors.mdx#three-envelope-spellings-one-shape")
  (ts := "packages/sdk/src/http.ts#readProblem")]
def normaliseLenient (j : JValue) : Option ApiProblemBody :=
  Codec.firstOf [readStandard ∘ pruneEnvelope ["error"] (some bodyKeys),
    readDetail ∘ pruneEnvelope ["error"] (some ["code", "detail"]),
    readBare ∘ pruneEnvelope ["error", "message"] none] j

/-- A field a newer server adds beside `error` keeps the code (CF-2). -/
example : normaliseLenient (.obj [("error", encodeBody ⟨"forbidden", "No.", none, none⟩),
    ("requestId", .str "r-1")]) = some ⟨"forbidden", "No.", none, none⟩ := by decide

/-- A field a newer server adds inside `error` keeps the code (CF-2). -/
example : normaliseLenient (.obj [("error", .obj [("code", .str "x"), ("message", .str "y"),
    ("status", .num 400 0)])]) = some ⟨"x", "y", none, none⟩ := by decide

/-- The documented target (SPEC §4): `ApiProblemSchema` on every route, so only the standard
envelope is read. -/
@[aw_spec (doc := "docs/sdk/04-api-specification.md#4-conventions")]
def normaliseTarget (j : JValue) : Option ApiProblemBody := readStandard j

/-! ## `COMMON_PROBLEM_CODES` -/

/-- `CommonProblemCode`: the keys of `COMMON_PROBLEM_CODES`, in the object's key order. -/
@[aw_spec (doc := "docs/sdk/site/guides/errors.mdx#common_problem_codes")
  (ts := "packages/contracts/src/problem.ts#CommonProblemCode")]
inductive CommonProblemCode where
  | unauthenticated
  | forbidden
  | authorisationUndecidable
  | malformedBody
  | invalidBody
  | unsupportedMediaType
  | requestBodyTooLarge
  | internalError
  | serviceUnavailable
  | upstreamFailure
  deriving DecidableEq, Repr, Inhabited

namespace CommonProblemCode

/-- The wire spelling of each code. -/
def toWire : CommonProblemCode → String
  | unauthenticated => "unauthenticated"
  | forbidden => "forbidden"
  | authorisationUndecidable => "authorisation_undecidable"
  | malformedBody => "malformed_body"
  | invalidBody => "invalid_body"
  | unsupportedMediaType => "unsupported_media_type"
  | requestBodyTooLarge => "request_body_too_large"
  | internalError => "internal_error"
  | serviceUnavailable => "service_unavailable"
  | upstreamFailure => "upstream_failure"

instance : WireEnum CommonProblemCode where
  all := [unauthenticated, forbidden, authorisationUndecidable, malformedBody, invalidBody,
    unsupportedMediaType, requestBodyTooLarge, internalError, serviceUnavailable, upstreamFailure]
  toWire := toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by intro a b; cases a <;> cases b <;> decide

/-- `COMMON_PROBLEM_CODES[code]`: the HTTP status each shared code travels under. -/
@[aw_spec (ts := "packages/contracts/src/problem.ts#COMMON_PROBLEM_CODES")]
def status : CommonProblemCode → Nat
  | unauthenticated => 401
  | forbidden => 403
  | authorisationUndecidable => 500
  | malformedBody => 400
  | invalidBody => 400
  | unsupportedMediaType => 415
  | requestBodyTooLarge => 413
  | internalError => 500
  | serviceUnavailable => 503
  | upstreamFailure => 502

end CommonProblemCode

/-- The table in the errors guide, transcribed separately from the code: `(code, status)` rows in
the guide's order. -/
@[aw_spec (doc := "docs/sdk/site/guides/errors.mdx#common_problem_codes")]
def documentedCommonCodes : List (String × Nat) :=
  [("unauthenticated", 401), ("forbidden", 403), ("authorisation_undecidable", 500),
    ("malformed_body", 400), ("invalid_body", 400), ("unsupported_media_type", 415),
    ("request_body_too_large", 413), ("internal_error", 500), ("service_unavailable", 503),
    ("upstream_failure", 502)]

/-- The statuses SPEC §4's "Status" row lists for a failure (4xx rows, and the `5xx` family). -/
@[aw_spec (doc := "docs/sdk/04-api-specification.md#4-conventions")]
def documentedFailureStatus (n : Nat) : Bool :=
  n ∈ [400, 401, 403, 404, 409, 410, 413, 415, 422, 429] || (500 ≤ n && n ≤ 599)

end AgentWorkspace.Contracts.Problem
