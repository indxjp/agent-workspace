import { VERTEX_LOCATIONS, type VertexLocation } from '@indx-workspace/contracts/models';
import { ModelConnectionIncompleteError } from '../types.js';
import type { ModelCapabilities, ModelInfo, ModelProvider, RequestContext } from '../types.js';
import { ANTHROPIC_CAPABILITIES, createAnthropicProvider } from './anthropic.js';
import { AZURE_OPENAI_CAPABILITIES, createAzureOpenAIProvider } from './azure-openai.js';
import {
  createOpenAICompatibleProvider,
  OPENAI_COMPATIBLE_CAPABILITIES,
} from './openai-compatible.js';
import { createOpenAIProvider, OPENAI_CAPABILITIES } from './openai.js';
import { forwardingRow, row } from './registry-rows.js';
import { optionalSetting, requiredSetting } from './registry-settings.js';
import { VERTEX_CAPABILITIES, vertexModels, vertexTarget } from './vertex.js';
import { createScriptedModels, scriptedModelsFromEnv, type ScriptedModels } from './scripted.js';

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
  VERTEX_CAPABILITIES,
};
export { createScriptedModels, scriptedModelsFromEnv, type ScriptedModels };
export { PROVIDER_IDS, registryProviderId, type RegisteredProviderId } from './registry-ids.js';

export type ProviderRegistryOptions = {
  readonly fetch?: typeof fetch;
  /**
   * Scripted models, a test tool (see `scripted.ts`). Omitted or `null`: off. An entry point that
   * offers them passes `scriptedModelsFromEnv(env)`, which reads `AW_SCRIPTED_MODELS_DIR` and throws
   * outside the `local` posture (refactoring part 03, step 5: the registry reads no environment).
   */
  readonly scripted?: ScriptedModels | null;
};

function isVertexLocation(value: string): value is VertexLocation {
  return VERTEX_LOCATIONS.some((location) => location === value);
}

/** The adapter option that injects the registry's `fetch`, present only when one was given. */
function fetchOption(request: typeof fetch | undefined): { readonly fetch?: typeof fetch } {
  return request === undefined ? {} : { fetch: request };
}

/** The connection's optional `baseUrl`, the only setting Anthropic and OpenAI rows read. */
function baseUrlOption(context: RequestContext): { readonly baseUrl?: string } {
  const baseUrl = optionalSetting(context, 'baseUrl');
  return baseUrl === undefined ? {} : { baseUrl };
}

/** Each row builds its adapter from the connection the run selected, one factory per provider. */
function adapterFactories(request: typeof fetch | undefined) {
  return {
    anthropic: (context: RequestContext) =>
      createAnthropicProvider({ ...baseUrlOption(context), ...fetchOption(request) }),
    openai: (context: RequestContext) =>
      createOpenAIProvider({ ...baseUrlOption(context), ...fetchOption(request) }),
    azureOpenai: (context: RequestContext) =>
      createAzureOpenAIProvider({
        endpoint: requiredSetting(context, 'baseUrl', 'azure-openai'),
        deployment: requiredSetting(context, 'deployment', 'azure-openai'),
        apiVersion: requiredSetting(context, 'apiVersion', 'azure-openai'),
        ...fetchOption(request),
      }),
    openaiCompatible: (context: RequestContext) =>
      createOpenAICompatibleProvider({
        baseUrl: requiredSetting(context, 'baseUrl', 'openai-compatible'),
        ...fetchOption(request),
      }),
    vertex: (context: RequestContext) => {
      const location = optionalSetting(context, 'location') ?? 'global';
      if (!isVertexLocation(location)) {
        throw new ModelConnectionIncompleteError('vertex', 'location');
      }
      return createAnthropicProvider({
        models: vertexModels(),
        target: vertexTarget({
          projectId: requiredSetting(context, 'projectId', 'vertex'),
          location,
        }),
        ...fetchOption(request),
      });
    },
  };
}

/** The complete and closed Wave 4 provider table, in stable display order. */
export function createProviderRegistry(
  options: ProviderRegistryOptions = {},
): readonly ModelProvider[] {
  const scripted = options.scripted ?? undefined;
  const create = adapterFactories(options.fetch);
  return [
    row('anthropic', ANTHROPIC_CAPABILITIES, create.anthropic, scripted),
    forwardingRow('openai', OPENAI_CAPABILITIES, create.openai, scripted),
    forwardingRow('azure-openai', AZURE_OPENAI_CAPABILITIES, create.azureOpenai, scripted),
    forwardingRow(
      'openai-compatible',
      OPENAI_COMPATIBLE_CAPABILITIES,
      create.openaiCompatible,
      scripted,
    ),
    row('vertex', VERTEX_CAPABILITIES, create.vertex),
  ];
}
