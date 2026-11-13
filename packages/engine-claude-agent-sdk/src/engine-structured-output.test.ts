import type { EngineRunRequest } from '@agent-workspace/engine';
import { createScriptedGateway } from '@agent-workspace/engine/testing';
import type { ClassifiedSdkEvent } from '@agent-workspace/run-protocol';
import { ENGINE_CATALOGUE } from '@indx-workspace/contracts/engines';
import { expect, it } from 'vitest';

import { CLAUDE_AGENT_SDK_ENGINE_ID, createClaudeAgentSdkEngine } from './engine.js';
import {
  AGENT,
  CLAUDE_AGENT_SDK_ENGINE_ADAPTER,
  POLICY,
  PROJECT_KEY,
  RECORDED_RUN,
  replayingStarter,
} from './engine.test-support.js';

const gateway = createScriptedGateway();
const outputSchema = {
  type: 'object',
  properties: { total: { type: 'number' } },
  required: ['total'],
};
const request: EngineRunRequest = {
  runId: '6f1d0d0a-8b0a-4a1f-9b3e-1c2d3e4f5a6b',
  sessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e',
  projectKey: PROJECT_KEY,
  cwd: '/workspace/conformance',
  prompt: 'go',
  engine: CLAUDE_AGENT_SDK_ENGINE_ID,
  portable: AGENT,
  policy: POLICY,
  session: { mode: 'fresh' },
  gateway: gateway.connection,
  resources: { files: [], skills: [] },
  env: { PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: gateway.connection.token },
};
const [init] = RECORDED_RUN;
const resultEvent = (
  subtype: 'success' | 'error_max_structured_output_retries',
  extra: Record<string, unknown> = {},
): ClassifiedSdkEvent => ({
  kind: 'result',
  subtype,
  carriesUsage: true,
  event: {
    type: 'result',
    subtype,
    session_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    num_turns: 1,
    total_cost_usd: 0.0012,
    modelUsage: {},
    ...extra,
  },
});

function started(events: readonly ClassifiedSdkEvent[]) {
  const starter = replayingStarter(events);
  const aborts: unknown[] = [];
  const engine = createClaudeAgentSdkEngine((runRequest, deps) => {
    const run = starter(runRequest, deps);
    return {
      ...run,
      abort: (reason?: unknown) => {
        aborts.push(reason);
        run.abort(reason);
      },
    };
  });
  return { connection: engine.start({ ...request, outputSchema }), aborts };
}

it('is declared by the catalogue and handed to the adapter', () => {
  expect(ENGINE_CATALOGUE['claude-agent-sdk'].structuredOutput).toBe(true);
});

it('compiles an outputFormat only when the request asks for one', () => {
  const asked = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile({ ...request, outputSchema });
  expect(asked.ok && asked.compiled.outputFormat).toEqual({
    type: 'json_schema',
    schema: outputSchema,
  });
  const plain = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile(request);
  expect(plain.ok).toBe(true);
  expect(plain.ok && 'outputFormat' in plain.compiled).toBe(false);
});

it("carries a result's structured_output on the agent.result frame's raw", async () => {
  if (init === undefined) throw new Error('RECORDED_RUN is empty');
  const { connection } = started([
    init,
    resultEvent('success', { structured_output: { total: 3 } }),
  ]);
  const frames = [];
  for await (const frame of connection.frames) frames.push(frame);
  const result = frames.find((frame) => frame.frame === 'agent.result');
  expect(result).toMatchObject({ frame: 'agent.result', stopReason: 'end_turn' });
  expect(result?.raw).toMatchObject({ structured_output: { total: 3 } });
});

it('fails the run with output_schema_unsatisfied after the result frame, and aborts it', async () => {
  if (init === undefined) throw new Error('RECORDED_RUN is empty');
  const { connection, aborts } = started([
    init,
    resultEvent('error_max_structured_output_retries'),
  ]);
  const seen: string[] = [];
  let failure: unknown = null;
  try {
    for await (const frame of connection.frames) seen.push(frame.frame);
  } catch (error) {
    failure = error;
  }
  expect(seen).toContain('agent.result');
  expect(failure).toBeInstanceOf(Error);
  const message = failure instanceof Error ? failure.message : '';
  expect(message).toMatch(/^output_schema_unsatisfied: /u);
  expect(message).not.toContain('total');
  expect(aborts).toHaveLength(1);
});

import { vi } from 'vitest';

// The real `compileRunRequest` behind a spy, so a test can count the compiles one start performs.
vi.mock('./compile.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./compile.js')>();
  return { ...original, compileRunRequest: vi.fn(original.compileRunRequest) };
});
