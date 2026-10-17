import type { RunEventFrame } from '@indx-workspace/sdk/events';
import { describe, expect, it } from 'vitest';

import { renderFrame } from './stream.js';

const HUMAN = { json: false, jsonl: false, raw: false, quiet: false };
const JSONL = { ...HUMAN, jsonl: true };
const RAW = { ...HUMAN, raw: true };

const ENGINE = 'claude-agent-sdk';

/** One neutral frame as the stream delivers it: the `event:` name, and the frame as its `data`. */
const agent = (
  frame: string,
  fields: Record<string, unknown>,
  raw: unknown = null,
): RunEventFrame => ({
  kind: 'runtime',
  id: '9',
  name: frame,
  data: { frame, engine: ENGINE, raw, ...fields },
});

describe('renderFrame', () => {
  it('renders the platform frames for a human, as themselves in JSON lines, and never `done`', () => {
    const reset: RunEventFrame = {
      kind: 'stream-reset',
      data: { reason: 'cursor expired', resumedAfter: null },
    };
    expect(renderFrame(reset, HUMAN)).toEqual(['stream reset: cursor expired']);
    expect(renderFrame(reset, JSONL)).toEqual([JSON.stringify(reset)]);
    const failedStatus: RunEventFrame = {
      kind: 'run-status',
      id: '3',
      data: { status: 'failed', error: 'Budget exhausted.' },
    };
    expect(renderFrame(failedStatus, HUMAN)).toEqual(['run: failed (Budget exhausted.)']);
    expect(renderFrame({ kind: 'done' }, HUMAN)).toEqual([]);
    expect(renderFrame({ kind: 'done' }, JSONL)).toEqual([]);
    expect(renderFrame({ kind: 'done' }, RAW)).toEqual(['{"kind":"done"}']);
  });

  it('renders the whole neutral vocabulary for a human', () => {
    expect(
      renderFrame(agent('agent.session', { engineSessionId: 'sess_1', model: null }), HUMAN),
    ).toEqual(['session sess_1']);
    expect(
      renderFrame(
        agent('agent.message', {
          messageId: 'u-2',
          role: 'user',
          blocks: [{ type: 'text', text: 'Try again.' }],
        }),
        HUMAN,
      ),
    ).toEqual(['user: Try again.']);
    // A reasoning block is not printed as prose: the CLI shows the answer, and the model's private
    // deliberation is available through `--raw` and `--jsonl`.
    expect(
      renderFrame(
        agent('agent.message', {
          messageId: null,
          role: 'assistant',
          blocks: [{ type: 'reasoning', text: 'hmm' }],
        }),
        HUMAN,
      ),
    ).toEqual([]);
    expect(
      renderFrame(
        agent('agent.tool.call', {
          toolCallId: 'toolu_9',
          name: 'Read',
          kind: 'read',
          input: { path: '/x' },
        }),
        HUMAN,
      ),
    ).toEqual(['tool Read (read) {"path":"/x"}']);
    expect(
      renderFrame(
        agent('agent.tool.result', {
          toolCallId: 'toolu_9',
          status: 'completed',
          output: 'boom',
          isError: true,
        }),
        HUMAN,
      ),
    ).toEqual(['tool result toolu_9 completed (error): boom']);
    expect(
      renderFrame(
        agent('agent.usage', {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: null,
          cacheCreationInputTokens: null,
          reasoningTokens: null,
        }),
        HUMAN,
      ),
    ).toEqual(['tokens=10/20']);
    expect(
      renderFrame(
        agent('agent.result', { stopReason: 'max_turns', turns: 3, engineCostUsd: null }),
        HUMAN,
      ),
    ).toEqual(['result: max_turns']);
    expect(
      renderFrame(
        agent('agent.result', { stopReason: 'end_turn', turns: 1, engineCostUsd: 0.125 }),
        HUMAN,
      ),
    ).toEqual(['result: end_turn engine-cost=$0.1250 (estimate)']);
    expect(
      renderFrame(agent('agent.native', { type: 'stream_event', payload: null }), HUMAN),
    ).toEqual(['engine event: stream_event']);
    expect(renderFrame(agent('agent.malformed', { reason: 'not an object' }), HUMAN)).toEqual([
      'engine sent an unreadable event: not an object',
    ]);
  });

  it('prints the neutral event in JSON lines, and the engine-native payload with --raw', () => {
    const native = agent(
      'agent.native',
      { type: 'stream_event', payload: { type: 'x' } },
      {
        type: 'stream_event',
        delta: 'hi',
      },
    );
    expect(JSON.parse(renderFrame(native, JSONL)[0] ?? '')).toMatchObject({
      frame: 'agent.native',
      engine: ENGINE,
      type: 'stream_event',
    });
    // `--raw` is the engine's own words, not the neutral view and not the SSE envelope: it wins over
    // `--jsonl` and prints exactly what the engine emitted.
    expect(renderFrame(native, { ...RAW, jsonl: true })).toEqual([
      JSON.stringify({ type: 'stream_event', delta: 'hi' }),
    ]);
  });

  it('prints the undecoded payload with --raw when the frame does not satisfy its schema', () => {
    // `agent.native` with an empty `type` is refused by the contract; `--raw` is the diagnostic
    // mode, so it prints what arrived instead of aborting the stream on it.
    const refused = agent('agent.native', { type: '', payload: null }, { type: '' });
    expect(() => renderFrame(refused, HUMAN)).toThrow();
    expect(renderFrame(refused, RAW)).toEqual([
      JSON.stringify({
        frame: 'agent.native',
        engine: ENGINE,
        raw: { type: '' },
        type: '',
        payload: null,
      }),
    ]);
    // A frame name this build does not know is the same case: platform drift, shown rather than fatal.
    const future: RunEventFrame = {
      kind: 'runtime',
      id: '10',
      name: 'agent.telepathy',
      data: { frame: 'agent.telepathy', engine: ENGINE, raw: null },
    };
    expect(renderFrame(future, RAW)).toEqual([
      JSON.stringify({ frame: 'agent.telepathy', engine: ENGINE, raw: null }),
    ]);
  });
});
