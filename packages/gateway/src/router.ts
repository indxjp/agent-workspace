import type {
  GatewayRoute,
  GatewayRouter,
  ModelProvider,
  RequestContext,
  WireProtocol,
  WireProtocolForwarder,
} from './types.js';
import {
  ModelConnectionIncompleteError,
  ModelCredentialUnavailableError,
  ModelOperationUnsupportedError,
} from './types.js';
import { protocolNotSupported } from './providers/passthrough.js';
import { json, problem, readGatewayRequest } from './router-http.js';
import { modelListingResponse } from './router-models.js';
import { inModelSpan } from './router-tracing.js';

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

type ProviderTable = ReadonlyMap<string, ModelProvider>;

function providerFor(
  providers: ProviderTable,
  context?: RequestContext,
): { readonly provider: ModelProvider; readonly context: RequestContext } | Response {
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
      { context },
    );
  }
  return { provider, context };
}

/** Attach the operation's client headers without mutating the authenticated base context. */
function contextForRequest(context: RequestContext, request: Request): RequestContext {
  return { ...context, requestHeaders: new Headers(request.headers) };
}

function assertProviderTable(providers: readonly ModelProvider[]): ProviderTable {
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

async function listModels(
  request: Request,
  providers: ProviderTable,
  context?: RequestContext,
): Promise<Response> {
  if (providers.size === 0) {
    return problem(
      503,
      'provider_not_registered',
      'No model provider is registered for model discovery.',
    );
  }

  const selected = providerFor(providers, context);
  if (selected instanceof Response) return selected;
  const models = await selected.provider.listModels(contextForRequest(selected.context, request));
  return modelListingResponse(request, models, selected.context.providerId);
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
  providers: ProviderTable,
  context?: RequestContext,
): Promise<Response> {
  const selected = providerFor(providers, context);
  if (selected instanceof Response) return selected;
  const forwarder = asForwarder(selected.provider, protocol);
  if (forwarder === null) return protocolNotSupported(protocol, selected.context.requestId);

  const validated = await readGatewayRequest(request, context);
  if (validated instanceof Response) return validated;
  const call = { operation: 'chat', model: validated.model, context: selected.context };
  return inModelSpan(call, () =>
    forwarder.forward(validated, protocol, contextForRequest(selected.context, request)),
  );
}

async function createMessage(
  request: Request,
  providers: ProviderTable,
  context?: RequestContext,
): Promise<Response> {
  const selected = providerFor(providers, context);
  if (selected instanceof Response) return selected;

  const validated = await readGatewayRequest(request, context);
  if (validated instanceof Response) return validated;
  const call = { operation: 'chat', model: validated.model, context: selected.context };
  return inModelSpan(call, () =>
    selected.provider.createMessage(validated, contextForRequest(selected.context, request)),
  );
}

async function countTokens(
  request: Request,
  providers: ProviderTable,
  context?: RequestContext,
): Promise<Response> {
  const selected = providerFor(providers, context);
  if (selected instanceof Response) return selected;
  const { provider } = selected;
  if (provider.countTokens === undefined) {
    return problem(
      501,
      'provider_operation_not_supported',
      `Model provider ${JSON.stringify(provider.id)} does not support token counting.`,
      { context },
    );
  }

  const validated = await readGatewayRequest(request, context);
  if (validated instanceof Response) return validated;
  const countTokensWith = provider.countTokens.bind(provider);
  const call = { operation: 'count_tokens', model: validated.model, context: selected.context };
  return json(
    await inModelSpan(call, () =>
      countTokensWith(validated, contextForRequest(selected.context, request)),
    ),
  );
}

/** The route for a request line: a handler, or the typed 404 / 405 refusal. */
function dispatchRoute(
  request: Request,
  providers: ProviderTable,
  context?: RequestContext,
): Promise<Response> | Response {
  const { pathname } = new URL(request.url);
  const method = request.method.toUpperCase();

  if (pathname === '/health' && method === 'GET') return json({ status: 'ok' });
  if (pathname === '/v1/models' && method === 'GET') return listModels(request, providers, context);
  if (pathname === '/v1/messages' && method === 'POST') {
    return createMessage(request, providers, context);
  }
  if (pathname === '/v1/messages/count_tokens' && method === 'POST') {
    return countTokens(request, providers, context);
  }
  const relayed = RELAYED_PROTOCOLS[pathname];
  if (relayed !== undefined && method === 'POST') {
    return forwardProtocol(request, relayed, providers, context);
  }

  const knownPath = ROUTES.find((route) => route.path === pathname);
  if (knownPath !== undefined) {
    return problem(405, 'method_not_allowed', `${method} is not allowed for ${pathname}.`, {
      context,
      headers: { allow: knownPath.method },
    });
  }
  return problem(404, 'not_found_error', `The gateway has no route for ${pathname}.`, {
    context,
  });
}

/** The typed response for a failure an adapter is allowed to raise, or `undefined` to rethrow it. */
function adapterFailureResponse(error: unknown, context?: RequestContext): Response | undefined {
  if (error instanceof ModelConnectionIncompleteError) {
    return problem(409, 'model_connection_incomplete', error.message, { context });
  }
  if (error instanceof ModelOperationUnsupportedError) {
    return problem(501, 'provider_operation_not_supported', error.message, { context });
  }
  // A keyless token the retry after a `401` could not renew.
  if (error instanceof ModelCredentialUnavailableError) {
    return problem(503, 'model_credential_unavailable', error.message, { context });
  }
  return undefined;
}

/**
 * Construct a router around an explicit provider table. The later integration task owns the
 * registry and composition root; keeping them out of this module lets each provider be tested in
 * isolation with `createRouter([provider])`.
 */
export function createRouter(providers: readonly ModelProvider[]): GatewayRouter {
  const providerTable = assertProviderTable(providers);

  return {
    routes: ROUTES,
    async fetch(request, context) {
      try {
        return await dispatchRoute(request, providerTable, context);
      } catch (error) {
        const response = adapterFailureResponse(error, context);
        if (response === undefined) throw error;
        return response;
      }
    },
  };
}
