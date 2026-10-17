import { describe, expect, it } from 'vitest';

import { AGENT_VERSION_NUMBER_MAX } from './agent-versions.js';
import {
  InterruptRunResponseSchema,
  MAX_PROMPT_CHARS,
  RUN_START_PROBLEM_CODES,
  RUN_LIST_MAX_LIMIT,
  RUN_PREPARATION_FAILED,
  RUNTIME_CAPACITY_EXHAUSTED,
  RevokeRunTokensResponseSchema,
  RunListResponseSchema,
  RunResourceSchema,
  StartRunRequestSchema,
  StartRunResponseSchema,
  isRunStartProblemCode,
  isTerminalRunStatus,
  parseRunFailure,
  runListSearchParams,
} from './runs.js';

const AGENT = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';

const run = {
  id: '33333333-3333-4333-8333-333333333333',
  workspaceId: '44444444-4444-4444-8444-444444444444',
  agentId: AGENT,
  projectId: null,
  initiatingUserId: null,
  sessionId: '55555555-5555-4555-8555-555555555555',
  status: 'queued',
  createdAt: '2026-09-21T10:00:00.000Z',
  startedAt: null,
  endedAt: null,
  durationMs: null,
  model: null,
  provider: null,
  modelConnectionId: null,
  engine: 'claude-agent-sdk',
  engineVersion: null,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalTokens: 0,
    toolCalls: 0,
  },
  cost: { amount: '0.000000', currency: 'USD', priceTableVersion: null },
  error: null,
  accountingState: 'pending',
  accountingError: null,
};

describe('RunResourceSchema', () => {
  it('accepts a freshly queued run and a settled one', () => {
    expect(RunResourceSchema.safeParse(run).success).toBe(true);
    expect(
      RunResourceSchema.safeParse({
        ...run,
        status: 'completed',
        startedAt: '2026-09-21T10:00:01.000Z',
        endedAt: '2026-09-21T10:00:05.000Z',
        durationMs: 4000,
        model: 'claude-sonnet-5',
        provider: 'anthropic',
        modelConnectionId: CONNECTION,
        engineVersion: 'claude-agent-sdk@0.3.278',
        accountingState: 'complete',
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown status, an unknown key, and a missing usage block', () => {
    expect(RunResourceSchema.safeParse({ ...run, status: 'paused' }).success).toBe(false);
    expect(RunResourceSchema.safeParse({ ...run, extra: true }).success).toBe(false);
    const withoutUsage = Object.fromEntries(Object.entries(run).filter(([key]) => key !== 'usage'));
    expect(RunResourceSchema.safeParse(withoutUsage).success).toBe(false);
  });

  it('rejects a negative token count and an epoch-number timestamp', () => {
    expect(
      RunResourceSchema.safeParse({ ...run, usage: { ...run.usage, inputTokens: -1 } }).success,
    ).toBe(false);
    expect(RunResourceSchema.safeParse({ ...run, createdAt: 1_700_000_000 }).success).toBe(false);
  });
});

describe('StartRunRequestSchema', () => {
  it('accepts a bare prompt and a full override', () => {
    expect(StartRunRequestSchema.safeParse({ prompt: 'hello' }).success).toBe(true);
    expect(
      StartRunRequestSchema.safeParse({
        prompt: 'hello',
        sessionId: null,
        modelConnectionId: CONNECTION,
        model: 'claude-sonnet-5',
      }).success,
    ).toBe(true);
  });

  it('refuses a blank prompt, an oversized prompt, and an unknown key', () => {
    expect(StartRunRequestSchema.safeParse({ prompt: '   ' }).success).toBe(false);
    expect(
      StartRunRequestSchema.safeParse({ prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1) }).success,
    ).toBe(false);
    expect(StartRunRequestSchema.safeParse({ prompt: 'hi', temperature: 1 }).success).toBe(false);
  });

  it('refuses a connection without a model and a model without a connection', () => {
    expect(
      StartRunRequestSchema.safeParse({ prompt: 'hi', modelConnectionId: CONNECTION }).success,
    ).toBe(false);
    expect(StartRunRequestSchema.safeParse({ prompt: 'hi', model: 'm' }).success).toBe(false);
  });

  it('accepts a version number on a new session and refuses a bad one (issue #697)', () => {
    expect(StartRunRequestSchema.parse({ prompt: 'hi', version: 2 }).version).toBe(2);
    for (const version of [0, -1, 1.5, '2', 2_147_483_648]) {
      expect(StartRunRequestSchema.safeParse({ prompt: 'hi', version }).success).toBe(false);
    }
  });

  it('refuses a version together with a session id', () => {
    const body = { prompt: 'hi', version: 2 };
    expect(StartRunRequestSchema.safeParse({ ...body, sessionId: CONNECTION }).success).toBe(false);
    expect(StartRunRequestSchema.safeParse({ ...body, sessionId: null }).success).toBe(true);
  });

  it('refuses a session id that is not a UUID', () => {
    expect(StartRunRequestSchema.safeParse({ prompt: 'hi', sessionId: 'latest' }).success).toBe(
      false,
    );
  });
});

describe('response envelopes', () => {
  it('reads the 202 and the list page', () => {
    expect(
      StartRunResponseSchema.safeParse({ run, events: `/api/runs/${run.id}/events` }).success,
    ).toBe(true);
    expect(RunListResponseSchema.safeParse({ runs: [run], nextCursor: null }).success).toBe(true);
    expect(RunListResponseSchema.safeParse({ runs: [run] }).success).toBe(false);
  });
});

describe('InterruptRunResponseSchema', () => {
  it('accepts the run with its new status, and refuses an unknown key or a missing field', () => {
    expect(
      InterruptRunResponseSchema.safeParse({ run: { ...run, status: 'cancelled' } }).success,
    ).toBe(true);
    expect(InterruptRunResponseSchema.safeParse({}).success).toBe(false);
    expect(InterruptRunResponseSchema.safeParse({ run, extra: 1 }).success).toBe(false);
  });
});

describe('RevokeRunTokensResponseSchema', () => {
  it('accepts every outcome the repository reports', () => {
    for (const outcome of ['revoked', 'already-revoked', 'not-found'] as const) {
      expect(RevokeRunTokensResponseSchema.safeParse({ revoked: 1, outcome }).success).toBe(true);
    }
    expect(
      RevokeRunTokensResponseSchema.safeParse({ revoked: 0, outcome: 'already-revoked' }).success,
    ).toBe(true);
  });

  it('rejects a negative count, an unknown outcome, an unknown key, and a missing field', () => {
    expect(
      RevokeRunTokensResponseSchema.safeParse({ revoked: -1, outcome: 'revoked' }).success,
    ).toBe(false);
    expect(
      RevokeRunTokensResponseSchema.safeParse({ revoked: 1, outcome: 'pending' }).success,
    ).toBe(false);
    expect(
      RevokeRunTokensResponseSchema.safeParse({ revoked: 1, outcome: 'revoked', extra: 1 }).success,
    ).toBe(false);
    expect(RevokeRunTokensResponseSchema.safeParse({ revoked: 1 }).success).toBe(false);
  });
});

describe('runListSearchParams', () => {
  it('renders only the fields that were given, as the route spells them', () => {
    const params = runListSearchParams({ status: 'failed', agent: AGENT, limit: 50 });
    expect([...params.entries()]).toEqual([
      ['status', 'failed'],
      ['agent', AGENT],
      ['limit', '50'],
    ]);
    expect(runListSearchParams({}).toString()).toBe('');
  });

  it('exposes the route bounds for a caller that pages', () => {
    expect(RUN_LIST_MAX_LIMIT).toBe(200);
    expect(isTerminalRunStatus('completed')).toBe(true);
    expect(isTerminalRunStatus('running')).toBe(false);
  });
});

describe('RUN_START_PROBLEM_CODES (issue #393)', () => {
  it('declares one 422 per missing piece a run start can name, and 403 for the ceiling', () => {
    expect(RUN_START_PROBLEM_CODES).toEqual({
      agent_runtime_profile_missing: 422,
      model_connection_unresolved: 422,
      model_connection_failed: 422,
      model_unavailable: 422,
      model_credential_rejected: 422,
      network_policy_unenforceable: 422,
      run_deadline_exceeds_host: 422,
      runtime_connection_missing: 422,
      runtime_connection_credential_unavailable: 422,
      runtime_not_verified: 422,
      policy_cannot_widen: 403,
    });
    // BH061-002: a lapsed Test Runtime pass is a coded refusal, not an opaque preparation failure.
    expect(isRunStartProblemCode('runtime_not_verified')).toBe(true);
    // Issue #785: a lowered `open` the driver cannot enforce is a coded refusal.
    expect(isRunStartProblemCode('network_policy_unenforceable')).toBe(true);
    // Issue #830 (ADR-0120 LC7): a profile deadline longer than the host's function is refused.
    expect(isRunStartProblemCode('run_deadline_exceeds_host')).toBe(true);
    // ADR-0120 LC6: a provider run without a usable runtime connection is a coded refusal.
    expect(isRunStartProblemCode('runtime_connection_missing')).toBe(true);
    expect(isRunStartProblemCode('runtime_connection_credential_unavailable')).toBe(true);
    // Issue #524 (C14): the ceiling refusal is a run-start code.
    expect(isRunStartProblemCode('policy_cannot_widen')).toBe(true);
    // PR #403 review: nothing refuses a start because a model list could not be read.
    expect(isRunStartProblemCode('model_discovery_failed')).toBe(false);
    expect(isRunStartProblemCode('agent_runtime_profile_missing')).toBe(true);
    expect(isRunStartProblemCode('internal_error')).toBe(false);
  });
});

describe('parseRunFailure', () => {
  it('reads the runtime-connection codes back from a coded run error', () => {
    expect(parseRunFailure('runtime_connection_missing: attach a runtime connection.')).toEqual({
      code: 'runtime_connection_missing',
      message: 'attach a runtime connection.',
    });
    expect(
      parseRunFailure('runtime_connection_credential_unavailable: replace the credential.'),
    ).toEqual({
      code: 'runtime_connection_credential_unavailable',
      message: 'replace the credential.',
    });
  });

  it('reads the code back from a coded run error', () => {
    expect(
      parseRunFailure('model_connection_unresolved: no workspace default is configured.'),
    ).toEqual({
      code: 'model_connection_unresolved',
      message: 'no workspace default is configured.',
    });
    expect(parseRunFailure('model_connection_failed: connection refused.')).toEqual({
      code: 'model_connection_failed',
      message: 'connection refused.',
    });
    expect(parseRunFailure('engine_model_protocol_unsupported: speaks nothing')).toEqual({
      code: 'engine_model_protocol_unsupported',
      message: 'speaks nothing',
    });
  });

  it('reads policy_cannot_widen back from a run refused at compose (issue #524)', () => {
    expect(parseRunFailure('policy_cannot_widen: engine:pi')).toEqual({
      code: 'policy_cannot_widen',
      message: 'engine:pi',
    });
  });

  it('keeps an uncoded or unknown-coded error whole, with no code', () => {
    expect(parseRunFailure('The run request could not be prepared.')).toEqual({
      code: null,
      message: 'The run request could not be prepared.',
    });
    expect(parseRunFailure('made_up: text')).toEqual({ code: null, message: 'made_up: text' });
    expect(parseRunFailure(null)).toBeNull();
  });

  it('reads the run-preparation code, which is not a start refusal (issue #827)', () => {
    expect(RUN_PREPARATION_FAILED).toBe('run_preparation_failed');
    expect(
      parseRunFailure(
        `${RUN_PREPARATION_FAILED}: The run request could not be prepared at the tools step (Error).`,
      ),
    ).toEqual({
      code: 'run_preparation_failed',
      message: 'The run request could not be prepared at the tools step (Error).',
    });
    expect(isRunStartProblemCode(RUN_PREPARATION_FAILED)).toBe(false);
  });

  it('reads the retryable runtime-capacity code, which is not a start refusal (issue #557)', () => {
    expect(RUNTIME_CAPACITY_EXHAUSTED).toBe('runtime_capacity_exhausted');
    expect(parseRunFailure(`${RUNTIME_CAPACITY_EXHAUSTED}: send the message again.`)).toEqual({
      code: 'runtime_capacity_exhausted',
      message: 'send the message again.',
    });
    expect(isRunStartProblemCode(RUNTIME_CAPACITY_EXHAUSTED)).toBe(false);
    expect(parseRunFailure('runner_capacity_exhausted: busy')).toEqual({
      code: null,
      message: 'runner_capacity_exhausted: busy',
    });
  });
});

describe('StartRunRequestSchema version range', () => {
  it('matches AgentVersionResource.number (the inlined max has not drifted)', () => {
    const accepts = (version: number): boolean =>
      StartRunRequestSchema.safeParse({ prompt: 'hi', version }).success;
    expect(accepts(AGENT_VERSION_NUMBER_MAX)).toBe(true);
    expect(accepts(AGENT_VERSION_NUMBER_MAX + 1)).toBe(false);
  });
});
