import {
  MODEL_PROVIDER_CONFIG_RULES,
  type ModelConnectionConfig,
} from '@indx-workspace/contracts/models';
import type { ModelProvider as ConnectionProvider } from '@indx-workspace/contracts/runs';
import { ModelConnectionIncompleteError } from '../types.js';
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
import { ANTHROPIC_CAPABILITIES, createAnthropicProvider } from './anthropic.js';
import { AZURE_OPENAI_CAPABILITIES, createAzureOpenAIProvider } from './azure-openai.js';
import {
  createOpenAICompatibleProvider,
  OPENAI_COMPATIBLE_CAPABILITIES,
} from './openai-compatible.js';
import { createOpenAIProvider, OPENAI_CAPABILITIES } from './openai.js';
import { OPENAI_WIRE_PROTOCOLS } from './passthrough.js';
import { scriptedModelsFromEnv, type ScriptedModels } from './scripted.js';

// Re-exported so a consumer of this subpath (issue #129's control-plane discovery module) needs
// only this one import; see `package.json`'s `./providers/registry` export, added for exactly
// that purpose.
export type { ModelCapabilities, ModelInfo, ModelProvider, RequestContext };
export { ModelConnectionIncompleteError, ModelDiscoveryHttpError } from '../types.js';
export {
  ANTHROPIC_CAPABILITIES,
  AZURE_OPENAI_CAPABILITIES,
  OPENAI_CAPABILITIES,
  OPENAI_COMPATIBLE_CAPABILITIES,
};

export const PROVIDER_IDS = ['anthropic', 'openai', 'azure-openai', 'openai-compatible'] as const;

export type RegisteredProviderId = (typeof PROVIDER_IDS)[number];

/** The registry row that serves a connection; `anthropic-compatible` has no row of its own. */
export function registryProviderId(provider: ConnectionProvider): RegisteredProviderId {
  return provider === 'anthropic-compatible' ? 'anthropic' : provider;
}

export type ProviderRegistryOptions = {
  readonly fetch?: typeof fetch;
  /**
   * Scripted models, a test tool (see `scripted.ts`). Omitted: read `AW_SCRIPTED_MODELS_DIR` from
   * the process environment, which throws outside the `local` posture. `null`: off.
   */
  readonly scripted?: ScriptedModels | null;
};

function optionalSetting(
  context: RequestContext,
  name: keyof ModelConnectionConfig,
): string | undefined {
  const value = context.settings[name];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function requiredSetting(
  context: RequestContext,
  name: keyof ModelConnectionConfig,
  providerId: RegisteredProviderId,
): string {
  const value = optionalSetting(context, name);
  if (value === undefined) throw new ModelConnectionIncompleteError(providerId, name);
  return value;
}

/**
 * Check `MODEL_PROVIDER_CONFIG_RULES[id].required` before an adapter is built, so a stored
 * connection that predates a rule (or a row that forgets to read a field) is a typed refusal
 * rather than an opaque 500.
 */
function withRequiredConfig<Adapter extends ModelProvider>(
  id: RegisteredProviderId,
  create: (context: RequestContext) => Adapter,
): (context: RequestContext) => Adapter {
  return (context) => {
    for (const field of MODEL_PROVIDER_CONFIG_RULES[id].required) {
      if (optionalSetting(context, field) === undefined) {
        throw new ModelConnectionIncompleteError(id, field);
      }
    }
    return create(context);
  };
}

/**
 * A registry row is deliberately a request-time delegate. Endpoint settings belong to the model
 * connection named by the run token, not to this process, so constructing one global Azure or
 * compatible adapter at startup would silently ignore the connection selected in the UI.
 */
function row(
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
      if (scripted === undefined) return create(context).listModels(context);
      const scriptedModels = await scripted.listModels();
      try {
        const upstream = await create(context).listModels(context);
        return [...upstream, ...scriptedModels];
      } catch (error) {
        // A placeholder key is expected in scripted mode; scripted ids stay usable without it.
        if (scriptedModels.length === 0) throw error;
        return scriptedModels;
      }
    },
    createMessage(request: AnthropicMessageRequest, context: RequestContext): Promise<Response> {
      if (scripted?.isScripted(request.model) === true) {
        return scripted.createMessage(request, context);
      }
      return create(context).createMessage(request, context);
    },
    countTokens(request: AnthropicCountTokensRequest, context: RequestContext) {
      if (scripted?.isScripted(request.model) === true) return scripted.countTokens(request);
      const provider = create(context);
      if (provider.countTokens === undefined) {
        throw new Error(`${id} does not support token counting.`);
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
function forwardingRow(
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
      if (scripted?.isScripted(request.model) === true) return scripted.countTokens(request);
      if (base.countTokens === undefined) throw new Error(`${id} does not support token counting.`);
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

/** The complete and closed Wave 4 provider table, in stable display order. */
export function createProviderRegistry(
  options: ProviderRegistryOptions = {},
): readonly ModelProvider[] {
  const request = options.fetch;
  const scripted =
    options.scripted === undefined
      ? scriptedModelsFromEnv(process.env)
      : (options.scripted ?? undefined);
  return [
    row(
      'anthropic',
      ANTHROPIC_CAPABILITIES,
      (context) => {
        const baseUrl = optionalSetting(context, 'baseUrl');
        return createAnthropicProvider({
          ...(baseUrl === undefined ? {} : { baseUrl }),
          ...(request === undefined ? {} : { fetch: request }),
        });
      },
      scripted,
    ),
    forwardingRow(
      'openai',
      OPENAI_CAPABILITIES,
      (context) => {
        const baseUrl = optionalSetting(context, 'baseUrl');
        return createOpenAIProvider({
          ...(baseUrl === undefined ? {} : { baseUrl }),
          ...(request === undefined ? {} : { fetch: request }),
        });
      },
      scripted,
    ),
    forwardingRow(
      'azure-openai',
      AZURE_OPENAI_CAPABILITIES,
      (context) => {
        return createAzureOpenAIProvider({
          endpoint: requiredSetting(context, 'baseUrl', 'azure-openai'),
          deployment: requiredSetting(context, 'deployment', 'azure-openai'),
          apiVersion: requiredSetting(context, 'apiVersion', 'azure-openai'),
          ...(request === undefined ? {} : { fetch: request }),
        });
      },
      scripted,
    ),
    forwardingRow(
      'openai-compatible',
      OPENAI_COMPATIBLE_CAPABILITIES,
      (context) =>
        createOpenAICompatibleProvider({
          baseUrl: requiredSetting(context, 'baseUrl', 'openai-compatible'),
          ...(request === undefined ? {} : { fetch: request }),
        }),
      scripted,
    ),
  ];
}
