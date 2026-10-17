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
import { anthropicToOpenAI, openAIError, openAIToAnthropic } from '../translate/openai.js';
import { translateOpenAIStream } from '../translate/openai-stream.js';
import { createWireProtocolForwarder, OPENAI_WIRE_PROTOCOLS } from './passthrough.js';

export type AzureOpenAIOperation = 'responses' | 'responses/input_tokens' | 'chat/completions';

export type AzureOpenAIProviderOptions = {
  readonly endpoint: string;
  readonly deployment: string;
  /** Omit for the current v1 surface; use `preview` for v1 preview or a date for legacy. */
  readonly apiVersion?: string;
  readonly models?: readonly ModelInfo[];
  readonly fetch?: typeof fetch;
};

export const AZURE_OPENAI_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  toolUse: true,
  thinking: false,
  promptCaching: false,
  structuredOutput: true,
  contextManagement: false,
  webSearch: false,
  tokenCounting: true,
};

function normalizeEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('Azure OpenAI endpoint must use https except for localhost fixture servers.');
  }
  return url.toString().replace(/\/$/u, '');
}

function requiredDeployment(value: string): string {
  const deployment = value.trim();
  if (deployment.length === 0) throw new Error('Azure OpenAI deployment is required.');
  return deployment;
}

/** R-05's two URL families, kept explicit so a deployment is never confused with a model name. */
export function buildAzureOpenAIUrl(
  endpoint: string,
  deployment: string,
  apiVersion: string | undefined,
  operation: AzureOpenAIOperation,
): string {
  const root = normalizeEndpoint(endpoint);
  const deploymentName = encodeURIComponent(requiredDeployment(deployment));
  const version = apiVersion?.trim();
  if (version === undefined || version === '' || version === 'v1') {
    return `${root}/openai/v1/${operation}`;
  }
  if (version === 'preview') {
    return `${root}/openai/v1/${operation}?api-version=preview`;
  }
  const query = `api-version=${encodeURIComponent(version)}`;
  if (operation === 'chat/completions') {
    return `${root}/openai/deployments/${deploymentName}/chat/completions?${query}`;
  }
  // R-05's executed SDK probe establishes that Responses is not deployment-scoped on the dated
  // surface; the deployment still travels as the request body's `model` value.
  return `${root}/openai/responses?${query}`;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function contentFilterExplanation(value: unknown): string {
  const outer = object(value);
  const error = object(outer['error']);
  if (typeof error['message'] === 'string') return error['message'];
  const filters = Array.isArray(outer['content_filters']) ? outer['content_filters'] : [];
  return filters.length > 0
    ? `Azure content filter blocked this response: ${JSON.stringify(filters)}`
    : 'Azure content filter blocked this response.';
}

function isContentFilterBlock(status: number, value: unknown): boolean {
  const outer = object(value);
  const error = object(outer['error']);
  if (status === 400 && error['code'] === 'content_filter') return true;
  return (
    Array.isArray(outer['content_filters']) &&
    outer['content_filters'].some((entry) => object(entry)['blocked'] === true)
  );
}

function refusal(model: string, requestId: string, explanation: string): Response {
  return Response.json({
    id: requestId,
    type: 'message',
    role: 'assistant',
    model,
    content: [],
    stop_reason: 'refusal',
    stop_sequence: null,
    stop_details: { type: 'refusal', category: null, explanation },
    usage: { input_tokens: 0, output_tokens: 0 },
  });
}

/** Azure's operation name for one relayed dialect, or `null` when it has none. */
function azureOpenAIOperationFor(protocol: WireProtocol): AzureOpenAIOperation | null {
  if (protocol === 'openai-responses') return 'responses';
  if (protocol === 'openai-chat-completions') return 'chat/completions';
  return null;
}

/** Azure OpenAI Responses adapter. The verified RequestContext supplies the only credential. */
export function createAzureOpenAIProvider(
  options: AzureOpenAIProviderOptions,
): ModelProvider & WireProtocolForwarder {
  const endpoint = normalizeEndpoint(options.endpoint);
  const deployment = requiredDeployment(options.deployment);
  const request = options.fetch ?? fetch;
  const policy = loadEgressPolicyFromEnv();
  const models = [...(options.models ?? [])];
  const forwarder = createWireProtocolForwarder({
    urlFor: (protocol) => {
      const operation = azureOpenAIOperationFor(protocol);
      return operation === null
        ? null
        : buildAzureOpenAIUrl(endpoint, deployment, options.apiVersion, operation);
    },
    credentialScheme: 'api-key',
    policy,
    fetch: request,
    // Azure addresses a deployment, never a model name, on every protocol it serves.
    pinnedModel: deployment,
  });

  const provider: ModelProvider &
    WireProtocolForwarder & {
      readonly compatibility: {
        readonly outcomes: Readonly<
          Record<string, { readonly verdict: 'unsupported'; readonly warning?: string }>
        >;
      };
    } = {
    id: 'azure-openai',
    capabilities: AZURE_OPENAI_CAPABILITIES,
    forwards: OPENAI_WIRE_PROTOCOLS,
    forward: (body: ForwardRequest, protocol: WireProtocol, context: RequestContext) =>
      forwarder.forward(body, protocol, context),
    compatibility: {
      outcomes: {
        thinking: { verdict: 'unsupported' },
        'prompt-caching': { verdict: 'unsupported' },
        'context-management': { verdict: 'unsupported' },
      },
    },
    listModels() {
      if (models.length > 0) return Promise.resolve(models.map((model) => ({ ...model })));
      return Promise.resolve([
        {
          id: deployment,
          type: 'model',
          display_name: deployment,
          created_at: new Date(0).toISOString(),
        },
      ]);
    },
    async createMessage(body: AnthropicMessageRequest, context: RequestContext) {
      const translated = anthropicToOpenAI({ ...body, model: deployment });
      const upstream = await guardedFetch(
        buildAzureOpenAIUrl(endpoint, deployment, options.apiVersion, 'responses'),
        {
          method: 'POST',
          headers: { 'api-key': context.credential, 'content-type': 'application/json' },
          body: JSON.stringify(translated),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        },
        policy,
        request,
      );
      if (body['stream'] === true && upstream.ok) {
        if (upstream.body === null) return openAIError(502, {}, context.requestId);
        return new Response(translateOpenAIStream(upstream.body, deployment), {
          status: upstream.status,
          headers: { 'content-type': 'text/event-stream' },
        });
      }

      let value: unknown;
      try {
        value = await upstream.json();
      } catch {
        value = {};
      }
      if (isContentFilterBlock(upstream.status, value)) {
        return refusal(deployment, context.requestId, contentFilterExplanation(value));
      }
      if (!upstream.ok) return openAIError(upstream.status, value, context.requestId);
      return Response.json(openAIToAnthropic(value, deployment), { status: upstream.status });
    },
    async countTokens(body: AnthropicCountTokensRequest, context: RequestContext) {
      const upstream = await guardedFetch(
        buildAzureOpenAIUrl(endpoint, deployment, options.apiVersion, 'responses/input_tokens'),
        {
          method: 'POST',
          headers: { 'api-key': context.credential, 'content-type': 'application/json' },
          body: JSON.stringify(anthropicToOpenAI({ ...body, model: deployment })),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        },
        policy,
        request,
      );
      if (!upstream.ok) {
        throw new Error(`Azure OpenAI token counting returned HTTP ${String(upstream.status)}.`);
      }
      const value = (await upstream.json()) as Record<string, unknown>;
      if (typeof value['input_tokens'] !== 'number') {
        throw new Error('Azure OpenAI token counting returned no input_tokens number.');
      }
      return { input_tokens: value['input_tokens'] };
    },
  };
  return provider;
}
