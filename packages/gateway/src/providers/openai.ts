import { guardedFetch, loadEgressPolicyFromEnv } from '@agent-workspace/core';

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
import { ModelDiscoveryHttpError } from '../types.js';
import {
  anthropicToOpenAI,
  openAIError,
  openAIToAnthropic,
  OPENAI_APPROXIMATION_WARNINGS,
} from '../translate/openai.js';
import { translateOpenAIStream } from '../translate/openai-stream.js';
import { createWireProtocolForwarder, OPENAI_WIRE_PROTOCOLS } from './passthrough.js';

export type OpenAIProviderOptions = {
  readonly baseUrl?: string;
  readonly models?: readonly ModelInfo[];
  readonly fetch?: typeof fetch;
};

export const OPENAI_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  toolUse: true,
  thinking: true,
  promptCaching: true,
  structuredOutput: true,
  contextManagement: true,
  webSearch: true,
  tokenCounting: true,
};

export function normalizeOpenAIBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('OpenAI base URL must use https except for localhost fixture servers.');
  }
  return url.toString().replace(/\/$/, '');
}

/** The Responses and Chat Completions paths relative to an OpenAI-shaped `/v1` base URL. */
export function openAIProtocolPath(protocol: WireProtocol): string | null {
  if (protocol === 'openai-responses') return '/responses';
  if (protocol === 'openai-chat-completions') return '/chat/completions';
  return null;
}

/** OpenAI Responses adapter. Credentials arrive only through the verified request context. */
export function createOpenAIProvider(
  options: OpenAIProviderOptions = {},
): ModelProvider & WireProtocolForwarder {
  const baseUrl = normalizeOpenAIBaseUrl(options.baseUrl ?? 'https://api.openai.com/v1');
  const request = options.fetch ?? fetch;
  const policy = loadEgressPolicyFromEnv();
  const models = [...(options.models ?? [])];
  const forwarder = createWireProtocolForwarder({
    urlFor: (protocol) => {
      const path = openAIProtocolPath(protocol);
      return path === null ? null : `${baseUrl}${path}`;
    },
    credentialScheme: 'bearer',
    policy,
    fetch: request,
  });

  const provider: ModelProvider &
    WireProtocolForwarder & {
      readonly compatibility: {
        readonly outcomes: Readonly<
          Record<string, { readonly verdict: string; readonly warning: string }>
        >;
      };
    } = {
    id: 'openai',
    capabilities: OPENAI_CAPABILITIES,
    forwards: OPENAI_WIRE_PROTOCOLS,
    forward: (body: ForwardRequest, protocol: WireProtocol, context: RequestContext) =>
      forwarder.forward(body, protocol, context),
    compatibility: {
      outcomes: {
        thinking: {
          verdict: 'approximated',
          warning: OPENAI_APPROXIMATION_WARNINGS['reasoning/thinking'],
        },
        'prompt-caching': {
          verdict: 'approximated',
          warning: OPENAI_APPROXIMATION_WARNINGS.usage,
        },
      },
    },
    async listModels(context: RequestContext) {
      if (models.length > 0) return models.map((model) => ({ ...model }));
      const response = await guardedFetch(
        `${baseUrl}/models`,
        {
          headers: { authorization: `Bearer ${context.credential}` },
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        },
        policy,
        request,
      );
      if (!response.ok) {
        throw new ModelDiscoveryHttpError('OpenAI', response.status);
      }
      const value = (await response.json()) as { data?: unknown };
      if (!Array.isArray(value.data)) {
        throw new Error('OpenAI model discovery returned no data array.');
      }
      return value.data.flatMap((entry): ModelInfo[] => {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [];
        const model = entry as Record<string, unknown>;
        if (typeof model['id'] !== 'string') return [];
        const created = typeof model['created'] === 'number' ? model['created'] : 0;
        return [
          {
            ...model,
            id: model['id'],
            type: 'model',
            display_name: model['id'],
            created_at: new Date(created * 1_000).toISOString(),
          },
        ];
      });
    },
    async createMessage(body: AnthropicMessageRequest, context: RequestContext) {
      const upstream = await guardedFetch(
        `${baseUrl}/responses`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${context.credential}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(anthropicToOpenAI(body)),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        },
        policy,
        request,
      );
      if (!upstream.ok) {
        let value: unknown;
        try {
          value = await upstream.json();
        } catch {
          value = {};
        }
        return openAIError(upstream.status, value, context.requestId);
      }
      if (body['stream'] === true) {
        if (upstream.body === null) {
          return openAIError(502, {}, context.requestId);
        }
        return new Response(translateOpenAIStream(upstream.body, body.model), {
          status: upstream.status,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      const translated = openAIToAnthropic(await upstream.json(), body.model);
      return Response.json(translated, { status: upstream.status });
    },
    async countTokens(body: AnthropicCountTokensRequest, context: RequestContext) {
      const upstream = await guardedFetch(
        `${baseUrl}/responses/input_tokens`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${context.credential}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(anthropicToOpenAI(body)),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        },
        policy,
        request,
      );
      if (!upstream.ok) {
        throw new Error(`OpenAI token counting returned HTTP ${String(upstream.status)}.`);
      }
      const value = (await upstream.json()) as Record<string, unknown>;
      if (typeof value['input_tokens'] !== 'number') {
        throw new Error('OpenAI token counting returned no input_tokens number.');
      }
      return { input_tokens: value['input_tokens'] };
    },
  };
  return provider;
}
