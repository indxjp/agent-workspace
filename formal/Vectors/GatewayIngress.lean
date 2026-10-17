import AgentWorkspace.Theorems.Refinement.GatewayIngress
import Vectors.Common

/-!
Vectors for the `gateway-ingress` family.

Three files, each replayed by `tests/formal/gateway-ingress.test.ts` against the **real** TypeScript:

* `routes.json` — one vector per ingress cell: the token verdict, the connection family, the
  protocol, the requested model and the declared tools in, and the decision out. Replayed through
  the real router, the real provider registry and `authenticateGatewayRequest`, with a stub upstream.
* `models.json` — the `GET /v1/models` envelope negotiation, replayed through the real router.
* `usage.json` — one vector per recorded event sequence: the frames in, the counters and the
  settlement out. Replayed through the real extractors and the real metering boundary.
-/

namespace Vectors.GatewayIngress

open Lean AgentWorkspace AgentWorkspace.Authz.RunToken
open AgentWorkspace.Behaviour.GatewayIngress
open AgentWorkspace.Concepts.Usage

private def wf : String := "AgentWorkspace.Theorems.WellFormed.GatewayIngress."
private def nrm : String := "AgentWorkspace.Theorems.Normative.GatewayIngress."
private def inv : String := "AgentWorkspace.Theorems.Invariants.GatewayIngress."
private def adv : String := "AgentWorkspace.Theorems.Adversarial.GatewayIngress."
private def ref : String := "AgentWorkspace.Theorems.Refinement.GatewayIngress."

/-! ## Routes -/

private def familyWire : ConnectionFamily → String
  | .anthropic => "anthropic"
  | .anthropicCompatible => "anthropic-compatible"
  | .openai => "openai"
  | .azureOpenai => "azure-openai"
  | .openaiCompatible => "openai-compatible"

private def toolWire : ToolType → String
  | .function => "function"
  | .custom => "custom"
  | .webSearch => "web_search"
  | .fileSearch => "file_search"
  | .codeInterpreter => "code_interpreter"
  | .imageGeneration => "image_generation"
  | .mcp => "mcp"
  | .computerUsePreview => "computer_use_preview"
  | .shell => "shell"
  | .unnamed => "unnamed"

/-- How the replay should present the run token: the three states the suite can build. -/
inductive TokenState where
  | valid
  | missing
  | expired
  | revoked
  deriving DecidableEq, Repr

private def tokenWire : TokenState → String
  | .valid => "valid"
  | .missing => "missing"
  | .expired => "expired"
  | .revoked => "revoked"

/-- The claims the replay suite mints its fixture token with. -/
private def fixtureClaims : Claims :=
  { toSubject := ⟨"r1", "s1", "w1", "a1", "mc1"⟩, version := 1, tokenId := "t1",
    issuedAt := 0, expiresAt := 300 }

private def verificationFor : TokenState → Verification
  | .expired => .expired
  | .valid | .missing | .revoked => .valid fixtureClaims

private def resolutionFor : TokenState → Resolution
  | .revoked => .revoked
  | .valid | .missing | .expired => .active

private def hasBearerFor : TokenState → Bool
  | .missing => false
  | .valid | .expired | .revoked => true

private def fixtureConnection (family : ConnectionFamily) : Connection :=
  { family := family, credential := "stored-credential", deployment := "prod-deployment" }

/-- The request as the model sees it, for one token state. The claims and the connection settings
are the fixture the replay suite builds; only the fields a vector varies appear in its input. -/
private def requestFor (token : TokenState) (protocol : WireProtocol) (family : ConnectionFamily)
    (model : String) (tools : List ToolType) (hostedToolField background : Bool)
    (vendorStateField : Option String) : Request :=
  { protocol := protocol,
    runToken := "run-token-fixture",
    hasBearer := hasBearerFor token,
    verification := verificationFor token,
    expectedRunId := none,
    resolution := resolutionFor token,
    connection := fixtureConnection family,
    requestedModel := model,
    tools := tools,
    hostedToolField := hostedToolField,
    background := background,
    vendorState := bodyAsksForVendorState ("model" :: vendorStateField.toList),
    stream := true,
    clientHeaders := [] }

private def decisionJson (d : Decision) : Json :=
  match d with
  | .forwarded up => Json.mkObj
    [("forwarded", toJson true),
      ("protocol", toJson (WireEnum.toWire up.protocol)),
      ("model", toJson up.model),
      ("includeUsage", toJson up.includeUsage),
      ("credentialHeader",
        toJson ((up.headers.head?.map Header.name).getD "")),
      ("credential", toJson up.credential)]
  | .answered status code => Json.mkObj
    [("forwarded", toJson false), ("status", toJson status), ("code", toJson code)]

/-- `vendorStateField` is the name of the field the replay should send to ask for vendor-held
conversation or prompt state, because the rule refuses every field in `vendorStateFields` alike and a vector says
which one it sent. -/
private def routeVector (id : String) (token : TokenState) (protocol : WireProtocol)
    (family : ConnectionFamily) (model : String) (tools : List ToolType)
    (hostedToolField background : Bool) (vendorStateField : Option String)
    (witnesses : List String) : Vectors.Vector :=
  let request :=
    requestFor token protocol family model tools hostedToolField background vendorStateField
  { id := id,
    input := Json.mkObj
      [("token", toJson (tokenWire token)),
        ("protocol", toJson (WireEnum.toWire protocol)),
        ("family", toJson (familyWire family)),
        ("model", toJson model),
        ("stream", toJson request.stream),
        ("tools", Json.arr ((tools.map (fun t => Json.str (toolWire t))).toArray)),
        ("webSearchOptions", toJson hostedToolField),
        ("background", toJson background),
        ("vendorStateField",
          match vendorStateField with | none => Json.null | some field => Json.str field)],
    expected := decisionJson (ingressDecision request),
    witnesses := witnesses }

/-- The common case: no hosted-tool field, no `background` and no vendor-side state. -/
private def plainRouteVector (id : String) (token : TokenState) (protocol : WireProtocol)
    (family : ConnectionFamily) (model : String) (tools : List ToolType)
    (witnesses : List String) : Vectors.Vector :=
  routeVector id token protocol family model tools false false none witnesses

private def routeVectors : List Vectors.Vector :=
  -- The happy paths, one per relayed protocol per OpenAI-family connection.
  (([WireProtocol.openaiResponses, .openaiChatCompletions].flatMap fun protocol =>
    [ConnectionFamily.openai, .azureOpenai, .openaiCompatible].map fun family =>
      plainRouteVector s!"forwards-{WireEnum.toWire protocol}-on-{familyWire family}"
        .valid protocol family "gpt-fixture" []
        [wf ++ "decision_is_total_over_protocol_and_family",
          adv ++ "a_forwarded_request_carries_its_own_credential",
          nrm ++ "azure_relays_its_deployment"])) ++
  -- Anthropic-family connections refuse both OpenAI dialects.
  ([WireProtocol.openaiResponses, .openaiChatCompletions].flatMap fun protocol =>
    [ConnectionFamily.anthropic, .anthropicCompatible].map fun family =>
      plainRouteVector s!"refuses-{WireEnum.toWire protocol}-on-{familyWire family}"
        .valid protocol family "gpt-fixture" []
        [nrm ++ "openai_dialect_on_anthropic_family_is_refused"]) ++
  -- The hosted-tool allowlist, one vector per refused type plus the two permitted ones.
  (ToolType.all.map fun tool =>
    plainRouteVector s!"tool-{toolWire tool}" .valid .openaiResponses .openai "gpt-fixture" [tool]
      [nrm ++ "every_hosted_tool_is_refused_on_every_relayed_protocol",
        nrm ++ "sandboxed_tools_are_relayed"]) ++
  -- The same rule applied to the field that asks for a hosted tool without declaring one, and to
  -- `background`, which is refused on the Responses route only.
  ([WireProtocol.openaiResponses, .openaiChatCompletions].flatMap fun protocol =>
    [(true, false), (false, true)].map fun flags =>
      routeVector
        s!"{if flags.1 then "web-search-options" else "background"}-{WireEnum.toWire protocol}"
        .valid protocol .openai "gpt-fixture" [] flags.1 flags.2 none
        [nrm ++ "a_hosted_tool_field_is_refused_on_every_relayed_protocol",
          nrm ++ "a_background_response_is_refused_and_not_forwarded",
          nrm ++ "background_is_refused_only_on_the_responses_route"]) ++
  -- State the vendor holds, in each of the fields that refer to it, on each relayed dialect.
  -- `anthropic-messages` carrying the same field is relayed, which is the last row here.
  (vendorStateFields.flatMap fun field =>
    [WireProtocol.openaiResponses, .openaiChatCompletions].map fun protocol =>
      routeVector s!"vendor-state-{field}-{WireEnum.toWire protocol}"
        .valid protocol .openai "gpt-fixture" [] false false (some field)
        [nrm ++ "vendor_state_is_refused_and_not_forwarded",
          nrm ++ "vendor_state_is_refused_on_every_relayed_cell",
          nrm ++ "every_vendor_state_field_is_refused_on_every_relayed_cell",
          nrm ++ "vendor_state_is_refused_only_on_the_relayed_dialects"]) ++
  [routeVector "vendor-state-previous_response_id-anthropic-messages" .valid .anthropicMessages
      .anthropic "claude-fixture" [] false false (some "previous_response_id")
      [nrm ++ "vendor_state_is_refused_only_on_the_relayed_dialects",
        ref ++ "messages_behaves_identically_on_every_family"]] ++
  -- Authentication, and the model guard.
  [plainRouteVector "token-missing" .missing .openaiResponses .openai "gpt-fixture" []
      [adv ++ "no_protocol_forwards_without_a_bearer"],
    plainRouteVector "token-expired" .expired .openaiResponses .openai "gpt-fixture" []
      [adv ++ "no_protocol_forwards_on_an_expired_token"],
    plainRouteVector "token-revoked" .revoked .openaiChatCompletions .openai "gpt-fixture" []
      [adv ++ "no_protocol_forwards_on_a_revoked_token"],
    plainRouteVector "model-blank" .valid .openaiResponses .openai "   " []
      [nrm ++ "a_blank_model_is_refused"],
    plainRouteVector "anthropic-messages-unchanged" .valid .anthropicMessages .anthropic
      "claude-fixture" [] [ref ++ "messages_behaves_identically_on_every_family"]]

/-! ## Model listing -/

private def formatWire : ModelFormat → String
  | .anthropic => "anthropic"
  | .openai => "openai"

/-- `anthropicVersion` is whether the replayed request carries the header the Anthropic SDK always
sends. `family` still varies because it decides which adapter serves the catalogue, but by D6 it
must not decide the envelope. -/
private def listingVector (family : ConnectionFamily) (anthropicVersion : Bool)
    (query header : Option ModelFormat) : Vectors.Vector :=
  { id := s!"models-{familyWire family}-{if anthropicVersion then "anthropic-sdk" else "openai-sdk"}-{(query.map formatWire).getD "none"}-{(header.map formatWire).getD "none"}",
    input := Json.mkObj
      [("family", toJson (familyWire family)),
        ("anthropicVersion", toJson anthropicVersion),
        ("query", match query with | none => Json.null | some f => Json.str (formatWire f)),
        ("header", match header with | none => Json.null | some f => Json.str (formatWire f))],
    expected := Json.mkObj
      [("format", toJson (formatWire (modelListingFormat anthropicVersion query header)))],
    witnesses :=
      [nrm ++ "model_listing_defaults_to_the_client_signal",
        nrm ++ "an_anthropic_sdk_request_keeps_its_envelope_on_every_family",
        nrm ++ "model_listing_overrides_are_ordered"] }

private def listingVectors : List Vectors.Vector :=
  -- Every family × every client, with no override: the envelope must track the client alone.
  (ConnectionFamily.all.flatMap fun family =>
    [true, false].map fun anthropicVersion => listingVector family anthropicVersion none none) ++
    [listingVector .openai true (some .openai) none,
      listingVector .openai false (some .anthropic) none,
      listingVector .openai false none (some .anthropic),
      listingVector .anthropic true (some .openai) none,
      listingVector .openai false (some .anthropic) (some .openai)]

/-! ## Usage -/

private def countersJson (c : Counters) : Json :=
  Json.mkObj
    [("inputTokens", toJson c.inputTokens), ("outputTokens", toJson c.outputTokens),
      ("cacheReadInputTokens", toJson c.cacheReadInputTokens),
      ("cacheCreationInputTokens", toJson c.cacheCreationInputTokens),
      ("toolCalls", toJson c.toolCalls)]

private def settlementWire : Settlement → String
  | .recorded _ true => "recorded"
  | .recorded _ false => "unmetered"
  | .failed => "failed"

/-- The settlement depends on the dialect as well as on the measurement (ADR-0068 D9), so the
protocol the vector replays on is what decides its `settlement` field. -/
private def measurementJson (protocol : WireProtocol) (m : Measurement) : Json :=
  Json.mkObj
    [("counters", countersJson m.counters), ("metered", toJson m.metered),
      ("completed", toJson m.completed),
      ("settlement", toJson (settlementWire (settle protocol m)))]

/-- An Anthropic frame, as the replay suite reconstructs the SSE payload from it. -/
private def anthropicFrameJson : AnthropicFrame → Json
  | .usageSnapshot i o cr cc => Json.mkObj
    [("kind", "usage"), ("inputTokens", toJson i), ("outputTokens", toJson o),
      ("cacheReadInputTokens", toJson cr), ("cacheCreationInputTokens", toJson cc)]
  | .toolBlockStart => Json.mkObj [("kind", "toolBlockStart")]
  | .stop => Json.mkObj [("kind", "stop")]

private def responsesFrameJson : ResponsesFrame → Json
  | .created => Json.mkObj [("kind", "created")]
  | .functionCallDone id => Json.mkObj [("kind", "functionCallDone"), ("itemId", toJson id)]
  | .terminal i o cached items => Json.mkObj
    [("kind", "terminal"), ("inputTokens", toJson i), ("outputTokens", toJson o),
      ("cachedTokens", toJson cached),
      ("items", Json.arr ((items.map Json.str).toArray))]

private def chatFrameJson : ChatFrame → Json
  | .toolCallDelta choice call => Json.mkObj
    [("kind", "toolCallDelta"), ("choiceIndex", toJson choice), ("callIndex", toJson call)]
  | .finish => Json.mkObj [("kind", "finish")]
  | .usage prompt completion cached => Json.mkObj
    [("kind", "usage"), ("promptTokens", toJson prompt),
      ("completionTokens", toJson completion), ("cachedTokens", toJson cached)]

private def usageVector (id : String) (protocol : WireProtocol) (frames : List Json)
    (m : Measurement) (witnesses : List String) : Vectors.Vector :=
  { id := id,
    input := Json.mkObj
      [("protocol", toJson (WireEnum.toWire protocol)), ("frames", Json.arr frames.toArray)],
    expected := measurementJson protocol m,
    witnesses := witnesses }

private def anthropicVector (id : String) (frames : List AnthropicFrame)
    (witnesses : List String) : Vectors.Vector :=
  usageVector id .anthropicMessages (frames.map anthropicFrameJson)
    (extractAnthropic frames) witnesses

private def responsesVector (id : String) (frames : List ResponsesFrame)
    (witnesses : List String) : Vectors.Vector :=
  usageVector id .openaiResponses (frames.map responsesFrameJson)
    (extractResponses frames) witnesses

private def chatVector (id : String) (frames : List ChatFrame)
    (witnesses : List String) : Vectors.Vector :=
  usageVector id .openaiChatCompletions (frames.map chatFrameJson) (extractChat frames) witnesses

private def usageVectors : List Vectors.Vector :=
  [anthropicVector "anthropic-complete"
      [.usageSnapshot 12 0 4 2, .toolBlockStart, .usageSnapshot 12 7 4 2, .stop]
      [ref ++ "anthropic_metering_is_unchanged"],
    anthropicVector "anthropic-truncated" [.usageSnapshot 12 0 4 2]
      [inv ++ "anthropic_extraction_is_prefix_monotone"],
    anthropicVector "anthropic-no-usage" [.toolBlockStart]
      [ref ++ "an_anthropic_response_without_usage_still_fails"],
    -- The shape every real Anthropic 200 without usage has: finished, and still a failure. The
    -- `unavailable` outcome is the two OpenAI dialects' alone (ADR-0068 D9).
    anthropicVector "anthropic-stopped-without-usage" [.toolBlockStart, .stop]
      [ref ++ "an_anthropic_response_without_usage_still_fails",
        nrm ++ "anthropic_never_settles_unmetered_as_unavailable",
        nrm ++ "the_unavailable_outcome_belongs_to_the_relayed_dialects"],
    anthropicVector "anthropic-empty" []
      [wf ++ "empty_frames_measure_zero"],
    responsesVector "responses-complete"
      [.created, .functionCallDone "fc_1", .terminal 100 40 30 ["fc_1"]]
      [inv ++ "responses_settlement_has_a_measured_witness",
        inv ++ "responses_cached_prefix_is_charged_once"],
    responsesVector "responses-repeated-item"
      [.functionCallDone "fc_1", .functionCallDone "fc_1", .terminal 10 5 0 ["fc_1"]]
      [inv ++ "a_repeated_function_call_is_counted_once"],
    responsesVector "responses-two-items"
      [.functionCallDone "fc_1", .functionCallDone "fc_2", .terminal 10 5 0 ["fc_1", "fc_2"]]
      [inv ++ "a_repeated_function_call_is_counted_once"],
    responsesVector "responses-all-cached" [.terminal 40 5 40 []]
      [inv ++ "responses_cached_prefix_is_charged_once"],
    responsesVector "responses-incomplete-terminal" [.created, .terminal 9 3 0 []]
      [inv ++ "responses_settlement_has_a_measured_witness"],
    responsesVector "responses-truncated" [.created, .functionCallDone "fc_1"]
      [inv ++ "responses_without_a_terminal_frame_is_a_failure"],
    responsesVector "responses-empty" []
      [wf ++ "empty_frames_measure_zero"],
    chatVector "chat-complete"
      [.toolCallDelta 0 0, .toolCallDelta 0 0, .finish, .usage 100 40 30]
      [inv ++ "a_fragmented_tool_call_is_counted_once",
        inv ++ "chat_cached_prefix_is_charged_once"],
    chatVector "chat-three-calls"
      [.toolCallDelta 0 0, .toolCallDelta 0 1, .toolCallDelta 1 0, .finish, .usage 10 5 0]
      [inv ++ "a_fragmented_tool_call_is_counted_once"],
    chatVector "chat-finished-without-usage" [.toolCallDelta 0 0, .finish]
      [inv ++ "chat_unmetered_settlement_has_a_witness",
        inv ++ "chat_without_a_usage_chunk_measures_no_tokens"],
    chatVector "chat-truncated" [.toolCallDelta 0 0]
      [inv ++ "chat_extraction_is_prefix_monotone",
        inv ++ "chat_without_a_usage_chunk_measures_no_tokens"],
    chatVector "chat-empty" []
      [wf ++ "empty_frames_measure_zero"]]

/-! ## The ingress table (ADR-0113 C16) -/

private def ingressId : Ingress → String
  | .model .messages => "messages"
  | .model .countTokens => "count-tokens"
  | .model .responses => "responses"
  | .model .chatCompletions => "chat-completions"
  | .model .models => "models"
  | .model .health => "health"
  | .tool => "tool"
  | .toolSandbox => "tool-sandbox"
  | .toolSandboxEndpoint => "tool-sandbox-endpoint"

private def ingressVector (ingress : Ingress) : Vectors.Vector :=
  { id := "ingress/" ++ ingressId ingress,
    input := Json.mkObj [("path", toJson ingress.path)],
    expected := Json.mkObj [("metered", toJson ingress.metered),
      ("resolvesModelKey", toJson ingress.resolvesModelKey)],
    witnesses := [adv ++ "ingress_paths_are_the_spec_contract"] ++
      match ingress with
      | .tool | .toolSandbox | .toolSandboxEndpoint =>
        [adv ++ "tool_ingress_is_unmetered", adv ++ "tool_ingress_never_resolves_a_model_key"]
      | .model _ => [adv ++ "model_ingress_is_route"] }

private def ingressVectors : List Vectors.Vector := Ingress.all.map ingressVector

def files : List (String × Json) :=
  [("routes.json", Vectors.file "gateway-ingress"
      "The ingress decision for each token verdict, connection family, protocol and tool list"
      routeVectors),
    ("models.json", Vectors.file "gateway-ingress"
      "The GET /v1/models envelope negotiated from the connection family and its two overrides"
      listingVectors),
    ("usage.json", Vectors.file "gateway-ingress"
      "Per-protocol usage extraction and settlement over a recorded frame sequence"
      usageVectors),
    ("tools.json", Vectors.file "gateway-ingress"
      "The application's route table in order: whether each path is metered and resolves the model key"
      ingressVectors)]

end Vectors.GatewayIngress
