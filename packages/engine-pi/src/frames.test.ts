/**
 * The pi frame mapper: every pi event type, nothing dropped, tool pairing held (ENG-08, #307).
 */
import { describe, expect, it } from 'vitest';

import { addPiUsage, createPiFrameMapper, type PiEvent } from './frames.js';

function pi(event: unknown): PiEvent {
  return { kind: 'pi', event };
}

describe('createPiFrameMapper', () => {
  it('maps text and thinking deltas, and forwards every other update natively', () => {
    const mapper = createPiFrameMapper();
    expect(
      mapper.map(
        pi({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hi' } }),
      ),
    ).toMatchObject([{ frame: 'agent.message.delta', block: 'text', text: 'Hi', engine: 'pi' }]);
    expect(
      mapper.map(
        pi({
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', delta: 'hm' },
        }),
      ),
    ).toMatchObject([{ frame: 'agent.message.delta', block: 'reasoning', text: 'hm' }]);
    for (const type of [
      'text_start',
      'text_end',
      'thinking_start',
      'toolcall_start',
      'toolcall_delta',
      'toolcall_end',
    ]) {
      expect(
        mapper.map(pi({ type: 'message_update', assistantMessageEvent: { type } })),
      ).toMatchObject([{ frame: 'agent.native', type: `message_update.${type}` }]);
    }
    expect(mapper.map(pi({ type: 'message_update' }))).toMatchObject([
      { frame: 'agent.malformed' },
    ]);
  });

  it('maps an assistant message_end to agent.message, prose and reasoning only', () => {
    const [frame] = createPiFrameMapper().map(
      pi({
        type: 'message_end',
        message: {
          role: 'assistant',
          responseId: 'msg_7',
          content: [
            { type: 'thinking', thinking: 'plan' },
            { type: 'text', text: 'answer' },
            { type: 'toolCall', id: 't', name: 'read', arguments: {} },
          ],
        },
      }),
    );
    expect(frame).toMatchObject({
      frame: 'agent.message',
      messageId: 'msg_7',
      role: 'assistant',
      blocks: [
        { type: 'reasoning', text: 'plan' },
        { type: 'text', text: 'answer' },
      ],
    });
  });

  it('forwards user, tool-result and system message_end natively, and refuses an unreadable one', () => {
    const mapper = createPiFrameMapper();
    for (const role of ['user', 'toolResult', 'system']) {
      expect(mapper.map(pi({ type: 'message_end', message: { role, content: [] } }))).toMatchObject(
        [{ frame: 'agent.native', type: `message_end.${role}` }],
      );
    }
    expect(
      mapper.map(pi({ type: 'message_end', message: { role: 'assistant', content: 'x' } })),
    ).toMatchObject([{ frame: 'agent.malformed' }]);
    expect(mapper.map(pi({ type: 'message_end' }))).toMatchObject([{ frame: 'agent.malformed' }]);
  });

  it('pairs tool_execution_start with tool_execution_end, kinds by tool', () => {
    const mapper = createPiFrameMapper();
    const kinds = ['read', 'write', 'edit', 'bash', 'grep'].map((name, index) => {
      const [call] = mapper.map(
        pi({
          type: 'tool_execution_start',
          toolCallId: `c${String(index)}`,
          toolName: name,
          args: { path: 'a' },
        }),
      );
      return call?.frame === 'agent.tool.call' ? call.kind : null;
    });
    expect(kinds).toEqual(['read', 'edit', 'edit', 'execute', 'other']);

    expect(
      mapper.map(
        pi({
          type: 'tool_execution_end',
          toolCallId: 'c0',
          result: { content: [{ type: 'text', text: 'body' }] },
          isError: false,
        }),
      ),
    ).toMatchObject([
      { frame: 'agent.tool.result', status: 'completed', output: 'body', isError: false },
    ]);
    expect(
      mapper.map(
        pi({
          type: 'tool_execution_end',
          toolCallId: 'c1',
          result: { content: [{ type: 'text', text: 'blocked' }] },
          isError: true,
        }),
      ),
    ).toMatchObject([{ frame: 'agent.tool.result', status: 'failed', isError: true }]);
    // Already answered, or never announced: a hole, not a result.
    expect(
      mapper.map(
        pi({
          type: 'tool_execution_end',
          toolCallId: 'c0',
          result: { content: [] },
          isError: false,
        }),
      ),
    ).toMatchObject([{ frame: 'agent.malformed' }]);
    expect(mapper.map(pi({ type: 'tool_execution_start', toolName: 'read' }))).toMatchObject([
      { frame: 'agent.malformed' },
    ]);
    expect(
      mapper.map(
        pi({
          type: 'tool_execution_end',
          toolCallId: 'c2',
          result: { content: 7 },
          isError: false,
        }),
      ),
    ).toMatchObject([{ frame: 'agent.malformed' }]);
  });

  it('forwards every lifecycle event natively, agent_end included, and never returns nothing', () => {
    const mapper = createPiFrameMapper();
    for (const type of [
      'agent_start',
      'turn_start',
      'message_start',
      'tool_execution_update',
      'turn_end',
      'agent_end',
      'agent_settled',
      'queue_update',
      'compaction_start',
      'compaction_end',
      'auto_retry_start',
      'auto_retry_end',
    ]) {
      expect(mapper.map(pi({ type }))).toMatchObject([{ frame: 'agent.native', type }]);
    }
    expect(mapper.map(pi(null))).toMatchObject([{ frame: 'agent.malformed' }]);
    expect(mapper.map(pi({ kind: 'no type' }))).toMatchObject([{ frame: 'agent.malformed' }]);
  });

  it('ends with agent.usage and agent.result from the terminal event', () => {
    const frames = createPiFrameMapper().map({
      kind: 'run_completed',
      stopReason: 'max_turns',
      turns: 3,
      usage: {
        inputTokens: 5,
        outputTokens: 2,
        cacheReadInputTokens: 1,
        cacheWriteInputTokens: 0,
        costUsd: 0.5,
      },
    });
    expect(frames).toMatchObject([
      {
        frame: 'agent.usage',
        inputTokens: 5,
        outputTokens: 2,
        cacheReadInputTokens: 1,
        cacheCreationInputTokens: 0,
        reasoningTokens: null,
      },
      { frame: 'agent.result', stopReason: 'max_turns', turns: 3, engineCostUsd: null },
    ]);
    expect(
      createPiFrameMapper().map({
        kind: 'run_completed',
        stopReason: 'cancelled',
        turns: 0,
        usage: null,
      }),
    ).toMatchObject([{ frame: 'agent.result', stopReason: 'cancelled', engineCostUsd: null }]);
  });
});

describe('addPiUsage', () => {
  it("sums pi's per-message usage and ignores what it cannot read", () => {
    const one = addPiUsage(null, {
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 1,
      cost: { total: 0.25 },
    });
    const two = addPiUsage(one, { input: 1, output: 1, cost: { total: 0.25 } });
    expect(two).toEqual({
      inputTokens: 11,
      outputTokens: 6,
      cacheReadInputTokens: 2,
      cacheWriteInputTokens: 1,
      costUsd: 0.5,
    });
    expect(addPiUsage(two, 'nothing')).toBe(two);
    expect(addPiUsage(null, { input: -1, output: 2 })).toBeNull();
  });
});
