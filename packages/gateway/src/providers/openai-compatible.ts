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
import { createOpenAIProvider } from './openai.js';
import { OPENAI_WIRE_PROTOCOLS } from './passthrough.js';

export type OpenAICompatibleProviderOptions = {
  readonly baseUrl: string;
  readonly models?: readonly ModelInfo[];
  readonly fetch?: typeof fetch;
};

/** Unknown endpoints earn no optional capability claim before their suite has measured it. */
export const OPENAI_COMPATIBLE_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  toolUse: true,
  thinking: false,
  promptCaching: false,
  structuredOutput: false,
  contextManagement: false,
  webSearch: false,
  tokenCounting: false,
};

export function normalizeOpenAICompatibleBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('OpenAI-compatible base URL must be an absolute URL.');
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error(
      'OpenAI-compatible base URL must use https except for localhost fixture servers.',
    );
  }
  return url.toString().replace(/\/$/u, '');
}

/**
 * Generic compatible endpoint. All Anthropic/OpenAI mapping remains in the shared OpenAI adapter;
 * this module contributes only endpoint validation, identity, and conservative capability claims.
 */
export function createOpenAICompatibleProvider(
  options: OpenAICompatibleProviderOptions,
): ModelProvider & WireProtocolForwarder {
  const inner = createOpenAIProvider({
    baseUrl: normalizeOpenAICompatibleBaseUrl(options.baseUrl),
    ...(options.models === undefined ? {} : { models: options.models }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  return {
    id: 'openai-compatible',
    capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
    // Compatible upstreams are the population most likely to implement only Chat Completions, so
    // the relay matters more here than anywhere else; it is the shared one, unchanged.
    forwards: OPENAI_WIRE_PROTOCOLS,
    forward: (body: ForwardRequest, protocol: WireProtocol, context: RequestContext) =>
      inner.forward(body, protocol, context),
    listModels: (context: RequestContext) => inner.listModels(context),
    createMessage: (request: AnthropicMessageRequest, context: RequestContext) =>
      inner.createMessage(request, context),
    countTokens: (request: AnthropicCountTokensRequest, context: RequestContext) => {
      if (inner.countTokens === undefined) throw new Error('OpenAI token counting is unavailable.');
      return inner.countTokens(request, context);
    },
  };
}
