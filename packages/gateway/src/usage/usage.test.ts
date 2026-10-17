import { describe, expect, it } from 'vitest';

import {
  createUsageAccumulator,
  extractResponseUsage,
  extractUsageFromEvents,
  readServerSentEvents,
  type ExtractedUsage,
} from './index.js';
import type { WireProtocol } from '../types.js';

function sse(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

function streamed(wire: string, chunkSize = wire.length): Response {
  const bytes = new TextEncoder().encode(wire);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}

async function payloadsOf(wire: string, chunkSize: number): Promise<string[]> {
  const collected: string[] = [];
  const body = streamed(wire, chunkSize).body;
  if (body === null) throw new Error('fixture stream has no body');
  await readServerSentEvents(body, (payload) => collected.push(payload));
  return collected;
}

/** Every strict prefix of an event list, shortest first — the monotonicity witness. */
function prefixes<T>(events: readonly T[]): readonly (readonly T[])[] {
  return events.map((_, index) => events.slice(0, index));
}

function assertPrefixMonotone(
  protocol: WireProtocol,
  events: readonly Record<string, unknown>[],
): void {
  const full = extractUsageFromEvents(protocol, events);
  expect(extractUsageFromEvents(protocol, [])).toMatchObject({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    toolCalls: 0,
    metered: false,
  });
  for (const prefix of prefixes(events)) {
    const partial = extractUsageFromEvents(protocol, prefix);
    expect(partial.inputTokens).toBeLessThanOrEqual(full.inputTokens);
    expect(partial.outputTokens).toBeLessThanOrEqual(full.outputTokens);
    expect(partial.cacheReadInputTokens).toBeLessThanOrEqual(full.cacheReadInputTokens);
    expect(partial.toolCalls).toBeLessThanOrEqual(full.toolCalls);
  }
}

const RESPONSES_STREAM = [
  'event: response.created',
  'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-fixture","output":[],"usage":null}}',
  '',
  'event: response.output_item.done',
  'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"fc_1","type":"function_call","name":"lookup"}}',
  '',
  'event: response.completed',
  'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-fixture","output":[{"id":"fc_1","type":"function_call","name":"lookup"}],"usage":{"input_tokens":100,"output_tokens":40,"input_tokens_details":{"cached_tokens":30},"output_tokens_details":{"reasoning_tokens":25}}}}',
  '',
];

const CHAT_STREAM = [
  'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","model":"gpt-fixture","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{\\"a"}}]},"finish_reason":null}],"usage":null}',
  '',
  'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","model":"gpt-fixture","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\":1}"}}]},"finish_reason":null}],"usage":null}',
  '',
  'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","model":"gpt-fixture","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":null}',
  '',
  'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","model":"gpt-fixture","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":40,"prompt_tokens_details":{"cached_tokens":30},"completion_tokens_details":{"reasoning_tokens":25}}}',
  '',
  'data: [DONE]',
  '',
];

describe('the incremental SSE reader', () => {
  it.each([1, 7, 64, 4096])(
    'reassembles the same payloads whatever the chunk boundaries are (%i bytes)',
    async (chunkSize) => {
      const payloads = await payloadsOf(sse(RESPONSES_STREAM), chunkSize);
      expect(payloads).toHaveLength(3);
      expect(payloads[0]).toContain('response.created');
      expect(payloads[2]).toContain('response.completed');
    },
  );

  it('drops the OpenAI [DONE] sentinel, which is not JSON', async () => {
    const payloads = await payloadsOf(sse(CHAT_STREAM), 13);
    expect(payloads).toHaveLength(4);
    expect(payloads.some((payload) => payload.includes('DONE'))).toBe(false);
  });

  it('delivers a final frame that arrived without its trailing newline', async () => {
    const payloads = await payloadsOf('data: {"type":"message_stop"}', 3);
    expect(payloads).toEqual(['{"type":"message_stop"}']);
  });

  it('discards a frame the stream was cut in the middle of', async () => {
    const payloads = await payloadsOf('data: {"type":"response.comp', 5);
    // Offered once and dropped, because it does not parse — see the caller in `index.ts`.
    expect(payloads).toEqual(['{"type":"response.comp']);
    expect(() => {
      JSON.parse(payloads[0] ?? '');
    }).toThrow();
  });
});

describe('Anthropic Messages extraction is unchanged', () => {
  it('merges the message_start and message_delta snapshots and counts tool blocks', async () => {
    const usage = await extractResponseUsage(
      streamed(
        sse([
          'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-fixture","usage":{"input_tokens":12,"output_tokens":0,"cache_read_input_tokens":4,"cache_creation_input_tokens":2}}}',
          '',
          'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"tool_1"}}',
          '',
          'data: {"type":"message_delta","usage":{"output_tokens":7}}',
          '',
          'data: {"type":"message_stop"}',
          '',
        ]),
        31,
      ),
      'anthropic-messages',
    );
    expect(usage).toEqual<ExtractedUsage>({
      responseId: 'msg_1',
      model: 'claude-fixture',
      inputTokens: 12,
      outputTokens: 7,
      cacheReadInputTokens: 4,
      cacheCreationInputTokens: 2,
      toolCalls: 1,
      metered: true,
      completed: true,
    });
  });

  it('reports a non-streaming body as metered and complete', async () => {
    const usage = await extractResponseUsage(
      Response.json({
        id: 'msg_2',
        type: 'message',
        model: 'claude-fixture',
        content: [{ type: 'tool_use', id: 'tool_1' }],
        usage: { input_tokens: 5, output_tokens: 6 },
      }),
      'anthropic-messages',
    );
    expect(usage).toMatchObject({ inputTokens: 5, outputTokens: 6, toolCalls: 1, metered: true });
  });

  // Both real shapes of a 200 with no `usage`: a non-streaming body carries `type: "message"` and a
  // stream ends with `message_stop`, so each declares itself complete. Extraction says so; what
  // `auth.ts` then does with an unmetered Anthropic response is `recorder.fail`, which
  // `auth.test.ts` pins.
  it.each([
    [
      'a non-streaming body',
      () => Response.json({ id: 'msg_3', type: 'message', model: 'claude-fixture', content: [] }),
    ],
    [
      'a stream ending in message_stop',
      () =>
        streamed(
          sse([
            'data: {"type":"message_start","message":{"id":"msg_3","model":"claude-fixture"}}',
            '',
            'data: {"type":"message_stop"}',
            '',
          ]),
          23,
        ),
    ],
  ])('reports %s carrying no usage at all as complete but unmetered', async (_shape, respond) => {
    const usage = await extractResponseUsage(respond(), 'anthropic-messages');
    expect(usage.metered).toBe(false);
    expect(usage.completed).toBe(true);
  });

  it('reports neither metered nor complete for a stream cut before message_stop', async () => {
    const usage = await extractResponseUsage(
      streamed(
        sse([
          'data: {"type":"message_start","message":{"id":"msg_4","model":"claude-fixture"}}',
          '',
        ]),
        19,
      ),
      'anthropic-messages',
    );
    expect(usage.metered).toBe(false);
    expect(usage.completed).toBe(false);
  });
});

describe('OpenAI Responses extraction', () => {
  it('subtracts the cached prefix and never adds reasoning on top of output', async () => {
    const usage = await extractResponseUsage(
      streamed(sse(RESPONSES_STREAM), 97),
      'openai-responses',
    );
    expect(usage).toEqual<ExtractedUsage>({
      responseId: 'resp_1',
      model: 'gpt-fixture',
      // 100 reported input INCLUDES the 30 cached, and pricing charges the two separately.
      inputTokens: 70,
      cacheReadInputTokens: 30,
      // 40 output already CONTAINS the 25 reasoning tokens; adding them would bill 65.
      outputTokens: 40,
      cacheCreationInputTokens: 0,
      toolCalls: 1,
      metered: true,
      completed: true,
    });
  });

  it('counts a function call once even when the stream and the terminal snapshot both name it', () => {
    const events = [
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { id: 'fc_1', type: 'function_call' },
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { id: 'fc_1', type: 'function_call' },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          model: 'gpt-fixture',
          output: [{ id: 'fc_1', type: 'function_call' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ];
    expect(extractUsageFromEvents('openai-responses', events).toolCalls).toBe(1);
  });

  // `passthrough.ts` relays `custom` tools as well as `function` ones, so the two rules have to
  // agree on what a tool call is: a `custom` invocation arrives as a `custom_tool_call` item.
  it('counts a custom_tool_call item as a tool call, from the stream and the snapshot alike', () => {
    expect(
      extractUsageFromEvents('openai-responses', [
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: { id: 'ctc_1', type: 'custom_tool_call' },
        },
        {
          type: 'response.completed',
          response: {
            id: 'resp_custom',
            model: 'gpt-fixture',
            output: [
              { id: 'ctc_1', type: 'custom_tool_call' },
              { id: 'fc_1', type: 'function_call' },
              { id: 'msg_1', type: 'message' },
            ],
            usage: { input_tokens: 4, output_tokens: 2 },
          },
        },
      ]).toolCalls,
    ).toBe(2);
  });

  it('meters a response.incomplete terminal frame, which a stream that ended early still sends', () => {
    const usage = extractUsageFromEvents('openai-responses', [
      {
        type: 'response.incomplete',
        response: {
          id: 'resp_2',
          model: 'gpt-fixture',
          status: 'incomplete',
          usage: { input_tokens: 9, output_tokens: 3 },
        },
      },
    ]);
    expect(usage).toMatchObject({
      inputTokens: 9,
      outputTokens: 3,
      metered: true,
      completed: true,
    });
  });

  it('reports a non-streaming body directly', async () => {
    const usage = await extractResponseUsage(
      Response.json({
        id: 'resp_3',
        object: 'response',
        model: 'gpt-fixture',
        output: [{ id: 'fc_9', type: 'function_call' }],
        usage: { input_tokens: 4, output_tokens: 2, input_tokens_details: { cached_tokens: 4 } },
      }),
      'openai-responses',
    );
    // Every input token was cached, so the input term clamps at zero rather than going negative.
    expect(usage).toMatchObject({
      inputTokens: 0,
      cacheReadInputTokens: 4,
      toolCalls: 1,
      metered: true,
      completed: true,
    });
  });

  it('records nothing and stays unmetered for a stream truncated before its terminal frame', async () => {
    const usage = await extractResponseUsage(
      streamed(sse(RESPONSES_STREAM.slice(0, 5)), 11),
      'openai-responses',
    );
    expect(usage).toMatchObject({
      model: 'gpt-fixture',
      inputTokens: 0,
      outputTokens: 0,
      metered: false,
      completed: false,
    });
  });

  it('is monotone over every prefix of its event sequence and invents nothing from none', () => {
    assertPrefixMonotone('openai-responses', [
      { type: 'response.created', response: { id: 'resp_1', model: 'gpt-fixture', usage: null } },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { id: 'fc_1', type: 'function_call' },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          model: 'gpt-fixture',
          usage: { input_tokens: 8, output_tokens: 3 },
        },
      },
    ]);
  });
});

describe('OpenAI Chat Completions extraction', () => {
  it('reads the final usage chunk and counts one fragmented tool call once', async () => {
    const usage = await extractResponseUsage(
      streamed(sse(CHAT_STREAM), 53),
      'openai-chat-completions',
    );
    expect(usage).toEqual<ExtractedUsage>({
      responseId: 'chatcmpl_1',
      model: 'gpt-fixture',
      inputTokens: 70,
      cacheReadInputTokens: 30,
      outputTokens: 40,
      cacheCreationInputTokens: 0,
      // Two delta chunks carry the same (choice 0, tool_calls[0]) call.
      toolCalls: 1,
      metered: true,
      completed: true,
    });
  });

  it('counts one call per distinct choice and index pair', () => {
    const usage = extractUsageFromEvents('openai-chat-completions', [
      {
        id: 'chatcmpl_2',
        model: 'gpt-fixture',
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0 }, { index: 1 }] } },
          { index: 1, delta: { tool_calls: [{ index: 0 }] } },
        ],
      },
    ]);
    expect(usage.toolCalls).toBe(3);
  });

  it('reports a non-streaming body directly', async () => {
    const usage = await extractResponseUsage(
      Response.json({
        id: 'chatcmpl_3',
        object: 'chat.completion',
        model: 'gpt-fixture',
        choices: [
          { index: 0, finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'call_1' }] } },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 5 },
      }),
      'openai-chat-completions',
    );
    expect(usage).toMatchObject({
      inputTokens: 20,
      outputTokens: 5,
      toolCalls: 1,
      metered: true,
      completed: true,
    });
  });

  it('reports a finished upstream that never sent usage as complete but unmetered', async () => {
    // The named `openai-compatible` risk: vLLM and Ollama do not all honour
    // `stream_options.include_usage`. Nothing is fabricated; the counters stay absent.
    const usage = await extractResponseUsage(
      streamed(
        sse([
          'data: {"id":"chatcmpl_4","object":"chat.completion.chunk","model":"local-fixture","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}',
          '',
          'data: {"id":"chatcmpl_4","object":"chat.completion.chunk","model":"local-fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          '',
          'data: [DONE]',
          '',
        ]),
        29,
      ),
      'openai-chat-completions',
    );
    expect(usage).toMatchObject({
      model: 'local-fixture',
      inputTokens: 0,
      outputTokens: 0,
      metered: false,
      completed: true,
    });
  });

  it('records nothing and stays incomplete for a stream cut before any finish_reason', async () => {
    const usage = await extractResponseUsage(
      streamed(sse(CHAT_STREAM.slice(0, 2)), 17),
      'openai-chat-completions',
    );
    expect(usage).toMatchObject({ metered: false, completed: false, toolCalls: 1 });
  });

  it('is monotone over every prefix of its event sequence and invents nothing from none', () => {
    assertPrefixMonotone('openai-chat-completions', [
      { id: 'c', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0 }] } }] },
      { id: 'c', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { id: 'c', model: 'm', choices: [], usage: { prompt_tokens: 6, completion_tokens: 2 } },
    ]);
  });
});

describe('the extractor table', () => {
  it.each(['anthropic-messages', 'openai-responses', 'openai-chat-completions'] as const)(
    'has an accumulator for %s that starts at zero and unmetered',
    (protocol) => {
      expect(createUsageAccumulator(protocol).snapshot()).toEqual<ExtractedUsage>({
        responseId: null,
        model: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        toolCalls: 0,
        metered: false,
        completed: false,
      });
    },
  );

  // A count that does not parse was never measured, so claiming a measured zero for it would price
  // the turn as genuinely free. `metered: false` settles the run `unavailable` instead (ADR-0068 D9).
  it.each([
    ['a negative count', { input_tokens: -5, output_tokens: 3 }],
    ['a fractional count', { input_tokens: 10, output_tokens: 1.5 }],
    ['string counts', { input_tokens: '90', output_tokens: '30' }],
    [
      'an unparseable cached prefix',
      { input_tokens: 10, output_tokens: 3, input_tokens_details: { cached_tokens: '4' } },
    ],
    ['no counter at all', {}],
  ])('reports %s as unmetered rather than as a measured zero (responses)', (_name, usage) => {
    const extracted = extractUsageFromEvents('openai-responses', [
      { type: 'response.completed', response: { id: 'resp_bad', model: 'gpt-fixture', usage } },
    ]);
    expect(extracted).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      metered: false,
      // Still complete: the upstream did finish, which is what makes this `unavailable` and not a
      // settlement failure.
      completed: true,
    });
  });

  it.each([
    ['a negative count', { prompt_tokens: -5, completion_tokens: 3 }],
    ['a fractional count', { prompt_tokens: 10, completion_tokens: 1.5 }],
    ['string counts', { prompt_tokens: '90', completion_tokens: '30' }],
    ['no counter at all', {}],
  ])(
    'reports %s as unmetered rather than as a measured zero (chat completions)',
    (_name, usage) => {
      const extracted = extractUsageFromEvents('openai-chat-completions', [
        { id: 'chatcmpl_bad', object: 'chat.completion', model: 'gpt-fixture', choices: [], usage },
      ]);
      expect(extracted).toMatchObject({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        metered: false,
        completed: true,
      });
    },
  );

  it('still meters a usage report that omits only its detail groups', () => {
    expect(
      extractUsageFromEvents('openai-responses', [
        {
          type: 'response.completed',
          response: {
            id: 'resp_plain',
            model: 'gpt-fixture',
            usage: { input_tokens: 8, output_tokens: 3 },
          },
        },
      ]),
    ).toMatchObject({ inputTokens: 8, outputTokens: 3, cacheReadInputTokens: 0, metered: true });
  });
});
