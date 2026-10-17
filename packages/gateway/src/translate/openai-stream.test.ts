import { describe, expect, it } from 'vitest';

import { translateOpenAIStream } from './openai-stream.js';

type ParsedFrame = { readonly event: string; readonly data: Record<string, unknown> };

function upstream(events: readonly Record<string, unknown>[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const wire = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
      // Split the stream inside JSON/SSE boundaries to exercise incremental framing too.
      for (let offset = 0; offset < wire.length; offset += 17) {
        controller.enqueue(encoder.encode(wire.slice(offset, offset + 17)));
      }
      controller.close();
    },
  });
}

async function translated(events: readonly Record<string, unknown>[]): Promise<ParsedFrame[]> {
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

describe('Responses API stream translation', () => {
  it('preserves text and independently tracks multiple interleaved function calls', async () => {
    const frames = await translated([
      {
        type: 'response.created',
        response: { id: 'resp_1', model: 'gpt-test', status: 'in_progress' },
      },
      {
        type: 'response.content_part.added',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '' },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        delta: 'Before tools',
      },
      {
        type: 'response.output_text.done',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        text: 'Before tools',
      },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'first' },
      },
      {
        type: 'response.output_item.added',
        output_index: 2,
        item: { id: 'fc_2', type: 'function_call', call_id: 'call_2', name: 'second' },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_2',
        output_index: 2,
        delta: '{"b":',
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        output_index: 1,
        delta: '{"a":',
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_2',
        output_index: 2,
        delta: '2}',
      },
      {
        type: 'response.output_item.done',
        output_index: 2,
        item: {
          id: 'fc_2',
          type: 'function_call',
          call_id: 'call_2',
          name: 'second',
          arguments: '{"b":2}',
        },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        output_index: 1,
        delta: '1}',
      },
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: {
          id: 'fc_1',
          type: 'function_call',
          call_id: 'call_1',
          name: 'first',
          arguments: '{"a":1}',
        },
      },
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [{ type: 'function_call' }],
          usage: { input_tokens: 9, output_tokens: 7 },
        },
      },
    ]);

    expect(frames.map((entry) => entry.event)).toEqual([
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
    ]);
    expect(frames[1]?.data).toMatchObject({ index: 0, content_block: { type: 'text' } });
    expect(frames[4]?.data).toMatchObject({
      index: 1,
      content_block: { type: 'tool_use', id: 'call_1', name: 'first', input: {} },
    });
    expect(frames[5]?.data).toMatchObject({
      index: 2,
      content_block: { type: 'tool_use', id: 'call_2', name: 'second', input: {} },
    });
    expect(frames[6]?.data).toMatchObject({
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '{"b":' },
    });
    expect(frames[7]?.data).toMatchObject({ index: 1 });
    expect(frames[12]?.data).toMatchObject({
      delta: { stop_reason: 'tool_use' },
      usage: { input_tokens: 9, output_tokens: 7 },
    });
  });

  it('backs up done-only arguments and reports an incomplete max-output response as max_tokens', async () => {
    const frames = await translated([
      { type: 'response.created', response: { id: 'resp_2', model: 'gpt-test' } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'lookup' },
      },
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
    ]);

    expect(frames.map((entry) => entry.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(frames[2]?.data).toMatchObject({
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"city":"Tokyo"}' },
    });
    expect(frames[4]?.data).toMatchObject({ delta: { stop_reason: 'max_tokens' } });
  });
});
