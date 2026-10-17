import type {
  AnthropicMessageRequest,
  ModelProvider,
  RequestContext,
} from '@agent-workspace/gateway';
import type { ProviderScenarioId } from './types.js';

export const REQUIRED_PROVIDER_SCENARIOS = [
  'basic-response',
  'streaming',
  'system-prompt',
  'multi-turn-conversation',
  'tool-call',
  'tool-result',
  'multiple-tool-calls',
  'errors',
  'usage',
  'cancellation',
] as const satisfies readonly ProviderScenarioId[];

export const OPTIONAL_PROVIDER_SCENARIOS = [
  'thinking',
  'prompt-caching',
  'structured-output',
  'context-management',
] as const satisfies readonly ProviderScenarioId[];

export type RequiredProviderScenario = {
  readonly id: (typeof REQUIRED_PROVIDER_SCENARIOS)[number];
  run(provider: ModelProvider): Promise<string>;
};

function context(provider: ModelProvider, signal?: AbortSignal): RequestContext {
  return {
    providerId: provider.id,
    credential: 'compatibility-fixture-credential',
    requestId: `compat_${crypto.randomUUID()}`,
    settings: {},
    ...(signal === undefined ? {} : { signal }),
  };
}

function request(
  scenario: RequiredProviderScenario['id'],
  fields: Record<string, unknown> = {},
): AnthropicMessageRequest {
  return {
    model: 'compatibility-model',
    max_tokens: 128,
    messages: [{ role: 'user', content: 'Hello' }],
    metadata: { compatibility_scenario: scenario },
    ...fields,
  };
}

async function body(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('provider returned a non-object JSON response');
  }
  return value as Record<string, unknown>;
}

async function successfulMessage(
  provider: ModelProvider,
  scenario: RequiredProviderScenario['id'],
  fields: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await provider.createMessage(request(scenario, fields), context(provider));
  if (!response.ok) throw new Error(`provider returned HTTP ${String(response.status)}`);
  const message = await body(response);
  if (
    message['type'] !== 'message' ||
    message['role'] !== 'assistant' ||
    !Array.isArray(message['content'])
  ) {
    throw new Error('provider response is not an Anthropic assistant message');
  }
  return message;
}

function contentBlocks(message: Record<string, unknown>): readonly Record<string, unknown>[] {
  return (message['content'] as unknown[]).filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === 'object' && !Array.isArray(item),
  );
}

export function requiredProviderScenarios(): readonly RequiredProviderScenario[] {
  return [
    {
      id: 'basic-response',
      async run(provider) {
        await successfulMessage(provider, 'basic-response');
        return 'returned an Anthropic assistant message';
      },
    },
    {
      id: 'streaming',
      async run(provider) {
        const response = await provider.createMessage(
          request('streaming', { stream: true }),
          context(provider),
        );
        if (!response.ok) throw new Error(`provider returned HTTP ${String(response.status)}`);
        if (!response.headers.get('content-type')?.includes('text/event-stream')) {
          throw new Error('streaming response is not text/event-stream');
        }
        const wire = await response.text();
        const events = [...wire.matchAll(/^event:\s*(.+)$/gm)].map((match) => match[1]);
        if (events[0] !== 'message_start' || events.at(-1) !== 'message_stop') {
          throw new Error(`unexpected SSE event order: ${events.join(', ')}`);
        }
        return `returned ${String(events.length)} ordered Anthropic SSE events`;
      },
    },
    {
      id: 'system-prompt',
      async run(provider) {
        await successfulMessage(provider, 'system-prompt', { system: 'Be concise.' });
        return 'accepted a system prompt';
      },
    },
    {
      id: 'multi-turn-conversation',
      async run(provider) {
        await successfulMessage(provider, 'multi-turn-conversation', {
          messages: [
            { role: 'user', content: 'First' },
            { role: 'assistant', content: 'Second' },
            { role: 'user', content: 'Third' },
          ],
        });
        return 'accepted alternating conversation history';
      },
    },
    {
      id: 'tool-call',
      async run(provider) {
        const message = await successfulMessage(provider, 'tool-call', {
          tools: [
            { name: 'weather', description: 'Get weather', input_schema: { type: 'object' } },
          ],
        });
        if (!contentBlocks(message).some((block) => block['type'] === 'tool_use')) {
          throw new Error('response did not contain a tool_use block');
        }
        return 'returned an Anthropic tool_use block';
      },
    },
    {
      id: 'tool-result',
      async run(provider) {
        await successfulMessage(provider, 'tool-result', {
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'toolu_1', name: 'weather', input: {} }],
            },
            {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny' }],
            },
          ],
        });
        return 'accepted an Anthropic tool_result block';
      },
    },
    {
      id: 'multiple-tool-calls',
      async run(provider) {
        const message = await successfulMessage(provider, 'multiple-tool-calls', {
          tools: [{ name: 'lookup', description: 'Lookup', input_schema: { type: 'object' } }],
        });
        const calls = contentBlocks(message).filter((block) => block['type'] === 'tool_use');
        if (calls.length < 2) throw new Error('response did not contain multiple tool_use blocks');
        return 'returned multiple Anthropic tool_use blocks';
      },
    },
    {
      id: 'errors',
      async run(provider) {
        const response = await provider.createMessage(request('errors'), context(provider));
        if (response.ok) throw new Error('error scenario returned a successful status');
        const error = await body(response);
        if (error['type'] !== 'error' || typeof error['error'] !== 'object') {
          throw new Error('error was not normalized to the Anthropic envelope');
        }
        return `returned an Anthropic error envelope with HTTP ${String(response.status)}`;
      },
    },
    {
      id: 'usage',
      async run(provider) {
        const message = await successfulMessage(provider, 'usage');
        const usage = message['usage'];
        if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) {
          throw new Error('response did not contain usage');
        }
        return 'returned usage accounting';
      },
    },
    {
      id: 'cancellation',
      async run(provider) {
        const controller = new AbortController();
        controller.abort();
        try {
          const response = await provider.createMessage(
            request('cancellation'),
            context(provider, controller.signal),
          );
          if (response.status !== 499) {
            throw new Error(`cancelled request returned HTTP ${String(response.status)}`);
          }
        } catch (error) {
          if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
        }
        return 'honoured an aborted request';
      },
    },
  ];
}
