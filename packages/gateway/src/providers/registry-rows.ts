import { ModelOperationUnsupportedError } from '../types.js';
import type {
  AnthropicCountTokensRequest,
  AnthropicMessageRequest,
  ForwardRequest,
  ModelCapabilities,
  ModelInfo,
  ModelProvider,
  RequestContext,
  WireProtocol,
  WireProtocolForwarder,
} from '../types.js';
import { OPENAI_WIRE_PROTOCOLS } from './passthrough.js';
import type { RegisteredProviderId } from './registry-ids.js';
import { withRequiredConfig } from './registry-settings.js';
import type { ScriptedModels } from './scripted.js';

/** Upstream models plus the scripted ones; scripted ids stay listed when upstream discovery fails. */
async function listWithScripted(
  scripted: ScriptedModels,
  listUpstream: () => Promise<ModelInfo[]>,
): Promise<ModelInfo[]> {
  const scriptedModels = await scripted.listModels();
  try {
    return [...(await listUpstream()), ...scriptedModels];
  } catch (error) {
    // A placeholder key is expected in scripted mode; scripted ids stay usable without it.
    if (scriptedModels.length === 0) throw error;
    return scriptedModels;
  }
}

/**
 * A registry row is deliberately a request-time delegate. Endpoint settings belong to the model
 * connection named by the run token, not to this process, so constructing one global Azure or
 * compatible adapter at startup would silently ignore the connection selected in the UI.
 */
export function row(
  id: RegisteredProviderId,
  capabilities: ModelCapabilities,
  createUnchecked: (context: RequestContext) => ModelProvider,
  scripted?: ScriptedModels,
): ModelProvider {
  const create = withRequiredConfig(id, createUnchecked);
  return {
    id,
    capabilities,
    async listModels(context: RequestContext): Promise<ModelInfo[]> {
      const listUpstream = () => create(context).listModels(context);
      return await (scripted === undefined
        ? listUpstream()
        : listWithScripted(scripted, listUpstream));
    },
    createMessage(request: AnthropicMessageRequest, context: RequestContext): Promise<Response> {
      if (scripted?.isScripted(request.model) === true) {
        return scripted.createMessage(request, context);
      }
      return create(context).createMessage(request, context);
    },
    countTokens(request: AnthropicCountTokensRequest, context: RequestContext) {
      if (scripted?.isScripted(request.model) === true) {
        return scripted.countTokens(request);
      }
      const provider = create(context);
      if (provider.countTokens === undefined) {
        throw new ModelOperationUnsupportedError(id, 'token counting');
      }
      return provider.countTokens(request, context);
    },
  };
}

/** The typed refusal for a scripted id on a route that does not serve it (issue #798). */
function scriptedProtocolUnsupported(protocol: WireProtocol, context: RequestContext): Response {
  return Response.json(
    {
      type: 'error',
      error: {
        type: 'scripted_model_protocol_unsupported',
        message: `A scripted model is only served on the anthropic-messages protocol, not ${protocol}.`,
      },
      request_id: context.requestId,
    },
    { status: 400 },
  );
}

/**
 * An OpenAI-family row, which relays the two OpenAI dialects in addition to the published
 * `ModelProvider` members (ADR-0068 D3). `anthropic` deliberately has no such row: the absence of
 * `forward` is what makes `/v1/responses` answer `protocol_not_supported_for_connection`.
 *
 * A scripted id never reaches the upstream here: messages and the OpenAI dialects refuse, and token
 * counting answers with the scripted local estimate (its contract has no error envelope).
 */
export function forwardingRow(
  id: RegisteredProviderId,
  capabilities: ModelCapabilities,
  createUnchecked: (context: RequestContext) => ModelProvider & WireProtocolForwarder,
  scripted?: ScriptedModels,
): ModelProvider & WireProtocolForwarder {
  const create = withRequiredConfig(id, createUnchecked);
  const base = row(id, capabilities, createUnchecked);
  return {
    ...base,
    countTokens(request: AnthropicCountTokensRequest, context: RequestContext) {
      if (scripted?.isScripted(request.model) === true) {
        return scripted.countTokens(request);
      }
      if (base.countTokens === undefined) {
        throw new ModelOperationUnsupportedError(id, 'token counting');
      }
      return base.countTokens(request, context);
    },
    createMessage(request: AnthropicMessageRequest, context: RequestContext): Promise<Response> {
      if (scripted?.isScripted(request.model) === true) {
        return Promise.resolve(scriptedProtocolUnsupported('anthropic-messages', context));
      }
      return create(context).createMessage(request, context);
    },
    forwards: OPENAI_WIRE_PROTOCOLS,
    forward(
      body: ForwardRequest,
      protocol: WireProtocol,
      context: RequestContext,
    ): Promise<Response> {
      if (scripted?.isScripted(body.model) === true) {
        return Promise.resolve(scriptedProtocolUnsupported(protocol, context));
      }
      return create(context).forward(body, protocol, context);
    },
  };
}
