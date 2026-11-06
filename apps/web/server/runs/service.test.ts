/**
 * `startRunOnSession` and the session it opens: a start whose run insert fails must not leave an
 * empty new session behind, and must never remove a session the client brought (issue #1263).
 */
import { ProjectPolicySchema } from '@indx-workspace/contracts/policy-ceiling';
import { log as webLogger } from '../telemetry/logger';
import { describe, expect, it, vi } from 'vitest';

import type { AgentRef, RunApiEnvironment, RunPrincipal, SessionRef } from './environment';
import { InMemoryRunStore } from './memory-store';
import { parseStartRunBody } from './api';
import { startRunOnSession } from './service';
import { SessionBusyError } from './store';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const AGENT: AgentRef = {
  id: '33333333-3333-4333-8333-333333333333',
  workspaceId: WORKSPACE,
  engine: 'claude-agent-sdk',
};
const PRINCIPAL: RunPrincipal = {
  principalId: '77777777-7777-4777-8777-777777777777',
  ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
  userId: '66666666-6666-4666-8666-666666666666',
  workspaceId: WORKSPACE,
  role: 'owner',
  scope: null,
};
const EXISTING_SESSION = '44444444-4444-4444-8444-444444444444';

/** An environment whose `openSession` records new sessions in `sessions`, as the real one inserts rows. */
function harness(discard?: RunApiEnvironment['discardSession']) {
  const sessions = new Map<string, SessionRef>([
    [EXISTING_SESSION, { id: EXISTING_SESSION, agentId: AGENT.id, engine: null }],
  ]);
  const store = new InMemoryRunStore();
  const discardSession: NonNullable<RunApiEnvironment['discardSession']> =
    discard ??
    ((_principal, sessionId) => {
      sessions.delete(sessionId);
      return Promise.resolve();
    });
  const env: RunApiEnvironment = {
    authenticate: () => Promise.resolve(PRINCIPAL),
    findAgent: () => Promise.resolve(AGENT),
    openSession: (_principal, agent, requested) => {
      if (requested !== null) return Promise.resolve(sessions.get(requested) ?? null);
      const fresh: SessionRef = { id: crypto.randomUUID(), agentId: agent.id, engine: null };
      sessions.set(fresh.id, fresh);
      return Promise.resolve(fresh);
    },
    discardSession,
    ownsRun: () => Promise.resolve(true),
    store,
    launch: () => undefined,
  };
  return { env, sessions, store };
}

const START = { prompt: 'hello', sessionId: null, modelOverride: null } as const;

describe('startRunOnSession: a failed run insert', () => {
  it('discards the new session and rethrows the failure', async () => {
    const { env, sessions, store } = harness();
    vi.spyOn(store, 'create').mockRejectedValue(new Error('insert failed'));

    await expect(startRunOnSession(env, PRINCIPAL, AGENT, START)).rejects.toThrow('insert failed');
    expect([...sessions.keys()]).toEqual([EXISTING_SESSION]);
  });

  it('discards the new session and answers 409 session_busy', async () => {
    const { env, sessions, store } = harness();
    vi.spyOn(store, 'create').mockRejectedValue(new SessionBusyError(EXISTING_SESSION));

    await expect(startRunOnSession(env, PRINCIPAL, AGENT, START)).resolves.toMatchObject({
      kind: 'refused',
      status: 409,
      code: 'session_busy',
    });
    expect([...sessions.keys()]).toEqual([EXISTING_SESSION]);
  });

  it('keeps the session of a follow-up, which the client opened', async () => {
    const { env, sessions, store } = harness();
    vi.spyOn(store, 'create').mockRejectedValue(new Error('insert failed'));

    await expect(
      startRunOnSession(env, PRINCIPAL, AGENT, { ...START, sessionId: EXISTING_SESSION }),
    ).rejects.toThrow('insert failed');
    expect(sessions.has(EXISTING_SESSION)).toBe(true);
  });

  it('still surfaces the insert failure when the discard itself fails', async () => {
    const logged = vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    try {
      const { env, store } = harness(() => Promise.reject(new Error('discard failed')));
      vi.spyOn(store, 'create').mockRejectedValue(new Error('insert failed'));

      await expect(startRunOnSession(env, PRINCIPAL, AGENT, START)).rejects.toThrow(
        'insert failed',
      );
      expect(logged).toHaveBeenCalledWith(
        '[runs] could not discard the session opened for a failed start',
        { error: new Error('discard failed') },
      );
    } finally {
      logged.mockRestore();
    }
  });
});

describe('startRunOnSession: the lower-only limits override', () => {
  function launching() {
    const { env, sessions, store } = harness();
    const launched: unknown[] = [];
    return {
      env: { ...env, launch: (context: unknown) => void launched.push(context) },
      sessions,
      store,
      launched,
    };
  }

  it('hands the override to the launch, and nothing when there is none', async () => {
    const { env, launched } = launching();
    await startRunOnSession(env, PRINCIPAL, AGENT, { ...START, limits: { maxBudgetUsd: 0.3 } });
    await startRunOnSession(env, PRINCIPAL, AGENT, START);
    expect(launched[0]).toMatchObject({ limits: { maxBudgetUsd: 0.3 } });
    expect(launched[1]).not.toHaveProperty('limits');
  });

  it('stores the override on the run row, so a run built from the row alone can keep it (#1963, SPD-01)', async () => {
    const { env, store } = launching();
    const capped = await startRunOnSession(env, PRINCIPAL, AGENT, {
      ...START,
      limits: { maxBudgetUsd: 0.3, maxTurns: 4 },
    });
    const uncapped = await startRunOnSession(env, PRINCIPAL, AGENT, START);
    if (capped.kind !== 'started' || uncapped.kind !== 'started') throw new Error('start refused');
    expect((await store.get(capped.run.id))?.limitsOverride).toEqual({
      maxBudgetUsd: 0.3,
      maxTurns: 4,
    });
    expect((await store.get(uncapped.run.id))?.limitsOverride).toBeNull();
  });

  it.each([
    { maxBudgetUsd: 0 },
    { maxBudgetUsd: -1 },
    { maxBudgetUsd: Number.NaN },
    { maxBudgetUsd: Number.POSITIVE_INFINITY },
    { maxTurns: 0 },
    { maxTurns: -3 },
    { maxTurns: 2.5 },
    { maxTurns: Number.POSITIVE_INFINITY },
  ])('refuses %o before it opens a session or creates a run', async (limits) => {
    const { env, sessions, launched } = launching();
    await expect(
      startRunOnSession(env, PRINCIPAL, AGENT, { ...START, limits }),
    ).resolves.toMatchObject({ kind: 'refused', status: 422, code: 'invalid_run_limits' });
    expect([...sessions.keys()]).toEqual([EXISTING_SESSION]);
    expect(launched).toEqual([]);
  });
});

describe('startRunOnSession: the spend ceiling (ADR-0162)', () => {
  function withLimit(limit: number | null) {
    const { env, sessions, store } = harness();
    const asked: (string | null)[] = [];
    const spendLimitFor: NonNullable<RunApiEnvironment['spendLimitFor']> = (
      _principal,
      _agent,
      sessionId,
    ) => {
      asked.push(sessionId);
      return Promise.resolve(limit);
    };
    return { env: { ...env, spendLimitFor }, sessions, store, asked };
  }

  it('refuses 403 policy_cannot_widen at spendCeilingUsd above the agent limit, before a session opens', async () => {
    const { env, sessions, store } = withLimit(1);
    const create = vi.spyOn(store, 'create');
    await expect(
      startRunOnSession(env, PRINCIPAL, AGENT, { ...START, spendCeilingUsd: 1.5 }),
    ).resolves.toMatchObject({
      kind: 'refused',
      status: 403,
      code: 'policy_cannot_widen',
      details: ['spendCeilingUsd'],
    });
    expect([...sessions.keys()]).toEqual([EXISTING_SESSION]);
    expect(create).not.toHaveBeenCalled();
  });

  it('stores a lower spendCeilingUsd on the run', async () => {
    const started = await startRunOnSession(withLimit(1).env, PRINCIPAL, AGENT, {
      ...START,
      spendCeilingUsd: 0.25,
    });
    expect(started).toMatchObject({ kind: 'started', run: { spendCeilingUsd: '0.250000' } });
  });

  it("stores the agent's limit when the start names none, asked with the follow-up's session", async () => {
    const { env, asked } = withLimit(2);
    const started = await startRunOnSession(env, PRINCIPAL, AGENT, {
      ...START,
      sessionId: EXISTING_SESSION,
    });
    expect(started).toMatchObject({ kind: 'started', run: { spendCeilingUsd: '2.000000' } });
    expect(asked).toEqual([EXISTING_SESSION]);
  });

  it('lets a trusted override lower it further, and stores none when nothing sets one', async () => {
    const lowered = await startRunOnSession(withLimit(2).env, PRINCIPAL, AGENT, {
      ...START,
      spendCeilingUsd: 1,
      limits: { maxBudgetUsd: 0.5 },
    });
    expect(lowered).toMatchObject({ kind: 'started', run: { spendCeilingUsd: '0.500000' } });
    const none = await startRunOnSession(withLimit(null).env, PRINCIPAL, AGENT, START);
    expect(none).toMatchObject({ kind: 'started', run: { spendCeilingUsd: null } });
  });

  it('reads spendCeilingUsd from the body and refuses a malformed one', () => {
    expect(parseStartRunBody({ prompt: 'hi', spendCeilingUsd: 0.5 })).toMatchObject({
      kind: 'ok',
      body: { spendCeilingUsd: 0.5 },
    });
    for (const spendCeilingUsd of [0, -1, '1', 0.0000001]) {
      expect(parseStartRunBody({ prompt: 'hi', spendCeilingUsd })).toMatchObject({
        kind: 'rejected',
      });
    }
  });
});

describe('startRunOnSession: an archived agent (#1851 slice 4)', () => {
  const ARCHIVED: AgentRef = { ...AGENT, archived: true };

  it('refuses 409 agent_archived before it opens a session or creates a run', async () => {
    const { env, sessions, store } = harness();
    const create = vi.spyOn(store, 'create');

    await expect(startRunOnSession(env, PRINCIPAL, ARCHIVED, START)).resolves.toMatchObject({
      kind: 'refused',
      status: 409,
      code: 'agent_archived',
    });
    expect(create).not.toHaveBeenCalled();
    expect([...sessions.keys()]).toEqual([EXISTING_SESSION]);
  });

  it('refuses a follow-up in an existing session too, and starts nothing', async () => {
    const { env, store } = harness();
    const create = vi.spyOn(store, 'create');

    await expect(
      startRunOnSession(env, PRINCIPAL, ARCHIVED, { ...START, sessionId: EXISTING_SESSION }),
    ).resolves.toMatchObject({ kind: 'refused', status: 409, code: 'agent_archived' });
    expect(create).not.toHaveBeenCalled();
  });

  it('names the archive before the daily cost cap', async () => {
    const { env } = harness();
    const capped: RunApiEnvironment = {
      ...env,
      dailyCostCap: { refusal: () => Promise.reject(new Error('ledger unreachable')) },
    };

    await expect(startRunOnSession(capped, PRINCIPAL, ARCHIVED, START)).resolves.toMatchObject({
      code: 'agent_archived',
    });
  });

  it('starts an agent without the archived mark', async () => {
    const { env } = harness();

    await expect(startRunOnSession(env, PRINCIPAL, AGENT, START)).resolves.toMatchObject({
      kind: 'started',
    });
  });
});

describe('startRunOnSession: the daily cost cap (#1851 slice 3)', () => {
  it('parses a policy with maxCostPerDayUsd: 5 and refuses a start once the workspace spent 5 USD today', async () => {
    expect(ProjectPolicySchema.parse({ maxCostPerDayUsd: 5 })).toEqual({ maxCostPerDayUsd: 5 });
    const { env, sessions, store } = harness();
    const create = vi.spyOn(store, 'create');
    const capped: RunApiEnvironment = {
      ...env,
      dailyCostCap: {
        refusal: () =>
          Promise.resolve({ capUsd: 5, spentUsd: 5, resetsAt: '2026-10-27T00:00:00.000Z' }),
      },
    };

    await expect(startRunOnSession(capped, PRINCIPAL, AGENT, START)).resolves.toMatchObject({
      kind: 'refused',
      status: 429,
      code: 'daily_cost_cap_reached',
      details: ['capUsd: 5', 'resetsAt: 2026-10-27T00:00:00.000Z'],
    });
    expect(create).not.toHaveBeenCalled();
    expect([...sessions.keys()]).toEqual([EXISTING_SESSION]);
  });

  it('starts the run unchanged while the workspace is under its cap', async () => {
    const { env, store } = harness();
    const create = vi.spyOn(store, 'create');
    const capped: RunApiEnvironment = {
      ...env,
      dailyCostCap: { refusal: () => Promise.resolve(null) },
    };

    await expect(startRunOnSession(capped, PRINCIPAL, AGENT, START)).resolves.toMatchObject({
      kind: 'started',
    });
    expect(create).toHaveBeenCalledOnce();
  });

  it('fails closed: a spend read that throws is a 503 daily_cost_unavailable with no internals, before any session or run exists', async () => {
    const { env, sessions, store } = harness();
    const create = vi.spyOn(store, 'create');
    const capped: RunApiEnvironment = {
      ...env,
      dailyCostCap: { refusal: () => Promise.reject(new Error('ledger unreachable')) },
    };

    const refusal = await startRunOnSession(capped, PRINCIPAL, AGENT, START);
    expect(refusal).toMatchObject({
      kind: 'refused',
      status: 503,
      code: 'daily_cost_unavailable',
    });
    expect(JSON.stringify(refusal)).not.toContain('ledger unreachable');
    await expect(
      startRunOnSession(capped, PRINCIPAL, AGENT, { ...START, sessionId: EXISTING_SESSION }),
    ).resolves.toMatchObject({ kind: 'refused', status: 503, code: 'daily_cost_unavailable' });
    expect(create).not.toHaveBeenCalled();
    expect([...sessions.keys()]).toEqual([EXISTING_SESSION]);
  });

  it('names unpriced usage in the refusal when the cap cannot be measured', async () => {
    const { env } = harness();
    const capped: RunApiEnvironment = {
      ...env,
      dailyCostCap: {
        refusal: () =>
          Promise.resolve({
            capUsd: 5,
            spentUsd: 0,
            resetsAt: '2026-10-27T00:00:00.000Z',
            unpricedUsage: true,
          }),
      },
    };
    await expect(startRunOnSession(capped, PRINCIPAL, AGENT, START)).resolves.toMatchObject({
      kind: 'refused',
      status: 429,
      code: 'daily_cost_cap_reached',
      details: ['capUsd: 5', 'resetsAt: 2026-10-27T00:00:00.000Z', 'unpricedUsage: true'],
    });
  });

  it('judges the workspace of the principal that starts the run', async () => {
    const { env } = harness();
    const asked: string[] = [];
    const capped: RunApiEnvironment = {
      ...env,
      dailyCostCap: {
        refusal: (workspaceId) => {
          asked.push(workspaceId);
          return Promise.resolve(null);
        },
      },
    };
    await startRunOnSession(capped, PRINCIPAL, AGENT, START);
    expect(asked).toEqual([WORKSPACE]);
  });
});

describe('startRunOnSession: a child run of a team lead (ADR-0104 acceptance, #1517)', () => {
  const LEAD = '88888888-8888-4888-8888-888888888888';
  const TEAM_VERSION = '99999999-9999-4999-8999-999999999999';

  it('writes parent_run_id and the team version on insert, and they are read back', async () => {
    const { env, store } = harness();
    const lead = await startRunOnSession(env, PRINCIPAL, AGENT, {
      ...START,
      agentTeamVersionId: TEAM_VERSION,
    });
    if (lead.kind !== 'started') throw new Error(lead.code);
    expect((await store.get(lead.run.id))?.agentTeamVersionId).toBe(TEAM_VERSION);
    expect(await store.markRunning(lead.run.id)).toBe(true);
    const child = await startRunOnSession(env, PRINCIPAL, AGENT, {
      ...START,
      parent: { runId: lead.run.id, maxChildren: 16 },
    });
    if (child.kind !== 'started') throw new Error(child.code);
    expect((await store.get(child.run.id))?.parentRunId).toBe(lead.run.id);
    expect((await store.get(child.run.id))?.agentTeamVersionId).toBeNull();
    expect((await store.get(lead.run.id))?.parentRunId).toBeNull();
  });

  /** A root run that is `running`, as a lead whose member calls start children is. */
  async function runningLead(env: RunApiEnvironment, store: InMemoryRunStore): Promise<string> {
    const lead = await startRunOnSession(env, PRINCIPAL, AGENT, START);
    if (lead.kind !== 'started') throw new Error(lead.code);
    expect(await store.markRunning(lead.run.id)).toBe(true);
    return lead.run.id;
  }

  it('refuses a child of a lead that is no longer running with parent_run_stopped', async () => {
    const { env, store, sessions } = harness();
    const leadId = await runningLead(env, store);
    await store.finish(leadId, 'cancelled', null);
    const before = sessions.size;
    await expect(
      startRunOnSession(env, PRINCIPAL, AGENT, {
        ...START,
        parent: { runId: leadId, maxChildren: 16 },
      }),
    ).resolves.toMatchObject({ kind: 'refused', status: 409, code: 'parent_run_stopped' });
    expect(sessions.size).toBe(before);
    await expect(store.listChildren(WORKSPACE, leadId, 16)).resolves.toEqual([]);
  });

  it('refuses the start over the fan-out limit with team_member_limit, leaving no session', async () => {
    const { env, store, sessions } = harness();
    const parent = { runId: await runningLead(env, store), maxChildren: 1 };
    const first = await startRunOnSession(env, PRINCIPAL, AGENT, { ...START, parent });
    expect(first.kind).toBe('started');
    const before = sessions.size;
    await expect(
      startRunOnSession(env, PRINCIPAL, AGENT, { ...START, parent }),
    ).resolves.toMatchObject({ kind: 'refused', code: 'team_member_limit' });
    expect(sessions.size).toBe(before);
  });

  it('is refused from a request body: parseStartRunBody rejects every tree field', () => {
    for (const field of ['parent', 'parentRunId', 'agentTeamVersionId']) {
      expect(parseStartRunBody({ prompt: 'hi', [field]: LEAD })).toEqual({
        kind: 'rejected',
        reason: `unknown field ${JSON.stringify(field)} in the request body`,
      });
    }
  });
});
