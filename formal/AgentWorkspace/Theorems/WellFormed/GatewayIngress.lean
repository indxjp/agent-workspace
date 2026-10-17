import AgentWorkspace.Behaviour.GatewayIngress
import AgentWorkspace.Trace.Spec

/-!
T0 for `gateway-ingress`: the route table is well shaped, the ingress decision is total over the
protocol × connection-family product, and every refusal it can produce carries a stable code.
-/

namespace AgentWorkspace.Theorems.WellFormed.GatewayIngress

open AgentWorkspace AgentWorkspace.Authz.RunToken
open AgentWorkspace.Behaviour.GatewayIngress
open AgentWorkspace.Concepts.Usage

/-! ## The route table -/

/-- The six routes of spec §9 have six distinct paths. -/
@[aw_spec (tier := T0) (doc := "docs/spec.md#9-model-gateway")
  (ts := "packages/gateway/src/router.ts#ROUTES")]
theorem route_paths_are_distinct : (Route.all.map Route.path).Nodup := by decide

/-- The route table is exactly §9's fenced block, in the order the specification prints it. -/
@[aw_spec (tier := T0) (doc := "docs/spec.md#9-model-gateway")
  (ts := "packages/gateway/src/router.ts#ROUTES")]
theorem route_table_is_the_spec_contract :
    Route.all.map Route.path =
      ["/v1/messages", "/v1/messages/count_tokens", "/v1/responses", "/v1/chat/completions",
        "/v1/models", "/health"] := by decide

/-- Exactly three routes carry a model turn, and each names a different dialect. -/
@[aw_spec (tier := T0) (ts := "packages/gateway/src/auth.ts#meteredProtocol")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d5--metering-is-per-protocol-incremental-and-corrects-two-openai-conventions")]
theorem metered_routes_name_distinct_protocols :
    (Route.all.filterMap routeProtocol?).length = 3 ∧
      (Route.all.filterMap routeProtocol?) =
        [.anthropicMessages, .openaiResponses, .openaiChatCompletions] := by decide

/-- Every wire protocol is reachable through exactly one route. -/
@[aw_spec (tier := T0) (ts := "packages/gateway/src/router.ts#RELAYED_PROTOCOLS")]
theorem every_protocol_has_one_route (protocol : WireProtocol) :
    (Route.all.filter fun route => routeProtocol? route == some protocol).length = 1 := by
  cases protocol <;> decide

/-! ## The closed sets -/

/-- `wire_protocol`'s three values round-trip through their wire spellings. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/run-usage-records.ts#wireProtocols")
  (ts := "packages/gateway/src/types.ts#WireProtocol")]
theorem wire_protocol_round_trips (protocol : WireProtocol) :
    WireEnum.ofWire? (WireEnum.toWire protocol) = some protocol :=
  WireEnum.ofWire?_toWire protocol

/-- Exactly the two OpenAI dialects are relayed; Anthropic Messages is translated. -/
@[aw_spec (tier := T0)
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d1--two-new-ingress-routes-and-they-are-passthrough")
  (ts := "packages/gateway/src/providers/passthrough.ts#OPENAI_WIRE_PROTOCOLS")]
theorem exactly_two_protocols_are_relayed :
    (WireEnum.all (α := WireProtocol)).filter WireProtocol.isRelayed =
      [.openaiResponses, .openaiChatCompletions] := by decide

/-- Exactly two of the ten tool types are relayed, so eight fail closed. -/
@[aw_spec (tier := T0)
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d4--hosted-tools-are-refused-by-a-closed-allowlist")
  (ts := "packages/gateway/src/providers/passthrough.ts#unrelayableToolType")]
theorem exactly_two_tool_types_are_relayable :
    ToolType.all.filter ToolType.isRelayable = [.function, .custom] ∧
      (ToolType.all.filter (!ToolType.isRelayable ·)).length = 8 := by decide

/-! ## Totality of the decision -/

/-- A request that passes authentication, names a model and declares no tool. Every T0 statement
below varies one field of it, so the decision's totality is a statement about the whole product. -/
def clean (protocol : WireProtocol) (family : ConnectionFamily) : Request :=
  { protocol := protocol,
    runToken := "the-callers-run-token",
    hasBearer := true,
    verification := .valid
      { toSubject := ⟨"r1", "s1", "w1", "a1", "mc1"⟩, version := 1, tokenId := "t1",
        issuedAt := 0, expiresAt := 300 },
    expectedRunId := none,
    resolution := .active,
    connection := { family := family, credential := "stored-credential", deployment := "dep" },
    requestedModel := "a-model",
    tools := [],
    hostedToolField := false,
    background := false,
    vendorState := false,
    stream := false,
    clientHeaders := [] }

/-- The decision is total over the protocol × family product: every one of the fifteen cells is
either a forward or a refusal, and never both. -/
@[aw_spec (tier := T0) (ts := "packages/gateway/src/router.ts#forwardProtocol")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d2--the-protocol-rule-is-a-function-of-the-connection-family")]
theorem decision_is_total_over_protocol_and_family (protocol : WireProtocol)
    (family : ConnectionFamily) :
    (ingressDecision (clean protocol family)).forwardedUpstream = family.speaks protocol := by
  cases protocol <;> cases family <;> decide

/-- The stable codes the ingress decision can refuse with: the seven `authenticateGatewayRequest`
already publishes, plus the four this unit adds. -/
@[aw_spec (ts := "packages/gateway/src/auth.ts#authenticateGatewayRequest")
  (ts := "packages/gateway/src/providers/passthrough.ts#refusal")]
def ingressRefusalCodes : List String :=
  ["token_missing", "token_invalid", "token_expired", "token_run_mismatch", "token_revoked",
    "run_deleted", "run_not_found", "protocol_not_supported_for_connection",
    "invalid_request_error", "hosted_tool_not_permitted", "background_not_supported",
    "vendor_state_not_permitted"]

/-- Every code `authenticate` denies with is one of the seven it publishes. -/
private theorem authenticate_deny_code_is_declared {hasBearer : Bool} {v : Verification}
    {expected : Option String} {res : Resolution} {status : Nat} {code : String}
    (h : authenticate hasBearer v expected res = .deny status code) :
    code ∈ ingressRefusalCodes := by
  unfold authenticate at h
  repeat' split at h
  all_goals first
    | (cases h; decide)
    | cases h
    | simp_all

/-- Every refusal carries a non-empty code drawn from the declared list, whatever the request: a
request is either forwarded or refused with something a client can branch on. -/
@[aw_spec (tier := T0) (ts := "packages/gateway/src/providers/passthrough.ts#refusal")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d2--the-protocol-rule-is-a-function-of-the-connection-family")]
theorem every_refusal_carries_a_declared_code (r : Request) :
    (ingressDecision r).forwardedUpstream = true ∨
      refusalCode (ingressDecision r) ∈ ingressRefusalCodes := by
  unfold ingressDecision
  cases hauth : authenticate r.hasBearer r.verification r.expectedRunId r.resolution with
  | allow =>
    by_cases hspeaks : (!r.connection.family.speaks r.protocol) = true
    · exact Or.inr (by simp [hspeaks, refusalCode, ingressRefusalCodes])
    · by_cases hmodel : Text.isBlank r.requestedModel = true
      · exact Or.inr (by simp [hspeaks, hmodel, refusalCode, ingressRefusalCodes])
      · by_cases htools : asksForHostedTool r = true
        · exact Or.inr (by simp [hspeaks, hmodel, htools, refusalCode, ingressRefusalCodes])
        · by_cases hbg : asksForUnreachableBackground r = true
          · exact Or.inr
              (by simp [hspeaks, hmodel, htools, hbg, refusalCode, ingressRefusalCodes])
          · by_cases hstate : asksForVendorState r = true
            · exact Or.inr
                (by simp [hspeaks, hmodel, htools, hbg, hstate, refusalCode, ingressRefusalCodes])
            · exact Or.inl
                (by simp [hspeaks, hmodel, htools, hbg, hstate, Decision.forwardedUpstream])
  | deny status code =>
    exact Or.inr (by simpa [refusalCode] using authenticate_deny_code_is_declared hauth)

/-- No declared refusal code is blank, so a client always has something to branch on. -/
@[aw_spec (tier := T0) (ts := "packages/gateway/src/providers/passthrough.ts#refusal")]
theorem declared_refusal_codes_are_non_empty :
    ingressRefusalCodes.all (fun code => !code.isEmpty) = true ∧
      ingressRefusalCodes.Nodup := by decide

/-- A forwarded request is the only shape that carries an upstream request; a refusal carries
none, so nothing can be read out of a refusal by mistake. -/
@[aw_spec (tier := T0) (ts := "packages/gateway/src/router.ts#forwardProtocol")]
theorem refusal_carries_no_upstream_request (status : Nat) (code : String) :
    (Decision.answered status code).forwardedUpstream = false := rfl

/-! ## Measurement -/

/-- Nothing observed measures nothing: three extractors, one zero. -/
@[aw_spec (tier := T0) (ts := "packages/gateway/src/usage/index.ts#createUsageAccumulator")]
theorem empty_frames_measure_zero :
    extractAnthropic [] = Measurement.zero ∧
      extractResponses [] = Measurement.zero ∧
      extractChat [] = Measurement.zero := by decide

/-- A measurement's `metered` and `completed` flags are independent, and `settle` reads both — and,
on an unmetered response, the protocol as well: all twelve combinations of the two flags with the
three dialects are reachable and named. -/
@[aw_spec (tier := T0) (ts := "packages/gateway/src/auth.ts#recordResponseUsage")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d9--no-sixth-accounting-state-is-invented")]
theorem settlement_is_total_over_the_two_flags (protocol : WireProtocol)
    (metered completed : Bool) :
    settledAccounting (settle protocol ⟨Counters.zero, metered, completed⟩) =
      (if metered then .complete
        else if completed && protocol.isRelayed then .unavailable else .failed) := by
  cases protocol <;> cases metered <;> cases completed <;> decide

end AgentWorkspace.Theorems.WellFormed.GatewayIngress
