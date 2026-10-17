/**
 * `createMastraFrameMapper`: every `fullStream` chunk type, the two invariants (nothing dropped,
 * tool pairing), and the usage fold (ENG-10, #309).
 */
import { PROVISIONAL_MODEL_PRICES } from '@agent-workspace/engine';
import { describe, expect, it } from 'vitest';

import { addMastraUsage, createMastraFrameMapper, type MastraEvent } from './frames.js';

function chunk(type: string, payload: Record<string, unknown> = {}): MastraEvent {
  return { kind: 'mastra', chunk: { type, from: 'AGENT', payload } };
}

describe('createMastraFrameMapper', () => {
  it('streams text deltas and ends the part with the joined message', () => {
    const mapper = createMastraFrameMapper();
    expect(mapper.map(chunk('text-start', { id: 't' }))[0]).toMatchObject({
      frame: 'agent.native',
      engine: 'mastra',
      type: 'text-start',
    });
    expect(mapper.map(chunk('text-delta', { id: 't', text: 'Hel' }))[0]).toMatchObject({
      frame: 'agent.message.delta',
      block: 'text',
      text: 'Hel',
      messageId: 't',
    });
    mapper.map(chunk('text-delta', { id: 't', text: 'lo' }));
    expect(mapper.map(chunk('text-end', { id: 't' }))[0]).toMatchObject({
      frame: 'agent.message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Hello' }],
    });
  });

  it('maps reasoning the same way, as the reasoning block', () => {
    const mapper = createMastraFrameMapper();
    expect(mapper.map(chunk('reasoning-delta', { id: 'r', text: 'hmm' }))[0]).toMatchObject({
      frame: 'agent.message.delta',
      block: 'reasoning',
    });
    expect(mapper.map(chunk('reasoning-end', { id: 'r' }))[0]).toMatchObject({
      frame: 'agent.message',
      blocks: [{ type: 'reasoning', text: 'hmm' }],
    });
  });

  it('names tool kinds by workspace tool, skill tool and connector', () => {
    const mapper = createMastraFrameMapper(['docs']);
    const kind = (toolName: string, id: string): unknown =>
      mapper.map(chunk('tool-call', { toolCallId: id, toolName, args: {} }))[0];
    expect(kind('mastra_workspace_write_file', '1')).toMatchObject({ kind: 'edit', input: {} });
    expect(kind('mastra_workspace_execute_command', '2')).toMatchObject({ kind: 'execute' });
    expect(kind('mastra_workspace_delete', '3')).toMatchObject({ kind: 'delete' });
    expect(kind('skill', '4')).toMatchObject({ kind: 'read' });
    expect(kind('docs_search', '5')).toMatchObject({ kind: 'mcp', name: 'docs_search' });
    expect(kind('invented', '6')).toMatchObject({ kind: 'other' });
  });

  it('pairs results with announced calls, and a stray result is malformed', () => {
    const mapper = createMastraFrameMapper();
    expect(mapper.map(chunk('tool-result', { toolCallId: 'x', result: 'r' }))[0]).toMatchObject({
      frame: 'agent.malformed',
    });
    mapper.map(chunk('tool-call', { toolCallId: 'a', toolName: 'mastra_workspace_read_file' }));
    expect(
      mapper.map(chunk('tool-result', { toolCallId: 'a', result: { lines: 2 } }))[0],
    ).toMatchObject({
      frame: 'agent.tool.result',
      status: 'completed',
      output: '{"lines":2}',
      isError: false,
    });
    expect(mapper.map(chunk('tool-result', { toolCallId: 'a', result: 'again' }))[0]).toMatchObject(
      {
        frame: 'agent.malformed',
      },
    );
    mapper.map(chunk('tool-call', { toolCallId: 'b', toolName: 'mastra_workspace_write_file' }));
    expect(
      mapper.map(
        chunk('tool-error', { toolCallId: 'b', error: { message: 'write refused: x' } }),
      )[0],
    ).toMatchObject({
      frame: 'agent.tool.result',
      status: 'failed',
      output: 'write refused: x',
      isError: true,
    });
  });

  it('turns an error chunk into agent.result error, counting the steps so far', () => {
    const mapper = createMastraFrameMapper();
    mapper.map(chunk('step-finish'));
    expect(mapper.map(chunk('error', { error: 'boom' }))).toEqual([
      expect.objectContaining({
        frame: 'agent.result',
        stopReason: 'error',
        turns: 1,
        engineCostUsd: null,
      }),
    ]);
  });

  it('turns run_completed into usage then result, carrying finish as raw', () => {
    const frames = createMastraFrameMapper().map({
      kind: 'run_completed',
      stopReason: 'max_turns',
      steps: 3,
      usage: {
        inputTokens: 5,
        outputTokens: 6,
        cacheReadInputTokens: 1,
        cacheWriteInputTokens: 2,
        reasoningTokens: null,
        costUsd: 0.1,
      },
      finish: { type: 'finish' },
    });
    expect(frames.map((frame) => frame.frame)).toEqual(['agent.usage', 'agent.result']);
    expect(frames[0]).toMatchObject({ cacheCreationInputTokens: 2, reasoningTokens: null });
    expect(frames[1]).toMatchObject({ stopReason: 'max_turns', turns: 3, engineCostUsd: null });
    expect(
      createMastraFrameMapper().map({
        kind: 'run_completed',
        stopReason: 'cancelled',
        steps: 0,
        usage: null,
        finish: null,
      }),
    ).toEqual([expect.objectContaining({ frame: 'agent.result', stopReason: 'cancelled' })]);
  });

  it.each([
    ['a non-object chunk', { kind: 'mastra', chunk: 7 }],
    ['a chunk without a type', { kind: 'mastra', chunk: { payload: {} } }],
    ['a delta without an id', chunk('text-delta', { text: 'x' })],
    ['an end without an id', chunk('text-end', {})],
    ['a tool call without a name', chunk('tool-call', { toolCallId: 'a' })],
    ['a result without a call id', chunk('tool-result', { result: 'x' })],
  ] as const)('never drops %s: it is agent.malformed', (_name, event) => {
    const frames = createMastraFrameMapper().map(event);
    expect(frames).toEqual([
      expect.objectContaining({ frame: 'agent.malformed', engine: 'mastra' }),
    ]);
  });

  it('forwards every other chunk as agent.native, step boundaries included', () => {
    const mapper = createMastraFrameMapper();
    for (const type of [
      'start',
      'step-start',
      'step-finish',
      'tool-call-delta',
      'tool-call-approval',
      'data-workspace-metadata',
    ]) {
      expect(mapper.map(chunk(type))).toEqual([
        expect.objectContaining({ frame: 'agent.native', type }),
      ]);
    }
  });
});

describe('addMastraUsage', () => {
  const price = PROVISIONAL_MODEL_PRICES['claude-sonnet-4-5'] ?? null;

  it('sums steps and prices uncached, cached and cache-write input apart', () => {
    const one = addMastraUsage(
      null,
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      price,
    );
    expect(one?.costUsd).toBeCloseTo(3);
    const two = addMastraUsage(
      one,
      {
        inputTokens: 2_000_000,
        outputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
        reasoningTokens: 7,
      },
      price,
    );
    // 3 + (0 uncached) + 1M cache write at 1.25 × 3 + 1M cached at 0.3 + 1M output at 15.
    expect(two?.costUsd).toBeCloseTo(3 + 3.75 + 0.3 + 15);
    expect(two).toMatchObject({
      inputTokens: 3_000_000,
      outputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      cacheWriteInputTokens: 1_000_000,
      reasoningTokens: 7,
    });
  });

  it('leaves the total unchanged for a step with no readable counts, and costs nothing uncapped', () => {
    expect(addMastraUsage(null, { inputTokens: 'x' }, price)).toBeNull();
    expect(addMastraUsage(null, { inputTokens: 1, outputTokens: 1 }, null)?.costUsd).toBe(0);
  });
});
