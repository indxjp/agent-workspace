# OpenAI ingress × upstream

Which gateway ingress protocol reaches which model-connection family, and what is actually measured
about each combination. The rule itself is [ADR-0068](../adr/0068-openai-wire-protocols-are-passthrough-ingress.md);
this page is the evidence for it.

[`providers.md`](providers.md) is the other half of the picture: it records how faithfully each
adapter *translates* Anthropic Messages. This page records what each adapter *relays*, which is a
different question and has a different fixture basis.

## The matrix

Rows are the model connection's provider; columns are the gateway route a client calls. `relay`
means the request body is passed through to the upstream's matching endpoint with the stored
credential substituted; `translate` means the existing Anthropic → Responses mapping.

| Connection family     | `POST /v1/messages` | `POST /v1/responses` | `POST /v1/chat/completions` | `GET /v1/models` |
| --------------------- | ------------------- | -------------------- | --------------------------- | ---------------- |
| `anthropic`           | relay (native)      | 400 `protocol_not_supported_for_connection` | 400 `protocol_not_supported_for_connection` | the client's envelope |
| `anthropic-compatible`| relay (native)      | 400 `protocol_not_supported_for_connection` | 400 `protocol_not_supported_for_connection` | the client's envelope |
| `openai`              | translate           | relay                | relay                       | the client's envelope |
| `azure-openai`        | translate           | relay                | relay                       | the client's envelope |
| `openai-compatible`   | translate           | relay                | relay                       | the client's envelope |

`GET /v1/models` is the one cell the connection family does not decide. Its envelope follows the
calling client — the Anthropic `{data, first_id, last_id, has_more}` shape when the request carries
`anthropic-version`, the OpenAI `{object: 'list', data: […]}` shape when it does not — because
`ANTHROPIC_BASE_URL` points Claude Code at the gateway on every family, including the OpenAI ones
(ADR-0068 D6). `?format=openai|anthropic` and `x-gateway-model-format` override it.

Every relayed cell is measured both streaming and non-streaming.

| Combination | Streaming | Non-streaming | Metered as |
| --- | --- | --- | --- |
| `openai` × responses | ✓ | ✓ | `openai-responses` |
| `openai` × chat-completions | ✓ | ✓ | `openai-chat-completions` |
| `azure-openai` × responses | ✓ | ✓ | `openai-responses` |
| `azure-openai` × chat-completions | ✓ | ✓ | `openai-chat-completions` |
| `openai-compatible` × responses | ✓ | ✓ | `openai-responses` |
| `openai-compatible` × chat-completions | ✓ | ✓ | `openai-chat-completions` |

Azure's URL for each cell comes from `buildAzureOpenAIUrl`, and is measured on all four of its
surfaces (the v1 default, `preview`, and a dated `api-version` for each operation). Azure relays its
deployment as the body's `model` on every protocol; `openai` and `openai-compatible` relay the
client's own model (ADR-0068 D8).

## Fixture basis

**The fixtures on this page are hand-authored from the published event schemas, not recorded from a
live account.** No `openai` or `azure-openai` credential exists in this repository —
[`providers.md`](providers.md) already records both as out of the tested 0.1.0 provider scope under
D-03 — so what a ✓ above means is precise and limited:

- **Measured**: the gateway's own half of the combination. The upstream URL, the substituted
  credential and its header scheme, the two header allowlists, the injected
  `stream_options.include_usage`, the hosted-tool and wrong-protocol refusals, and the usage
  arithmetic including the cached-prefix subtraction.
- **Not measured**: whether a particular upstream *accepts* the relayed body. That is the upstream's
  contract, and no assertion on this page depends on it.

The suites behind the table are `packages/gateway/src/providers/passthrough.test.ts` (per adapter and
protocol), `packages/gateway/src/ingress.test.ts` (end to end through the real router, registry and
metering boundary), `packages/gateway/src/usage/usage.test.ts` (the extractors over recorded SSE) and
`tests/formal/gateway-ingress.test.ts` (the `gateway-ingress` vector replay).

## What is refused, and why

| Refusal | Code | Reason |
| --- | --- | --- |
| An OpenAI dialect on an Anthropic-family connection | `protocol_not_supported_for_connection` | An engine that wants an Anthropic model speaks Anthropic Messages, which the gateway already serves. Translating the other way would lose the fields the dialect exists for, `reasoning` and `stream_options` among them. |
| A tool whose `type` is not `function` or `custom` | `hosted_tool_not_permitted` | A vendor-hosted tool executes at the model vendor, outside the sandbox and past the egress policy and connector model. The rule is a closed allowlist, so a hosted type the vendor ships next fails closed. |
| A top-level `web_search_options` | `hosted_tool_not_permitted` | Chat Completions turns on OpenAI's hosted web search through this field rather than through `tools`, so checking `tools` alone would let the same vendor-side execution through unchallenged. The rule is about *where* a tool runs, not about which field asked. |
| `background: true` on `/v1/responses` | `background_not_supported` | A backgrounded response is retrieved through `GET /v1/responses/{id}`, which §9 does not publish. Relaying one would spend the run's tokens on a turn no route could collect the usage for: the client would hold a `queued` id it cannot resolve and the run would settle `unavailable` with the real spend unmetered. A capability the platform cannot account for is refused, not emulated. |
| A `previous_response_id`, a `conversation` or a `prompt` | `vendor_state_not_permitted` | Each one refers to state the model vendor holds, outside the platform's session boundary and outside `session_transcripts`, keyed by an id the platform never sees. A run that learned another run's stored response id could otherwise resume its context through the shared credential, and a stored `prompt` object carries its own instructions and its own tools, so it would also reach a vendor-hosted tool through a body with no `tools` at all. Checked on both relayed dialects, for the same reason `web_search_options` is: the rule is about where the state lives, not about which route asked (ADR-0068 D10). |

The refused tool types this covers today are `web_search`, `file_search`, `code_interpreter`,
`image_generation`, `mcp`, `computer_use_preview` and a hosted `shell` — and, because the rule is an
allowlist rather than a list of these, anything else. Every refusal above reaches no upstream at all.

## What a relayed body does not get to keep

Passthrough is not transparency. Two fields are stated by the gateway rather than by the client:

- **`store: false`** on every relayed body, `POST /v1/responses` and `POST /v1/chat/completions`
  alike. `store: true` leaves the turn's prompt and completion at the model vendor, under the stored
  credential's organisation and an id the platform never sees, outside `session_transcripts`; the
  Responses API even defaults to it. So the relay injects `false` when the client omitted it and
  overwrites a client `true` on both dialects (ADR-0068 D10).
- **`stream_options.include_usage: true`** on every streamed Chat Completions body, merged into
  whatever the client sent, because the upstream otherwise reports no usage at all.

The headers are a named list in the same way. Of the client's own request headers only `openai-beta`
travels upstream; the client-visible response is rebuilt from `content-type`, `cache-control`,
`retry-after` and `x-request-id`. `openai-organization` and `openai-project` deliberately do **not**
travel, because they choose which account on the stored credential serves and is billed for the turn,
and that is the model connection's decision rather than the caller's (ADR-0068 D7).

### Declared gap

Because both directions are lists of names, a header a particular upstream needs and this page does
not name is **dropped** rather than relayed — an Azure `x-ms-*`, say, or an `openai-` header OpenAI
ships next. That direction fails closed by design: adding a name is a reviewable edit to
`UPSTREAM_HEADERS`, and no assertion on this page depends on a header outside the list travelling.

## Metering

`run_usage_records.wire_protocol` names which dialect served each row. Two corrections are applied
before OpenAI's numbers reach a price table built for Anthropic's additive conventions:

- `input_tokens` / `prompt_tokens` **include** the cached prefix, so the gateway records
  `inputTokens = input − cached` and `cacheReadInputTokens = cached`. Without this every cached
  request is billed twice for its prefix.
- `reasoning_tokens` is already **inside** `output_tokens`, so it is recorded nowhere extra.

An upstream that finishes without reporting usage at all — the known `openai-compatible` case, since
vLLM, Ollama and LM Studio do not all honour `stream_options.include_usage` — is recorded at
unmeasured zeros with no price version, which settles the run `unavailable`. So is one whose `usage`
counters do not parse as non-negative safe integers: a reported `"90"` was never a measurement, and
pricing it at zero would be indistinguishable from a genuinely free turn. A stream that stops before
any terminal frame settles it `failed`. Counts are never fabricated.

Both apply to the two OpenAI dialects only. On `anthropic-messages` a 200 reporting no `usage`
settles `failed`, exactly as it did before the gateway spoke three dialects (ADR-0068 D9).
