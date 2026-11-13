import { describe, expect, it } from 'vitest';

import {
  CACHED_PREFIX_EVENTS,
  DONE_ONLY_ARGUMENTS_EVENTS,
  DONE_ONLY_ARGUMENTS_FRAME_EVENTS,
  FAILED_WITH_USAGE_EVENTS,
  INTERLEAVED_TOOL_CALL_EVENTS,
  INTERLEAVED_TOOL_CALL_FRAME_EVENTS,
  meteredUsage,
  translated,
} from './openai-stream.test-support.js';

describe('Responses API stream translation of tool calls', () => {
  it('preserves text and independently tracks multiple interleaved function calls', async () => {
    const frames = await translated(INTERLEAVED_TOOL_CALL_EVENTS);

    expect(frames.map((entry) => entry.event)).toEqual(INTERLEAVED_TOOL_CALL_FRAME_EVENTS);
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
    const frames = await translated(DONE_ONLY_ARGUMENTS_EVENTS);

    expect(frames.map((entry) => entry.event)).toEqual(DONE_ONLY_ARGUMENTS_FRAME_EVENTS);
    expect(frames[2]?.data).toMatchObject({
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"city":"Tokyo"}' },
    });
    expect(frames[4]?.data).toMatchObject({ delta: { stop_reason: 'max_tokens' } });
  });
});

describe('Responses API stream translation of usage', () => {
  it('reports cached tokens additively, not inside input_tokens', async () => {
    const frames = await translated(CACHED_PREFIX_EVENTS);

    expect(frames.find((f) => f.event === 'message_delta')?.data).toMatchObject({
      usage: { input_tokens: 10_000, output_tokens: 1000, cache_read_input_tokens: 90_000 },
    });
  });

  it('carries usage on response.failed and never settles it as measured zero', async () => {
    const frames = await translated(FAILED_WITH_USAGE_EVENTS);

    expect(meteredUsage(frames)).toMatchObject({
      inputTokens: 50_000,
      outputTokens: 800,
      metered: true,
      completed: false,
    });
  });

  it('ends a stream with no terminal event as an error that stays unmetered', async () => {
    const frames = await translated([{ type: 'response.created', response: { id: 'resp_t' } }]);

    expect(frames.map((f) => f.event)).toEqual(['message_start', 'error']);
    expect(meteredUsage(frames)).toMatchObject({ metered: false, completed: false });
  });
});
