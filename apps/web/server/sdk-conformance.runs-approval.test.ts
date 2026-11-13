/**
 * SDK conformance, runs / approval: see `sdk-conformance.test-support.ts` for what this suite pins.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { servedContractsHeaders } from './versioning/contracts-version';
import { ApiProblemSchema } from '@indx-workspace/contracts';
import { ApiProblemError, createClient } from '@indx-workspace/sdk';
import {
  CONTROL_FRAME_NAMES,
  RELAYED_EVENT_NAMES,
  RUN_STATUS_EVENT,
} from '@indx-workspace/contracts/run-events';
import {
  RUN_APPROVAL_COMMENT_MAX_LENGTH,
  RUN_APPROVAL_PROBLEM_CODES,
  RUN_START_PROBLEM_CODES,
  RunApprovalResponseSchema,
} from '@indx-workspace/contracts/runs';
import { enforceCeiling } from './policy-ceiling/ceiling';
import { recordingCeilingFor } from './policy-ceiling/fixtures';
import { classifyRunEventFrame, parseSseFrame } from '@indx-workspace/sdk/events';
import { decideRunApproval } from './runs/approval';
import { InMemoryRunStore } from './runs/memory-store';
import {
  classifyEventName,
  CONTROL_FRAME_NAMES as SERVER_CONTROL_FRAME_NAMES,
  RUN_STATUS_EVENT as SERVER_RUN_STATUS_EVENT,
  sseControlFrame,
  sseFrame,
} from './runs/sse';
import { ApprovalDecisionError, type CreateRunInput, type RunRecord } from './runs/store';
import { AGENT_VERSION_PROBLEM_CODES } from '@indx-workspace/contracts/agent-versions';
import { versionRequest } from './agent-versions/fixtures';
import { installTestRunApi, resetTestRunApi } from './application-context-fixtures';
import { WORKSPACE, AGENT, SESSION } from './sdk-conformance.test-support';

/** Refuses every decision for `reason`, as the repository store does under its lock. */
class RefusingRunStore extends InMemoryRunStore {
  constructor(readonly reason: 'already-decided' | 'expired') {
    super();
  }

  override create(input: CreateRunInput): Promise<RunRecord> {
    return input.decides === undefined
      ? super.create(input)
      : Promise.reject(new ApprovalDecisionError(input.decides, this.reason));
  }
}

async function installPaused(store: InMemoryRunStore): Promise<string> {
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
    launch: () => undefined,
  });
  const id = crypto.randomUUID();
  await store.create({
    engine: 'claude-agent-sdk',
    id,
    workspaceId: WORKSPACE,
    agentId: AGENT,
    sessionId: SESSION,
  });
  await store.markRunning(id);
  await store.awaitApproval(id, { toolName: 'send_email', canonicalCall: '{}' });
  return id;
}

function decide(runId: string, body: unknown): Promise<Response> {
  return decideRunApproval(
    new Request(`http://web/api/runs/${runId}/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    runId,
  );
}

describe('runs', () => {
  /**
   * The approval route's 202 body and every refusal it can answer, from the real handler, against
   * the published schema and `RUN_APPROVAL_PROBLEM_CODES` (issue #1301). A code renamed or answered
   * under another status on either side fails here.
   */
  describe('approval decisions', () => {
    afterEach(() => {
      resetTestRunApi();
    });

    it('answers 202 with the published RunApprovalResponseSchema, then run_not_awaiting_approval', async () => {
      const id = await installPaused(new InMemoryRunStore());
      const tooLong = await decide(id, {
        decision: 'approve',
        comment: 'x'.repeat(RUN_APPROVAL_COMMENT_MAX_LENGTH + 1),
      });
      expect(tooLong.status).toBe(400);

      const accepted = await decide(id, {
        decision: 'approve',
        comment: 'x'.repeat(RUN_APPROVAL_COMMENT_MAX_LENGTH),
      });
      expect(accepted.status).toBe(202);
      const body = RunApprovalResponseSchema.parse(await accepted.json());
      expect(body.events).toBe(`/api/runs/${body.run.id}/events`);

      const again = await decide(id, { decision: 'reject' });
      expect(ApiProblemSchema.parse(await again.json()).error.code).toBe(
        'run_not_awaiting_approval',
      );
      expect(again.status).toBe(RUN_APPROVAL_PROBLEM_CODES.run_not_awaiting_approval);
    });

    it('answers every published approval refusal under its published status', async () => {
      const refusals = [
        ['already-decided', 'approval_already_decided'],
        ['expired', 'approval_expired'],
      ] as const;
      for (const [reason, code] of refusals) {
        const id = await installPaused(new RefusingRunStore(reason));
        const response = await decide(id, { decision: 'approve' });
        expect(ApiProblemSchema.parse(await response.json()).error.code).toBe(code);
        expect(response.status).toBe(RUN_APPROVAL_PROBLEM_CODES[code]);
      }
      // Every published code is one the route answers, and the reverse.
      expect(Object.keys(RUN_APPROVAL_PROBLEM_CODES).sort()).toEqual(
        ['run_not_awaiting_approval', ...refusals.map(([, code]) => code)].sort(),
      );
      expect(new Set(Object.values(RUN_APPROVAL_PROBLEM_CODES))).toEqual(new Set([409]));
    });
  });
});

describe('run events', () => {
  it('reserves the same names as the server, minus the one it never emits', () => {
    expect(SERVER_RUN_STATUS_EVENT).toBe(RUN_STATUS_EVENT);
    expect(SERVER_CONTROL_FRAME_NAMES.filter((name) => name !== 'error')).toEqual([
      ...CONTROL_FRAME_NAMES,
    ]);
    for (const name of RELAYED_EVENT_NAMES) {
      expect(classifyEventName(name).kind, `${name} must be relayable`).toBe('ok');
    }
  });

  it('parses every frame the server writes into the classification the SDK publishes', () => {
    const status = parseSseFrame(
      sseFrame({ id: 7n, type: RUN_STATUS_EVENT, data: { status: 'running', error: null } }),
    );
    expect(status).not.toBeNull();
    expect(classifyRunEventFrame(status ?? { event: '', id: null, data: null })).toEqual({
      kind: 'run-status',
      id: '7',
      data: { status: 'running', error: null },
    });

    const relayed = parseSseFrame(
      sseFrame({ id: 8n, type: 'sdk-event', data: { kind: 'event', type: 'assistant' } }),
    );
    expect(classifyRunEventFrame(relayed ?? { event: '', id: null, data: null })).toEqual({
      kind: 'runtime',
      id: '8',
      name: 'sdk-event',
      data: { kind: 'event', type: 'assistant' },
    });

    const failed = parseSseFrame(
      sseControlFrame({ name: 'run-failed', data: { status: 'failed', message: 'x' } }),
    );
    expect(classifyRunEventFrame(failed ?? { event: '', id: null, data: null })).toEqual({
      kind: 'run-failed',
      data: { status: 'failed', message: 'x' },
    });

    const reset = parseSseFrame(
      sseControlFrame({ name: 'stream-reset', data: { reason: 'retention', resumedAfter: null } }),
    );
    expect(classifyRunEventFrame(reset ?? { event: '', id: null, data: null })).toEqual({
      kind: 'stream-reset',
      data: { reason: 'retention', resumedAfter: null },
    });

    const done = parseSseFrame(sseControlFrame({ name: 'done', data: null }));
    expect(classifyRunEventFrame(done ?? { event: '', id: null, data: null })).toEqual({
      kind: 'done',
    });
  });
});

describe('policy_cannot_widen (issue #535)', () => {
  it('reaches an SDK client as ApiProblemError whose details round-trip, under the published status', async () => {
    const { ceilingFor } = recordingCeilingFor({
      permissions: { runCommands: false },
      models: ['claude-sonnet-4-5'],
    });
    const refusal = await enforceCeiling(
      {
        permissions: {
          readFiles: true,
          writeFiles: false,
          runCommands: true,
          unrestrictedNetwork: false,
        },
        limits: { maxTurns: null, maxBudgetUsd: null },
        engine: 'claude-agent-sdk',
        model: 'gpt-5.1',
        tools: [],
      },
      ceilingFor(new Request('https://aw.example.com/'), WORKSPACE),
      null,
    );
    if (refusal === null) throw new Error('the configuration is over the ceiling');
    const details = ['permissions.runCommands', 'model:gpt-5.1'];
    expect(ApiProblemSchema.parse(refusal.body).error).toMatchObject({
      code: 'policy_cannot_widen',
      details,
    });
    expect(refusal.status).toBe(AGENT_VERSION_PROBLEM_CODES.policy_cannot_widen);
    expect(refusal.status).toBe(RUN_START_PROBLEM_CODES.policy_cannot_widen);

    const client = createClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'api-key', apiKey: 'ak_live_k' },
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify(refusal.body), {
            status: refusal.status,
            headers: { 'content-type': 'application/json', ...servedContractsHeaders() },
          }),
        ),
    });
    const { summary, via, body } = versionRequest();
    const failure: unknown = await client.agents.versions
      .create('11111111-1111-4111-8111-111111111111', { summary, via, body })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiProblemError);
    const problemError = failure as ApiProblemError;
    expect([problemError.status, problemError.code, problemError.details]).toEqual([
      403,
      'policy_cannot_widen',
      details,
    ]);
  });
});
