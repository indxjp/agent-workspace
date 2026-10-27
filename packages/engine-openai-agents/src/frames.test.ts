/**
 * `createOpenAiAgentsFrameMapper`: every `RunStreamEvent` kind and item name (ENG-09, #308).
 */
import { AgentFrameSchema } from '@indx-workspace/contracts/run-events';
import { describe, expect, it } from 'vitest';

import {
  addResponseUsage,
  createOpenAiAgentsFrameMapper,
  type OpenAiAgentsEvent,
} from './frames.js';

const mapper = () => createOpenAiAgentsFrameMapper({ localTools: ['read_file'], hasMcp: true });
const item = (name: string, rawItem: unknown, output?: unknown): OpenAiAgentsEvent => ({
  kind: 'run_item_stream_event',
  name,
  item: { type: 'x', rawItem, ...(output === undefined ? {} : { output }) },
});

describe('the OpenAI Agents frame mapper', () => {
  it('maps text and reasoning deltas', () => {
    const map = mapper();
    expect(
      map.map({
        kind: 'raw_model_stream_event',
        data: { type: 'output_text_delta', delta: 'a', itemId: 'm' },
      }),
    ).toMatchObject([{ frame: 'agent.message.delta', block: 'text', text: 'a', messageId: 'm' }]);
    expect(
      map.map({
        kind: 'raw_model_stream_event',
        data: {
          type: 'model',
          event: { type: 'response.reasoning_summary_text.delta', delta: 'r' },
        },
      }),
    ).toMatchObject([{ frame: 'agent.message.delta', block: 'reasoning', text: 'r' }]);
    expect(
      map.map({ kind: 'raw_model_stream_event', data: { type: 'response_started' } }),
    ).toMatchObject([{ frame: 'agent.native', type: 'raw_model_stream_event.response_started' }]);
  });

  it('maps messages, reasoning items, tool calls and results, with MCP kinds', () => {
    const map = mapper();
    expect(
      map.map(
        item('message_output_created', { id: 'm', content: [{ type: 'output_text', text: 'hi' }] }),
      ),
    ).toMatchObject([{ frame: 'agent.message', blocks: [{ type: 'text', text: 'hi' }] }]);
    expect(
      map.map(
        item('reasoning_item_created', {
          id: 'r',
          content: [{ type: 'input_text', text: 'think' }],
        }),
      ),
    ).toMatchObject([{ frame: 'agent.message', blocks: [{ type: 'reasoning', text: 'think' }] }]);
    expect(
      map.map(
        item('tool_called', {
          type: 'function_call',
          callId: 'c1',
          name: 'read_file',
          arguments: '{"path":"a"}',
        }),
      ),
    ).toMatchObject([{ frame: 'agent.tool.call', kind: 'read', input: { path: 'a' } }]);
    expect(
      map.map(
        item('tool_called', { type: 'function_call', callId: 'c2', name: 'echo', arguments: '{}' }),
      ),
    ).toMatchObject([{ frame: 'agent.tool.call', kind: 'mcp' }]);
    expect(
      map.map(
        item(
          'tool_output',
          { type: 'function_call_result', callId: 'c1', status: 'completed' },
          'ok',
        ),
      ),
    ).toMatchObject([
      { frame: 'agent.tool.result', toolCallId: 'c1', output: 'ok', isError: false },
    ]);
    expect(
      map.map(item('tool_output', { type: 'function_call_result', callId: 'c2' }, 'ERROR: no')),
    ).toMatchObject([{ frame: 'agent.tool.result', isError: true }]);
  });

  it('never drops an event: unknown kinds are native, unreadable ones malformed', () => {
    const map = mapper();
    for (const name of [
      'handoff_requested',
      'handoff_occurred',
      'tool_approval_requested',
      'compaction_item_created',
    ]) {
      expect(map.map(item(name, {}))).toMatchObject([{ frame: 'agent.native' }]);
    }
    expect(map.map({ kind: 'agent_updated_stream_event', agentName: 'A' })).toMatchObject([
      { frame: 'agent.native', type: 'agent_updated_stream_event' },
    ]);
    expect(map.map({ kind: 'raw_model_stream_event', data: 7 })).toMatchObject([
      { frame: 'agent.malformed' },
    ]);
    expect(map.map(item('message_output_created', null))).toMatchObject([
      { frame: 'agent.malformed' },
    ]);
  });

  it('refuses a tool result whose call was never announced', () => {
    expect(
      mapper().map(item('tool_output', { type: 'function_call_result', callId: 'ghost' }, 'x')),
    ).toMatchObject([{ frame: 'agent.malformed' }]);
  });

  it('ends with usage and result, and every frame parses against the published contract', () => {
    const frames = mapper().map({
      kind: 'run_completed',
      stopReason: 'max_turns',
      turns: 2,
      usage: { inputTokens: 3, outputTokens: 4, cachedInputTokens: 1, reasoningTokens: null },
    });
    expect(frames.map((frame) => frame.frame)).toEqual(['agent.usage', 'agent.result']);
    for (const frame of frames) expect(AgentFrameSchema.safeParse(frame).success).toBe(true);
    expect(frames[1]).toMatchObject({ stopReason: 'max_turns', turns: 2, engineCostUsd: null });
  });

  it('carries the answer onto agent.result when run_completed has one, and no key when it has none', () => {
    const completed = {
      kind: 'run_completed',
      stopReason: 'end_turn',
      turns: 1,
      usage: null,
    } as const;
    const output = { text: '{"a":1}', structured: { a: 1 } };
    const [withOutput] = mapper().map({ ...completed, output });
    expect(AgentFrameSchema.safeParse(withOutput).success).toBe(true);
    expect(withOutput).toMatchObject({ frame: 'agent.result', output });
    expect(mapper().map(completed)[0]).not.toHaveProperty('output');
  });

  it('sums response usage, cached and reasoning details included', () => {
    const once = addResponseUsage(null, {
      inputTokens: 10,
      outputTokens: 2,
      inputTokensDetails: { cached_tokens: 4 },
      outputTokensDetails: [{ reasoning_tokens: 1 }],
    });
    expect(addResponseUsage(once, { inputTokens: 1, outputTokens: 1 })).toEqual({
      inputTokens: 11,
      outputTokens: 3,
      cachedInputTokens: 4,
      reasoningTokens: 1,
    });
    expect(addResponseUsage(null, 'nothing')).toBeNull();
  });
});
