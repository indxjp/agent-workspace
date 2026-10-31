/**
 * Test support for the webhook domain: a finished run as the run read renders it. No route or
 * production module imports it.
 */
import type { RunResource } from '@indx-workspace/contracts/runs';

export const WEBHOOK_TEST_WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

/** A completed run of {@link WEBHOOK_TEST_WORKSPACE_ID}, with a prompt-bearing output. */
export function finishedRun(overrides: Partial<RunResource> = {}): RunResource {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    workspaceId: WEBHOOK_TEST_WORKSPACE_ID,
    agentId: '33333333-3333-4333-8333-333333333333',
    projectId: null,
    initiatingUserId: null,
    sessionId: '44444444-4444-4444-8444-444444444444',
    agentVersion: 1,
    status: 'completed',
    createdAt: '2026-10-31T00:00:00.000Z',
    startedAt: '2026-10-31T00:00:01.000Z',
    endedAt: '2026-10-31T00:00:09.000Z',
    durationMs: 8_000,
    model: 'claude-test',
    provider: null,
    modelConnectionId: null,
    engine: 'claude-agent-sdk',
    engineVersion: null,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 15,
      toolCalls: 1,
    },
    cost: { amount: '0.001000', currency: 'USD', priceTableVersion: 'v1' },
    error: null,
    output: { text: 'the secret answer the receiver must never see', structured: null },
    pendingApproval: null,
    accountingState: 'complete',
    accountingError: null,
    ...overrides,
  };
}
