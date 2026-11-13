import type { AnthropicMessageRequest } from '../types.js';
import { record, stringValue } from './openai-stream-values.js';

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

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The object entries of a list; anything else in it, or a non-list, contributes nothing. */
function objectItems(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function isFunctionItem(item: JsonObject): boolean {
  return item['type'] === 'function_call' || item['type'] === 'function_call_output';
}

function textPartType(role: string): 'output_text' | 'input_text' {
  return role === 'assistant' ? 'output_text' : 'input_text';
}

function toolResultOutput(block: JsonObject): string {
  return typeof block['content'] === 'string'
    ? block['content']
    : JSON.stringify(block['content'] ?? '');
}

/** One Anthropic content block as zero or one Responses item; unknown block types are dropped. */
function contentBlockItem(block: JsonObject, role: string): JsonObject[] {
  switch (block['type']) {
    case 'text':
      return [{ type: textPartType(role), text: block['text'] ?? '' }];
    case 'tool_use':
      return [
        {
          type: 'function_call',
          call_id: block['id'],
          name: block['name'],
          arguments: JSON.stringify(block['input'] ?? {}),
        },
      ];
    case 'tool_result':
      return [
        {
          type: 'function_call_output',
          call_id: block['tool_use_id'],
          output: toolResultOutput(block),
        },
      ];
    default:
      return [];
  }
}

function blocks(content: unknown, role: string): JsonObject[] {
  if (typeof content === 'string') return [{ type: textPartType(role), text: content }];
  return objectItems(content).flatMap((block) => contentBlockItem(block, role));
}

function instructionText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  return objectItems(value)
    .flatMap((item) => (typeof item['text'] === 'string' ? [item['text']] : []))
    .join('\n');
}

/** A message becomes one `message` item for its ordinary content, then its function items. */
function messageItems(message: JsonObject): JsonObject[] {
  const role = typeof message['role'] === 'string' ? message['role'] : 'user';
  const content = blocks(message['content'], role);
  const ordinary = content.filter((item) => !isFunctionItem(item));
  const functionItems = content.filter(isFunctionItem);
  return [
    ...(ordinary.length === 0 ? [] : [{ type: 'message', role, content: ordinary }]),
    ...functionItems,
  ];
}

function functionTool(tool: JsonObject): JsonObject {
  return {
    type: 'function',
    name: tool['name'],
    description: tool['description'],
    parameters: tool['input_schema'],
    // Strict mode demands additionalProperties:false and every property required, which an
    // arbitrary Anthropic input_schema does not satisfy; the Responses API defaults to
    // strict when omitted, so opt out explicitly rather than rewrite the schema.
    strict: false,
  };
}

/** The optional request fields, present only when the Anthropic request set them. */
function optionalFields(request: AnthropicMessageRequest): Partial<OpenAIResponsesRequest> {
  const instructions = instructionText(request['system']);
  const metadata = request['metadata'];
  const thinking = request['thinking'];
  return {
    ...(instructions === undefined ? {} : { instructions }),
    ...(Array.isArray(request['tools'])
      ? { tools: objectItems(request['tools']).map(functionTool) }
      : {}),
    ...(typeof request['max_tokens'] === 'number'
      ? { max_output_tokens: request['max_tokens'] }
      : {}),
    ...(request['stream'] === true ? { stream: true } : {}),
    ...(isObject(metadata) ? { metadata } : {}),
    ...(thinking !== null && typeof thinking === 'object'
      ? { reasoning: { summary: 'auto' } }
      : {}),
  };
}

export function anthropicToOpenAI(request: AnthropicMessageRequest): OpenAIResponsesRequest {
  const messages = Array.isArray(request['messages']) ? objectItems(request['messages']) : [];
  return {
    model: request['model'],
    input: messages.flatMap(messageItems),
    ...optionalFields(request),
  };
}

function usage(value: unknown): JsonObject {
  const raw = record(value);
  const inputDetails = record(raw['input_tokens_details']);
  const outputDetails = record(raw['output_tokens_details']);
  const cached = Number(inputDetails['cached_tokens'] ?? 0);
  return {
    // OpenAI's input_tokens already include the cached prefix; Anthropic's exclude cache reads.
    input_tokens: Math.max(0, Number(raw['input_tokens'] ?? 0) - cached),
    output_tokens: Number(raw['output_tokens'] ?? 0),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: Number(inputDetails['cache_write_tokens'] ?? 0),
    output_tokens_details: { thinking_tokens: Number(outputDetails['reasoning_tokens'] ?? 0) },
  };
}

/** Tool arguments are model-written text: unparseable JSON is kept verbatim under `_unparsed`. */
function parseToolArguments(argumentsText: string): unknown {
  try {
    return JSON.parse(argumentsText) as unknown;
  } catch {
    return { _unparsed: argumentsText };
  }
}

function functionCallBlocks(item: JsonObject): JsonObject[] {
  return [
    {
      type: 'tool_use',
      id: item['call_id'] ?? item['id'],
      name: item['name'],
      input: parseToolArguments(stringValue(item['arguments'], '{}')),
    },
  ];
}

function reasoningBlocks(item: JsonObject): JsonObject[] {
  return objectItems(item['summary']).map((part) => ({
    type: 'thinking',
    thinking: stringValue(part['text']),
    signature: stringValue(item['encrypted_content']),
  }));
}

function messageBlocks(item: JsonObject): JsonObject[] {
  return objectItems(item['content']).flatMap((part): JsonObject[] => {
    if (part['type'] === 'output_text') return [{ type: 'text', text: stringValue(part['text']) }];
    if (part['type'] === 'refusal') return [{ type: 'text', text: stringValue(part['refusal']) }];
    return [];
  });
}

/** One Responses output item as the Anthropic content blocks it stands for. */
function outputItemBlocks(item: JsonObject): JsonObject[] {
  switch (item['type']) {
    case 'function_call':
      return functionCallBlocks(item);
    case 'reasoning':
      return reasoningBlocks(item);
    case 'message':
      return messageBlocks(item);
    default:
      return [];
  }
}

function stopReason(content: readonly JsonObject[], response: JsonObject): string {
  if (content.some((item) => item['type'] === 'tool_use')) return 'tool_use';
  return record(response['incomplete_details'])['reason'] === 'max_output_tokens'
    ? 'max_tokens'
    : 'end_turn';
}

export function openAIToAnthropic(value: unknown, fallbackModel: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error('OpenAI response was not an object');
  if (value['status'] === 'failed') {
    throw new Error(`OpenAI response failed: ${JSON.stringify(value['error'])}`);
  }
  const content = objectItems(value['output']).flatMap(outputItemBlocks);
  return {
    id: stringValue(value['id'], `msg_${crypto.randomUUID()}`),
    type: 'message',
    role: 'assistant',
    model: stringValue(value['model'], fallbackModel),
    content,
    stop_reason: stopReason(content, value),
    stop_sequence: null,
    usage: usage(value['usage']),
  };
}

function errorType(status: number): string {
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'api_error';
  if (status === 401) return 'authentication_error';
  return 'invalid_request_error';
}

export function openAIError(status: number, value: unknown, requestId: string): Response {
  const inner = record(record(value)['error']);
  return Response.json(
    {
      type: 'error',
      error: {
        type: errorType(status),
        message: stringValue(inner['message'], `OpenAI returned HTTP ${String(status)}`),
      },
      request_id: requestId,
    },
    { status },
  );
}
