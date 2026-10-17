import { guardedFetch, loadEgressPolicyFromEnv } from '@agent-workspace/core';

import type {
  AnthropicCountTokensRequest,
  AnthropicMessageRequest,
  ModelCapabilities,
  ModelInfo,
  ModelProvider,
  RequestContext,
} from '../types.js';
import { ModelDiscoveryHttpError } from '../types.js';
import { clientResponse } from './passthrough.js';
import { z } from 'zod';

const ModelInfoSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal('model'),
    display_name: z.string(),
    created_at: z.string(),
  })
  .catchall(z.unknown());
const ModelListSchema = z.object({ data: z.array(ModelInfoSchema) }).passthrough();
const TokenCountSchema = z
  .object({ input_tokens: z.number().int().nonnegative().safe() })
  .passthrough();

export type AnthropicProviderOptions = {
  readonly baseUrl?: string;
  readonly models?: readonly ModelInfo[];
  readonly fetch?: typeof fetch;
};

export const ANTHROPIC_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  toolUse: true,
  thinking: true,
  // R-03 requires these two claims to remain false until a credential-bound replay verifies them.
  promptCaching: false,
  structuredOutput: true,
  contextManagement: true,
  webSearch: true,
  tokenCounting: false,
};

function normalizedBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('Anthropic base URL must use https except for localhost fixture servers.');
  }
  return url.toString().replace(/\/$/, '');
}

/**
 * Build upstream Anthropic headers without forwarding the caller's gateway credential.
 *
 * Claude Code treats `anthropic-*` as an open protocol-header list. In particular,
 * `anthropic-beta` gates body fields such as `context_management`; forwarding the body while
 * dropping that header makes Anthropic reject the otherwise valid request with HTTP 400.
 */
function anthropicRequestHeaders(context: RequestContext): Headers {
  const headers = new Headers({
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key': context.credential,
  });
  context.requestHeaders?.forEach((value, name) => {
    if (name.toLowerCase().startsWith('anthropic-')) headers.set(name, value);
  });
  return headers;
}

/**
 * Anthropic is the native pass-through adapter: the request body and the upstream response stream
 * are not reshaped. Authentication is substituted exclusively from the verified request context,
 * and the response carries only the headers the OpenAI relay allows the client to see.
 */
export function createAnthropicProvider(options: AnthropicProviderOptions = {}): ModelProvider {
  const baseUrl = normalizedBaseUrl(options.baseUrl ?? 'https://api.anthropic.com');
  const request = options.fetch ?? fetch;
  const policy = loadEgressPolicyFromEnv();
  const models = [...(options.models ?? [])];

  return {
    id: 'anthropic',
    capabilities: ANTHROPIC_CAPABILITIES,
    async listModels(context: RequestContext) {
      if (models.length > 0) return models.map((model) => ({ ...model }));
      const response = await guardedFetch(
        // The list is paginated and defaults to 20 rows, newest first; a workspace whose selected
        // model is older than the twentieth would otherwise see it reported as unavailable.
        `${baseUrl}/v1/models?limit=1000`,
        {
          headers: anthropicRequestHeaders(context),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        },
        policy,
        request,
      );
      if (!response.ok) {
        throw new ModelDiscoveryHttpError('Anthropic', response.status);
      }
      const value: unknown = await response.json();
      const parsed = ModelListSchema.safeParse(value);
      if (!parsed.success)
        throw new Error('Anthropic model discovery returned invalid model data.');
      return parsed.data.data;
    },
    async createMessage(body: AnthropicMessageRequest, context: RequestContext) {
      const upstream = await guardedFetch(
        `${baseUrl}/v1/messages`,
        {
          method: 'POST',
          headers: anthropicRequestHeaders(context),
          body: JSON.stringify(body),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        },
        policy,
        request,
      );
      return clientResponse(upstream);
    },
    async countTokens(body: AnthropicCountTokensRequest, context: RequestContext) {
      const response = await guardedFetch(
        `${baseUrl}/v1/messages/count_tokens`,
        {
          method: 'POST',
          headers: anthropicRequestHeaders(context),
          body: JSON.stringify(body),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        },
        policy,
        request,
      );
      if (!response.ok) {
        throw new Error(`Anthropic token counting returned HTTP ${String(response.status)}.`);
      }
      const value: unknown = await response.json();
      const parsed = TokenCountSchema.safeParse(value);
      if (!parsed.success) {
        throw new Error('Anthropic token counting returned an invalid input_tokens value.');
      }
      return { input_tokens: parsed.data.input_tokens };
    },
  };
}
