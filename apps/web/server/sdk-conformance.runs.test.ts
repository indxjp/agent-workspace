/**
 * SDK conformance, runs: see `sdk-conformance.test-support.ts` for what this suite pins.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ApiProblemError, createClient } from '@indx-workspace/sdk';
import {
  AGENT_FRAME_NAMES,
  AGENT_FRAME_RAW_MAX_BYTES,
  AGENT_STOP_REASONS,
  AGENT_TOOL_KINDS,
  AgentFrameSchema,
} from '@indx-workspace/contracts/run-events';
import { ENGINE_IDS } from '@indx-workspace/contracts/engines';
import {
  ACCOUNTING_STATES,
  InterruptRunResponseSchema,
  MAX_PROMPT_CHARS,
  MAX_RUN_ATTACHMENTS,
  RevokeRunTokensResponseSchema,
  RUN_IDEMPOTENCY_PROBLEM_CODES,
  RUN_LIST_MAX_LIMIT,
  RUN_STATUSES,
  RunResourceSchema,
  StartRunRequestSchema,
} from '@indx-workspace/contracts/runs';
import {
  RUN_FEEDBACK_COMMENT_MAX_LENGTH,
  RUN_FEEDBACK_RATINGS,
  RunFeedbackRequestSchema,
} from '@indx-workspace/contracts/feedback';
import {
  AGENT_FRAME_RAW_MAX_BYTES as CORE_AGENT_FRAME_RAW_MAX_BYTES,
  agentFrameNames as coreAgentFrameNames,
  agentStopReasons as coreAgentStopReasons,
  agentToolKinds as coreAgentToolKinds,
  classifySdkEvent,
  toAgentFrames,
} from '@agent-workspace/run-protocol';
import {
  engineIds as schemaEngineIds,
  RUN_FEEDBACK_COMMENT_MAX_LENGTH as CORE_RUN_FEEDBACK_COMMENT_MAX_LENGTH,
  RUN_FEEDBACK_RATINGS as CORE_RUN_FEEDBACK_RATINGS,
} from '@agent-workspace/core/db';
import { parseStartRunBody, renderRun, startRun } from './runs/api';
import { MAX_PROMPT_CHARS as SERVER_MAX_PROMPT_CHARS } from './runs/service';
import { InMemoryRunStore } from './runs/memory-store';
import { accountingStates, MAX_RUN_LIST_LIMIT, type RunRecord, runStatuses } from './runs/store';
import { installTestRunApi, resetTestRunApi } from './application-context-fixtures';
import { WORKSPACE, AGENT, SESSION } from './sdk-conformance.test-support';

const queued: RunRecord = {
  id: '33333333-3333-4333-8333-333333333333',
  workspaceId: WORKSPACE,
  agentId: AGENT,
  sessionId: SESSION,
  status: 'queued',
  createdAt: new Date('2026-09-21T10:00:00.000Z'),
  startedAt: null,
  endedAt: null,
  error: null,
};

describe('runs', () => {
  it('renders a minimal record and a fully settled one into the published shape', () => {
    expect(RunResourceSchema.safeParse(renderRun(queued)).success).toBe(true);
    const settled: RunRecord = {
      ...queued,
      status: 'failed',
      startedAt: new Date('2026-09-21T10:00:01.000Z'),
      endedAt: new Date('2026-09-21T10:00:05.500Z'),
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      modelConnectionId: '22222222-2222-4222-8222-222222222222',
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 1,
      toolCalls: 2,
      costUsd: '0.001234',
      costCurrency: 'USD',
      priceTableVersion: '2026-09',
      error: 'The runtime exited.',
      accountingState: 'failed',
      accountingError: 'ledger: relation "x" does not exist',
      projectId: '66666666-6666-4666-8666-666666666666',
      initiatingUserId: '77777777-7777-4777-8777-777777777777',
    };
    const parsed = RunResourceSchema.parse(renderRun(settled));
    expect(parsed.durationMs).toBe(4500);
    expect(parsed.usage.totalTokens).toBe(36);
    // The redacted accounting failure is the contract; the raw ledger cause never crosses.
    expect(parsed.accountingError).not.toContain('relation');
  });

  it('renders a run with and without an output into the published RunResource (ADR-0143)', () => {
    expect(RunResourceSchema.parse(renderRun(queued)).output).toBeNull();
    const output = { text: '{"a":1}', structured: { a: 1 } };
    const completed: RunRecord = {
      ...queued,
      status: 'completed',
      startedAt: new Date('2026-09-21T10:00:01.000Z'),
      endedAt: new Date('2026-09-21T10:00:02.000Z'),
      output,
    };
    expect(RunResourceSchema.parse(renderRun(completed)).output).toEqual(output);
  });
});

describe('runs', () => {
  it('pins run_feedback’s rating set and comment cap to RunFeedbackRequestSchema (issue #539)', () => {
    // `packages/core` may not import the contracts, so the table restates both; same watcher as
    // `engineIds` below. The contract's `rating` enum is built from `RUN_FEEDBACK_RATINGS`.
    expect([...CORE_RUN_FEEDBACK_RATINGS]).toEqual([...RUN_FEEDBACK_RATINGS]);
    expect(CORE_RUN_FEEDBACK_COMMENT_MAX_LENGTH).toBe(RUN_FEEDBACK_COMMENT_MAX_LENGTH);
    const comment = (length: number) => ({ rating: 'up', comment: 'c'.repeat(length) });
    expect(
      RunFeedbackRequestSchema.safeParse(comment(CORE_RUN_FEEDBACK_COMMENT_MAX_LENGTH)).success,
    ).toBe(true);
    expect(
      RunFeedbackRequestSchema.safeParse(comment(CORE_RUN_FEEDBACK_COMMENT_MAX_LENGTH + 1)).success,
    ).toBe(false);
  });
});

describe('runs', () => {
  it('shares the run vocabulary and the list/prompt bounds with the server', () => {
    expect([...runStatuses]).toEqual([...RUN_STATUSES]);
    // ADR-0136: the database's engine list is `ENGINE_IDS` itself, not a restatement.
    expect(schemaEngineIds).toBe(ENGINE_IDS);
    // ENG-03 (#302): `packages/core` also restates the neutral frame vocabulary, because
    // `toAgentFrames` lives beside the Claude classification and cannot import the contracts. Same
    // rule, same watcher — and the raw cap too, since the contract publishes the number a consumer
    // reads while core is the side that applies it.
    expect([...coreAgentFrameNames]).toEqual([...AGENT_FRAME_NAMES]);
    expect([...coreAgentToolKinds]).toEqual([...AGENT_TOOL_KINDS]);
    expect([...coreAgentStopReasons]).toEqual([...AGENT_STOP_REASONS]);
    expect(CORE_AGENT_FRAME_RAW_MAX_BYTES).toBe(AGENT_FRAME_RAW_MAX_BYTES);
    // And every frame the Claude mapping produces satisfies the published union — the hole the
    // restatement opens, closed by a test rather than left to a comment (see `run-protocol/src/types.ts`).
    for (const message of [
      { type: 'system', subtype: 'init', session_id: 'sess_1' },
      {
        type: 'assistant',
        message: {
          id: 'msg_1',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'tool_use', id: 'tool_1', name: 'Read', input: {} },
          ],
        },
      },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool_1' }] } },
      {
        type: 'result',
        subtype: 'success',
        modelUsage: { m: { inputTokens: 1, outputTokens: 2 } },
      },
      { type: 'system', subtype: 'status' },
      'not an object',
    ]) {
      for (const frame of toAgentFrames(classifySdkEvent(message))) {
        const parsed = AgentFrameSchema.safeParse(frame);
        expect(parsed.success, `${frame.frame}: ${JSON.stringify(parsed.error?.issues)}`).toBe(
          true,
        );
      }
    }
    expect([...accountingStates]).toEqual([...ACCOUNTING_STATES]);
    expect(SERVER_MAX_PROMPT_CHARS).toBe(MAX_PROMPT_CHARS);
    expect(MAX_RUN_LIST_LIMIT).toBe(RUN_LIST_MAX_LIMIT);
  });
});

describe('runs', () => {
  it('renders the interrupted run through renderRun into InterruptRunResponseSchema (issue #235, S-14)', () => {
    const cancelled: RunRecord = {
      ...queued,
      status: 'cancelled',
      startedAt: new Date('2026-09-21T10:00:01.000Z'),
      endedAt: new Date('2026-09-21T10:00:02.000Z'),
      error: 'the run was interrupted by request',
    };
    expect(InterruptRunResponseSchema.safeParse({ run: renderRun(cancelled) }).success).toBe(true);
  });

  it('renders a paused run, with its pending call, into the published RunResource (issue #1301)', () => {
    const paused: RunRecord = {
      ...queued,
      status: 'awaiting_approval',
      startedAt: new Date('2026-09-21T10:00:01.000Z'),
      endedAt: new Date('2026-09-21T10:00:02.000Z'),
      pendingApproval: { toolName: 'send_email', canonicalCall: '{"to":"a@b.c"}' },
    };
    const parsed = RunResourceSchema.parse(renderRun(paused));
    expect(parsed.status).toBe('awaiting_approval');
    expect(parsed.pendingApproval).toEqual(paused.pendingApproval);
  });
});

/** Installs the run API over `store`, recording each launched run id into `launched`. */
function installLaunchRecordingRunApi(store: InMemoryRunStore, launched: string[]): void {
  installTestRunApi({
    authenticate: () =>
      Promise.resolve({
        principalId: '77777777-7777-4777-8777-777777777777',
        ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
        userId: '66666666-6666-4666-8666-666666666666',
        workspaceId: WORKSPACE,
        role: 'owner' as const,
        scope: null,
      }),
    findAgent: (principal, agentId) =>
      Promise.resolve(
        agentId === AGENT
          ? { id: AGENT, workspaceId: principal.workspaceId, engine: 'claude-agent-sdk' }
          : null,
      ),
    openSession: () => Promise.resolve({ id: SESSION, agentId: AGENT, engine: null }),
    ownsRun: () => Promise.resolve(true),
    store,
    launch: (context) => {
      launched.push(context.run.id);
    },
  });
}

/** The SDK's own request, header and body as it sends them, answered by the real route handler. */
function startRunRouteClient() {
  return createClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'api-key', apiKey: 'ak_live_k' },
    fetch: (input, init) => startRun(new Request(input, init), AGENT),
  });
}

describe('runs', () => {
  it('publishes RevokeRunTokensResponseSchema for the repository’s own outcome vocabulary (issue #235, S-15)', () => {
    for (const outcome of ['revoked', 'already-revoked', 'not-found'] as const) {
      expect(
        RevokeRunTokensResponseSchema.safeParse({ revoked: outcome === 'revoked' ? 1 : 0, outcome })
          .success,
      ).toBe(true);
    }
  });
});

describe('runs', () => {
  describe('idempotent start (issue #250, S-6, ADR-0151)', () => {
    afterEach(() => {
      resetTestRunApi();
    });

    it('answers an SDK start retried with its key with the same run, and another input with 409', async () => {
      const store = new InMemoryRunStore();
      const launched: string[] = [];
      installLaunchRecordingRunApi(store, launched);
      const client = startRunRouteClient();
      const outputSchema = { type: 'object', properties: { a: { type: 'string' } } };

      const first = await client.runs.start(AGENT, {
        prompt: 'hi',
        outputSchema,
        idempotencyKey: 'order-42',
      });
      const retried = await client.runs.start(AGENT, {
        prompt: 'hi',
        outputSchema,
        idempotencyKey: 'order-42',
      });
      expect(retried.run.id).toBe(first.run.id);
      expect(retried.events).toBe(first.events);

      const conflict = await client.runs
        .start(AGENT, { prompt: 'something else', idempotencyKey: 'order-42' })
        .catch((error: unknown) => error);
      expect(conflict).toBeInstanceOf(ApiProblemError);
      expect((conflict as ApiProblemError).status).toBe(
        RUN_IDEMPOTENCY_PROBLEM_CODES.run_idempotency_conflict,
      );
      expect((conflict as ApiProblemError).code).toBe('run_idempotency_conflict');

      const blank = await client.runs
        .start(AGENT, { prompt: 'hi', idempotencyKey: '   ' })
        .catch((error: unknown) => error);
      expect((blank as ApiProblemError).status).toBe(
        RUN_IDEMPOTENCY_PROBLEM_CODES.invalid_idempotency_key,
      );
      expect((blank as ApiProblemError).code).toBe('invalid_idempotency_key');

      expect((await store.listRuns(WORKSPACE, { limit: 10 })).items).toHaveLength(1);
      expect(launched).toEqual([first.run.id]);
    });
  });
});

describe('runs', () => {
  it('accepts a start-run body as the SDK sends it, and rejects what the SDK rejects', () => {
    const attachmentList = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ fileId: `file-${String(index)}` }));
    const bodies: readonly unknown[] = [
      { prompt: 'hello', sessionId: null, modelConnectionId: null, model: null },
      { prompt: 'hello', sessionId: SESSION, modelConnectionId: null, model: null },
      {
        prompt: 'hello',
        sessionId: null,
        modelConnectionId: '22222222-2222-4222-8222-222222222222',
        model: 'claude-sonnet-5',
      },
      { prompt: '   ' },
      { prompt: 'hello', model: 'alone' },
      { prompt: 'hello', sessionId: 'latest' },
      { prompt: 'hello', unknown: 1 },
      { prompt: 'hello', sessionId: null, modelConnectionId: null, model: null, version: 2 },
      { prompt: 'hello', version: 0 },
      { prompt: 'hello', version: 1.5 },
      { prompt: 'hello', version: '2' },
      { prompt: 'hello', sessionId: SESSION, version: 2 },
      { prompt: 'hello', attachments: [{ fileId: 'a' }] },
      { prompt: 'hello', sessionId: SESSION, attachments: [{ fileId: 'a' }, { fileId: 'b' }] },
      { prompt: 'hello', attachments: attachmentList(MAX_RUN_ATTACHMENTS) },
      { prompt: 'hello', attachments: [] },
      { prompt: 'hello', attachments: attachmentList(MAX_RUN_ATTACHMENTS + 1) },
      { prompt: 'hello', attachments: [{ fileId: 'a' }, { fileId: 'a' }] },
      { prompt: 'hello', attachments: [{ fileId: 'a', access: 'write' }] },
      { prompt: 'hello', attachments: [{ fileId: '' }] },
      { prompt: 'hello', attachments: [{}] },
      { prompt: 'hello', attachments: ['a'] },
      { prompt: 'hello', attachments: 'a' },
      { prompt: 'hello', attachments: null },
      { prompt: 'hello', outputSchema: { type: 'object' } },
      { prompt: 'hello', sessionId: SESSION, outputSchema: { type: 'object' } },
      { prompt: 'hello', outputSchema: { type: 'array' } },
      { prompt: 'hello', outputSchema: { type: 'object', $schema: 'draft-07' } },
      { prompt: 'hello', outputSchema: { type: 'object', $ref: 'https://example.com/a' } },
      { prompt: 'hello', outputSchema: { type: 'object', description: 'x'.repeat(40_000) } },
      { prompt: 'hello', outputSchema: 'object' },
      { prompt: 'hello', outputSchema: null },
    ];
    for (const body of bodies) {
      expect(
        parseStartRunBody(body).kind === 'ok',
        `server and contract disagree on ${JSON.stringify(body)}`,
      ).toBe(StartRunRequestSchema.safeParse(body).success);
    }
  });
});
