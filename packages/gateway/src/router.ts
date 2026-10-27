import { redacted } from '@agent-workspace/core/telemetry';
import { inSpan, SpanKind, SpanStatusCode } from '@agent-workspace/core/tracing';

import type {
  AnthropicMessageRequest,
  GatewayRoute,
  GatewayRouter,
  ModelInfo,
  ModelProvider,
  RequestContext,
  WireProtocol,
  WireProtocolForwarder,
} from './types.js';
import { ModelConnectionIncompleteError } from './types.js';
import { protocolNotSupported } from './providers/passthrough.js';
import { z } from 'zod';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;
const GatewayRequestSchema = z.object({ model: z.string().trim().min(1) }).catchall(z.unknown());

export const ROUTES = [
  { method: 'POST', path: '/v1/messages' },
  { method: 'POST', path: '/v1/messages/count_tokens' },
  { method: 'POST', path: '/v1/responses' },
  { method: 'POST', path: '/v1/chat/completions' },
  { method: 'GET', path: '/v1/models' },
  { method: 'GET', path: '/health' },
] as const satisfies readonly GatewayRoute[];

/** The dialect each relayed route speaks. `/v1/messages` is translated, so it is not here. */
const RELAYED_PROTOCOLS: Readonly<Record<string, WireProtocol>> = {
  '/v1/responses': 'openai-responses',
  '/v1/chat/completions': 'openai-chat-completions',
};

/** Model-listing envelopes. OpenAI SDK clients call `models.list()` and parse `{object, data}`. */
const MODEL_FORMATS = ['anthropic', 'openai'] as const;
type ModelFormat = (typeof MODEL_FORMATS)[number];

/**
 * The header every Anthropic SDK request carries and no OpenAI SDK request does. It is the only
 * signal at this route that names the *client*, which is what decides the envelope (ADR-0068 D6).
 */
const ANTHROPIC_CLIENT_HEADER = 'anthropic-version';

type GatewayErrorType =
  | 'gateway_context_required'
  | 'invalid_request_error'
  | 'method_not_allowed'
  | 'model_connection_incomplete'
  | 'not_found_error'
  | 'provider_not_registered'
  | 'provider_operation_not_supported';

function requestId(context?: RequestContext): string {
  return context?.requestId ?? `gateway_${crypto.randomUUID()}`;
}

function json(body: unknown, status = 200, headers?: Readonly<Record<string, string>>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

function problem(
  status: number,
  type: GatewayErrorType,
  message: string,
  context?: RequestContext,
  headers?: Readonly<Record<string, string>>,
): Response {
  return json(
    {
      type: 'error',
      error: { type, message },
      request_id: requestId(context),
    },
    status,
    headers,
  );
}

async function jsonObject(
  request: Request,
  context?: RequestContext,
): Promise<Record<string, unknown> | Response> {
  const contentType = request.headers.get('content-type');
  if (contentType === null || !contentType.toLowerCase().startsWith('application/json')) {
    return problem(
      415,
      'invalid_request_error',
      'This endpoint accepts application/json request bodies.',
      context,
    );
  }

  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return problem(400, 'invalid_request_error', 'The request body is not valid JSON.', context);
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return problem(
      400,
      'invalid_request_error',
      'The request body must be a JSON object.',
      context,
    );
  }
  return value as Record<string, unknown>;
}

function gatewayRequest(
  value: Record<string, unknown>,
  context?: RequestContext,
): AnthropicMessageRequest | Response {
  const parsed = GatewayRequestSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return problem(
    400,
    'invalid_request_error',
    'The request body must include a non-empty string "model".',
    context,
  );
}

function providerFor(
  providers: ReadonlyMap<string, ModelProvider>,
  context?: RequestContext,
): ModelProvider | Response {
  if (context === undefined) {
    return problem(
      401,
      'gateway_context_required',
      'A verified per-run gateway context is required for this route.',
    );
  }

  const provider = providers.get(context.providerId);
  if (provider === undefined) {
    return problem(
      503,
      'provider_not_registered',
      `Model provider ${JSON.stringify(context.providerId)} is not registered.`,
      context,
    );
  }
  return provider;
}

/** Attach the operation's client headers without mutating the authenticated base context. */
function contextForRequest(context: RequestContext, request: Request): RequestContext {
  return { ...context, requestHeaders: new Headers(request.headers) };
}

function assertProviderTable(
  providers: readonly ModelProvider[],
): ReadonlyMap<string, ModelProvider> {
  const table = new Map<string, ModelProvider>();
  for (const provider of providers) {
    const id = provider.id.trim();
    if (id.length === 0) {
      throw new Error('A model provider id must not be blank.');
    }
    if (table.has(id)) {
      throw new Error(`Duplicate model provider id ${JSON.stringify(id)}.`);
    }
    table.set(id, provider);
  }
  return table;
}

function isModelFormat(value: string | null): value is ModelFormat {
  return value !== null && (MODEL_FORMATS as readonly string[]).includes(value);
}

/**
 * Which model-listing envelope this request wants (ADR-0068 D6).
 *
 * The envelope belongs to the *client*, not to the run's connection family: Claude Code reaches the
 * gateway through `ANTHROPIC_BASE_URL` on every family, including the three OpenAI ones, so keying
 * on the family would answer an OpenAI envelope to a client that cannot parse it. `anthropic-version`
 * is the discriminator — the Anthropic SDK always sends it and the OpenAI SDK never does — and
 * `Accept: application/json`, which both send identically, is not. An explicit `?format=` or
 * `x-gateway-model-format` overrides both.
 */
function modelListingFormat(request: Request): ModelFormat {
  const query = new URL(request.url).searchParams.get('format');
  if (isModelFormat(query)) return query;
  const header = request.headers.get('x-gateway-model-format');
  if (isModelFormat(header)) return header;
  return request.headers.has(ANTHROPIC_CLIENT_HEADER) ? 'anthropic' : 'openai';
}

/** Map the adapter's Anthropic-shaped catalogue onto OpenAI's `models.list()` envelope. */
function openAIModelListing(models: readonly ModelInfo[], providerId: string): unknown {
  return {
    object: 'list',
    data: models.map((model) => ({
      id: model.id,
      object: 'model',
      created: Math.max(0, Math.floor(Date.parse(model.created_at) / 1_000) || 0),
      owned_by: providerId,
    })),
  };
}

async function listModels(
  request: Request,
  providers: ReadonlyMap<string, ModelProvider>,
  context?: RequestContext,
): Promise<Response> {
  if (providers.size === 0) {
    return problem(
      503,
      'provider_not_registered',
      'No model provider is registered for model discovery.',
    );
  }

  const provider = providerFor(providers, context);
  if (provider instanceof Response) return provider;
  const verified = context as RequestContext;
  const models = await provider.listModels(contextForRequest(verified, request));
  if (modelListingFormat(request) === 'openai') {
    return json(openAIModelListing(models, verified.providerId));
  }
  return json({
    data: models,
    first_id: models.at(0)?.id ?? null,
    last_id: models.at(-1)?.id ?? null,
    has_more: false,
  });
}

/** The run's credential, for {@link redacted}; an empty one would mask every character. */
function credentialOf(context: RequestContext): readonly string[] {
  return context.credential === '' ? [] : [context.credential];
}

/**
 * One model call as a CLIENT span (ADR-0155): the operation, the run's provider id, the requested
 * model and the upstream status. Never the prompt, the reply, a header or a key. The model name is
 * caller text, so it is redacted and capped like a log field, with the run's credential masked too.
 */
function inModelSpan<T>(
  operation: string,
  providerId: string,
  model: string,
  secrets: readonly string[],
  call: () => Promise<T>,
): Promise<T> {
  return inSpan(
    `${operation} ${providerId}`,
    SpanKind.CLIENT,
    {
      'gen_ai.operation.name': operation,
      'gen_ai.provider.name': providerId,
      'gen_ai.request.model': redacted(model, secrets),
    },
    async (span) => {
      const result = await call();
      if (result instanceof Response) {
        span.setAttribute('http.response.status_code', result.status);
        if (result.status >= 400) span.setStatus({ code: SpanStatusCode.ERROR });
      }
      return result;
    },
  );
}

function asForwarder(
  provider: ModelProvider,
  protocol: WireProtocol,
): WireProtocolForwarder | null {
  // Probed structurally: spec §10's interface is reproduced member-for-member and must not grow
  // (ADR-0068 D3).
  const candidate = provider as Partial<WireProtocolForwarder>;
  if (typeof candidate.forward !== 'function') return null;
  return candidate.forwards?.has(protocol) === true ? (candidate as WireProtocolForwarder) : null;
}

/**
 * Relay one OpenAI-dialect request to the run's own upstream (ADR-0068 D1). The protocol refusal is
 * decided here, before the adapter's hosted-tool rule and before any network call, so an
 * Anthropic-family connection never reaches an upstream on these routes.
 */
async function forwardProtocol(
  request: Request,
  protocol: WireProtocol,
  providers: ReadonlyMap<string, ModelProvider>,
  context?: RequestContext,
): Promise<Response> {
  const provider = providerFor(providers, context);
  if (provider instanceof Response) return provider;
  const verified = context as RequestContext;
  const forwarder = asForwarder(provider, protocol);
  if (forwarder === null) return protocolNotSupported(protocol, verified.requestId);

  const body = await jsonObject(request, context);
  if (body instanceof Response) return body;
  const validated = gatewayRequest(body, context);
  if (validated instanceof Response) return validated;
  return inModelSpan('chat', verified.providerId, validated.model, credentialOf(verified), () =>
    forwarder.forward(validated, protocol, contextForRequest(verified, request)),
  );
}

async function createMessage(
  request: Request,
  providers: ReadonlyMap<string, ModelProvider>,
  context?: RequestContext,
): Promise<Response> {
  const provider = providerFor(providers, context);
  if (provider instanceof Response) return provider;

  const body = await jsonObject(request, context);
  if (body instanceof Response) return body;
  const validated = gatewayRequest(body, context);
  if (validated instanceof Response) return validated;
  const verified = context as RequestContext;
  return inModelSpan('chat', verified.providerId, validated.model, credentialOf(verified), () =>
    provider.createMessage(validated, contextForRequest(verified, request)),
  );
}

async function countTokens(
  request: Request,
  providers: ReadonlyMap<string, ModelProvider>,
  context?: RequestContext,
): Promise<Response> {
  const provider = providerFor(providers, context);
  if (provider instanceof Response) return provider;
  if (provider.countTokens === undefined) {
    return problem(
      501,
      'provider_operation_not_supported',
      `Model provider ${JSON.stringify(provider.id)} does not support token counting.`,
      context,
    );
  }

  const body = await jsonObject(request, context);
  if (body instanceof Response) return body;
  const validated = gatewayRequest(body, context);
  if (validated instanceof Response) return validated;
  const verified = context as RequestContext;
  const countTokensWith = provider.countTokens.bind(provider);
  return json(
    await inModelSpan(
      'count_tokens',
      verified.providerId,
      validated.model,
      credentialOf(verified),
      () => countTokensWith(validated, contextForRequest(verified, request)),
    ),
  );
}

/**
 * Construct a router around an explicit provider table. The later integration task owns the
 * registry and composition root; keeping them out of this module lets each provider be tested in
 * isolation with `createRouter([provider])`.
 */
export function createRouter(providers: readonly ModelProvider[]): GatewayRouter {
  const providerTable = assertProviderTable(providers);

  async function dispatch(request: Request, context?: RequestContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method.toUpperCase();

    if (pathname === '/health' && method === 'GET') {
      return json({ status: 'ok' });
    }
    if (pathname === '/v1/models' && method === 'GET') {
      return listModels(request, providerTable, context);
    }
    if (pathname === '/v1/messages' && method === 'POST') {
      return createMessage(request, providerTable, context);
    }
    if (pathname === '/v1/messages/count_tokens' && method === 'POST') {
      return countTokens(request, providerTable, context);
    }
    const relayed = RELAYED_PROTOCOLS[pathname];
    if (relayed !== undefined && method === 'POST') {
      return forwardProtocol(request, relayed, providerTable, context);
    }

    const knownPath = ROUTES.find((route) => route.path === pathname);
    if (knownPath !== undefined) {
      return problem(
        405,
        'method_not_allowed',
        `${method} is not allowed for ${pathname}.`,
        context,
        { allow: knownPath.method },
      );
    }
    return problem(404, 'not_found_error', `The gateway has no route for ${pathname}.`, context);
  }

  return {
    routes: ROUTES,
    async fetch(request, context) {
      try {
        return await dispatch(request, context);
      } catch (error) {
        if (error instanceof ModelConnectionIncompleteError) {
          return problem(409, 'model_connection_incomplete', error.message, context);
        }
        throw error;
      }
    },
  };
}
