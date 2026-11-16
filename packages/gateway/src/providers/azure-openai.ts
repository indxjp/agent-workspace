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
import { contentFilterRefusal } from './azure-openai-content-filter.js';
import {
  buildAzureOpenAIUrl,
  normalizeEndpoint,
  requiredDeployment,
  type AzureOpenAIOperation,
} from './azure-openai-url.js';
import { createWireProtocolForwarder, OPENAI_WIRE_PROTOCOLS } from './passthrough.js';

export { buildAzureOpenAIUrl } from './azure-openai-url.js';

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

/** Everything one Azure OpenAI deployment needs to be called, resolved once at construction. */
type AzureConnection = {
  readonly endpoint: string;
  readonly deployment: string;
  readonly apiVersion: string | undefined;
  readonly policy: ReturnType<typeof loadEgressPolicyFromEnv>;
  readonly fetch: typeof fetch;
};

/** Azure's operation name for one relayed dialect, or `null` when it has none. */
function azureOpenAIOperationFor(protocol: WireProtocol): AzureOpenAIOperation | null {
  if (protocol === 'openai-responses') return 'responses';
  if (protocol === 'openai-chat-completions') return 'chat/completions';
  return null;
}

function operationUrl(connection: AzureConnection, operation: AzureOpenAIOperation): string {
  return buildAzureOpenAIUrl(
    connection.endpoint,
    connection.deployment,
    connection.apiVersion,
    operation,
  );
}

/** POST the translated request to one Azure operation; the context supplies the only credential. */
function postTranslated(
  connection: AzureConnection,
  operation: AzureOpenAIOperation,
  body: AnthropicMessageRequest | AnthropicCountTokensRequest,
  context: RequestContext,
): Promise<Response> {
  return guardedFetch(
    operationUrl(connection, operation),
    {
      method: 'POST',
      headers: { 'api-key': context.credential, 'content-type': 'application/json' },
      body: JSON.stringify(anthropicToOpenAI({ ...body, model: connection.deployment })),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    },
    connection.policy,
    connection.fetch,
  );
}

async function readJsonOrEmpty(upstream: Response): Promise<unknown> {
  try {
    return await upstream.json();
  } catch {
    return {};
  }
}

function streamedResponse(upstream: Response, connection: AzureConnection, requestId: string) {
  if (upstream.body === null) return openAIError(502, {}, requestId);
  return new Response(translateOpenAIStream(upstream.body, connection.deployment), {
    status: upstream.status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function createMessage(
  connection: AzureConnection,
  body: AnthropicMessageRequest,
  context: RequestContext,
): Promise<Response> {
  const upstream = await postTranslated(connection, 'responses', body, context);
  if (body['stream'] === true && upstream.ok) {
    return streamedResponse(upstream, connection, context.requestId);
  }

  const value = await readJsonOrEmpty(upstream);
  const refusal = contentFilterRefusal(
    upstream.status,
    value,
    connection.deployment,
    context.requestId,
  );
  if (refusal !== undefined) return refusal;
  if (!upstream.ok) return openAIError(upstream.status, value, context.requestId);
  return Response.json(openAIToAnthropic(value, connection.deployment), {
    status: upstream.status,
  });
}

async function countTokens(
  connection: AzureConnection,
  body: AnthropicCountTokensRequest,
  context: RequestContext,
): Promise<{ input_tokens: number }> {
  const upstream = await postTranslated(connection, 'responses/input_tokens', body, context);
  if (!upstream.ok) {
    throw new Error(`Azure OpenAI token counting returned HTTP ${String(upstream.status)}.`);
  }
  const value = (await upstream.json()) as Record<string, unknown>;
  if (typeof value['input_tokens'] !== 'number') {
    throw new Error('Azure OpenAI token counting returned no input_tokens number.');
  }
  return { input_tokens: value['input_tokens'] };
}

/** The deployment itself is the one model an Azure connection serves unless it lists others. */
function listedModels(connection: AzureConnection, configured: readonly ModelInfo[]): ModelInfo[] {
  if (configured.length > 0) return configured.map((model) => ({ ...model }));
  return [
    {
      id: connection.deployment,
      type: 'model',
      display_name: connection.deployment,
      created_at: new Date(0).toISOString(),
    },
  ];
}

/** Azure OpenAI Responses adapter. The verified RequestContext supplies the only credential. */
export function createAzureOpenAIProvider(
  options: AzureOpenAIProviderOptions,
): ModelProvider & WireProtocolForwarder {
  const endpoint = normalizeEndpoint(options.endpoint);
  const deployment = requiredDeployment(options.deployment);
  const connection: AzureConnection = {
    endpoint,
    deployment,
    apiVersion: options.apiVersion,
    policy: loadEgressPolicyFromEnv(),
    fetch: options.fetch ?? fetch,
  };
  const models = [...(options.models ?? [])];
  const forwarder = createWireProtocolForwarder({
    urlFor: (protocol) => {
      const operation = azureOpenAIOperationFor(protocol);
      return operation === null ? null : operationUrl(connection, operation);
    },
    credentialScheme: 'api-key',
    policy: connection.policy,
    fetch: connection.fetch,
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
    listModels: () => Promise.resolve(listedModels(connection, models)),
    createMessage: (body: AnthropicMessageRequest, context: RequestContext) =>
      createMessage(connection, body, context),
    countTokens: (body: AnthropicCountTokensRequest, context: RequestContext) =>
      countTokens(connection, body, context),
  };
  return provider;
}
