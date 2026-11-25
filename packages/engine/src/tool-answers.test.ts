/**
 * The record of a run's tool answers (ADR-0176): what it keeps, how long `find` waits, and that the
 * adapter kit fills it from every frame a run maps, whichever engine mapped it.
 */
import { ENGINE_CATALOGUE } from '@indx-workspace/contracts/engines';
import { describe, expect, it } from 'vitest';

import { createEngineAdapter } from './adapter.js';
import { engineFrameBuilder, type EngineFrame } from './frames.js';
import type { EngineRunRequest } from './port.js';
import { createToolAnswers, TOOL_ANSWERS_LIMITS, type ToolAnswers } from './tool-answers.js';

const b = engineFrameBuilder('demo');

function call(toolCallId: string, name: string): EngineFrame {
  return b.toolCall({ frame: 'agent.tool.call', toolCallId, name, kind: 'mcp', input: {} }, null);
}

function result(
  toolCallId: string,
  output: string,
  verdict: { readonly isError?: boolean; readonly status?: 'completed' | 'failed' } = {},
): EngineFrame {
  return b.toolResult(
    {
      frame: 'agent.tool.result',
      toolCallId,
      status: verdict.status ?? 'completed',
      output,
      isError: verdict.isError ?? false,
    },
    null,
  );
}

const QUICK = { waitMs: 20, maxRetainedBytes: 1024 };

describe('createToolAnswers', () => {
  it('pins its limits', () => {
    expect(TOOL_ANSWERS_LIMITS).toEqual({ waitMs: 5_000, maxRetainedBytes: 24 * 1024 * 1024 });
  });

  it('keeps an answer with the name its call announced, as the frame carried it', async () => {
    const answers = createToolAnswers(QUICK);
    answers.observe(call('toolu_1', 'mcp__peers__public_source'));
    answers.observe(result('toolu_1', '{"records":[]}'));
    expect(await answers.find('toolu_1')).toEqual({
      toolCallId: 'toolu_1',
      name: 'mcp__peers__public_source',
      output: '{"records":[]}',
      isError: false,
    });
    expect(answers.held()).toEqual([{ toolCallId: 'toolu_1', name: 'mcp__peers__public_source' }]);
  });

  it('marks an error answer and a failed call as errors, and names an unannounced call with ""', async () => {
    const answers = createToolAnswers(QUICK);
    answers.observe(result('a', 'boom', { isError: true }));
    answers.observe(result('b', 'stopped', { status: 'failed' }));
    expect(await answers.find('a')).toMatchObject({ name: '', isError: true });
    expect(await answers.find('b')).toMatchObject({ isError: true });
  });

  it('ignores every other frame', () => {
    const answers = createToolAnswers(QUICK);
    answers.observe(b.native('text', null));
    expect(answers.held()).toEqual([]);
  });

  it('waits for an answer whose frame arrives after the call asked for it', async () => {
    const answers = createToolAnswers({ ...QUICK, waitMs: 5_000 });
    const pending = answers.find('late');
    const second = answers.find('late');
    answers.observe(result('late', 'here'));
    expect(await pending).toMatchObject({ output: 'here' });
    expect(await second).toMatchObject({ output: 'here' });
  });

  it('answers null when no answer arrives within the wait', async () => {
    expect(await createToolAnswers(QUICK).find('never')).toBeNull();
  });

  it('stops waiting when the run is aborted, and does not wait on an aborted signal', async () => {
    const answers = createToolAnswers({ ...QUICK, waitMs: 60_000 });
    const controller = new AbortController();
    const pending = answers.find('never', controller.signal);
    controller.abort();
    expect(await pending).toBeNull();
    expect(await answers.find('never', controller.signal)).toBeNull();
  });

  it('drops the oldest answers past the byte limit, and counts a repeated id once', async () => {
    const answers = createToolAnswers({ waitMs: 0, maxRetainedBytes: 10 });
    answers.observe(result('one', '1234'));
    answers.observe(result('one', '12345'));
    answers.observe(result('two', '12345'));
    expect(answers.held().map((held) => held.toolCallId)).toEqual(['one', 'two']);
    answers.observe(result('three', '1'));
    expect(answers.held().map((held) => held.toolCallId)).toEqual(['two', 'three']);
    expect(await answers.find('one')).toBeNull();
    answers.observe(result('huge', 'x'.repeat(11)));
    expect(answers.held()).toEqual([]);
  });
});

describe('createEngineAdapter records the answers of the frames it maps', () => {
  const request = {
    runId: 'run-1',
    sessionId: 'session-1',
    projectKey: 'tenant',
    cwd: '/workspace/tenant',
    prompt: 'go',
    engine: 'demo',
    portable: {
      name: 'Writer',
      instructions: '',
      model: null,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: true,
        unrestrictedNetwork: false,
      },
      skills: { mode: 'allowlist', names: [] },
      mcpServers: {},
      limits: { maxTurns: null, maxBudgetUsd: null },
    },
    policy: {},
    session: { mode: 'fresh' },
    gateway: null,
    resources: { files: [], skills: [] },
    env: {},
  } satisfies EngineRunRequest;

  it('hands the plan one record per run, filled as the consumer reads each frame', async () => {
    const records: ToolAnswers[] = [];
    const engine = createEngineAdapter<null, EngineFrame>({
      id: 'demo',
      version: '0',
      capabilities: ENGINE_CATALOGUE['claude-agent-sdk'].capabilities,
      protectedConfigDirectory: '.demo',
      compile: () => ({ ok: true, compiled: null }),
      plan: (_compiled, _request, { toolAnswers }) => {
        records.push(toolAnswers);
        return {
          identity: { kind: 'declared', engineSessionId: 's', model: null, raw: null },
          events: async function* () {
            for (const frame of [call('c1', 'lookup'), result('c1', 'answer')]) {
              await Promise.resolve();
              yield frame;
            }
          },
          map: (frame) => [frame],
          isTerminal: () => false,
          cancelled: null,
          durability: () => ({ durable: false, reason: 'test' }),
        };
      },
    });
    const first = engine.start(request);
    const record = records[0];
    expect(record?.held()).toEqual([]);
    for await (const frame of first.frames) expect(frame).toBeDefined();
    expect(await record?.find('c1')).toMatchObject({ name: 'lookup', output: 'answer' });

    engine.start(request);
    expect(records[1]).not.toBe(record);
    expect(records[1]?.held()).toEqual([]);
  });

  it('records nothing from an event the plan says is not the run’s own (a subagent’s)', async () => {
    let record: ToolAnswers | undefined;
    const engine = createEngineAdapter<null, EngineFrame>({
      id: 'demo',
      version: '0',
      capabilities: ENGINE_CATALOGUE['claude-agent-sdk'].capabilities,
      protectedConfigDirectory: '.demo',
      compile: () => ({ ok: true, compiled: null }),
      plan: (_compiled, _request, { toolAnswers }) => {
        record = toolAnswers;
        return {
          identity: { kind: 'declared', engineSessionId: 's', model: null, raw: null },
          events: async function* () {
            for (const frame of [call('own', 'lookup'), result('own', 'a'), result('sub', 'b')]) {
              await Promise.resolve();
              yield frame;
            }
          },
          map: (frame) => [frame],
          isTerminal: () => false,
          cancelled: null,
          durability: () => ({ durable: false, reason: 'test' }),
          isOwnAnswer: (frame) => !('toolCallId' in frame) || frame.toolCallId !== 'sub',
        };
      },
    });
    const frames = [];
    for await (const frame of engine.start(request).frames) frames.push(frame);
    expect(frames).toHaveLength(4);
    expect(record?.held()).toEqual([{ toolCallId: 'own', name: 'lookup' }]);
  });
});
