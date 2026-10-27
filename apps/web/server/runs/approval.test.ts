import { RunApprovalResponseSchema } from '@indx-workspace/contracts/runs';
import { afterEach, describe, expect, it } from 'vitest';

import { interruptRun } from './api';
import { decideRunApproval } from './approval';
import {
  type AgentRef,
  type LaunchContext,
  type RunApiEnvironment,
  type RunPrincipal,
  type SessionRef,
} from './environment';
import { InMemoryRunStore } from './memory-store';
import { ApprovalDecisionError, type ApprovalCall, type RunRecord } from './store';
import { installTestRunApi, resetTestRunApi } from '../application-context-fixtures';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const OTHER_WORKSPACE = '55555555-5555-4555-8555-555555555555';
const AGENT = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';
const CALL: ApprovalCall = { toolName: 'send_email', canonicalCall: '{"to":"a@b.c"}' };
const PRINCIPAL: RunPrincipal = {
  principalId: '77777777-7777-4777-8777-777777777777',
  ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
  userId: '66666666-6666-4666-8666-666666666666',
  workspaceId: WORKSPACE,
  role: 'owner',
  scope: null,
};

interface Harness {
  readonly store: InMemoryRunStore;
  readonly launched: LaunchContext[];
}

function install(
  overrides: Partial<RunApiEnvironment> = {},
  store = new InMemoryRunStore(),
): Harness {
  const launched: LaunchContext[] = [];
  installTestRunApi({
    authenticate: (request: Request) =>
      Promise.resolve(request.headers.get('x-test-user') === null ? null : PRINCIPAL),
    findAgent: (principal: RunPrincipal, agentId: string): Promise<AgentRef | null> =>
      Promise.resolve(
        agentId === AGENT
          ? { id: AGENT, workspaceId: principal.workspaceId, engine: 'claude-agent-sdk' }
          : null,
      ),
    openSession: (_p: RunPrincipal, agent: AgentRef): Promise<SessionRef | null> =>
      Promise.resolve({ id: SESSION, agentId: agent.id, engine: null }),
    ownsRun: () => Promise.resolve(true),
    store,
    launch: (context: LaunchContext): void => {
      launched.push(context);
    },
    interruptRun: () => Promise.resolve(),
    ...overrides,
  });
  return { store, launched };
}

afterEach(() => {
  resetTestRunApi();
});

/** A run in `SESSION` that the engine stopped before `CALL`. */
async function pausedRun(
  store: InMemoryRunStore,
  workspaceId = WORKSPACE,
  id = crypto.randomUUID(),
  outputSchema?: Readonly<Record<string, unknown>>,
  subject?: string,
): Promise<RunRecord> {
  await store.create({
    engine: 'claude-agent-sdk',
    id,
    workspaceId,
    agentId: AGENT,
    sessionId: SESSION,
    initiatingUserId: PRINCIPAL.userId,
    ownerPrincipalId: PRINCIPAL.principalId,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(subject === undefined ? {} : { subject }),
  });
  await store.markRunning(id);
  await store.awaitApproval(id, CALL);
  const run = await store.get(id);
  if (run === null) throw new Error('the paused run vanished');
  return run;
}

function decision(runId: string, body: unknown, authenticated = true): Request {
  return new Request(`http://web/api/runs/${runId}/approval`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authenticated ? { 'x-test-user': '1' } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? '(none)';
}

describe('POST /api/runs/:id/approval (ADR-0145 D2, issue #1301)', () => {
  it('answers 503, 401, 400 and 404 before it reads the body', async () => {
    const id = crypto.randomUUID();
    expect((await decideRunApproval(decision(id, {}), id)).status).toBe(503);
    install();
    expect((await decideRunApproval(decision(id, {}, false), id)).status).toBe(401);
    expect((await decideRunApproval(decision('x', {}), 'x')).status).toBe(400);
    expect((await decideRunApproval(decision(id, {}), id)).status).toBe(404);
  });

  it('conceals a foreign-workspace run behind the same 404 as a missing one', async () => {
    const { store } = install();
    const run = await pausedRun(store, OTHER_WORKSPACE);
    expect(
      (await decideRunApproval(decision(run.id, { decision: 'approve' }), run.id)).status,
    ).toBe(404);
  });

  it('approve answers 202 with a queued continuation in the same session that may make the call', async () => {
    const { store, launched } = install();
    const paused = await pausedRun(store);
    const response = await decideRunApproval(
      decision(paused.id, { decision: 'approve', comment: 'go ahead' }),
      paused.id,
    );
    expect(response.status).toBe(202);
    const body = RunApprovalResponseSchema.parse(await response.json());
    expect(body.run.id).not.toBe(paused.id);
    expect(body.run.sessionId).toBe(SESSION);
    expect(body.events).toBe(`/api/runs/${body.run.id}/events`);
    expect(response.headers.get('Location')).toBe(body.events);

    expect((await store.get(paused.id))?.status).toBe('completed');
    // The repository store writes the same event; a replay of the paused run ends `completed`.
    const handle = await store.openStream(paused.id, null);
    if (handle === null) throw new Error('the paused run had no event stream');
    const statuses: unknown[] = [];
    for await (const event of handle.events) {
      if (event.type === 'run.status') statuses.push(event.data);
    }
    expect(statuses.at(-1)).toEqual({ status: 'completed', error: null });
    expect(launched).toHaveLength(1);
    expect(launched[0]?.prompt).toBe('approved: go ahead');
    expect(launched[0]?.run.approvedToolCalls).toEqual([CALL]);
  });

  it("a continuation inherits the paused run's file grants as its scope (issue #1539)", async () => {
    const { store, launched } = install();
    const paused = await pausedRun(store);
    const get = store.get.bind(store);
    store.get = async (id) => {
      const run = await get(id);
      return run?.id === paused.id ? { ...run, fileGrants: ['docs/alice'] } : run;
    };
    const response = await decideRunApproval(
      decision(paused.id, { decision: 'approve' }),
      paused.id,
    );
    expect(response.status).toBe(202);
    expect(launched[0]?.fileScope).toEqual(['docs/alice']);
  });

  it('a continuation of a run with no recorded grants carries no scope', async () => {
    const { store, launched } = install();
    const paused = await pausedRun(store);
    await decideRunApproval(decision(paused.id, { decision: 'approve' }), paused.id);
    expect(launched[0]?.fileScope).toBeUndefined();
  });

  it('reject starts a continuation that may not make the call', async () => {
    const { store, launched } = install();
    const paused = await pausedRun(store);
    const response = await decideRunApproval(
      decision(paused.id, { decision: 'reject' }),
      paused.id,
    );
    expect(response.status).toBe(202);
    expect(launched[0]?.prompt).toBe('rejected');
    expect(launched[0]?.run.approvedToolCalls).toEqual([]);
    expect((await store.get(paused.id))?.status).toBe('completed');
  });

  it("approve and reject start a continuation that asks for the paused run's outputSchema", async () => {
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
    const { store, launched } = install();
    const approved = await pausedRun(store, WORKSPACE, crypto.randomUUID(), schema);
    await decideRunApproval(decision(approved.id, { decision: 'approve' }), approved.id);
    expect(launched[0]?.outputSchema).toEqual(schema);
    expect(launched[0]?.run.outputSchema).toEqual(schema);
    const rejected = await pausedRun(store, WORKSPACE, crypto.randomUUID(), schema);
    await decideRunApproval(decision(rejected.id, { decision: 'reject' }), rejected.id);
    expect(launched[1]?.outputSchema).toEqual(schema);
  });

  it('a paused run with no outputSchema continues untyped', async () => {
    const { store, launched } = install();
    const paused = await pausedRun(store);
    await decideRunApproval(decision(paused.id, { decision: 'approve' }), paused.id);
    expect(launched[0]?.outputSchema).toBeUndefined();
  });

  it('the continuation of a subject-bearing run carries the same subject (ADR-0157)', async () => {
    const { store, launched } = install();
    const approved = await pausedRun(store, WORKSPACE, crypto.randomUUID(), undefined, 'user-4711');
    await decideRunApproval(decision(approved.id, { decision: 'approve' }), approved.id);
    expect(launched[0]?.subject).toBe('user-4711');
    const rejected = await pausedRun(store, WORKSPACE, crypto.randomUUID(), undefined, 'user-4711');
    await decideRunApproval(decision(rejected.id, { decision: 'reject' }), rejected.id);
    expect(launched[1]?.subject).toBe('user-4711');
  });

  it("an approver's body cannot set the subject (400 invalid_body), and a member approving a key's run still acts for the stored subject", async () => {
    const { store, launched } = install();
    const paused = await pausedRun(store, WORKSPACE, crypto.randomUUID(), undefined, 'user-4711');
    const forged = await decideRunApproval(
      decision(paused.id, { decision: 'approve', subject: 'someone-else' }),
      paused.id,
    );
    expect(forged.status).toBe(400);
    expect(await errorCode(forged)).toBe('invalid_body');
    expect(launched).toHaveLength(0);
    expect((await store.get(paused.id))?.status).toBe('awaiting_approval');

    // PRINCIPAL is a signed-in member, not the key that started the run.
    const approved = await decideRunApproval(
      decision(paused.id, { decision: 'approve' }),
      paused.id,
    );
    expect(approved.status).toBe(202);
    expect(launched[0]?.subject).toBe('user-4711');
  });

  it('a run with no subject continues with none', async () => {
    const { store, launched } = install();
    const paused = await pausedRun(store);
    await decideRunApproval(decision(paused.id, { decision: 'approve' }), paused.id);
    expect(launched[0]?.subject).toBeUndefined();
  });

  it('refuses a second decision: the first one completed the paused run', async () => {
    const { store, launched } = install();
    const paused = await pausedRun(store);
    expect(
      (await decideRunApproval(decision(paused.id, { decision: 'approve' }), paused.id)).status,
    ).toBe(202);
    const second = await decideRunApproval(decision(paused.id, { decision: 'reject' }), paused.id);
    expect(second.status).toBe(409);
    expect(await errorCode(second)).toBe('run_not_awaiting_approval');
    expect(launched).toHaveLength(1);
  });

  it('refuses a run that is not paused', async () => {
    const { store } = install();
    const run = await store.create({
      engine: 'claude-agent-sdk',
      id: crypto.randomUUID(),
      workspaceId: WORKSPACE,
      agentId: AGENT,
      sessionId: SESSION,
      initiatingUserId: PRINCIPAL.userId,
      ownerPrincipalId: PRINCIPAL.principalId,
    });
    const response = await decideRunApproval(decision(run.id, { decision: 'approve' }), run.id);
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('run_not_awaiting_approval');
  });

  it.each([
    ['an unknown decision', { decision: 'maybe' }],
    ['no decision', {}],
    ['an unknown key', { decision: 'approve', extra: true }],
    ['a blank comment', { decision: 'approve', comment: '   ' }],
  ])('refuses %s with 400 invalid_body and starts nothing', async (_name, body) => {
    const { store, launched } = install();
    const paused = await pausedRun(store);
    const response = await decideRunApproval(decision(paused.id, body), paused.id);
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('invalid_body');
    expect(launched).toHaveLength(0);
    expect((await store.get(paused.id))?.status).toBe('awaiting_approval');
  });

  it('refuses a member who may not run this row, before the body is read', async () => {
    const { store, launched } = install({
      authenticate: () => Promise.resolve({ ...PRINCIPAL, role: 'viewer' }),
      ownsRun: () => Promise.resolve(false),
    });
    const paused = await pausedRun(store);
    const response = await decideRunApproval(
      decision(paused.id, { decision: 'approve' }),
      paused.id,
    );
    expect(response.status).toBe(403);
    expect(launched).toHaveLength(0);
    expect((await store.get(paused.id))?.status).toBe('awaiting_approval');
  });

  it('an interrupt of a paused run cancels it, and a decision after it is 409', async () => {
    const store = new InMemoryRunStore();
    const { launched } = install(
      {
        interruptRun: async (_principal, run) => {
          await store.finish(run.id, 'cancelled', 'the run was interrupted by request', true);
        },
      },
      store,
    );
    const paused = await pausedRun(store);
    const request = new Request(`http://web/api/runs/${paused.id}/interrupt`, {
      method: 'POST',
      headers: { 'x-test-user': '1' },
    });
    expect((await interruptRun(request, paused.id)).status).toBe(200);
    expect((await store.get(paused.id))?.status).toBe('cancelled');

    const response = await decideRunApproval(
      decision(paused.id, { decision: 'approve' }),
      paused.id,
    );
    expect(response.status).toBe(409);
    expect(launched).toHaveLength(0);
  });
});

describe('InMemoryRunStore: a decision is a compare-and-set (ADR-0145 D2.1)', () => {
  const fresh = () => ({
    engine: 'claude-agent-sdk' as const,
    id: crypto.randomUUID(),
    workspaceId: WORKSPACE,
    agentId: AGENT,
    sessionId: SESSION,
    initiatingUserId: PRINCIPAL.userId,
    ownerPrincipalId: PRINCIPAL.principalId,
  });
  const continuation = (decides: string) => ({
    ...fresh(),
    approvedToolCalls: [CALL],
    decides,
  });

  it('lets exactly one of two decisions create a continuation', async () => {
    const store = new InMemoryRunStore();
    const paused = await pausedRun(store);
    const first = await store.create(continuation(paused.id));
    expect(first.approvedToolCalls).toEqual([CALL]);
    await expect(store.create(continuation(paused.id))).rejects.toMatchObject({
      constructor: ApprovalDecisionError,
      reason: 'already-decided',
    });
  });

  it('refuses a decision on a run that is not paused, or is in another workspace', async () => {
    const store = new InMemoryRunStore();
    const other = await pausedRun(store, OTHER_WORKSPACE);
    await expect(store.create(continuation(other.id))).rejects.toBeInstanceOf(
      ApprovalDecisionError,
    );
    await expect(store.create(continuation(crypto.randomUUID()))).rejects.toBeInstanceOf(
      ApprovalDecisionError,
    );
  });

  it('awaitApproval pauses only a running run, and records the call it waits on', async () => {
    const store = new InMemoryRunStore();
    const queued = await store.create(fresh());
    await store.awaitApproval(queued.id, CALL);
    expect((await store.get(queued.id))?.status).toBe('queued');
    const paused = await pausedRun(store);
    expect(paused.status).toBe('awaiting_approval');
    expect(paused.pendingApproval).toEqual(CALL);
    expect(paused.endedAt).not.toBeNull();
  });
});
