import type { AnthropicMessageRequest } from '../types.js';

export type OpenAIResponsesRequest = {
  readonly model: string;
  readonly input: readonly Record<string, unknown>[];
  readonly instructions?: string;
  readonly tools?: readonly Record<string, unknown>[];
  readonly max_output_tokens?: number;
  readonly stream?: boolean;
  readonly metadata?: Record<string, unknown>;
  readonly reasoning?: { readonly effort?: string; readonly summary?: string };
};

export const OPENAI_APPROXIMATION_WARNINGS = {
  'system instructions':
    'This model receives your system prompt as a single block of text, not as separately cached, individually managed pieces — the platform still sends the prompt, but the fine-grained caching and prompt structure you set for Claude does not carry over.',
  'tool definitions':
    'Tool definitions are sent as plain JSON Schema; you cannot mark an individual tool as a fixed cache boundary the way you can with Claude, so changing your tool list may invalidate more of the cached prompt than it would on Claude.',
  'tool calls':
    'This model returns tool-call arguments as raw text you must parse into JSON yourself, rather than as a ready-made structured object.',
  'tool results':
    "Whether a tool call succeeded or failed is not a separate flag for this model — it is judged from the wording of the tool's output text, so a tool that fails silently (empty or ambiguous output) will not be recognized as an error the way it would with Claude.",
  streaming:
    "Streaming updates arrive under this provider's own event names and grouping, not Claude's — the platform translates them, so what you see should look the same, but a tool inspecting the raw event stream will see different event types than it would with Claude.",
  'stop reasons':
    'This model does not report a single reason your conversation stopped the way Claude does — the platform infers it from the shape of the response, a refusal from this model looks like a normal completed answer unless you read the message content closely, and stop sequences you configured are not enforced by the model itself at all.',
  usage:
    "Usage reporting is close but not identical: this provider doesn't distinguish a short-lived cache from a long-lived one the way Claude does, and it doesn't report web-search or web-fetch call counts inside the usage totals.",
  errors:
    "Some failures from this model arrive as a completed response marked failed, rather than as an error the platform can pass straight through — the platform converts these for you, but the underlying failure code is provider-specific and not one of Claude's own error types.",
  'reasoning/thinking':
    "This model's reasoning is hidden by default — you can request a short paraphrased summary instead of the reasoning itself, and the full reasoning is only preserved across turns as an opaque token, not as readable text the way Claude's thinking can be.",
} as const;

export const OPENAI_CANNOT_REPRESENT = [
  'stop_sequences and stop_reason:stop_sequence',
  'tool_result.is_error',
  'pause_turn',
  'model_context_window_exceeded as a post-hoc condition',
  'Anthropic refusal category taxonomy',
  'dual 5m/1h cache TTL and split',
  'verbatim continuous visible reasoning text',
] as const;

export const OPENAI_TRANSLATION_TABLE = [
  {
    element: 'system instructions',
    verdict: 'approximated',
    warning: OPENAI_APPROXIMATION_WARNINGS['system instructions'],
  },
  { element: 'user messages', verdict: 'lossless' },
  { element: 'assistant messages', verdict: 'lossless' },
  {
    element: 'text content blocks',
    verdict: 'lossless',
    caveat: 'citations use a provider-specific shape',
  },
  {
    element: 'tool definitions',
    verdict: 'approximated',
    warning: OPENAI_APPROXIMATION_WARNINGS['tool definitions'],
  },
  {
    element: 'tool calls',
    verdict: 'approximated',
    warning: OPENAI_APPROXIMATION_WARNINGS['tool calls'],
  },
  {
    element: 'tool results',
    verdict: 'approximated',
    warning: OPENAI_APPROXIMATION_WARNINGS['tool results'],
    cannotRepresent: ['tool_result.is_error'],
  },
  {
    element: 'streaming',
    verdict: 'approximated',
    warning: OPENAI_APPROXIMATION_WARNINGS.streaming,
  },
  {
    element: 'stop reasons',
    verdict: 'approximated',
    warning: OPENAI_APPROXIMATION_WARNINGS['stop reasons'],
    cannotRepresent: ['stop_sequences', 'pause_turn', 'model_context_window_exceeded'],
  },
  { element: 'usage', verdict: 'approximated', warning: OPENAI_APPROXIMATION_WARNINGS.usage },
  { element: 'errors', verdict: 'approximated', warning: OPENAI_APPROXIMATION_WARNINGS.errors },
  {
    element: 'reasoning/thinking where a meaningful mapping exists',
    verdict: 'approximated',
    warning: OPENAI_APPROXIMATION_WARNINGS['reasoning/thinking'],
  },
] as const;

function blocks(content: unknown, role: string): Record<string, unknown>[] {
  if (typeof content === 'string') {
    return [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: content }];
  }
  if (!Array.isArray(content)) return [];
  return content.flatMap((raw): Record<string, unknown>[] => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const block = raw as Record<string, unknown>;
    if (block['type'] === 'text') {
      return [
        { type: role === 'assistant' ? 'output_text' : 'input_text', text: block['text'] ?? '' },
      ];
    }
    if (block['type'] === 'tool_use') {
      return [
        {
          type: 'function_call',
          call_id: block['id'],
          name: block['name'],
          arguments: JSON.stringify(block['input'] ?? {}),
        },
      ];
    }
    if (block['type'] === 'tool_result') {
      const value =
        typeof block['content'] === 'string'
          ? block['content']
          : JSON.stringify(block['content'] ?? '');
      return [{ type: 'function_call_output', call_id: block['tool_use_id'], output: value }];
    }
    return [];
  });
}

function instructionText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  return value
    .flatMap((item) =>
      item !== null &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      typeof (item as Record<string, unknown>)['text'] === 'string'
        ? [(item as Record<string, unknown>)['text'] as string]
        : [],
    )
    .join('\n');
}

export function anthropicToOpenAI(request: AnthropicMessageRequest): OpenAIResponsesRequest {
  const messages = Array.isArray(request['messages']) ? request['messages'] : [];
  const input = messages.flatMap((raw): Record<string, unknown>[] => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const message = raw as Record<string, unknown>;
    const role = typeof message['role'] === 'string' ? message['role'] : 'user';
    const content = blocks(message['content'], role);
    const ordinary = content.filter(
      (item) => item['type'] !== 'function_call' && item['type'] !== 'function_call_output',
    );
    const functionItems = content.filter(
      (item) => item['type'] === 'function_call' || item['type'] === 'function_call_output',
    );
    return [
      ...(ordinary.length === 0 ? [] : [{ type: 'message', role, content: ordinary }]),
      ...functionItems,
    ];
  });
  const tools = Array.isArray(request['tools'])
    ? request['tools'].flatMap((raw): Record<string, unknown>[] => {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return [];
        const tool = raw as Record<string, unknown>;
        return [
          {
            type: 'function',
            name: tool['name'],
            description: tool['description'],
            parameters: tool['input_schema'],
            strict: true,
          },
        ];
      })
    : undefined;
  const metadata = request['metadata'];
  const instructions = instructionText(request['system']);
  return {
    model: request['model'],
    input,
    ...(instructions === undefined ? {} : { instructions }),
    ...(tools === undefined ? {} : { tools }),
    ...(typeof request['max_tokens'] === 'number'
      ? { max_output_tokens: request['max_tokens'] }
      : {}),
    ...(request['stream'] === true ? { stream: true } : {}),
    ...(metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
      ? { metadata: metadata as Record<string, unknown> }
      : {}),
    ...(request['thinking'] !== null && typeof request['thinking'] === 'object'
      ? { reasoning: { summary: 'auto' } }
      : {}),
  };
}

function usage(value: unknown): Record<string, unknown> {
  const raw =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const inputDetails = raw['input_tokens_details'] as Record<string, unknown> | undefined;
  const outputDetails = raw['output_tokens_details'] as Record<string, unknown> | undefined;
  return {
    input_tokens: Number(raw['input_tokens'] ?? 0),
    output_tokens: Number(raw['output_tokens'] ?? 0),
    cache_read_input_tokens: Number(inputDetails?.['cached_tokens'] ?? 0),
    cache_creation_input_tokens: Number(inputDetails?.['cache_write_tokens'] ?? 0),
    output_tokens_details: { thinking_tokens: Number(outputDetails?.['reasoning_tokens'] ?? 0) },
  };
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function openAIToAnthropic(value: unknown, fallbackModel: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('OpenAI response was not an object');
  const response = value as Record<string, unknown>;
  if (response['status'] === 'failed')
    throw new Error(`OpenAI response failed: ${JSON.stringify(response['error'])}`);
  const output = Array.isArray(response['output']) ? response['output'] : [];
  const content: Record<string, unknown>[] = [];
  for (const raw of output) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    if (item['type'] === 'function_call') {
      const argumentsText = stringValue(item['arguments'], '{}');
      const input: unknown = (() => {
        try {
          return JSON.parse(argumentsText) as unknown;
        } catch {
          return { _unparsed: argumentsText };
        }
      })();
      content.push({
        type: 'tool_use',
        id: item['call_id'] ?? item['id'],
        name: item['name'],
        input,
      });
    } else if (item['type'] === 'reasoning') {
      const summary = Array.isArray(item['summary']) ? item['summary'] : [];
      for (const part of summary)
        if (part !== null && typeof part === 'object' && !Array.isArray(part))
          content.push({
            type: 'thinking',
            thinking: stringValue((part as Record<string, unknown>)['text']),
            signature: stringValue(item['encrypted_content']),
          });
    } else if (item['type'] === 'message' && Array.isArray(item['content'])) {
      for (const rawPart of item['content']) {
        if (rawPart === null || typeof rawPart !== 'object' || Array.isArray(rawPart)) continue;
        const part = rawPart as Record<string, unknown>;
        if (part['type'] === 'output_text')
          content.push({ type: 'text', text: stringValue(part['text']) });
        if (part['type'] === 'refusal')
          content.push({ type: 'text', text: stringValue(part['refusal']) });
      }
    }
  }
  const hasTool = content.some((item) => item['type'] === 'tool_use');
  const incomplete = response['incomplete_details'] as Record<string, unknown> | undefined;
  const stopReason = hasTool
    ? 'tool_use'
    : incomplete?.['reason'] === 'max_output_tokens'
      ? 'max_tokens'
      : 'end_turn';
  return {
    id: stringValue(response['id'], `msg_${crypto.randomUUID()}`),
    type: 'message',
    role: 'assistant',
    model: stringValue(response['model'], fallbackModel),
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: usage(response['usage']),
  };
}

export function openAIError(status: number, value: unknown, requestId: string): Response {
  const outer =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const inner =
    outer['error'] !== null && typeof outer['error'] === 'object' && !Array.isArray(outer['error'])
      ? (outer['error'] as Record<string, unknown>)
      : {};
  const type =
    status === 429
      ? 'rate_limit_error'
      : status >= 500
        ? 'api_error'
        : status === 401
          ? 'authentication_error'
          : 'invalid_request_error';
  return Response.json(
    {
      type: 'error',
      error: {
        type,
        message: stringValue(inner['message'], `OpenAI returned HTTP ${String(status)}`),
      },
      request_id: requestId,
    },
    { status },
  );
}
