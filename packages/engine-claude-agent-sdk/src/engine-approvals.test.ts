import type { EngineRunRequest } from '@agent-workspace/engine';
import { createScriptedGateway } from '@agent-workspace/engine/testing';
import type { ClassifiedSdkEvent } from '@agent-workspace/run-protocol';
import { ENGINE_CATALOGUE } from '@indx-workspace/contracts/engines';
import { expect, it, vi } from 'vitest';

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
const request: EngineRunRequest = {
  runId: '6f1d0d0a-8b0a-4a1f-9b3e-1c2d3e4f5a6b',
  sessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e',
  projectKey: PROJECT_KEY,
  cwd: '/workspace/conformance',
  prompt: 'go',
  engine: CLAUDE_AGENT_SDK_ENGINE_ID,
  portable: AGENT,
  policy: { ...POLICY, requireApproval: ['Write'] },
  session: { mode: 'fresh' },
  gateway: gateway.connection,
  resources: { files: [], skills: [] },
  env: { PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: gateway.connection.token },
};
const [init] = RECORDED_RUN;
const final = RECORDED_RUN.at(-1);
const asked = {
  toolName: 'Write',
  toolUseId: 'toolu_9',
  canonicalCall: '{"input":{},"name":"Write"}',
};

it('is declared by the catalogue for this engine', () => {
  expect(ENGINE_CATALOGUE['claude-agent-sdk'].approvals).toBe(true);
});

it('compiles the gate and hands it to the run starter', () => {
  const compiled = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile(request);
  // The agent runs commands, so Run commands' own gate joins the stored one (#2091).
  expect(compiled.ok && compiled.compiled.approval?.requireApproval).toEqual(['Write', 'Bash']);
  expect(compiled.ok && compiled.compiled.approval?.ask).toEqual(['Write']);
  const starter = vi.fn(replayingStarter());
  createClaudeAgentSdkEngine(starter).start(request);
  expect(starter.mock.calls[0]?.[0]).toMatchObject({
    approval: { requireApproval: ['Write', 'Bash'], ask: ['Write'] },
  });
});

it('refuses a policy that would not ask, as a value', () => {
  const refused = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile({
    ...request,
    policy: {
      tools: {
        base: 'claude_code_preset',
        autoApprove: [],
        deny: [],
        permissionMode: 'dontAsk',
        allowDangerouslySkipPermissions: false,
      },
      requireApproval: ['Write'],
    },
  });
  expect(refused).toMatchObject({ ok: false, code: 'engine_policy_invalid' });
});

it('refuses a gate on a tool the SDK runs without asking, naming it', () => {
  const refused = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile({
    ...request,
    policy: { ...POLICY, requireApproval: ['Read'] },
  });
  expect(refused).toMatchObject({ ok: false, code: 'engine_policy_invalid' });
  expect(!refused.ok && refused.reason).toContain('"Read"');
});

it('ends a run the gate stopped without reporting the SDK result as a failure', async () => {
  if (init === undefined || final === undefined) throw new Error('RECORDED_RUN is empty');
  const replay = replayingStarter([init, final]);
  const connection = createClaudeAgentSdkEngine((start, deps) => ({
    ...replay(start, deps),
    approvalRequest: () => asked,
  })).start(request);
  const seen: string[] = [];
  for await (const frame of connection.frames) seen.push(frame.frame);
  expect(seen).not.toContain('agent.result');
  expect(connection.approvalRequest?.()).toEqual(asked);
});

it('treats a thrown stream as the stop when a request was recorded, and as a failure otherwise', async () => {
  if (init === undefined) throw new Error('RECORDED_RUN is empty');
  const throwing = (recorded: boolean) =>
    createClaudeAgentSdkEngine(() => ({
      events: (async function* (): AsyncGenerator<ClassifiedSdkEvent, void, void> {
        await Promise.resolve();
        yield init;
        throw new Error('aborted by the permission interrupt');
      })(),
      sessionDurability: () => ({ durable: false, reason: 'test' }),
      approvalRequest: () => (recorded ? asked : null),
      handoff: () => null,
      abort: () => undefined,
    })).start(request);
  const drain = async (connection: ReturnType<typeof throwing>): Promise<void> => {
    for await (const frame of connection.frames) void frame;
  };
  await expect(drain(throwing(true))).resolves.toBeUndefined();
  await expect(drain(throwing(false))).rejects.toThrow('aborted by the permission interrupt');
});

it('still fails a run on a rejected key after a request was recorded', async () => {
  if (init === undefined) throw new Error('RECORDED_RUN is empty');
  const rejected: ClassifiedSdkEvent = {
    kind: 'system',
    subtype: 'api_retry',
    event: {
      type: 'system',
      subtype: 'api_retry',
      session_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      attempt: 1,
      max_retries: 10,
      retry_delay_ms: 500,
      error_status: 401,
      error: 'authentication_failed',
    },
  };
  const replay = replayingStarter([init, rejected]);
  const connection = createClaudeAgentSdkEngine(
    (start, deps) => ({ ...replay(start, deps), approvalRequest: () => asked }),
    () => Promise.resolve(Response.json({ error: 'upstream' }, { status: 500 })),
  ).start(request);
  const drain = async (): Promise<void> => {
    for await (const frame of connection.frames) void frame;
  };
  await expect(drain()).rejects.toThrow(/^model_credential_rejected:/u);
});

// The real `compileRunRequest` behind a spy, so a test can count the compiles one start performs.
vi.mock('./compile.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./compile.js')>();
  return { ...original, compileRunRequest: vi.fn(original.compileRunRequest) };
});
