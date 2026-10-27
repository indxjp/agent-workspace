/**
 * `toAgentFrames` — the Claude Agent SDK → neutral `agent.*` mapping (ENG-03, #302).
 *
 * The two guarantees the runner and the event-read path both rely on are asserted exhaustively, over
 * the constants `types.ts` transcribes from R-01 rather than over a hand-picked sample:
 *
 *   1. **nothing is dropped** — every `sdkEventTypes` and every `sdkSystemSubtypes` value produces
 *      at least one frame, and anything with no neutral meaning produces `agent.native`;
 *   2. **tool results are paired** — a `tool_result` frame is only ever produced after the
 *      `tool_use` frame naming the same `toolCallId`.
 */
import { readFileSync } from 'node:fs';

import { AgentResultFrameSchema } from '@indx-workspace/contracts/run-events';
import { describe, expect, it } from 'vitest';

import {
  AGENT_FRAME_RAW_MAX_BYTES,
  CLAUDE_AGENT_SDK_ENGINE,
  capAgentFrameRaw,
  claudeToolKind,
  classifySdkEvent,
  toAgentFrames,
} from './schemas.js';
import {
  agentFrameNames,
  sdkEventTypes,
  sdkResultSubtypes,
  sdkSystemSubtypes,
  type AgentFrame,
} from './types.js';

function framesOf(raw: unknown): readonly AgentFrame[] {
  return toAgentFrames(classifySdkEvent(raw));
}

function names(frames: readonly AgentFrame[]): readonly string[] {
  return frames.map((frame) => frame.frame);
}

const assistantWithTools = {
  type: 'assistant',
  session_id: 'sess_1',
  uuid: 'uuid-1',
  message: {
    id: 'msg_1',
    content: [
      { type: 'thinking', thinking: 'let me look' },
      { type: 'text', text: 'Reading the file.' },
      { type: 'tool_use', id: 'tool_1', name: 'Read', input: { path: '/etc/hosts' } },
      { type: 'tool_use', id: 'tool_2', name: 'mcp__github__issues', input: {} },
    ],
  },
};

const userWithResult = {
  type: 'user',
  session_id: 'sess_1',
  uuid: 'uuid-2',
  message: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tool_1',
        content: [{ type: 'text', text: '127.0.0.1' }],
      },
    ],
  },
};

/**
 * Every shape the mapping reads, by name. `__fixtures__/agent-frames.golden.json` holds the frames
 * the mapping produced for each one before it was rebuilt on the port's `engineFrameBuilder`
 * (#958): the rebuild may reorder keys and must change no value.
 */
const goldenInputs: ReadonlyArray<readonly [name: string, raw: unknown]> = [
  ...sdkEventTypes.map((type): readonly [string, unknown] => [
    `type:${type}`,
    type === 'system' || type === 'result'
      ? { type, subtype: 'init', session_id: 'sess_1' }
      : { type },
  ]),
  ...sdkSystemSubtypes.map((subtype): readonly [string, unknown] => [
    `system:${subtype}`,
    { type: 'system', subtype, session_id: 'sess_1', model: 'claude-opus-5' },
  ]),
  ['system:init-without-session', { type: 'system', subtype: 'init' }],
  ['system:unknown-subtype', { type: 'system', subtype: 'from_the_future', n: 1 }],
  ...sdkResultSubtypes.map((subtype): readonly [string, unknown] => [
    `result:${subtype}`,
    { type: 'result', subtype, total_cost_usd: 0.5, num_turns: 3 },
  ]),
  ['result:unknown-subtype', { type: 'result', subtype: 'error_from_the_future' }],
  ['result:negative-cost', { type: 'result', subtype: 'success', total_cost_usd: -1 }],
  [
    'result:usage',
    {
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.25,
      modelUsage: {
        'claude-opus-5': {
          inputTokens: 10,
          outputTokens: 40,
          cacheReadInputTokens: 5,
          cacheCreationInputTokens: 2,
          thinkingTokens: 8,
        },
        'claude-haiku-4-5': { inputTokens: 1, outputTokens: 2 },
      },
    },
  ],
  ['assistant:tools', assistantWithTools],
  ['assistant:no-message', { type: 'assistant', session_id: 's' }],
  [
    'assistant:tool-without-input',
    {
      type: 'assistant',
      message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'tool_1', name: 'Grep' }] },
    },
  ],
  ['user:tool-result', userWithResult],
  [
    'user:error-result',
    {
      type: 'user',
      uuid: 'uuid-3',
      message: {
        content: [
          { type: 'text', text: 'hello' },
          { type: 'tool_result', tool_use_id: 'tool_9', content: 'boom', is_error: true },
        ],
      },
    },
  ],
  ['user:image-only', { type: 'user', message: { content: [{ type: 'image', source: {} }] } }],
  ['malformed:not-an-object', 'not an object'],
  ['malformed:no-type', { subtype: 'init' }],
  ['malformed:empty-type', { type: '' }],
];

describe('toAgentFrames — equivalence with the pre-#958 mapping', () => {
  const golden: unknown = JSON.parse(
    readFileSync(new URL('./__fixtures__/agent-frames.golden.json', import.meta.url), 'utf8'),
  );

  it('produces deep-equal frames for every recorded input', () => {
    const actual = goldenInputs.map(([name, raw]) => ({ name, frames: framesOf(raw) }));
    expect(JSON.parse(JSON.stringify(actual))).toEqual(golden);
  });
});

describe('toAgentFrames — nothing is dropped', () => {
  it('produces at least one frame for every SDK top-level type', () => {
    for (const type of sdkEventTypes) {
      const raw =
        type === 'system' || type === 'result'
          ? { type, subtype: 'init', session_id: 'sess_1' }
          : { type };
      const frames = framesOf(raw);
      expect(frames.length, type).toBeGreaterThan(0);
      for (const frame of frames) expect(agentFrameNames).toContain(frame.frame);
    }
  });

  it('produces a neutral frame or agent.native for every system subtype, never a drop', () => {
    for (const subtype of sdkSystemSubtypes) {
      const frames = framesOf({ type: 'system', subtype, session_id: 'sess_1' });
      expect(frames.length, subtype).toBe(1);
      const only = frames[0];
      if (subtype === 'init') {
        expect(only?.frame).toBe('agent.session');
      } else {
        expect(only?.frame, subtype).toBe('agent.native');
        expect(only?.frame === 'agent.native' && only.type).toBe(`system/${subtype}`);
      }
    }
  });

  it('maps every result subtype onto a stop reason, and an unknown one onto error', () => {
    const expected: Readonly<Record<string, string>> = {
      success: 'end_turn',
      error_during_execution: 'error',
      error_max_turns: 'max_turns',
      error_max_budget_usd: 'max_budget',
      error_max_structured_output_retries: 'error',
    };
    for (const subtype of sdkResultSubtypes) {
      const frames = framesOf({ type: 'result', subtype, total_cost_usd: 0.5, num_turns: 3 });
      expect(names(frames), subtype).toEqual(['agent.result']);
      const result = frames[0];
      expect(result?.frame === 'agent.result' && result.stopReason, subtype).toBe(
        expected[subtype],
      );
      expect(result?.frame === 'agent.result' && result.engineCostUsd).toBe(0.5);
      expect(result?.frame === 'agent.result' && result.turns).toBe(3);
    }
    const unknown = framesOf({ type: 'result', subtype: 'error_from_the_future' });
    const only = unknown[0];
    expect(only?.frame === 'agent.result' && only.stopReason).toBe('error');
  });

  it('carries a successful result as agent.result.output, with structured_output or null', () => {
    const structured = framesOf({
      type: 'result',
      subtype: 'success',
      result: '{"total":3}',
      structured_output: { total: 3 },
    })[0];
    expect(structured).toMatchObject({
      frame: 'agent.result',
      output: { text: '{"total":3}', structured: { total: 3 } },
    });
    expect(AgentResultFrameSchema.safeParse(structured).success).toBe(true);
    const plain = framesOf({ type: 'result', subtype: 'success', result: 'done' })[0];
    expect(plain).toMatchObject({ output: { text: 'done', structured: null } });
    expect(AgentResultFrameSchema.safeParse(plain).success).toBe(true);
  });

  it('gives a result that is not a success, or has no text, no output', () => {
    for (const raw of [
      { type: 'result', subtype: 'error_max_structured_output_retries', result: 'x' },
      { type: 'result', subtype: 'error_max_turns' },
      { type: 'result', subtype: 'success' },
      { type: 'result', subtype: 'success', result: 7 },
    ]) {
      const only = framesOf(raw)[0];
      expect(only?.frame === 'agent.result' && 'output' in only, JSON.stringify(raw)).toBe(false);
    }
  });

  it('reports a message it cannot read as agent.native rather than returning nothing', () => {
    // An `assistant` event with no `message`, and a `user` turn carrying only an image: both are
    // events that happened, and neither has any prose or tool block to become a frame.
    expect(names(framesOf({ type: 'assistant', session_id: 's' }))).toEqual(['agent.native']);
    expect(
      names(framesOf({ type: 'user', message: { content: [{ type: 'image', source: {} }] } })),
    ).toEqual(['agent.native']);
  });

  it('names a malformed event by its reason and keeps what arrived in raw', () => {
    const frames = framesOf('not an object');
    expect(names(frames)).toEqual(['agent.malformed']);
    const only = frames[0];
    expect(only?.frame === 'agent.malformed' && only.reason).toMatch(/must be an object/);
    expect(only?.raw).toBe('not an object');
    const noType = framesOf({ subtype: 'init' });
    const first = noType[0];
    expect(first?.frame === 'agent.malformed' && first.reason).toMatch(/string 'type'/);
  });

  it('refuses an empty `type` by name, so it never becomes an agent.native the contract rejects', () => {
    expect(classifySdkEvent({ type: '' })).toMatchObject({
      kind: 'malformed',
      reason: `an SDK event must carry a non-empty 'type'; got the string ""`,
    });
    const frames = framesOf({ type: '' });
    expect(names(frames)).toEqual(['agent.malformed']);
    expect(frames[0]?.raw).toEqual({ type: '' });
  });
});

describe('toAgentFrames — the neutral fields', () => {
  it('reads a session from system/init, and refuses one without a session id', () => {
    const frames = framesOf({
      type: 'system',
      subtype: 'init',
      session_id: 'sess_1',
      model: 'claude-opus-5',
    });
    expect(frames[0]).toMatchObject({
      frame: 'agent.session',
      engine: CLAUDE_AGENT_SDK_ENGINE,
      engineSessionId: 'sess_1',
      model: 'claude-opus-5',
    });
    // No session id means this is not a session — claiming one would write an empty id into
    // `sessions.engine_session_id`.
    expect(names(framesOf({ type: 'system', subtype: 'init' }))).toEqual(['agent.native']);
    const noModel = framesOf({ type: 'system', subtype: 'init', session_id: 'sess_2' });
    expect(noModel[0]).toMatchObject({ frame: 'agent.session', model: null });
  });

  it('splits an assistant turn into its prose and one frame per tool call, in order', () => {
    const frames = framesOf(assistantWithTools);
    expect(names(frames)).toEqual(['agent.message', 'agent.tool.call', 'agent.tool.call']);
    expect(frames[0]).toMatchObject({
      frame: 'agent.message',
      role: 'assistant',
      messageId: 'msg_1',
      blocks: [
        { type: 'reasoning', text: 'let me look' },
        { type: 'text', text: 'Reading the file.' },
      ],
    });
    expect(frames[1]).toMatchObject({
      frame: 'agent.tool.call',
      toolCallId: 'tool_1',
      name: 'Read',
      kind: 'read',
      input: { path: '/etc/hosts' },
    });
    expect(frames[2]).toMatchObject({ toolCallId: 'tool_2', kind: 'mcp' });
  });

  it('reads a tool result off a user turn, flattening its content to text', () => {
    const frames = framesOf(userWithResult);
    expect(names(frames)).toEqual(['agent.tool.result']);
    expect(frames[0]).toMatchObject({
      frame: 'agent.tool.result',
      toolCallId: 'tool_1',
      status: 'completed',
      output: '127.0.0.1',
      isError: false,
    });
  });

  it('pairs every tool result with an earlier call naming the same id', () => {
    const stream = [assistantWithTools, userWithResult].flatMap((raw) => [...framesOf(raw)]);
    const called = new Set<string>();
    for (const frame of stream) {
      if (frame.frame === 'agent.tool.call') called.add(frame.toolCallId);
      if (frame.frame === 'agent.tool.result') expect(called.has(frame.toolCallId)).toBe(true);
    }
    expect(called).toEqual(new Set(['tool_1', 'tool_2']));
  });

  it('carries the engine-reported counters as usage, separately from the result', () => {
    const frames = framesOf({
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.25,
      modelUsage: {
        'claude-opus-5': {
          inputTokens: 10,
          outputTokens: 40,
          cacheReadInputTokens: 5,
          cacheCreationInputTokens: 2,
          thinkingTokens: 8,
        },
        'claude-haiku-4-5': { inputTokens: 1, outputTokens: 2 },
      },
    });
    expect(names(frames)).toEqual(['agent.usage', 'agent.result']);
    // Summed across models because R-01 §4 records the record key as unstable, and
    // `thinkingTokens` is reported separately without being added again: it is already inside
    // `outputTokens`.
    expect(frames[0]).toMatchObject({
      frame: 'agent.usage',
      inputTokens: 11,
      outputTokens: 42,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 2,
      reasoningTokens: 8,
    });
  });

  it('omits usage entirely when the engine reported none, rather than reporting zeros', () => {
    expect(names(framesOf({ type: 'result', subtype: 'success' }))).toEqual(['agent.result']);
    expect(names(framesOf({ type: 'result', subtype: 'success', modelUsage: {} }))).toEqual([
      'agent.result',
    ]);
    const unreadable = framesOf({
      type: 'result',
      subtype: 'success',
      modelUsage: { m: { inputTokens: 'lots' } },
    });
    expect(names(unreadable)).toEqual(['agent.result']);
  });

  it('refuses a cost that is not a finite non-negative number', () => {
    for (const total_cost_usd of [-1, Number.NaN, Number.POSITIVE_INFINITY, '0.5', null]) {
      const frames = framesOf({ type: 'result', subtype: 'success', total_cost_usd });
      expect(frames[0]).toMatchObject({ frame: 'agent.result', engineCostUsd: null });
    }
  });
});

describe('toAgentFrames — tool input', () => {
  it('sends a tool_use block without an input as `input: null`, never an absent key', () => {
    const frames = framesOf({
      type: 'assistant',
      message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'tool_1', name: 'Grep' }] },
    });
    expect(frames).toHaveLength(1);
    const call = frames[0];
    expect(call?.frame).toBe('agent.tool.call');
    expect(call !== undefined && 'input' in call && call.input).toBeNull();
    // And it survives the wire: `JSON.stringify` keeps a `null`, where it would drop `undefined`.
    expect(JSON.parse(JSON.stringify(call))).toHaveProperty('input', null);
  });
});

describe('claudeToolKind', () => {
  it('names the tools whose effect is known and answers `other` for the rest', () => {
    expect(claudeToolKind('Read')).toBe('read');
    expect(claudeToolKind('Edit')).toBe('edit');
    expect(claudeToolKind('Grep')).toBe('search');
    expect(claudeToolKind('WebFetch')).toBe('fetch');
    expect(claudeToolKind('Bash')).toBe('execute');
    expect(claudeToolKind('mcp__slack__post')).toBe('mcp');
    // Not a default that hides an unmapped effect: `other` is the honest answer for a tool this
    // build has not heard of, and a reader is told so rather than shown a guess.
    expect(claudeToolKind('Skill')).toBe('other');
    expect(claudeToolKind('SomeFutureTool')).toBe('other');
  });
});

describe('capAgentFrameRaw', () => {
  it('carries a payload under the cap unchanged', () => {
    const payload = { type: 'assistant', message: { content: [] } };
    expect(capAgentFrameRaw(payload)).toBe(payload);
    expect(capAgentFrameRaw(null)).toBeNull();
  });

  it('truncates an oversized payload with a marker rather than rejecting the frame', () => {
    const big = { type: 'user', text: 'x'.repeat(AGENT_FRAME_RAW_MAX_BYTES) };
    expect(capAgentFrameRaw(big)).toEqual({
      truncated: true,
      encodedBytes: JSON.stringify(big).length,
      limitBytes: AGENT_FRAME_RAW_MAX_BYTES,
    });
  });

  it('marks a payload with no JSON representation, instead of letting the frame fail later', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    for (const value of [cyclic, { n: 1n }, undefined, () => undefined]) {
      expect(capAgentFrameRaw(value)).toEqual({
        truncated: true,
        encodedBytes: null,
        limitBytes: AGENT_FRAME_RAW_MAX_BYTES,
      });
    }
  });

  it('caps the raw of every frame it produces, and of agent.native payloads too', () => {
    const frames = framesOf({
      type: 'system',
      subtype: 'status',
      detail: 'y'.repeat(AGENT_FRAME_RAW_MAX_BYTES),
    });
    const only = frames[0];
    expect(only?.raw).toMatchObject({ truncated: true });
    expect(only?.frame === 'agent.native' && only.payload).toMatchObject({ truncated: true });
  });

  it('truncates the raw of every frame of a fan-out, not only the first', () => {
    const frames = framesOf({
      type: 'assistant',
      padding: 'z'.repeat(AGENT_FRAME_RAW_MAX_BYTES),
      message: {
        id: 'msg_1',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', id: 'tool_1', name: 'Read', input: {} },
          { type: 'tool_use', id: 'tool_2', name: 'Grep', input: {} },
        ],
      },
    });
    expect(names(frames)).toEqual(['agent.message', 'agent.tool.call', 'agent.tool.call']);
    for (const frame of frames) {
      expect(frame.raw).toMatchObject({ truncated: true, limitBytes: AGENT_FRAME_RAW_MAX_BYTES });
    }
  });

  it('marks a cyclic raw on a frame with encodedBytes: null', () => {
    const cyclic: Record<string, unknown> = { type: 'user' };
    cyclic['self'] = cyclic;
    const frames = toAgentFrames(classifySdkEvent(cyclic));
    expect(frames[0]?.raw).toEqual({
      truncated: true,
      encodedBytes: null,
      limitBytes: AGENT_FRAME_RAW_MAX_BYTES,
    });
  });
});

describe('toAgentFrames — tool results (BH061-062)', () => {
  it("leaves out the Claude CLI's system reminders, in string and block content", () => {
    const reminder =
      '\n\n<system-reminder>\nWhenever you read a file, consider…\n</system-reminder>\n';
    for (const content of [
      `127.0.0.1${reminder}`,
      [
        { type: 'text', text: '127.0.0.1' },
        { type: 'text', text: reminder },
      ],
    ]) {
      const frames = framesOf({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool_1', content }] },
      });
      expect(frames.find((frame) => frame.frame === 'agent.tool.result')).toMatchObject({
        output: '127.0.0.1',
      });
    }
  });
});
