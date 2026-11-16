import type { EngineRunRequest } from '@agent-workspace/engine';
import { createScriptedGateway } from '@agent-workspace/engine/testing';
import { expect, it, vi } from 'vitest';

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
  prompt: 'go',
  engine: CLAUDE_AGENT_SDK_ENGINE_ID,
  portable: AGENT,
  policy: { ...POLICY, handoff: true },
  session: { mode: 'fresh' },
  gateway: gateway.connection,
  resources: { files: [], skills: [] },
  env: { PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: gateway.connection.token },
};
const handoffTool = 'mcp__agent-workspace__handoff_to_person';

async function frameNames(handoff: { reason: string } | null): Promise<string[]> {
  const replay = replayingStarter();
  const connection = createClaudeAgentSdkEngine((start, deps) => ({
    ...replay(start, deps),
    handoff: () => handoff,
  })).start(request);
  const names: string[] = [];
  for await (const frame of connection.frames) names.push(frame.frame);
  return names;
}

it('auto-approves the tool and hands the opt-in to the run starter only when it is on', () => {
  const on = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile(request);
  expect(on.ok && on.compiled.allowedTools).toContain(handoffTool);
  expect(on.ok && on.compiled.handoff).toBe(true);
  const starter = vi.fn(replayingStarter());
  createClaudeAgentSdkEngine(starter).start(request);
  expect(starter.mock.calls[0]?.[0]).toMatchObject({ handoff: true });

  const off = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile({ ...request, policy: POLICY });
  expect(off.ok && off.compiled.allowedTools).not.toContain(handoffTool);
  expect(off.ok && off.compiled.handoff).toBeUndefined();
  const offStarter = vi.fn(replayingStarter());
  createClaudeAgentSdkEngine(offStarter).start({ ...request, policy: POLICY });
  expect(offStarter.mock.calls[0]?.[0]).toMatchObject({ handoff: undefined });
});

it('refuses a connector named like the server that now carries the tool', () => {
  const refused = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile({
    ...request,
    portable: {
      ...AGENT,
      mcpServers: { 'agent-workspace': { type: 'http', url: 'https://example.test/mcp' } },
    },
  });
  expect(refused).toMatchObject({ ok: false, code: 'engine_policy_invalid' });
});

it('ends the frames with agent.handoff after agent.result, with the reason', async () => {
  const replay = replayingStarter();
  const connection = createClaudeAgentSdkEngine((start, deps) => ({
    ...replay(start, deps),
    handoff: () => ({ reason: 'The visitor asked for a person.' }),
  })).start(request);
  const frames = [];
  for await (const frame of connection.frames) frames.push(frame);
  expect(frames.slice(-2).map((frame) => frame.frame)).toEqual(['agent.result', 'agent.handoff']);
  expect(frames.at(-1)).toMatchObject({ reason: 'The visitor asked for a person.' });
});

it('emits no agent.handoff when the model did not hand off', async () => {
  expect(await frameNames(null)).not.toContain('agent.handoff');
});

// The real `compileRunRequest` behind a spy, so a test can count the compiles one start performs.
vi.mock('./compile.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./compile.js')>();
  return { ...original, compileRunRequest: vi.fn(original.compileRunRequest) };
});
