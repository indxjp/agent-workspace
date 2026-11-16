import { createUsageAccumulator } from '../usage/index.js';
import { translateOpenAIStream } from './openai-stream.js';

export type StreamEvent = Record<string, unknown>;
export type ParsedFrame = { readonly event: string; readonly data: Record<string, unknown> };
type FunctionCallRef = { readonly id: string; readonly callId: string; readonly name: string };

const UPSTREAM_CHUNK_SIZE = 17;

/** An upstream body that delivers the events as SSE, cut mid-frame to exercise incremental parsing. */
function upstream(events: readonly StreamEvent[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const wire = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
      for (let offset = 0; offset < wire.length; offset += UPSTREAM_CHUNK_SIZE) {
        controller.enqueue(encoder.encode(wire.slice(offset, offset + UPSTREAM_CHUNK_SIZE)));
      }
      controller.close();
    },
  });
}

export async function translated(events: readonly StreamEvent[]): Promise<ParsedFrame[]> {
  const wire = await new Response(translateOpenAIStream(upstream(events), 'fallback-model')).text();
  return wire
    .trim()
    .split(/\r?\n\r?\n/)
    .map((raw) => {
      const lines = raw.split(/\r?\n/);
      return {
        event: lines[0]?.slice('event: '.length) ?? '',
        data: JSON.parse(lines[1]?.slice('data: '.length) ?? '{}') as Record<string, unknown>,
      };
    });
}

/** What the usage meter settles from the translated frames. */
export function meteredUsage(
  frames: readonly ParsedFrame[],
): ReturnType<ReturnType<typeof createUsageAccumulator>['snapshot']> {
  const usage = createUsageAccumulator('anthropic-messages');
  for (const frame of frames) usage.observe(frame.data);
  return usage.snapshot();
}

function functionCallAdded(outputIndex: number, call: FunctionCallRef): StreamEvent {
  return {
    type: 'response.output_item.added',
    output_index: outputIndex,
    item: { id: call.id, type: 'function_call', call_id: call.callId, name: call.name },
  };
}

function argumentsDelta(itemId: string, outputIndex: number, delta: string): StreamEvent {
  return {
    type: 'response.function_call_arguments.delta',
    item_id: itemId,
    output_index: outputIndex,
    delta,
  };
}

function functionCallDone(
  outputIndex: number,
  call: FunctionCallRef,
  argumentsText: string,
): StreamEvent {
  return {
    type: 'response.output_item.done',
    output_index: outputIndex,
    item: {
      id: call.id,
      type: 'function_call',
      call_id: call.callId,
      name: call.name,
      arguments: argumentsText,
    },
  };
}

function textPartEvent(type: string, extra: StreamEvent): StreamEvent {
  return { type, item_id: 'msg_1', output_index: 0, content_index: 0, ...extra };
}

const FIRST_CALL: FunctionCallRef = { id: 'fc_1', callId: 'call_1', name: 'first' };
const SECOND_CALL: FunctionCallRef = { id: 'fc_2', callId: 'call_2', name: 'second' };

/** Text, then two function calls whose argument deltas interleave and finish out of order. */
export const INTERLEAVED_TOOL_CALL_EVENTS: readonly StreamEvent[] = [
  {
    type: 'response.created',
    response: { id: 'resp_1', model: 'gpt-test', status: 'in_progress' },
  },
  textPartEvent('response.content_part.added', { part: { type: 'output_text', text: '' } }),
  textPartEvent('response.output_text.delta', { delta: 'Before tools' }),
  textPartEvent('response.output_text.done', { text: 'Before tools' }),
  functionCallAdded(1, FIRST_CALL),
  functionCallAdded(2, SECOND_CALL),
  argumentsDelta('fc_2', 2, '{"b":'),
  argumentsDelta('fc_1', 1, '{"a":'),
  argumentsDelta('fc_2', 2, '2}'),
  functionCallDone(2, SECOND_CALL, '{"b":2}'),
  argumentsDelta('fc_1', 1, '1}'),
  functionCallDone(1, FIRST_CALL, '{"a":1}'),
  {
    type: 'response.completed',
    response: {
      status: 'completed',
      output: [{ type: 'function_call' }],
      usage: { input_tokens: 9, output_tokens: 7 },
    },
  },
];

/** A function call whose arguments arrive only in the `.done` event, then hit the token limit. */
export const DONE_ONLY_ARGUMENTS_EVENTS: readonly StreamEvent[] = [
  { type: 'response.created', response: { id: 'resp_2', model: 'gpt-test' } },
  functionCallAdded(0, { id: 'fc_1', callId: 'call_1', name: 'lookup' }),
  {
    type: 'response.function_call_arguments.done',
    item_id: 'fc_1',
    output_index: 0,
    name: 'lookup',
    arguments: '{"city":"Tokyo"}',
  },
  {
    type: 'response.incomplete',
    response: {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      usage: { input_tokens: 4, output_tokens: 5 },
    },
  },
];

export const INTERLEAVED_TOOL_CALL_FRAME_EVENTS: readonly string[] = [
  'message_start',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'content_block_start',
  'content_block_start',
  'content_block_delta',
  'content_block_delta',
  'content_block_delta',
  'content_block_stop',
  'content_block_delta',
  'content_block_stop',
  'message_delta',
  'message_stop',
];

export const DONE_ONLY_ARGUMENTS_FRAME_EVENTS: readonly string[] = [
  'message_start',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'message_delta',
  'message_stop',
];

/** A completed response whose 100k input tokens include a 90k cached prefix. */
export const CACHED_PREFIX_EVENTS: readonly StreamEvent[] = [
  { type: 'response.created', response: { id: 'resp_c' } },
  {
    type: 'response.completed',
    response: {
      usage: {
        input_tokens: 100_000,
        output_tokens: 1000,
        input_tokens_details: { cached_tokens: 90_000 },
      },
    },
  },
];

/** A response that fails after the upstream already spent tokens. */
export const FAILED_WITH_USAGE_EVENTS: readonly StreamEvent[] = [
  { type: 'response.created', response: { id: 'resp_f' } },
  {
    type: 'response.failed',
    response: {
      error: { message: 'boom' },
      usage: { input_tokens: 50_000, output_tokens: 800 },
    },
  },
];
