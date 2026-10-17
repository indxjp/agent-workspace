import type {
  AnthropicMessageRequest,
  ModelCapabilities,
  ModelProvider,
  RequestContext,
} from '@agent-workspace/gateway';

const capabilities: ModelCapabilities = {
  streaming: true,
  toolUse: true,
  thinking: true,
  promptCaching: true,
  structuredOutput: true,
  contextManagement: true,
  webSearch: true,
  tokenCounting: true,
};

function scenario(request: AnthropicMessageRequest): string | undefined {
  const metadata = request['metadata'];
  return metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)['compatibility_scenario']?.toString()
    : undefined;
}

function message(
  content: readonly Record<string, unknown>[] = [{ type: 'text', text: 'Hello' }],
): Response {
  return Response.json({
    id: 'msg_compatibility',
    type: 'message',
    role: 'assistant',
    content,
    model: 'compatibility-model',
    stop_reason: content.some((block) => block['type'] === 'tool_use') ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 4, output_tokens: 2 },
  });
}

export const stubProvider: ModelProvider = {
  id: 'stub',
  capabilities,
  listModels() {
    return Promise.resolve([
      {
        id: 'compatibility-model',
        type: 'model',
        display_name: 'Compatibility',
        created_at: '2026-01-01T00:00:00Z',
      },
    ]);
  },
  createMessage(request: AnthropicMessageRequest, context: RequestContext) {
    switch (scenario(request)) {
      case 'streaming':
        return Promise.resolve(
          new Response(
            [
              'event: message_start',
              'data: {"type":"message_start"}',
              '',
              'event: content_block_delta',
              'data: {"type":"content_block_delta"}',
              '',
              'event: message_stop',
              'data: {"type":"message_stop"}',
              '',
            ].join('\n'),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
        );
      case 'tool-call':
        return Promise.resolve(
          message([{ type: 'tool_use', id: 'toolu_1', name: 'weather', input: {} }]),
        );
      case 'multiple-tool-calls':
        return Promise.resolve(
          message([
            { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { item: 1 } },
            { type: 'tool_use', id: 'toolu_2', name: 'lookup', input: { item: 2 } },
          ]),
        );
      case 'errors':
        return Promise.resolve(
          Response.json(
            { type: 'error', error: { type: 'rate_limit_error', message: 'fixture limit' } },
            { status: 429 },
          ),
        );
      case 'cancellation':
        if (context.signal?.aborted)
          return Promise.reject(new DOMException('Aborted', 'AbortError'));
        return Promise.resolve(new Response(null, { status: 499 }));
      default:
        return Promise.resolve(message());
    }
  },
  countTokens() {
    return Promise.resolve({ input_tokens: 4 });
  },
};
