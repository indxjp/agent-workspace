/**
 * The shared relay behind `POST /v1/responses` and `POST /v1/chat/completions` (ADR-0068).
 *
 * All three OpenAI-family adapters forward through this one module, so the security-relevant rules
 * — the closed hosted-tool allowlist, the refused vendor-side conversation state, the two header
 * allowlists, and the injected `stream_options.include_usage` — are stated once and tested once per
 * adapter rather than copied three times.
 */
import { guardedFetch, type EgressPolicyConfig } from '@agent-workspace/core';

import type {
  ForwardRequest,
  RequestContext,
  WireProtocol,
  WireProtocolForwarder,
} from '../types.js';

/** The two dialects an OpenAI-family connection relays. `anthropic-messages` is translated, not
 * relayed, so it is deliberately absent: its absence is what refuses the route. */
export const OPENAI_WIRE_PROTOCOLS: ReadonlySet<WireProtocol> = new Set<WireProtocol>([
  'openai-responses',
  'openai-chat-completions',
]);

/**
 * Tool types the platform will relay, as a closed allowlist (ADR-0068 D4).
 *
 * Everything else — `web_search`, `file_search`, `code_interpreter`, `image_generation`, `mcp`,
 * `computer_use_preview`, hosted `shell` — executes at the model vendor, outside the sandbox and
 * past the egress policy and connector model. A denylist would fail open for the next hosted type
 * the vendor ships, so the rule is inverted and widening it is an edit to this list.
 */
const RELAYABLE_TOOL_TYPES: ReadonlySet<string> = new Set(['function', 'custom']);

/**
 * Top-level fields that ask for a vendor-hosted tool without declaring one in `tools` (ADR-0068 D4).
 *
 * Chat Completions turns on OpenAI's hosted web search through `web_search_options` rather than a
 * `tools` entry, so `{model, messages, web_search_options: {}}` would otherwise pass the allowlist
 * above unchallenged and get exactly the vendor-side execution the rule exists to prevent. The rule
 * is about where a tool runs, not about which field asked for it, so it is checked wherever the
 * request asks.
 */
const HOSTED_TOOL_FIELDS = ['web_search_options'] as const;

/**
 * Top-level fields that hold the turn's conversation state at the model vendor (ADR-0068 D10).
 *
 * The Responses API resumes a stored response through `previous_response_id`, and `conversation`
 * names the same vendor-side state a different way. Either one puts a run's context outside the
 * platform's session boundary and outside `session_transcripts`, keyed by an id the platform never
 * sees, so any run reaching the same model connection that learns the id could resume another run's
 * context through the shared credential. `prompt` resolves a prompt object stored in the
 * organisation that owns the substituted credential, and that object carries its own instructions
 * and its own tool configuration: it is vendor-held state of the same kind, and a stored prompt
 * declaring a hosted tool would reach vendor-side execution through a body with no `tools` at all.
 * Checked for every relayed dialect, like {@link HOSTED_TOOL_FIELDS}: the rule is about where the
 * state lives, not about which route asked.
 */
const VENDOR_STATE_FIELDS = ['previous_response_id', 'conversation', 'prompt'] as const;

/** Client request headers that may travel upstream, by name rather than by prefix: an `openai-`
 * prefix would also admit `openai-organization` and `openai-project`, letting the caller choose
 * which account on the stored credential serves and is billed for the turn, which is what the model
 * connection decides. The caller's run token lives in `authorization`, which is never copied: the
 * upstream sees the substituted credential only. */
const UPSTREAM_HEADERS: ReadonlySet<string> = new Set(['openai-beta']);

/** Upstream response headers the client may see. Rebuilding from this list is what keeps
 * `set-cookie`, organisation identifiers, rate-limit state and any upstream credential header off
 * the response. `x-request-id` is OpenAI's request id, `request-id` Anthropic's. */
const CLIENT_RESPONSE_HEADERS = [
  'content-type',
  'cache-control',
  'retry-after',
  'x-request-id',
  'request-id',
] as const;

type PassthroughCredentialScheme = 'bearer' | 'api-key';

export type PassthroughConfig = {
  /** The upstream URL for one protocol, or `null` when this connection cannot serve it. */
  readonly urlFor: (protocol: WireProtocol) => string | null;
  readonly credentialScheme: PassthroughCredentialScheme;
  readonly policy: EgressPolicyConfig;
  readonly fetch: typeof fetch;
  /**
   * Overrides the relayed body's `model`. Azure addresses a deployment rather than a model name, so
   * its adapter pins this; `openai` and `openai-compatible` leave the client's model alone
   * (ADR-0068 D8).
   */
  readonly pinnedModel?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function refusal(status: number, code: string, message: string, requestId: string): Response {
  // Carries the code under both `type` and `code`: the gateway's own envelope reads the former,
  // and an OpenAI SDK client surfaces the latter on its `APIError`.
  return Response.json(
    { type: 'error', error: { type: code, code, message }, request_id: requestId },
    { status, headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
}

/** The refusal a route answers when the run token's connection family does not speak the dialect. */
export function protocolNotSupported(protocol: WireProtocol, requestId: string): Response {
  return refusal(
    400,
    'protocol_not_supported_for_connection',
    `This run's model connection does not accept ${protocol} traffic.`,
    requestId,
  );
}

/**
 * Names the first tool the platform refuses to relay, or `null` when every declared tool is
 * relayable. A tool entry with no string `type` is refused: the rule fails closed.
 */
export function unrelayableToolType(request: ForwardRequest): string | null {
  const tools = request['tools'];
  if (!Array.isArray(tools)) return null;
  for (const tool of tools) {
    const type = isRecord(tool) ? tool['type'] : undefined;
    if (typeof type !== 'string' || !RELAYABLE_TOOL_TYPES.has(type)) {
      return typeof type === 'string' ? type : 'unnamed';
    }
  }
  return null;
}

/**
 * Names the first top-level field asking for a vendor-hosted tool, or `null` when none does.
 *
 * The same rule as {@link unrelayableToolType}, applied to the other way a request can ask for
 * vendor-side execution. Checked for every relayed dialect rather than only for Chat Completions:
 * the rule is about where a tool runs, and a field the Responses API does not define cannot become
 * permissible by arriving on that route.
 */
export function hostedToolField(request: ForwardRequest): string | null {
  for (const field of HOSTED_TOOL_FIELDS) {
    if (request[field] !== undefined) return field;
  }
  return null;
}

/**
 * Names the first field referring to conversation or prompt state held at the model vendor, or `null`
 * when none does (ADR-0068 D10).
 *
 * A present field asks for it whatever its value, so a `null` or empty one is refused too: only an
 * absent field does not ask.
 */
export function vendorStateField(request: ForwardRequest): string | null {
  for (const field of VENDOR_STATE_FIELDS) {
    if (request[field] !== undefined) return field;
  }
  return null;
}

/**
 * `background: true` on `POST /v1/responses`, which the gateway refuses (ADR-0068 D4).
 *
 * A backgrounded response returns a `queued` snapshot with `usage: null` immediately and is then
 * polled through `GET /v1/responses/{id}`, which spec §9 does not publish. Relaying it would spend
 * the run's tokens on a turn no route can ever collect the usage for: the client sees a queued id it
 * cannot resolve, and the run settles `unavailable` with the real spend unmetered. The programme's
 * rule for a capability the platform cannot account for is to refuse it, not to emulate it.
 */
function isUnreachableBackgroundRequest(request: ForwardRequest, protocol: WireProtocol): boolean {
  return protocol === 'openai-responses' && request['background'] === true;
}

/**
 * The body actually relayed upstream: the client's, with Azure's deployment pinned where the
 * adapter asks for it, with vendor-side retention turned off on both relayed dialects, and with
 * usage reporting turned on for a streamed Chat Completions request.
 *
 * `store: true` leaves the turn's prompt and completion at the model vendor, under the stored
 * credential's organisation and an id the platform never sees, outside `session_transcripts` and
 * outside anything the platform can see or delete. The Responses API defaults it to **`true`**, and
 * a Chat Completions client can ask for it, so the relay states `false` on both rather than trusting
 * the client: it is injected when the client omitted it and overwrites a client `true`, for the same
 * reason `stream_options.include_usage` is injected below (ADR-0068 D10).
 *
 * A streamed Chat Completions response reports no `usage` at all unless
 * `stream_options.include_usage` is set, so the gateway sets it even when the client omitted it —
 * otherwise the run could not be metered. Any `stream_options` the client sent is merged, not
 * replaced.
 */
export function relayedBody(
  request: ForwardRequest,
  protocol: WireProtocol,
  pinnedModel?: string,
): ForwardRequest {
  const pinned: ForwardRequest =
    pinnedModel === undefined ? request : { ...request, model: pinnedModel };
  if (protocol === 'anthropic-messages') return pinned;
  const unretained: ForwardRequest = { ...pinned, store: false };
  if (protocol !== 'openai-chat-completions' || unretained['stream'] !== true) return unretained;
  const options = isRecord(unretained['stream_options']) ? unretained['stream_options'] : {};
  return { ...unretained, stream_options: { ...options, include_usage: true } };
}

function upstreamHeaders(context: RequestContext, scheme: PassthroughCredentialScheme): Headers {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (scheme === 'bearer') headers.set('authorization', `Bearer ${context.credential}`);
  else headers.set('api-key', context.credential);
  context.requestHeaders?.forEach((value, name) => {
    if (UPSTREAM_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  });
  return headers;
}

/** Rebuild an upstream response with only the {@link CLIENT_RESPONSE_HEADERS} the client may see. */
export function clientResponse(upstream: Response): Response {
  const headers = new Headers();
  for (const name of CLIENT_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  // The body is handed over unread, so a streamed relay stays a stream.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/** Build the forwarder an OpenAI-family adapter exposes alongside its `ModelProvider` members. */
export function createWireProtocolForwarder(config: PassthroughConfig): WireProtocolForwarder {
  return {
    forwards: OPENAI_WIRE_PROTOCOLS,
    async forward(request: ForwardRequest, protocol: WireProtocol, context: RequestContext) {
      const url = OPENAI_WIRE_PROTOCOLS.has(protocol) ? config.urlFor(protocol) : null;
      if (url === null) return protocolNotSupported(protocol, context.requestId);

      const refused = unrelayableToolType(request);
      if (refused !== null) {
        return refusal(
          400,
          'hosted_tool_not_permitted',
          `Tool type ${JSON.stringify(refused)} executes outside this platform's sandbox and cannot be relayed. Only function and custom tools are forwarded.`,
          context.requestId,
        );
      }

      const hostedField = hostedToolField(request);
      if (hostedField !== null) {
        return refusal(
          400,
          'hosted_tool_not_permitted',
          `${JSON.stringify(hostedField)} asks the model vendor to run a tool outside this platform's sandbox and cannot be relayed. Declare a function or custom tool instead.`,
          context.requestId,
        );
      }

      if (isUnreachableBackgroundRequest(request, protocol)) {
        return refusal(
          400,
          'background_not_supported',
          'This gateway does not relay background responses: it publishes no route to retrieve one, so the tokens it spent could never be metered. Send the request without "background".',
          context.requestId,
        );
      }

      const vendorState = vendorStateField(request);
      if (vendorState !== null) {
        return refusal(
          400,
          'vendor_state_not_permitted',
          `${JSON.stringify(vendorState)} refers to state held at the model vendor, outside this platform's session boundary, so the platform can neither see nor account for it. Send the context and instructions the turn needs in the request instead.`,
          context.requestId,
        );
      }

      const upstream = await guardedFetch(
        url,
        {
          method: 'POST',
          headers: upstreamHeaders(context, config.credentialScheme),
          body: JSON.stringify(relayedBody(request, protocol, config.pinnedModel)),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        },
        config.policy,
        config.fetch,
      );
      return clientResponse(upstream);
    },
  };
}
