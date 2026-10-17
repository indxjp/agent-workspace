# ADR-0068 — OpenAI wire protocols are passthrough ingress, not a second translation

Status: accepted
Date: 2026-09-27
Decided by: the Owner (agent-engines programme, tracker #299, unit ENG-05 #304)
Scope: `docs/spec.md` §9; `packages/gateway/src/{router,types,auth}.ts`,
`packages/gateway/src/providers/{openai,azure-openai,openai-compatible,passthrough}.ts`,
`packages/gateway/src/usage/`; `packages/core/src/db/schema/run-usage-records.ts`;
`migrations/0023_*`; `docs/compatibility/openai-ingress.md`;
`formal/AgentWorkspace/Behaviour/GatewayIngress.lean`

## Context

The gateway speaks exactly one dialect at its front door. `docs/spec.md` §9 prints four routes —
`POST /v1/messages`, `POST /v1/messages/count_tokens`, `GET /v1/models`, `GET /health` — and
`ModelProvider.createMessage` takes an `AnthropicMessageRequest`. Every adapter translates *into*
that shape: `providers/openai.ts` maps Anthropic Messages onto the OpenAI Responses API through
`translate/openai.ts`, and `providers/azure-openai.ts` does the same against Azure's deployment
URLs. That was the right shape while the only engine was the Claude Agent SDK, which is pointed at
the gateway with `ANTHROPIC_BASE_URL` and therefore speaks Anthropic Messages natively.

ADR-0065 made the engine an extension point, and tracker #299 schedules four engines that do not
speak Anthropic Messages: the OpenAI Agents SDK (#308), ACP/Codex (#310), Mastra with
OpenAI-family connections (#309) and pi. They speak the two OpenAI dialects — the Responses API
(`POST /v1/responses`) and Chat Completions (`POST /v1/chat/completions`). Chat Completions is not
optional alongside Responses: many `openai-compatible` upstreams (vLLM, Ollama, LM Studio)
implement only Chat Completions, and Mastra and pi default to it for a custom endpoint.

Those engines need everything the gateway already gives the Claude engine — a run token instead of
a provider key, the credential substituted outside the sandbox, egress policy, metering and
pricing — and they need it without the gateway reshaping their requests. A round trip through the
Anthropic shape would drop exactly the fields they depend on (`reasoning`, `stream_options`, and the
vendor-side conversation fields D10 decides about separately).

Three constraints shape the answer.

1. **§9's fenced route block is a live gate.** `packages/gateway/src/spec-conformance.test.ts`
   asserts `createRouter([]).routes` *equals* the routes parsed out of §9, and
   `tests/gateway-inventory.test.ts` asserts the same against the composed application. There is no
   way to add ingress without amending §9 that is not a weakening of a live check.
2. **§10's `ModelProvider` is compared member-for-member with the spec.** The same conformance
   suite diffs the emitted declaration against the fenced `ts` block. Any new member on
   `ModelProvider` is a §10 edit to the interface the specification calls "intentionally tiny".
3. **The gateway must stay streaming.** `auth.ts`'s capture branch buffers the whole response with
   `await response.text()` today. A Responses stream's `response.completed` frame repeats the
   model's entire output, so extending that buffer to two more protocols is the unit's own stop
   condition ("metering a protocol requires buffering an entire streamed response in memory").

## Decision

### D1 — Two new ingress routes, and they are passthrough

`POST /v1/responses` and `POST /v1/chat/completions` join §9's contract. Both are authenticated by
the same `authenticateGatewayRequest` as `/v1/messages`, and for an `openai`, `azure-openai` or
`openai-compatible` model connection the request body is **relayed** to the upstream's matching
endpoint. Nothing is translated in either direction.

Translation from an OpenAI dialect into Anthropic Messages is refused rather than attempted: an
engine that wants an Anthropic model speaks Anthropic Messages, which the gateway already serves.

### D2 — The protocol rule is a function of the connection family

| Connection family | `/v1/messages` | `/v1/responses` | `/v1/chat/completions` |
| --- | --- | --- | --- |
| `anthropic`, `anthropic-compatible` | native passthrough | `400 protocol_not_supported_for_connection` | `400 protocol_not_supported_for_connection` |
| `openai` | translated (unchanged) | passthrough | passthrough |
| `azure-openai` | translated (unchanged) | passthrough | passthrough |
| `openai-compatible` | translated (unchanged) | passthrough | passthrough |

The refusal is decided before the tool rule and before any network call, so an Anthropic-family
connection never reaches an upstream on one of the new routes.

### D3 — The contract is a sibling interface, not a bigger `ModelProvider`

`packages/gateway/src/types.ts` gains

```ts
export type WireProtocol = 'anthropic-messages' | 'openai-responses' | 'openai-chat-completions';

export interface WireProtocolForwarder {
  readonly forwards: ReadonlySet<WireProtocol>;
  forward(request: ForwardRequest, protocol: WireProtocol, context: RequestContext): Promise<Response>;
}
```

The three OpenAI-family adapters implement it *in addition to* `ModelProvider`, and the router
probes for it structurally — exactly as it already probes for the contextual `listModels` and
`countTokens` (`router.ts`'s `ContextualProvider`, `registry.ts`'s `listModelsWithContext`). A
provider that does not implement it is what produces D2's refusal.

This is chosen over a `forward` method on `ModelProvider` because that would force a §10 edit
(constraint 2) and, per the unit's stop condition, could not be added "without changing every
adapter's Anthropic path". A sibling interface costs one exported type, changes no Anthropic code
path, and reuses a widening pattern this package already applies twice.

It is chosen over a second router or server for OpenAI ingress because that would duplicate
authentication, metering and the egress policy, and the unit requires the same
`authenticateGatewayRequest`.

### D4 — Hosted tools are refused by a closed allowlist

A Responses or Chat Completions request whose `tools` contain any entry whose `type` is not
`function` or `custom` is refused `400 hosted_tool_not_permitted`, with nothing sent upstream.

The Issue names a denylist (`web_search`, `file_search`, `code_interpreter`, `image_generation`,
`mcp`, `computer_use_preview`, hosted `shell`). This record inverts it. Vendor-hosted tools execute
at the model vendor, outside the sandbox, and bypass the platform's network policy and connector
model — which is precisely what ADR-0065's non-goals say they cannot do. A denylist fails *open*
for the next hosted tool type OpenAI ships; an allowlist fails closed, and widening it is a
reviewable edit to this list.

The rule is about *where* a tool runs, not about which field asked for it, so it is applied wherever
a request can ask. Chat Completions turns on OpenAI's hosted web search through a **top-level
`web_search_options`** object (for the `*-search-preview` models) rather than through a `tools`
entry, so `{model, messages, web_search_options: {}}` is refused `400 hosted_tool_not_permitted`
too. Checking `tools` alone would have left the rule stating one thing and enforcing another.

**`background: true` on `/v1/responses` is refused `400 background_not_supported`**, also with
nothing sent upstream. A backgrounded response returns a `queued` snapshot with `usage: null` and is
retrieved through `GET /v1/responses/{id}`, which D1 does not add to §9 and this unit does not
publish. Relaying one would therefore spend the run's tokens on a turn no route can ever collect the
usage for: the client holds a queued id it cannot resolve, and the run settles `unavailable` with the
real spend unmetered — a worse outcome than a refusal for both the caller and the ledger. A
capability the platform cannot account for is refused rather than emulated; adding the retrieval
route, its authorization and its metering is a different unit's work.

### D10 — Vendor-side conversation state is refused, and `store` is relayed `false`

_Recorded after review, and placed here because it is D4's rule applied to a second capability. It is
numbered last so that D5–D9's anchors, which the Lean model and the docs site both link to, keep
pointing at the decisions they were written for._

A Responses or Chat Completions request carrying **`previous_response_id`**, **`conversation`** or
**`prompt`** is refused `400 vendor_state_not_permitted`, with nothing sent upstream. Every relayed
body — Responses **and** Chat Completions — carries **`store: false`**: the field is injected when
the client omitted it and overwrites a client `true`, exactly as `stream_options.include_usage` is
injected by D5.

The Responses API defaults `store` to `true`, so relaying a body unchanged left the turn's text at the
model vendor, retrievable through `previous_response_id` under an id the platform never sees. That is
conversation state outside the platform's session boundary and outside `session_transcripts`: any run
reaching the same model connection that learned a stored response id could resume another run's
context through the shared credential. Exploitation needs the id (`resp_<random>`, not guessable), so
this is narrow rather than urgent — but it is the same class as `background: true` above, a capability
the platform can neither see nor account for, and the programme's rule for that class is to refuse it
rather than to accept it silently.

`prompt` is the Responses API's third reference to state the vendor holds: `{"prompt": {"id":
"pmpt_…", "version": "3"}}` resolves a prompt object stored in the organisation that owns the
substituted credential, keyed by an id the platform never sees. That object carries its own
instructions **and its own tool configuration**, so relaying the reference would also reopen D4: a
stored prompt declaring `web_search` or `file_search` reaches vendor-side execution through a body
with no `tools` at all, which the hosted-tool allowlist cannot see through. It is refused with the
same code as the other two, rather than inspected, because the platform cannot read the stored
object it names.

The refusal is checked for **both** relayed dialects, like D4's `web_search_options`: the rule is
about where the state lives, not about which field or route asked for it, so a field the Chat
Completions API does not define does not become permissible by arriving on that route. It is the
relay's rule alone — `anthropic-messages` is translated rather than relayed, so its behaviour is
unchanged here as everywhere else. `store: false` is stated on both relayed dialects for the same
reason. `store` is about **retention** before it is about resumption: a stored Chat Completion leaves
the turn's prompt and completion at the vendor, under the stored credential's organisation, outside
`session_transcripts` and outside anything the platform can see or delete, even though Chat
Completions has no `previous_response_id` to resume it by. The field is sent to every OpenAI-family
connection alike, `openai-compatible` included: an upstream that does not implement `store` receives
one more OpenAI field it does not define, which is the risk this record accepts in exchange for not
branching the rule on the family.

The alternative — recording that vendor-side retention is accepted — was available and is rejected:
the platform's session boundary is the thing `session_transcripts` exists to be, and "the vendor also
has a copy, keyed by an id we never see" is not a property a tenant can audit. A connection-level
opt-in (`ModelConnectionConfig.store`) would need a new config field, its own migration and
control-plane UI, which is the same different-unit work D8 defers.

This narrows what the gateway relays; it does not widen it. `docs/sdk/site/building/models-and-runtimes.mdx`
advertised that `store` and `previous_response_id` "survive the hop", and that sentence is corrected
by this record rather than by the code. The same page no longer names `stream_options` among the
fields that survive either, since D5 merges `include_usage: true` into it.

### D5 — Metering is per protocol, incremental, and corrects two OpenAI conventions

`run_usage_records` gains a `wire_protocol` column over exactly D3's three values. The extractor is
selected by the route, because the route is the only place that knows both the protocol and the
response:

- **`anthropic-messages`** — today's behaviour, moved unchanged: the maximum over the `usage`
  snapshots on `message_start` and `message_delta`; tool calls from `tool_use` content blocks.
- **`openai-responses`** — the terminal snapshot's `usage` (`response.completed`, and also
  `response.incomplete` and `response.failed`, which carry usage for a stream that ended early):
  `input_tokens`, `output_tokens`, `input_tokens_details.cached_tokens`,
  `output_tokens_details.reasoning_tokens`. Tool calls are the number of **distinct**
  `response.output_item.done` item identities whose type is a tool call — `function_call` or
  `custom_tool_call`, matching the two tool types D4's allowlist relays, because the two rules have
  to agree on what a tool call is.
- **`openai-chat-completions`** — the final chunk's `usage`. Tool calls are the number of distinct
  `(choice index, tool_calls[].index)` pairs, because one call's deltas fragment across many
  chunks. The gateway sets `stream_options.include_usage = true` on every streamed body it
  forwards, merging rather than replacing whatever the client sent, because without it the upstream
  reports no usage at all.

Two corrections are required before OpenAI's numbers reach a price table built for Anthropic's
conventions. `pricing.ts` charges `inputTokens`, `outputTokens`, `cacheReadInputTokens` and
`cacheCreationInputTokens` as four separate additive terms, because Anthropic's `input_tokens`
*excludes* cache reads.

- OpenAI's `input_tokens` / `prompt_tokens` **include** the cached prefix, so the extractors record
  `inputTokens = input − cached` (clamped at zero) and `cacheReadInputTokens = cached`. Without
  this, every cached OpenAI request is billed twice for its prefix.
- `reasoning_tokens` is already **inside** `output_tokens`, so it is recorded nowhere extra. That is
  what "reasoning tokens are priced as output tokens" means.

The capture branch becomes an incremental SSE line reader that holds only the accumulators. This
removes the pre-existing whole-response buffer rather than extending it, satisfying constraint 3
for Anthropic Messages as well.

### D6 — `GET /v1/models` negotiates on the client

The envelope follows the **client**: a request carrying `anthropic-version` gets the Anthropic
envelope (`{data, first_id, last_id, has_more}`) with Anthropic-shaped items, and a request without
it gets `{object: 'list', data: [{id, object: 'model', created, owned_by}]}`.
`?format=openai|anthropic` and the `x-gateway-model-format` header override both.

`Accept: application/json` is not the discriminator the Issue hoped for — both SDKs send it
identically, so it carries no signal — but `anthropic-version` is: the Anthropic SDK sets it on
every request including `models.list()`, and no OpenAI SDK sends it.

The connection family is **not** the discriminator, even though the verified token already knows it.
`apps/web/server/compose/run-request.ts` points every sandboxed run's `ANTHROPIC_BASE_URL` at the
gateway regardless of the connection's provider, and the Claude engine keeps reaching an `openai`,
`azure-openai` or `openai-compatible` connection through `translate/openai.ts`. Keying the envelope
on the family would therefore answer Claude Code with a body the Anthropic SDK cannot parse on
exactly the pair this decision claims to protect. The client's own header is the signal that says
whose SDK is talking; the family says only which upstream will serve the turn.

### D7 — Both header directions are closed allowlists

The upstream request is built from scratch with the substituted credential
(`authorization: Bearer <credential>`, or `api-key` for Azure) plus `content-type`; of the client's
headers only the **named** list `openai-beta` travels with it, so the caller's run token never does.
The client-visible response is rebuilt from `content-type`, `cache-control`, `retry-after` and
`x-request-id`, so no `set-cookie`, organisation identifier or upstream credential header reaches the
client.

Both lists name headers rather than matching a prefix. An `openai-` prefix — which this unit shipped
first and review caught — also admits `openai-organization` and `openai-project`, two real OpenAI
request headers the OpenAI SDK sends when configured. Under a prefix a client holding only the run
token, which is the sandboxed agent, could pick which organisation and project on the **stored**
credential served and was billed for the turn, while the gateway still metered the spend against this
run: the platform's ledger and the vendor's invoice could then disagree about whose account paid.
Selecting the account is the model connection's decision. Widening the list is an edit to it, and
`openai-beta` is the only entry the relay needs today. The Lean `travelsUpstream` moved onto the same
closed list, with a T4 theorem proving the list admits a subset of what the prefix admitted — the
narrowing is a refinement, not a weakening.

Passthrough is the gateway's new attack surface in both directions at once, and an allowlist is the
only form of this rule that fails closed.

### D8 — Model enforcement mirrors today; the acceptance criterion is amended

The Issue asks for a request naming a model other than the run token's connection model to be
refused, "same rule as `/v1/messages` today". **There is no such rule today.**
`ModelConnectionConfig` is `{ baseUrl?, apiVersion?, deployment? }` with `.strict()` — it has no
model field, and no code path compares a requested model with anything. The only approximation is
`azure-openai`, which *overrides* the body's `model` with its deployment.

So: Azure keeps pinning the body `model` to its deployment on all three protocols, and `openai` /
`openai-compatible` relay the client's model to an upstream reachable only through that
connection's credential and base URL. Pinning every OpenAI-family connection to one model needs a
new `ModelConnectionConfig.model`, its own migration and control-plane UI; that is a different
unit's work, and it is not in this Issue's scope.

### D9 — No sixth accounting state is invented

The Issue's "record the row with `accounting_state` 'unmetered'" names a state that does not exist.
The vocabulary is `pending | complete | partial | failed | unavailable`, and the two situations it
covers are genuinely different:

- **Upstream finished and reported no usage** (the named `openai-compatible` risk): a row is
  recorded at unmeasured zeros with `price_table_version = null`, which settles the run
  `unavailable`. Counts are never fabricated.
- **The stream stopped before any terminal usage frame**: `recorder.fail`, which settles `failed`.

Both outcomes are **the two OpenAI dialects' rule only.** On `anthropic-messages` a response that
reports no `usage` settles `failed` whether or not it declared itself finished, exactly as it did
before this unit — and every real Anthropic response does declare itself finished, a non-streaming
body through `type: "message"` and a stream through `message_stop`. Widening the `unavailable`
outcome to Anthropic traffic would have been a silent change to how the gateway's only existing
dialect settles, which is what "Anthropic ingress behaviour is unchanged" forbids. `settle` in the
Lean model therefore takes the protocol, and the two rules are proved separately.

A `usage` object whose counters do not parse as non-negative safe integers — an upstream reporting
`{"prompt_tokens": "90"}`, say — is **not** a measurement either. It is unmetered, so it settles
`unavailable` rather than being priced as a genuinely free turn: claiming a measured zero for a
count that was never read is itself a fabricated count.

## Consequences

- `docs/spec.md` §9's fenced block gains the two routes; the two inventory gates then pass against
  six routes rather than four. §10 and §12 are untouched, so `ModelProvider` and
  `ModelCapabilities` still print exactly as the specification does.
- `run_usage_records.wire_protocol` is `NOT NULL DEFAULT 'anthropic-messages'` with a check
  constraint over D5's three values. The default is what lets a gateway pod from the previous
  release keep inserting rows while `migrate` runs at container start on Cloud Run and Azure
  Container Apps. Rollback is a plain column drop; no backfill rewrites a token count.
- Anthropic ingress behaviour is unchanged by construction: no adapter's `createMessage` is
  touched, and the T4 refinement theorem proves the current route table embeds in the target one.
- Passthrough is not transparency: D4's hosted tools, D10's `previous_response_id` / `conversation`
  and a Responses `store: true` are the four things a relayed body does not get to keep. Each is a
  capability that would execute or persist outside the sandbox, and each is refused or overwritten
  before anything leaves the process. An engine that needs conversation continuity sends the context
  it needs with the request, which is what `session_transcripts` holds.
- `docs/compatibility/openai-ingress.md` states the ingress × upstream matrix and says, in those
  words, that its fixtures are hand-authored from the published event schemas. No live `openai` or
  `azure-openai` credential exists in this repository — `docs/compatibility/providers.md` already
  records both as out of tested scope under D-03 — so what is measured is the gateway's own half of
  each combination, never whether a particular upstream accepts the relayed body.
- The whole rule is modelled and proved in Lean as the `gateway-ingress` family; the new column is
  carried into the ER model as a refinement rather than as a weakening.

## Related decisions

- [ADR-0065](0065-an-agents-engine-is-an-extension-point-behind-one-port.md) — the engine port these
  dialects exist to serve, and the non-goal that D4 enforces.
- [ADR-0062](0062-the-specification-is-a-lean-4-model-and-typescript-is-tested-against-it.md) — why
  D2, D4, D5 and D7 are stated in Lean as well as in prose.
- [ADR-0018](0018-the-declared-owns-line-is-the-ownership-boundary.md) — why the PR's `Owns globs:`
  line, not the Issue's guidance, is the boundary for the `docs/spec.md` and `packages/core` edits
  this record requires.
- [ADR-0003](0003-adr-naming-preserves-file-ownership.md) — why this record is `0068-<slug>.md`
  rather than the Issue's `ENG-05-<slug>.md`.
- `docs/spec.md` §9 — amended by this record.
- Issue [#304](https://github.com/indxjp/agent-workspace/issues/304) — the unit;
  tracker [#299](https://github.com/indxjp/agent-workspace/issues/299).
