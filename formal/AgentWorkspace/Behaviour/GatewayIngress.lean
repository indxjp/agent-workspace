import AgentWorkspace.Authz.RunToken
import AgentWorkspace.Concepts.Usage

/-!
# Gateway ingress: three dialects at one front door

The model gateway serves three wire protocols (ADR-0068): Anthropic Messages, which it translates
to whatever the run's connection speaks, and the two OpenAI dialects — the Responses API and Chat
Completions — which it **relays** to an OpenAI-family upstream with the stored credential
substituted. This module states, as pure functions over an explicit request:

1. **The ingress decision** (`ingressDecision`): whether a request is forwarded upstream at all, and if so
   with which credential, which model and which headers. It reuses `Authz.RunToken.authenticate`
   rather than re-deriving the authentication order.
2. **The route table** (`routeProtocol?`, `ingressDecisionRoute`), and how today's
   messages-only table embeds in it.
3. **The two header allowlists** (`upstreamHeaders`, `clientResponseHeaders`), which are the whole
   of the credential-isolation rule in both directions.
4. **Per-protocol usage extraction** (`extractAnthropic`, `extractResponses`, `extractChat`) over a
   finite frame sequence, and the settlement it implies (`settle`).

Two things are explicit assumptions, enforced by `tests/formal/gateway-ingress.test.ts` rather than
proved here:

* **Header names arrive lowercased.** `Headers` normalises them before the TypeScript sees one, so
  the allowlists below match on lower case and this module does not model the normalisation.
* **The frames are what the provider sent.** This module begins after SSE framing has been parsed
  into frames; it does not model the byte-level reader, whose behaviour the replay suite measures.
-/

namespace AgentWorkspace.Behaviour.GatewayIngress

open AgentWorkspace AgentWorkspace.Authz.RunToken
open AgentWorkspace.Concepts.Usage

/-! ## The connection family -/

/-- `MODEL_PROVIDERS`: the provider a model connection names. -/
@[aw_spec (ts := "packages/core/src/db/schema/model-connections.ts#modelProviders")]
inductive ConnectionFamily where
  | anthropic
  | anthropicCompatible
  | openai
  | azureOpenai
  | openaiCompatible
  deriving DecidableEq, Repr, Inhabited

namespace ConnectionFamily

def all : List ConnectionFamily :=
  [anthropic, anthropicCompatible, openai, azureOpenai, openaiCompatible]

theorem all_complete (f : ConnectionFamily) : f ∈ all := by cases f <;> decide

/-- The registry id the resolver maps a connection onto: `anthropic-compatible` is served by the
`anthropic` adapter, so the router only ever sees four ids. -/
@[aw_spec (ts := "packages/gateway/src/index.ts#createDatabaseGatewayRunResolver")
  (ts := "packages/gateway/src/providers/registry.ts#PROVIDER_IDS")]
def providerId : ConnectionFamily → String
  | anthropic | anthropicCompatible => "anthropic"
  | openai => "openai"
  | azureOpenai => "azure-openai"
  | openaiCompatible => "openai-compatible"

/-- The family relays the OpenAI dialects: it has a `WireProtocolForwarder` (ADR-0068 D2). -/
@[aw_spec (ts := "packages/gateway/src/providers/registry.ts#forwardingRow")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d2--the-protocol-rule-is-a-function-of-the-connection-family")]
def isOpenAIFamily : ConnectionFamily → Bool
  | anthropic | anthropicCompatible => false
  | openai | azureOpenai | openaiCompatible => true

/-- Which protocol this family accepts. Anthropic Messages is translated by every adapter; the two
OpenAI dialects are relayed, and only by an OpenAI-family connection. -/
@[aw_spec (ts := "packages/gateway/src/types.ts#WireProtocolForwarder")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d2--the-protocol-rule-is-a-function-of-the-connection-family")]
def speaks (f : ConnectionFamily) : WireProtocol → Bool
  | .anthropicMessages => true
  | .openaiResponses | .openaiChatCompletions => f.isOpenAIFamily

/-- Azure addresses a deployment, never a model name, so its adapter pins the relayed body's
`model`. Every other family relays the client's own choice (ADR-0068 D8). -/
@[aw_spec (ts := "packages/gateway/src/providers/azure-openai.ts#createAzureOpenAIProvider")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d8--model-enforcement-mirrors-today-the-acceptance-criterion-is-amended")]
def pinsModel : ConnectionFamily → Bool
  | azureOpenai => true
  | anthropic | anthropicCompatible | openai | openaiCompatible => false

/-- The header this family's substituted credential travels in. Three schemes, because the two
vendors disagree: Anthropic reads `x-api-key`, Azure reads `api-key`, and OpenAI reads a bearer. -/
@[aw_spec (ts := "packages/gateway/src/providers/passthrough.ts#PassthroughCredentialScheme")
  (ts := "packages/gateway/src/providers/anthropic.ts#anthropicRequestHeaders")]
def credentialHeader : ConnectionFamily → String
  | anthropic | anthropicCompatible => "x-api-key"
  | azureOpenai => "api-key"
  | openai | openaiCompatible => "authorization"

end ConnectionFamily

/-! ## Tools -/

/-- A declared tool's `type`. `unnamed` is an entry that names no string type at all, which the
closed allowlist refuses rather than assuming it is a function (ADR-0068 D4). -/
@[aw_spec (ts := "packages/gateway/src/providers/passthrough.ts#unrelayableToolType")]
inductive ToolType where
  | function
  | custom
  | webSearch
  | fileSearch
  | codeInterpreter
  | imageGeneration
  | mcp
  | computerUsePreview
  | shell
  | unnamed
  deriving DecidableEq, Repr, Inhabited

namespace ToolType

def all : List ToolType :=
  [function, custom, webSearch, fileSearch, codeInterpreter, imageGeneration, mcp,
    computerUsePreview, shell, unnamed]

theorem all_complete (t : ToolType) : t ∈ all := by cases t <;> decide

/-- The closed allowlist: only a tool the platform executes inside its own sandbox is relayed.
Everything else runs at the model vendor, past the egress policy and the connector model. -/
@[aw_spec (ts := "packages/gateway/src/providers/passthrough.ts#unrelayableToolType")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d4--hosted-tools-are-refused-by-a-closed-allowlist")]
def isRelayable : ToolType → Bool
  | function | custom => true
  | webSearch | fileSearch | codeInterpreter | imageGeneration | mcp | computerUsePreview
  | shell | unnamed => false

end ToolType

/-! ## Headers -/

/-- A request or response header, with its name already lowercased (see the module docstring). -/
structure Header where
  name : String
  value : String
  deriving DecidableEq, Repr, Inhabited

/-- Client request headers that may travel upstream, by name. A closed list rather than the
`openai-` prefix it replaces: `openai-organization` and `openai-project` are real OpenAI request
headers, and admitting them would let the caller choose which account on the stored credential
serves and is billed for the turn — the one thing the model connection decides. The caller's run
token lives in `authorization`, which no list admits. -/
@[aw_spec (ts := "packages/gateway/src/providers/passthrough.ts#UPSTREAM_HEADERS")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d7--both-header-directions-are-closed-allowlists")]
def upstreamAllowedHeaders : List String := ["openai-beta"]

/-- The `openai-` prefix rule this unit shipped first, kept only to state the refinement: the closed
list above admits a subset of what it admitted (`Theorems.Refinement.GatewayIngress`). -/
def hasOpenAIPrefix (name : String) : Bool :=
  -- Over `List Char` rather than `String.isPrefixOf`, so the kernel can decide it.
  List.isPrefixOf "openai-".toList name.toList

@[aw_spec (ts := "packages/gateway/src/providers/passthrough.ts#UPSTREAM_HEADERS")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d7--both-header-directions-are-closed-allowlists")]
def travelsUpstream (name : String) : Bool := upstreamAllowedHeaders.contains name

/-- Upstream response headers the client may see. The response is rebuilt from this list, so
`set-cookie`, an organisation identifier or an upstream credential header cannot reach the caller. -/
@[aw_spec (ts := "packages/gateway/src/providers/passthrough.ts#CLIENT_RESPONSE_HEADERS")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d7--both-header-directions-are-closed-allowlists")]
def clientVisibleHeaders : List String :=
  ["content-type", "cache-control", "retry-after", "x-request-id"]

/-- The headers the gateway sends upstream: the substituted credential, `content-type`, and the
allowlisted client headers. Built from scratch, never by editing the client's own collection. -/
@[aw_spec (ts := "packages/gateway/src/providers/passthrough.ts#upstreamHeaders")]
def upstreamHeaders (family : ConnectionFamily) (credential : String)
    (clientHeaders : List Header) : List Header :=
  ⟨family.credentialHeader, credential⟩ :: ⟨"content-type", "application/json"⟩ ::
    clientHeaders.filter fun h => travelsUpstream h.name

/-- The headers the client sees: the allowlisted subset of what the upstream answered. -/
@[aw_spec (ts := "packages/gateway/src/providers/passthrough.ts#clientResponse")]
def clientResponseHeaders (upstream : List Header) : List Header :=
  upstream.filter fun h => clientVisibleHeaders.contains h.name

/-! ## The ingress decision -/

/-- What the gateway relays upstream, once it has decided to. -/
structure UpstreamRequest where
  protocol : WireProtocol
  /-- The stored provider credential, substituted from the run's model connection. -/
  credential : String
  /-- The relayed body's `model`: the client's, or Azure's deployment. -/
  model : String
  /-- `stream_options.include_usage`, which the gateway sets on every streamed Chat Completions
  body it forwards, because without it the upstream reports no usage at all. -/
  includeUsage : Bool
  headers : List Header
  deriving DecidableEq, Repr, Inhabited

/-- The outcome of one model-turn request at the gateway's front door. -/
inductive Decision where
  | forwarded (upstream : UpstreamRequest)
  | answered (status : Nat) (code : String)
  deriving DecidableEq, Repr, Inhabited

/-- Nothing left the process. -/
def Decision.forwardedUpstream : Decision → Bool
  | .forwarded _ => true
  | .answered _ _ => false

/-- The run's model connection, as the verified token resolves it. -/
structure Connection where
  family : ConnectionFamily
  /-- The credential held outside the sandbox. The gateway substitutes exactly this. -/
  credential : String
  /-- Azure's deployment name, which is what `pinsModel` relays instead of the client's model. -/
  deployment : String
  deriving DecidableEq, Repr, Inhabited

/-- One request at the front door, after the route has named its protocol. -/
structure Request where
  protocol : WireProtocol
  /-- The caller's gateway run token, which must never travel upstream. -/
  runToken : String
  hasBearer : Bool
  verification : Verification
  expectedRunId : Option String
  resolution : Resolution
  connection : Connection
  requestedModel : String
  tools : List ToolType
  /-- A top-level field asking the vendor to run a hosted tool without declaring one in `tools`:
  Chat Completions' `web_search_options` (ADR-0068 D4). -/
  hostedToolField : Bool
  /-- `background: true`, which only the Responses API defines (ADR-0068 D4). -/
  background : Bool
  /-- A field referring to state held at the model vendor — one of `vendorStateFields`: the Responses
  API's `previous_response_id`, a `conversation`, or a stored `prompt` (ADR-0068 D10). -/
  vendorState : Bool
  stream : Bool
  clientHeaders : List Header
  -- No `Inhabited`: `Authz.RunToken.Verification` has no default, and a request with no
  -- verification verdict is not a state this model should be able to conjure.
  deriving DecidableEq, Repr

/-- The model the relayed body carries. -/
def relayedModel (r : Request) : String :=
  if r.connection.family.pinsModel then r.connection.deployment else r.requestedModel

/-- `stream_options.include_usage` is injected for a streamed Chat Completions request and for
nothing else — the Responses API has no such field. -/
def injectsIncludeUsage (r : Request) : Bool :=
  r.stream && r.protocol == .openaiChatCompletions

/-- `store` as a relayed body carries it: always `false` on both relayed dialects, whatever the
client sent or did not send. `store: true` retains the turn's prompt and completion at the vendor
under an id the platform never sees — the Responses API even defaults to it — so injecting the value
and overwriting a client `true` are one rule rather than two, and it is the same rule on Chat
Completions, whose stored completions are retained even though no field resumes them (ADR-0068 D10).
`anthropic-messages` is translated rather than relayed, so its body is left as the client wrote it. -/
@[aw_spec (ts := "packages/gateway/src/providers/passthrough.ts#relayedBody")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d10--vendor-side-conversation-state-is-refused-and-store-is-relayed-false")]
def relayedStore (protocol : WireProtocol) (clientStore : Option Bool) : Option Bool :=
  if protocol.isRelayed then some false else clientStore

/-- The top-level body fields that refer to state held at the model vendor, in the TypeScript
order: a stored response to resume, a conversation, and a stored prompt object, which carries its
own instructions and its own tools (ADR-0068 D10). -/
@[aw_spec (ts := "packages/gateway/src/providers/passthrough.ts#VENDOR_STATE_FIELDS")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d10--vendor-side-conversation-state-is-refused-and-store-is-relayed-false")]
def vendorStateFields : List String := ["previous_response_id", "conversation", "prompt"]

/-- Whether a body with these top-level keys asks for vendor-held state: a listed key is present,
whatever its value, so only an absent field does not ask. This is how `Request.vendorState` is
read off a body. -/
@[aw_spec (ts := "packages/gateway/src/providers/passthrough.ts#vendorStateField")]
def bodyAsksForVendorState (keys : List String) : Bool :=
  keys.any (vendorStateFields.contains ·)

/-- The request asks for vendor-hosted execution: through a `tools` entry outside the allowlist, or
through the top-level field that asks for the same thing without declaring a tool (ADR-0068 D4). -/
def asksForHostedTool (r : Request) : Bool :=
  !r.tools.all ToolType.isRelayable || r.hostedToolField

/-- The request asks to be backgrounded on a route that publishes no way to retrieve the result, so
relaying it would spend tokens no route could ever meter (ADR-0068 D4). -/
@[aw_spec (ts := "packages/gateway/src/providers/passthrough.ts#isUnreachableBackgroundRequest")]
def asksForUnreachableBackground (r : Request) : Bool :=
  r.background && r.protocol == .openaiResponses

/-- The request refers to state the vendor holds, which lives outside the
platform's session boundary and outside `session_transcripts`, keyed by an id the platform never
sees (ADR-0068 D10).

Refused on **every relayed dialect**, like the hosted-tool field: the rule is about where the state
lives, not about which route asked for it, so a field the Chat Completions API does not define cannot
become permissible by arriving on that route. It is the relay's rule alone, so `anthropic-messages`
— which is translated, not relayed — keeps the behaviour it had. -/
@[aw_spec (ts := "packages/gateway/src/providers/passthrough.ts#vendorStateField")]
def asksForVendorState (r : Request) : Bool := r.vendorState && r.protocol.isRelayed

/--
The ingress decision, in the order the router and the relay take it (ADR-0068 D1–D4, D7–D8, D10):

1. authentication, exactly as `Authz.RunToken.authenticate` orders it;
2. the connection family must speak the protocol, before any tool rule and before any network call;
3. the body must name a non-blank model;
4. the request must ask for no vendor-hosted tool, in either of the two ways it can;
5. it must not ask to be backgrounded beyond the reach of metering;
6. it must not ask to resume conversation state the platform cannot see.

Only then is anything forwarded, and what is forwarded carries the stored credential and this
connection's own model.
-/
@[aw_spec (ts := "packages/gateway/src/router.ts#forwardProtocol")
  (ts := "packages/gateway/src/providers/passthrough.ts#createWireProtocolForwarder")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d1--two-new-ingress-routes-and-they-are-passthrough")]
def ingressDecision (r : Request) : Decision :=
  match authenticate r.hasBearer r.verification r.expectedRunId r.resolution with
  | .deny status code => .answered status code
  | .allow =>
    if !r.connection.family.speaks r.protocol then
      .answered 400 "protocol_not_supported_for_connection"
    else if Text.isBlank r.requestedModel then .answered 400 "invalid_request_error"
    else if asksForHostedTool r then .answered 400 "hosted_tool_not_permitted"
    else if asksForUnreachableBackground r then .answered 400 "background_not_supported"
    else if asksForVendorState r then .answered 400 "vendor_state_not_permitted"
    else .forwarded
      { protocol := r.protocol,
        credential := r.connection.credential,
        model := relayedModel r,
        includeUsage := injectsIncludeUsage r,
        headers := upstreamHeaders r.connection.family r.connection.credential r.clientHeaders }

/-- The stable code of a refusal, and `""` for a forwarded request. -/
def refusalCode : Decision → String
  | .forwarded _ => ""
  | .answered _ code => code

/-! ## The route table -/

/-- The gateway's public routes, as spec §9 prints them. -/
@[aw_spec (ts := "packages/gateway/src/router.ts#ROUTES") (doc := "docs/spec.md#9-model-gateway")]
inductive Route where
  | messages
  | countTokens
  | responses
  | chatCompletions
  | models
  | health
  deriving DecidableEq, Repr, Inhabited

namespace Route

def all : List Route := [messages, countTokens, responses, chatCompletions, models, health]

theorem all_complete (route : Route) : route ∈ all := by cases route <;> decide

/-- The path, as §9's fenced block spells it. -/
def path : Route → String
  | messages => "/v1/messages"
  | countTokens => "/v1/messages/count_tokens"
  | responses => "/v1/responses"
  | chatCompletions => "/v1/chat/completions"
  | models => "/v1/models"
  | health => "/health"

/-- The route existed before this unit. The two OpenAI dialects did not, so they answered 404. -/
@[aw_spec (ts := "packages/gateway/src/router.ts#ROUTES")]
def existedBeforeIngress : Route → Bool
  | responses | chatCompletions => false
  | messages | countTokens | models | health => true

end Route

/-- The dialect a route speaks, and so which usage extractor meters it. `/v1/models` and
`/v1/messages/count_tokens` carry no model turn, so they are not metered at all. -/
@[aw_spec (ts := "packages/gateway/src/auth.ts#meteredProtocol")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d5--metering-is-per-protocol-incremental-and-corrects-two-openai-conventions")]
def routeProtocol? : Route → Option WireProtocol
  | .messages => some .anthropicMessages
  | .responses => some .openaiResponses
  | .chatCompletions => some .openaiChatCompletions
  | .countTokens | .models | .health => none

/-- The decision for a request arriving on a route, in the target route table. -/
def ingressDecisionRoute (route : Route) (r : Request) : Decision :=
  match routeProtocol? route with
  | none => .answered 404 "not_found_error"
  | some protocol => ingressDecision { r with protocol := protocol }

/-- The decision the gateway took before this unit: the two new paths were not routes. -/
@[aw_spec (ts := "packages/gateway/src/router.ts#createRouter")]
def ingressDecisionRouteCurrent (route : Route) (r : Request) : Decision :=
  if route.existedBeforeIngress then ingressDecisionRoute route r else .answered 404 "not_found_error"

/-! ## The ingress table: the model routes plus the tool route (ADR-0113 C16)

`Route` stays the model router's table, unchanged. The application serves one more path, the
stateless MCP endpoint of a tool connector, which it dispatches before the model boundary: it
authenticates the run token but never resolves the model key and is never metered. The tool
sandbox route (ADR-0118 TS3) is the same class: it forwards a code tool's MCP call to the run's
tool sandbox after the run token, and never touches the model key either. So does the endpoint tool
sandbox route (ADR-0134 part 2), which forwards after an endpoint grant instead. -/

/-- What the application serves: a model route, the tool route, the tool sandbox route or the
endpoint tool sandbox route. -/
@[aw_spec (ts := "packages/gateway/src/index.ts#GATEWAY_ROUTES") (doc := "docs/spec.md#9-model-gateway")]
inductive Ingress where
  | model (route : Route)
  | tool
  | toolSandbox
  | toolSandboxEndpoint
  deriving DecidableEq, Repr, Inhabited

namespace Ingress

def all : List Ingress := Route.all.map model ++ [tool, toolSandbox, toolSandboxEndpoint]

theorem all_complete (ingress : Ingress) : ingress ∈ all := by
  cases ingress with
  | model route => cases route <;> decide
  | tool => decide
  | toolSandbox => decide
  | toolSandboxEndpoint => decide

/-- The path, as §9's fenced block spells it. -/
def path : Ingress → String
  | model route => route.path
  | tool => "/v1/tools/:connectorId/mcp"
  | toolSandbox => "/v1/tool-sandbox/mcp"
  | toolSandboxEndpoint => "/v1/tool-sandbox/endpoint/mcp"

/-- Whether the usage recorder meters a request on this path. -/
@[aw_spec (ts := "packages/gateway/src/auth.ts#meteredProtocol")]
def metered : Ingress → Bool
  | model route => (routeProtocol? route).isSome
  | tool => false
  | toolSandbox => false
  | toolSandboxEndpoint => false

/-- Whether serving the path resolves (and so decrypts) the run's model key. Health is a process
probe and the tool routes stop after the run token, so none of them does. -/
@[aw_spec (ts := "packages/gateway/src/index.ts#createGatewayApplication")]
def resolvesModelKey : Ingress → Bool
  | model .health => false
  | model _ => true
  | tool => false
  | toolSandbox => false
  | toolSandboxEndpoint => false

end Ingress

/-! ## The tool route's authorisation (C16) -/

/-- A tool connector's kind. Only `openapi` has an executor in the gateway today. -/
inductive ToolKind where
  | openapi
  | postgres
  deriving DecidableEq, Repr, Inhabited

/-- What the resolver reads of the token's run, in the token's workspace. -/
structure ToolRun where
  terminal : Bool
  toolConnectorIds : List String
  deriving DecidableEq, Repr, Inhabited

/-- What the resolver reads of the named connector, in the token's workspace. -/
structure ToolConnector where
  workspaceId : String
  kind : ToolKind
  enabled : Bool
  deriving DecidableEq, Repr, Inhabited

/--
The tool route's decision, in the order the endpoint takes it:

1. the bearer and the token's signature and expiry, with `authenticate`'s codes;
2. the registry row must be active and the run live, else `401 tool_run_not_active`;
3. the connector must be in the run's snapshot, in the token's workspace, enabled and an `openapi`
   connector, else one `403 tool_not_in_run`, so the route never reveals whether it exists.

There is no expected run id on this route, and no model-key resolution at all.
-/
@[aw_spec (ts := "packages/gateway/src/tools/authorize.ts#authorizeToolCall")
  (ts := "packages/gateway/src/auth.ts#verifyRunToken")]
def toolDecision (hasBearer : Bool) (verification : Verification) (tokenActive : Bool)
    (run : Option ToolRun) (connector : Option ToolConnector) (workspaceId connectorId : String) :
    GatewayDecision :=
  if !hasBearer then .deny 401 "token_missing"
  else match verification with
  | .invalid => .deny 401 "token_invalid"
  | .expired => .deny 401 "token_expired"
  | .valid _ =>
    match run with
    | none => .deny 401 "tool_run_not_active"
    | some r =>
      if !tokenActive || r.terminal then .deny 401 "tool_run_not_active"
      else match connector with
      | none => .deny 403 "tool_not_in_run"
      | some c =>
        if r.toolConnectorIds.contains connectorId && c.workspaceId == workspaceId &&
            c.enabled && c.kind == .openapi then .allow
        else .deny 403 "tool_not_in_run"

/-! ## Model listing -/

/-- The envelope `GET /v1/models` answers in (ADR-0068 D6). -/
@[aw_spec (ts := "packages/gateway/src/router.ts#MODEL_FORMATS")]
inductive ModelFormat where
  | anthropic
  | openai
  deriving DecidableEq, Repr, Inhabited

/-- The envelope follows the **client**, and the connection family is deliberately not an input:
Claude Code reaches the gateway through `ANTHROPIC_BASE_URL` on every family, so keying on the
family would answer an Anthropic SDK with a body it cannot parse. `Accept: application/json` is sent
identically by both SDKs and carries no signal, but `anthropic-version` does: the Anthropic SDK sends
it on every request and no OpenAI SDK sends it. `?format=` wins, then `x-gateway-model-format`. -/
@[aw_spec (ts := "packages/gateway/src/router.ts#modelListingFormat")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d6--get-v1models-negotiates-on-the-client")]
def modelListingFormat (anthropicVersion : Bool) (query header : Option ModelFormat) :
    ModelFormat :=
  match query with
  | some format => format
  | none => match header with
    | some format => format
    | none => if anthropicVersion then .anthropic else .openai

/-! ## Usage extraction -/

/-- What one response's frames measured. `metered` and `completed` are separate because the two
unmetered outcomes settle differently (ADR-0068 D9). -/
@[aw_spec (ts := "packages/gateway/src/usage/accumulator.ts#ExtractedUsage")]
structure Measurement where
  counters : Counters
  metered : Bool
  completed : Bool
  deriving DecidableEq, Repr, Inhabited

namespace Measurement

/-- Nothing observed: no counters, nothing measured, nothing finished. -/
def zero : Measurement := ⟨Counters.zero, false, false⟩

/-- Counter-wise `≤`: what "extraction is monotone under prefix truncation" means. -/
def le (a b : Measurement) : Bool :=
  a.counters.inputTokens ≤ b.counters.inputTokens &&
    a.counters.outputTokens ≤ b.counters.outputTokens &&
    a.counters.cacheReadInputTokens ≤ b.counters.cacheReadInputTokens &&
    a.counters.cacheCreationInputTokens ≤ b.counters.cacheCreationInputTokens &&
    a.counters.toolCalls ≤ b.counters.toolCalls

end Measurement

/-! ### Anthropic Messages -/

/-- A frame of an Anthropic Messages response, abstracted to what metering reads. -/
@[aw_spec (ts := "packages/gateway/src/usage/anthropic.ts#createAnthropicUsageAccumulator")]
inductive AnthropicFrame where
  /-- A cumulative `usage` snapshot, as `message_start` and `message_delta` carry one. -/
  | usageSnapshot (inputTokens outputTokens cacheRead cacheCreation : Nat)
  /-- A `content_block_start` whose block is a `tool_use`. -/
  | toolBlockStart
  /-- `message_stop`, or a non-streaming body, whose `type` is `message`. -/
  | stop
  deriving DecidableEq, Repr, Inhabited

/-- Absorb one Anthropic frame. The snapshots are merged with `max`, because a streamed response
reports the same cumulative figures twice and an earlier frame must not be charged again. -/
def stepAnthropic (m : Measurement) : AnthropicFrame → Measurement
  | .usageSnapshot i o cr cc =>
    { m with
      counters :=
        { m.counters with
          inputTokens := max m.counters.inputTokens i,
          outputTokens := max m.counters.outputTokens o,
          cacheReadInputTokens := max m.counters.cacheReadInputTokens cr,
          cacheCreationInputTokens := max m.counters.cacheCreationInputTokens cc },
      metered := true }
  | .toolBlockStart =>
    { m with counters := { m.counters with toolCalls := m.counters.toolCalls + 1 } }
  | .stop => { m with completed := true }

/-- Metering an Anthropic Messages response. -/
@[aw_spec (ts := "packages/gateway/src/usage/anthropic.ts#createAnthropicUsageAccumulator")]
def extractAnthropic (frames : List AnthropicFrame) : Measurement :=
  frames.foldl stepAnthropic Measurement.zero

/-! ### The OpenAI Responses API -/

/-- A frame of a Responses response. Usage lives only on the terminal snapshot, which also repeats
every output item — hence the identity list.

The frame kinds below are abstract over *which* item type is a tool call: both of the two the
hosted-tool allowlist admits are — a `function` tool invocation arrives as a `function_call` item and
a `custom` one as a `custom_tool_call` item (`usage/responses.ts`'s `FUNCTION_CALL_ITEM_TYPES`). -/
@[aw_spec (ts := "packages/gateway/src/usage/responses.ts#createResponsesUsageAccumulator")]
inductive ResponsesFrame where
  /-- `response.created`: names the response and its model, and carries no usage. -/
  | created
  /-- `response.output_item.done` for a tool-call item — `function_call` or `custom_tool_call` — at
  the item's own identity. -/
  | functionCallDone (itemId : String)
  /-- `response.completed`, `response.incomplete` or `response.failed`, or a non-streaming body.
  `inputTokens` is OpenAI's cache-INCLUSIVE figure and `cachedTokens` the cached part of it. -/
  | terminal (inputTokens outputTokens cachedTokens : Nat) (items : List String)
  deriving DecidableEq, Repr, Inhabited

/-- The extraction state: a measurement plus the function-call identities seen so far. Identities
rather than a count, because the stream and the terminal snapshot both name the same items. -/
structure ResponsesState where
  measurement : Measurement
  functionCalls : List String
  deriving DecidableEq, Repr, Inhabited

def ResponsesState.zero : ResponsesState := ⟨Measurement.zero, []⟩

/-- Add one identity, if it is new. -/
def noteIdentity (seen : List String) (id : String) : List String :=
  if seen.contains id then seen else seen ++ [id]

/-- Add every identity of a list, each at most once. -/
def noteIdentities (seen : List String) (ids : List String) : List String :=
  ids.foldl noteIdentity seen

def stepResponses (s : ResponsesState) : ResponsesFrame → ResponsesState
  | .created => s
  | .functionCallDone id => { s with functionCalls := noteIdentity s.functionCalls id }
  | .terminal i o cached items =>
    { measurement :=
        { counters :=
            { s.measurement.counters with
              -- OpenAI's `input_tokens` INCLUDES the cached prefix, while the price table charges
              -- input and cache reads as separate additive terms. Without this subtraction every
              -- cached request is billed twice for its prefix.
              inputTokens := max s.measurement.counters.inputTokens (i - cached),
              -- `reasoning_tokens` is already inside `output_tokens`, so it is added nowhere.
              outputTokens := max s.measurement.counters.outputTokens o,
              cacheReadInputTokens := max s.measurement.counters.cacheReadInputTokens cached },
          metered := true,
          completed := true },
      functionCalls := noteIdentities s.functionCalls items }

/-- Metering a Responses response: tool calls are the number of distinct tool-call item identities
(`function_call` or `custom_tool_call`), so an item reported twice cannot inflate them. -/
@[aw_spec (ts := "packages/gateway/src/usage/responses.ts#createResponsesUsageAccumulator")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d5--metering-is-per-protocol-incremental-and-corrects-two-openai-conventions")]
def extractResponses (frames : List ResponsesFrame) : Measurement :=
  let s := frames.foldl stepResponses ResponsesState.zero
  { s.measurement with
    counters := { s.measurement.counters with toolCalls := s.functionCalls.length } }

/-! ### OpenAI Chat Completions -/

/-- A frame of a Chat Completions response. -/
@[aw_spec (ts := "packages/gateway/src/usage/chat-completions.ts#createChatCompletionsUsageAccumulator")]
inductive ChatFrame where
  /-- One `tool_calls` delta, at its `(choice index, tool_calls[].index)` pair. One call's
  arguments arrive as many deltas that all repeat the same pair. -/
  | toolCallDelta (choiceIndex callIndex : Nat)
  /-- A chunk carrying a `finish_reason`, or a non-streaming body. -/
  | finish
  /-- The final chunk's `usage`. `promptTokens` is cache-inclusive, as on Responses. -/
  | usage (promptTokens completionTokens cachedTokens : Nat)
  deriving DecidableEq, Repr, Inhabited

/-- The extraction state: a measurement plus the `(choice, index)` pairs seen so far. -/
structure ChatState where
  measurement : Measurement
  toolCalls : List (Nat × Nat)
  deriving DecidableEq, Repr, Inhabited

def ChatState.zero : ChatState := ⟨Measurement.zero, []⟩

def notePair (seen : List (Nat × Nat)) (pair : Nat × Nat) : List (Nat × Nat) :=
  if seen.contains pair then seen else seen ++ [pair]

def stepChat (s : ChatState) : ChatFrame → ChatState
  | .toolCallDelta choice call => { s with toolCalls := notePair s.toolCalls (choice, call) }
  | .finish => { s with measurement := { s.measurement with completed := true } }
  | .usage prompt completion cached =>
    { s with measurement :=
      { counters :=
          { s.measurement.counters with
            inputTokens := max s.measurement.counters.inputTokens (prompt - cached),
            outputTokens := max s.measurement.counters.outputTokens completion,
            cacheReadInputTokens := max s.measurement.counters.cacheReadInputTokens cached },
        metered := true,
        completed := s.measurement.completed } }

/-- Metering a Chat Completions response: tool calls are the number of distinct
`(choice, index)` pairs, because one call's deltas fragment across many chunks. -/
@[aw_spec (ts := "packages/gateway/src/usage/chat-completions.ts#createChatCompletionsUsageAccumulator")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d5--metering-is-per-protocol-incremental-and-corrects-two-openai-conventions")]
def extractChat (frames : List ChatFrame) : Measurement :=
  let s := frames.foldl stepChat ChatState.zero
  { s.measurement with
    counters := { s.measurement.counters with toolCalls := s.toolCalls.length } }

/-! ### Settlement -/

/-- What the recorder does with a measurement. -/
inductive Settlement where
  /-- A ledger row. `metered = false` means the zeros were never measured, which settles the run
  `unavailable` rather than as a real zero-cost turn. -/
  | recorded (counters : Counters) (metered : Bool)
  /-- No settlement data at all: `recorder.fail`, which settles the run `failed`. -/
  | failed
  deriving DecidableEq, Repr, Inhabited

/--
The two unmetered outcomes, and which dialects each belongs to (ADR-0068 D9). No sixth accounting
state is invented.

A measured response always records. An unmetered one splits on the **protocol**: a relayed OpenAI
dialect records unpriced zeros once the upstream has declared itself finished, because a compatible
upstream that ignores `stream_options.include_usage` genuinely finishes without reporting anything.
On `anthropic-messages` an unmetered response is a settlement failure however it ended — the rule the
gateway had before it spoke three dialects, and deliberately unchanged, since every real Anthropic
response does declare itself finished (`type: "message"`, or `message_stop`) and so would otherwise
have started settling `unavailable` where it used to settle `failed`.
-/
@[aw_spec (ts := "packages/gateway/src/auth.ts#recordResponseUsage")
  (ts := "packages/gateway/src/auth.ts#isUnpricedWhenUnmetered")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d9--no-sixth-accounting-state-is-invented")]
def settle (protocol : WireProtocol) (m : Measurement) : Settlement :=
  if m.metered || (m.completed && protocol.isRelayed) then .recorded m.counters m.metered
  else .failed

/-- The accounting state a settled row leaves the run in: an unmetered row carries no price, so
the ledger reads `unavailable`; a measured one that priced reads `complete`. -/
@[aw_spec (ts := "packages/core/src/db/repositories/runs.ts#pricedCount")
  (ts := "packages/gateway/src/index.ts#createDatabaseUsageRecorder")]
def settledAccounting : Settlement → AccountingState
  | .recorded _ true => .complete
  | .recorded _ false => .unavailable
  | .failed => .failed

end AgentWorkspace.Behaviour.GatewayIngress
