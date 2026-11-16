import type { EngineRunRequest } from '@agent-workspace/engine';
import { createScriptedGateway } from '@agent-workspace/engine/testing';
import { beforeEach, expect, it, vi } from 'vitest';

import type { ClaudeRunStart } from './boundary.js';
import { compileRunRequest } from './compile.js';
import { CLAUDE_AGENT_SDK_ENGINE_ID, createClaudeAgentSdkEngine } from './engine.js';
import {
  AGENT,
  CLAUDE_AGENT_SDK_ENGINE_ADAPTER,
  POLICY,
  PROJECT_KEY,
  replayingStarter,
} from './engine.test-support.js';

const gateway = createScriptedGateway();
const request: EngineRunRequest = {
  runId: '6f1d0d0a-8b0a-4a1f-9b3e-1c2d3e4f5a6b',
  sessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e',
  projectKey: PROJECT_KEY,
  cwd: '/workspace/conformance',
  prompt: 'summarise the contracts',
  engine: CLAUDE_AGENT_SDK_ENGINE_ID,
  portable: AGENT,
  policy: POLICY,
  session: { mode: 'fresh' },
  gateway: gateway.connection,
  resources: { files: [], skills: [] },
  env: { PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: gateway.connection.token },
};

function startedWith(): ClaudeRunStart {
  const handed: ClaudeRunStart[] = [];
  const starter = replayingStarter();
  createClaudeAgentSdkEngine((start, deps) => {
    handed.push(start);
    return starter(start, deps);
  }).start(request);
  const [start] = handed;
  if (start === undefined) throw new Error('the run starter was not called');
  return start;
}

beforeEach(() => {
  vi.mocked(compileRunRequest).mockClear();
});

it('starts the run from the compiled options', () => {
  const compiled = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile(request);
  if (!compiled.ok) throw new Error(compiled.reason);
  const start = startedWith();
  expect(start.options).toEqual(compiled.compiled);
  expect(start.prompt).toBe(request.prompt);
  expect(start.runId).toBe(request.runId);
  expect(start.projectKey).toBe(request.projectKey);
});

it('compiles once per start, and starts with that very value', () => {
  const start = startedWith();
  expect(compileRunRequest).toHaveBeenCalledTimes(1);
  expect(start.options).toBe(vi.mocked(compileRunRequest).mock.results[0]?.value);
});

// The real `compileRunRequest` behind a spy, so a test can count the compiles one start performs.
vi.mock('./compile.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./compile.js')>();
  return { ...original, compileRunRequest: vi.fn(original.compileRunRequest) };
});
