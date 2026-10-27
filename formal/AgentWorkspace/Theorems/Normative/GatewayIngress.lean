import AgentWorkspace.Theorems.WellFormed.GatewayIngress

/-!
T1 for `gateway-ingress`: the refusals ADR-0068 requires, the relay rules it requires, and the
model-listing negotiation it decides. Every statement here is something the specification says the
gateway must do, rather than a property of the model's shape.
-/

namespace AgentWorkspace.Theorems.Normative.GatewayIngress

open AgentWorkspace AgentWorkspace.Authz.RunToken
open AgentWorkspace.Behaviour.GatewayIngress
open AgentWorkspace.Concepts.Usage
open AgentWorkspace.Theorems.WellFormed.GatewayIngress (clean)

/-! ## Refusals: nothing is forwarded in either case -/

/-- A Responses request asking for a vendor-hosted tool is refused `hosted_tool_not_permitted`, and
nothing is sent upstream. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d4--hosted-tools-are-refused-by-a-closed-allowlist")
  (ts := "packages/gateway/src/providers/passthrough.ts#unrelayableToolType")]
theorem hosted_tool_is_refused_and_not_forwarded (family : ConnectionFamily) (tool : ToolType)
    (hopen : family.isOpenAIFamily = true) (hhosted : tool.isRelayable = false) :
    ingressDecision { clean .openaiResponses family with tools := [tool] } =
      .answered 400 "hosted_tool_not_permitted" := by
  cases family <;> cases tool <;> revert hopen hhosted <;> decide +kernel

/-- Every one of the eight refused tool types is refused on both relayed protocols, with nothing
forwarded. The witness for the theorem above, spelled out cell by cell. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d4--hosted-tools-are-refused-by-a-closed-allowlist")
  (ts := "packages/gateway/src/providers/passthrough.ts#unrelayableToolType")]
theorem every_hosted_tool_is_refused_on_every_relayed_protocol :
    (ToolType.all.filter (!ToolType.isRelayable ·)).all (fun tool =>
      [WireProtocol.openaiResponses, .openaiChatCompletions].all fun protocol =>
        ingressDecision { clean protocol .openai with tools := [tool] } ==
          .answered 400 "hosted_tool_not_permitted") = true := by decide +kernel

/-- The other way a request can ask for vendor-hosted execution is refused with the same code: Chat
Completions turns on OpenAI's hosted web search through a top-level `web_search_options` rather than
a `tools` entry, so a request declaring no tool at all is still refused. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d4--hosted-tools-are-refused-by-a-closed-allowlist")
  (ts := "packages/gateway/src/providers/passthrough.ts#hostedToolField")]
theorem a_hosted_tool_field_is_refused_on_every_relayed_protocol :
    [WireProtocol.openaiResponses, .openaiChatCompletions].all (fun protocol =>
      [ConnectionFamily.openai, .azureOpenai, .openaiCompatible].all fun family =>
        ingressDecision { clean protocol family with hostedToolField := true } ==
          .answered 400 "hosted_tool_not_permitted") = true := by decide +kernel

/-- A relayable tool is relayed: the refusal is about where a tool runs, not about tools. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d4--hosted-tools-are-refused-by-a-closed-allowlist")
  (ts := "packages/gateway/src/providers/passthrough.ts#unrelayableToolType")]
theorem sandboxed_tools_are_relayed :
    (ingressDecision { clean .openaiResponses .openai with
      tools := [.function, .custom] }).forwardedUpstream = true := by decide +kernel

/-- An OpenAI dialect on an Anthropic-family connection is refused
`protocol_not_supported_for_connection`, and nothing is sent upstream. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d2--the-protocol-rule-is-a-function-of-the-connection-family")
  (ts := "packages/gateway/src/providers/passthrough.ts#protocolNotSupported")]
theorem openai_dialect_on_anthropic_family_is_refused (protocol : WireProtocol)
    (family : ConnectionFamily) (hrelayed : protocol.isRelayed = true)
    (hanthropic : family.isOpenAIFamily = false) :
    ingressDecision (clean protocol family) =
      .answered 400 "protocol_not_supported_for_connection" := by
  cases protocol <;> cases family <;> revert hrelayed hanthropic <;> decide +kernel

/-- The protocol refusal is decided before the tool rule, so an Anthropic-family connection asking
for a hosted tool is still told which of the two things is wrong first — and, either way, nothing
leaves the process. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d2--the-protocol-rule-is-a-function-of-the-connection-family")
  (ts := "packages/gateway/src/router.ts#forwardProtocol")]
theorem protocol_refusal_precedes_the_tool_rule :
    ingressDecision { clean .openaiResponses .anthropic with tools := [.webSearch] } =
      .answered 400 "protocol_not_supported_for_connection" := by decide +kernel

/-- Anthropic Messages is accepted on every connection family: this unit adds ingress, it does not
narrow the ingress that existed. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d2--the-protocol-rule-is-a-function-of-the-connection-family")
  (ts := "packages/gateway/src/router.ts#createMessage")]
theorem anthropic_messages_is_accepted_by_every_family (family : ConnectionFamily) :
    (ingressDecision (clean .anthropicMessages family)).forwardedUpstream = true := by
  cases family <;> decide +kernel

/-- A body naming no model is refused before anything is relayed. -/
@[aw_spec (tier := T1) (ts := "packages/gateway/src/router.ts#GatewayRequestSchema")]
theorem a_blank_model_is_refused :
    ingressDecision { clean .openaiResponses .openai with requestedModel := "   " } =
      .answered 400 "invalid_request_error" := by decide +kernel

/-- `background: true` on `/v1/responses` is refused `background_not_supported`, with nothing sent
upstream. Spec §9 publishes no route that retrieves a backgrounded response, so relaying one would
spend the run's tokens on a turn no route could ever meter; the rule is to refuse, not to emulate. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d4--hosted-tools-are-refused-by-a-closed-allowlist")
  (ts := "packages/gateway/src/providers/passthrough.ts#isUnreachableBackgroundRequest")]
theorem a_background_response_is_refused_and_not_forwarded (family : ConnectionFamily)
    (hopen : family.isOpenAIFamily = true) :
    ingressDecision { clean .openaiResponses family with background := true } =
      .answered 400 "background_not_supported" := by
  cases family <;> revert hopen <;> decide +kernel

/-- And only there: `background` is a Responses field, so a Chat Completions request carrying it is
relayed unchanged rather than refused for a rule that does not apply to it. -/
@[aw_spec (tier := T1)
  (ts := "packages/gateway/src/providers/passthrough.ts#isUnreachableBackgroundRequest")]
theorem background_is_refused_only_on_the_responses_route :
    (WireEnum.all (α := WireProtocol)).all (fun protocol =>
      (refusalCode (ingressDecision { clean protocol .openai with background := true }) ==
        "background_not_supported") == (protocol == .openaiResponses)) = true := by decide +kernel

/-- A request resuming conversation state the vendor holds is refused `vendor_state_not_permitted`,
with nothing sent upstream. The state lives outside the platform's session boundary and outside
`session_transcripts`, keyed by an id the platform never sees, so a run that learned another run's id
could resume its context through the shared credential — a capability the platform can neither see
nor account for, which is the same reason `background` is refused (ADR-0068 D10). -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d10--vendor-side-conversation-state-is-refused-and-store-is-relayed-false")
  (ts := "packages/gateway/src/providers/passthrough.ts#vendorStateField")]
theorem vendor_state_is_refused_and_not_forwarded (protocol : WireProtocol)
    (family : ConnectionFamily) (hrelayed : protocol.isRelayed = true)
    (hopen : family.isOpenAIFamily = true) :
    ingressDecision { clean protocol family with vendorState := true } =
      .answered 400 "vendor_state_not_permitted" := by
  cases protocol <;> cases family <;> revert hrelayed hopen <;> decide +kernel

/-- On every relayed protocol and every OpenAI-family connection, and with nothing forwarded. The
witness for the theorem above, spelled out cell by cell. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d10--vendor-side-conversation-state-is-refused-and-store-is-relayed-false")
  (ts := "packages/gateway/src/providers/passthrough.ts#vendorStateField")]
theorem vendor_state_is_refused_on_every_relayed_cell :
    [WireProtocol.openaiResponses, .openaiChatCompletions].all (fun protocol =>
      [ConnectionFamily.openai, .azureOpenai, .openaiCompatible].all fun family =>
        (ingressDecision { clean protocol family with vendorState := true } ==
          .answered 400 "vendor_state_not_permitted") &&
          !(ingressDecision { clean protocol family with
            vendorState := true }).forwardedUpstream) = true := by decide +kernel

/-- And only there: the refusal is the relay's rule, so an `anthropic-messages` request carrying the
same field is translated exactly as it was before this decision existed. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d10--vendor-side-conversation-state-is-refused-and-store-is-relayed-false")
  (ts := "packages/gateway/src/providers/passthrough.ts#createWireProtocolForwarder")]
theorem vendor_state_is_refused_only_on_the_relayed_dialects :
    (WireEnum.all (α := WireProtocol)).all (fun protocol =>
      (refusalCode (ingressDecision { clean protocol .openai with vendorState := true }) ==
        "vendor_state_not_permitted") == protocol.isRelayed) = true := by decide +kernel

/-- A stored `prompt` reference is vendor-held state like the other two: the three fields that
refer to it are exactly `previous_response_id`, `conversation` and `prompt`, and a body carrying any
one of them — `prompt` included, whose stored object brings its own instructions and tools — is
refused `vendor_state_not_permitted` on every relayed protocol and every OpenAI-family connection,
with nothing forwarded (ADR-0068 D10). -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d10--vendor-side-conversation-state-is-refused-and-store-is-relayed-false")
  (ts := "packages/gateway/src/providers/passthrough.ts#VENDOR_STATE_FIELDS")]
theorem every_vendor_state_field_is_refused_on_every_relayed_cell :
    vendorStateFields = ["previous_response_id", "conversation", "prompt"] ∧
      vendorStateFields.all (fun field =>
        [WireProtocol.openaiResponses, .openaiChatCompletions].all fun protocol =>
          [ConnectionFamily.openai, .azureOpenai, .openaiCompatible].all fun family =>
            let r := { clean protocol family with
              vendorState := bodyAsksForVendorState ["model", field] }
            (ingressDecision r == .answered 400 "vendor_state_not_permitted") &&
              !(ingressDecision r).forwardedUpstream) = true := by decide +kernel

/-- Only a listed field asks: a body that keeps its context and instructions in the request — its
`input`, `instructions`, `tools` and even an explicit `store` — does not ask for vendor-held state. -/
@[aw_spec (tier := T1) (ts := "packages/gateway/src/providers/passthrough.ts#vendorStateField")]
theorem a_self_contained_body_does_not_ask_for_vendor_state :
    bodyAsksForVendorState ["model", "input", "instructions", "tools", "store", "stream"] = false ∧
      bodyAsksForVendorState ["model", "messages", "stream_options"] = false := by decide +kernel

/-- The hosted-tool and background rules are still decided first, so a request that breaks two rules
is told about the same one it was told about before this decision existed. -/
@[aw_spec (tier := T1) (ts := "packages/gateway/src/providers/passthrough.ts#createWireProtocolForwarder")]
theorem the_earlier_refusals_precede_the_vendor_state_rule :
    ingressDecision { clean .openaiResponses .openai with
        vendorState := true, tools := [.webSearch] } =
      .answered 400 "hosted_tool_not_permitted" ∧
    ingressDecision { clean .openaiResponses .openai with
        vendorState := true, background := true } =
      .answered 400 "background_not_supported" := by decide +kernel

/-! ## The relay -/

/-- Every relayed body carries `store: false`, on the Responses API and on Chat Completions alike:
injecting the field the client omitted and overwriting the `true` it sent are the same rule, because
a stored turn is retained at the vendor under an id the platform never sees; only the translated
`anthropic-messages` body is left as the client wrote it (ADR-0068 D10). -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d10--vendor-side-conversation-state-is-refused-and-store-is-relayed-false")
  (ts := "packages/gateway/src/providers/passthrough.ts#relayedBody")]
theorem responses_always_relays_store_false :
    [none, some true, some false].all (fun clientStore =>
      relayedStore .openaiResponses clientStore == some false) = true ∧
      [none, some true, some false].all (fun clientStore =>
        relayedStore .openaiChatCompletions clientStore == some false) = true ∧
      [none, some true, some false].all (fun clientStore =>
        relayedStore .anthropicMessages clientStore == clientStore) = true := by decide +kernel

/-- The gateway sets `stream_options.include_usage` on a streamed Chat Completions body even when
the client omitted it, because the upstream otherwise reports no usage at all. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d5--metering-is-per-protocol-incremental-and-corrects-two-openai-conventions")
  (ts := "packages/gateway/src/providers/passthrough.ts#relayedBody")]
theorem streamed_chat_completions_requests_usage (r : Request)
    (hstream : r.stream = true) (hprotocol : r.protocol = .openaiChatCompletions)
    (up : UpstreamRequest) (h : ingressDecision r = .forwarded up) :
    up.includeUsage = true := by
  unfold ingressDecision at h
  split at h
  · cases h
  · repeat' split at h
    · cases h
    · cases h
    · cases h
    · cases h
    · cases h
    · cases h; simp [injectsIncludeUsage, hstream, hprotocol]

/-- It is never set on a Responses body, which has no such field. -/
@[aw_spec (tier := T1) (ts := "packages/gateway/src/providers/passthrough.ts#relayedBody")]
theorem responses_requests_are_not_given_stream_options (family : ConnectionFamily) :
    (ingressDecision { clean .openaiResponses family with stream := true } ==
      .forwarded
        { protocol := .openaiResponses,
          credential := "stored-credential",
          model := relayedModel { clean .openaiResponses family with stream := true },
          includeUsage := false,
          headers := upstreamHeaders family "stored-credential" [] }) =
      family.isOpenAIFamily := by
  cases family <;> decide +kernel

/-- Azure relays its deployment, not the client's model; every other family relays the client's
own choice (ADR-0068 D8). -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d8--model-enforcement-mirrors-today-the-acceptance-criterion-is-amended")
  (ts := "packages/gateway/src/providers/azure-openai.ts#createAzureOpenAIProvider")]
theorem azure_relays_its_deployment (r : Request) :
    relayedModel r =
      (if r.connection.family == .azureOpenai then r.connection.deployment
        else r.requestedModel) := by
  unfold relayedModel ConnectionFamily.pinsModel
  cases r.connection.family <;> simp

/-- The substituted credential is the first header of every relayed request, in the scheme its
family reads: three schemes, one per vendor, and never the caller's own `authorization`. -/
@[aw_spec (tier := T1) (ts := "packages/gateway/src/providers/passthrough.ts#upstreamHeaders")]
theorem the_credential_header_follows_the_family (family : ConnectionFamily) :
    (upstreamHeaders family "k" []).head? = some ⟨family.credentialHeader, "k"⟩ ∧
      (upstreamHeaders .openai "k" []).head? = some ⟨"authorization", "k"⟩ ∧
      (upstreamHeaders .azureOpenai "k" []).head? = some ⟨"api-key", "k"⟩ ∧
      (upstreamHeaders .anthropic "k" []).head? = some ⟨"x-api-key", "k"⟩ := by
  cases family <;> decide +kernel

/-! ## Model listing -/

/-- With no override, the envelope follows the client's own `anthropic-version` header: an Anthropic
SDK request keeps the envelope Claude Code depends on, and a request without it — which is every
OpenAI SDK request — gets the OpenAI shape. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d6--get-v1models-negotiates-on-the-client")
  (ts := "packages/gateway/src/router.ts#modelListingFormat")]
theorem model_listing_defaults_to_the_client_signal (anthropicVersion : Bool) :
    modelListingFormat anthropicVersion none none =
      (if anthropicVersion then .anthropic else .openai) := by
  cases anthropicVersion <;> decide +kernel

/-- The regression this rule exists to prevent, stated over every connection family: an Anthropic-SDK
request gets the Anthropic envelope whichever family serves the run, including the three OpenAI ones
that `ANTHROPIC_BASE_URL` also points at the gateway. The family is not an input to the decision. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d6--get-v1models-negotiates-on-the-client")
  (ts := "packages/gateway/src/router.ts#ANTHROPIC_CLIENT_HEADER")]
theorem an_anthropic_sdk_request_keeps_its_envelope_on_every_family :
    ConnectionFamily.all.all (fun _ => modelListingFormat true none none == .anthropic) = true ∧
      ConnectionFamily.all.all (fun _ => modelListingFormat false none none == .openai) = true := by
  decide +kernel

/-- `?format=` overrides both the header and the client signal; the header overrides only the
client signal. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d6--get-v1models-negotiates-on-the-client")
  (ts := "packages/gateway/src/router.ts#modelListingFormat")]
theorem model_listing_overrides_are_ordered (anthropicVersion : Bool) (query header : ModelFormat) :
    modelListingFormat anthropicVersion (some query) (some header) = query ∧
      modelListingFormat anthropicVersion none (some header) = header := by
  cases anthropicVersion <;> cases query <;> cases header <;> decide +kernel

/-! ## Settlement -/

/-- On a relayed OpenAI dialect, an upstream that finished without reporting usage settles the run
`unavailable`, and a stream that stopped before any terminal frame settles it `failed`. No sixth
accounting state is invented, and no counts are fabricated in either case. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d9--no-sixth-accounting-state-is-invented")
  (ts := "packages/gateway/src/auth.ts#recordResponseUsage")]
theorem the_two_unmetered_outcomes_are_named (protocol : WireProtocol)
    (hrelayed : protocol.isRelayed = true) (c : Counters) :
    settle protocol ⟨c, false, true⟩ = .recorded c false ∧
      settledAccounting (settle protocol ⟨c, false, true⟩) = .unavailable ∧
      settle protocol ⟨c, false, false⟩ = .failed ∧
      settledAccounting (settle protocol ⟨c, false, false⟩) = .failed := by
  cases protocol <;> revert hrelayed <;>
    simp [settle, settledAccounting, WireProtocol.isRelayed]

/-- And the `unavailable` outcome is that rule's alone: on `anthropic-messages` an unmetered response
settles `failed` whether or not it declared itself finished, which is what "Anthropic ingress
behaviour is unchanged" means for the accounting path (ADR-0068 D9). -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d9--no-sixth-accounting-state-is-invented")
  (ts := "packages/gateway/src/auth.ts#isUnpricedWhenUnmetered")]
theorem anthropic_never_settles_unmetered_as_unavailable (c : Counters) (completed : Bool) :
    settle .anthropicMessages ⟨c, false, completed⟩ = .failed ∧
      settledAccounting (settle .anthropicMessages ⟨c, false, completed⟩) = .failed := by
  cases completed <;> refine ⟨rfl, rfl⟩

/-- The whole rule as one table: which of the three settlements each dialect reaches for each of the
four `(metered, completed)` pairs, and that `unavailable` appears in the two relayed rows only. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d9--no-sixth-accounting-state-is-invented")
  (ts := "packages/gateway/src/auth.ts#isUnpricedWhenUnmetered")]
theorem the_unavailable_outcome_belongs_to_the_relayed_dialects :
    (WireEnum.all (α := WireProtocol)).all (fun protocol =>
      [true, false].all fun completed =>
        (settledAccounting (settle protocol ⟨Counters.zero, false, completed⟩) == .unavailable) ==
          (completed && protocol.isRelayed)) = true := by decide +kernel

/-- Every accounting state a settlement can produce is one the existing vocabulary already has,
whichever dialect settled it. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/schema/runs.ts#accountingStates")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d9--no-sixth-accounting-state-is-invented")]
theorem settlement_uses_only_existing_accounting_states (protocol : WireProtocol)
    (m : Measurement) :
    settledAccounting (settle protocol m) ∈ (WireEnum.all (α := AccountingState)) :=
  AccountingState.instWireEnum.complete _

end AgentWorkspace.Theorems.Normative.GatewayIngress
