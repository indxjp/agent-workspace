import crypto from 'node:crypto';

import {
  agents as agentRows,
  createDatabaseAgentRepositoryProvider,
  createDatabaseAgentVersionEvaluationRepositoryProvider,
  createDatabaseAgentVersionRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { AgentVersionBodySchema } from '@indx-workspace/contracts/agent-versions';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { lowerLimits } from '../../../compose/run-request';
import { createInMemoryAgentVersionStoreProvider } from '../../../agent-versions/memory-store';
import {
  createRepositoryAgentVersionStoreProvider,
  type AgentVersionStoreProvider,
} from '../../../agent-versions/store';
import { createInMemoryAgentStoreProvider } from '../../../agents/memory-store';
import { createRepositoryAgentStoreProvider, type AgentStoreProvider } from '../../../agents/store';
import { ORDER_STATUS_FRAMES } from '../../../evaluations/fixtures';
import type { RunApiEnvironment, RunPrincipal } from '../../../runs/environment';
import { InMemoryRunStore } from '../../../runs/memory-store';
import { startRunOnSession } from '../../../runs/service';
import type { RunRecord } from '../../../runs/store';
import { callContextOf } from '../../testing/context';
import { draftBody } from '../checker/checker.contract';
import { createAgentStore } from '../store/production';
import { MemoryRunner } from './memory';
import { BUILDER_TRIAL_KEY_PREFIX, createRunner } from './production';
import {
  describeRunnerConformance,
  describeTrialConformance,
  LONG_ANSWER,
  ORDER_CASE,
  POLICY_BUDGET_USD,
  type RunnerFixture,
} from './runner.contract';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

/** The memory adapter has no saved version: it reports the agent policy's budget lowered by the override. */
const budgetUnder = (overrideUsd: number | undefined) =>
  lowerLimits(
    { maxTurns: null, maxBudgetUsd: POLICY_BUDGET_USD },
    overrideUsd === undefined ? undefined : { maxBudgetUsd: overrideUsd },
  ).maxBudgetUsd;

/** The stored limits of the version a run is pinned to, or `null` when that run is pinned to none. */
type VersionLimits = (
  agentId: string,
  versionId: string | null,
) => Promise<ReturnType<typeof lowerLimits> | null>;

/**
 * A run API whose every run answers the order-status frames and ends; `started` counts the runs
 * launched, and `last` holds what the last one was started with and the budget it ran under: the
 * limits of the saved version it is pinned to (`limitsOf`), lowered by the start's override.
 */
function fakeRunApi(limitsOf: VersionLimits = () => Promise.resolve(null), interruptible = true) {
  const store = new InMemoryRunStore();
  const counter: {
    started: number;
    last?: {
      versionId: string | null;
      overrideUsd?: number;
      maxBudgetUsd: number | null;
    };
  } = { started: 0 };
  const runs: RunApiEnvironment = {
    authenticate: () => Promise.resolve(null),
    findAgent: (principal, id) =>
      Promise.resolve({ id, workspaceId: principal.workspaceId, engine: 'claude-agent-sdk' }),
    openSession: (_principal, agent, _requested, agentVersionId) =>
      Promise.resolve({
        id: crypto.randomUUID(),
        agentId: agent.id,
        engine: null,
        agentVersionId: agentVersionId ?? null,
      }),
    ownsRun: () => Promise.resolve(true),
    store,
    // What a trial's stop does: the run is cancelled, as the real interrupt writes it.
    ...(interruptible
      ? {
          interruptRun: async (_principal: RunPrincipal, run: RunRecord) => {
            await store.finish(run.id, 'cancelled', null);
          },
        }
      : {}),
    launch: ({ run, session, limits }) => {
      counter.started += 1;
      void (async () => {
        const versionId = session.agentVersionId ?? null;
        const stored = await limitsOf(session.agentId, versionId);
        counter.last = {
          versionId,
          ...(limits?.maxBudgetUsd === undefined ? {} : { overrideUsd: limits.maxBudgetUsd }),
          maxBudgetUsd: stored === null ? null : lowerLimits(stored, limits).maxBudgetUsd,
        };
        for (const frame of ORDER_STATUS_FRAMES) {
          await store.append(run.id, { type: frame.frame, data: frame });
        }
        await store.finish(run.id, 'completed', null, true, {
          text: LONG_ANSWER,
          structured: null,
        });
      })();
    },
    recordEvaluation: () => Promise.resolve({ id: crypto.randomUUID(), createdAt: new Date() }),
  };
  return { runs, counter };
}

/** The production adapter over `agents` and `versions`, with a builder who has saved the agent under test. */
async function productionFixture(
  agents: AgentStoreProvider,
  versions: AgentVersionStoreProvider,
  person: { workspaceId: string; otherWorkspaceId: string; principalId: string },
  markBuiltin: RunnerFixture['markBuiltin'],
): Promise<RunnerFixture> {
  const { workspaceId, otherWorkspaceId, principalId } = person;
  const ctx = callContextOf(workspaceId, 'builder', principalId);
  const draft = draftBody(`runner-${crypto.randomUUID().slice(0, 8)}`);
  const saved = await createAgentStore({
    agents,
    versions,
    pipeline: () => ({}),
    actorLabel: (_workspaceId, id) => Promise.resolve(`${id}@example.test`),
  }).save(ctx, {
    body: {
      ...draft,
      definition: {
        ...draft.definition,
        policy: {
          ...draft.definition.policy,
          limits: { maxTurns: null, maxBudgetUsd: POLICY_BUDGET_USD },
        },
      },
    },
  });
  if (!saved.ok) throw new Error(`the fixture agent was not saved: ${saved.code}`);
  const savedVersion = await (
    await versions.forWorkspace(workspaceId)
  )?.find(saved.agentId, saved.version);
  const { runs, counter } = fakeRunApi(async (agentId, versionId) => {
    const stored = await (await versions.forWorkspace(workspaceId))?.find(agentId, saved.version);
    return stored?.id === versionId
      ? AgentVersionBodySchema.parse(stored.body).definition.policy.limits
      : null;
  });
  return {
    port: createRunner({ agents, versions, runApi: () => runs }),
    ctx,
    viewer: callContextOf(workspaceId, 'viewer'),
    admin: callContextOf(workspaceId, 'admin'),
    noCaller: callContextOf(workspaceId, null),
    otherOwner: callContextOf(workspaceId, 'builder'),
    otherWorkspace: callContextOf(otherWorkspaceId, 'builder', principalId),
    agentId: saved.agentId,
    version: saved.version,
    started: () => counter.started,
    markBuiltin,
    lastRun: () =>
      counter.last === undefined
        ? undefined
        : {
            version: counter.last.versionId === savedVersion?.id ? saved.version : null,
            overrideUsd: counter.last.overrideUsd,
            maxBudgetUsd: counter.last.maxBudgetUsd,
          },
  };
}

function memoryFixture(): RunnerFixture {
  const runner = new MemoryRunner();
  runner.answer = LONG_ANSWER;
  const workspaceId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  runner.seedAgent(workspaceId, agentId, principalId, 1);
  return {
    port: runner,
    ctx: callContextOf(workspaceId, 'builder', principalId),
    viewer: callContextOf(workspaceId, 'viewer'),
    admin: callContextOf(workspaceId, 'admin'),
    noCaller: callContextOf(workspaceId, null),
    otherOwner: callContextOf(workspaceId, 'builder'),
    otherWorkspace: callContextOf(crypto.randomUUID(), 'builder', principalId),
    agentId,
    version: 1,
    started: () => runner.started,
    markBuiltin: (id) => Promise.resolve(runner.markBuiltin(workspaceId, id)),
    lastRun: () =>
      runner.last === undefined
        ? undefined
        : { ...runner.last, maxBudgetUsd: budgetUnder(runner.last.overrideUsd) },
  };
}

describeRunnerConformance('the memory adapter', () => Promise.resolve(memoryFixture()));
describeTrialConformance('the memory adapter', () => Promise.resolve(memoryFixture()));

/** The in-memory agent store has no built-in rows; the adapter only reads the marker off what `get` returns. */
function inMemoryFixture(): Promise<RunnerFixture> {
  const stored = createInMemoryAgentStoreProvider();
  const versions = createInMemoryAgentVersionStoreProvider({ agents: stored });
  const builtinIds = new Set<string>();
  const agents: AgentStoreProvider = {
    forWorkspace: (id) => {
      const bound = stored.forWorkspace(id);
      return {
        ...bound,
        get: async (agentId) => {
          const agent = await bound.get(agentId);
          return agent !== null && builtinIds.has(agentId)
            ? { ...agent, builtin: 'builder' }
            : agent;
        },
      };
    },
  };
  return productionFixture(
    agents,
    versions,
    {
      workspaceId: crypto.randomUUID(),
      otherWorkspaceId: crypto.randomUUID(),
      principalId: crypto.randomUUID(),
    },
    (agentId) => Promise.resolve(void builtinIds.add(agentId)),
  );
}

describeRunnerConformance('the production adapter over in-memory stores', inMemoryFixture);
describeTrialConformance('the production adapter over in-memory stores', inMemoryFixture);

describe('the production runner without a run API', () => {
  it('rejects with only the status, so the handler’s text never reaches the model', async () => {
    const agents = createInMemoryAgentStoreProvider();
    const versions = createInMemoryAgentVersionStoreProvider({ agents });
    const { ctx, agentId, version } = await productionFixture(
      agents,
      versions,
      {
        workspaceId: crypto.randomUUID(),
        otherWorkspaceId: crypto.randomUUID(),
        principalId: crypto.randomUUID(),
      },
      () => Promise.resolve(),
    );
    const port = createRunner({ agents, versions, runApi: () => null });
    await expect(port.evaluate(ctx, agentId, version, [ORDER_CASE])).rejects.toThrow(
      /^The evaluations handler answered 503\.$/,
    );
    await expect(port.trial(ctx, agentId, version, 'hi', 0.1, 'k')).rejects.toThrow(
      /^The run API is not configured\.$/,
    );
  });
});

/** A production runner over in-memory stores whose run API is `runApi(base)`, with a builder who saved an agent. */
async function runnerOver(
  runApi: (base: RunApiEnvironment) => RunApiEnvironment,
  { interruptible = true } = {},
) {
  const agents = createInMemoryAgentStoreProvider();
  const versions = createInMemoryAgentVersionStoreProvider({ agents });
  const { ctx, agentId, version } = await productionFixture(
    agents,
    versions,
    {
      workspaceId: crypto.randomUUID(),
      otherWorkspaceId: crypto.randomUUID(),
      principalId: crypto.randomUUID(),
    },
    () => Promise.resolve(),
  );
  const { runs, counter } = fakeRunApi(undefined, interruptible);
  const api = runApi(runs);
  return {
    port: createRunner({ agents, versions, runApi: () => api }),
    ctx,
    agentId,
    version,
    api,
    counter,
  };
}

/** A run API whose runs start, then wait on an approval nobody here will give. */
const pausing = (base: RunApiEnvironment): RunApiEnvironment => ({
  ...base,
  launch: ({ run }) => {
    void (async () => {
      await base.store.markRunning(run.id);
      await base.store.awaitApproval(run.id, { toolName: 'orders_refund', canonicalCall: '{}' });
    })();
  },
});

describe('a production trial paused for an approval', () => {
  it('is interrupted before the trial answers, so no approval can continue it past the cap', async () => {
    const { port, ctx, agentId, version, api } = await runnerOver((base) => ({
      ...pausing(base),
      interruptRun: async (_principal, run) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        await base.store.finish(run.id, 'cancelled', null);
      },
    }));
    const result = await port.trial(ctx, agentId, version, 'Refund order 1042', 0.1, 'paused');
    if (!result.ok) throw new Error(`the trial was refused: ${result.code}`);
    expect(result.status).toBe('cancelled');
    expect((await api.store.get(result.runId))?.status).toBe('cancelled');
  });

  it('is refused as trial_not_stopped when the interrupt fails', async () => {
    const { port, ctx, agentId, version } = await runnerOver((base) => ({
      ...pausing(base),
      interruptRun: () => Promise.reject(new Error('the runtime is unreachable')),
    }));
    const result = await port.trial(ctx, agentId, version, 'Refund order 1042', 0.1, 'stuck');
    expect(result).toMatchObject({ ok: false, code: 'trial_not_stopped' });
    expect(JSON.stringify(result)).not.toContain('unreachable');
  });

  it('is refused as trial_not_stopped when the run is not terminal after the interrupt', async () => {
    const { port, ctx, agentId, version } = await runnerOver((base) => ({
      ...pausing(base),
      interruptRun: () => Promise.resolve(),
    }));
    expect(
      await port.trial(ctx, agentId, version, 'Refund order 1042', 0.1, 'unstopped'),
    ).toMatchObject({ ok: false, code: 'trial_not_stopped' });
  });

  it('starts nothing when the run API cannot interrupt a run', async () => {
    const { port, ctx, agentId, version, counter } = await runnerOver((base) => base, {
      interruptible: false,
    });
    await expect(
      port.trial(ctx, agentId, version, 'hi', 0.1, 'no-interrupt'),
    ).resolves.toMatchObject({
      ok: false,
      code: 'trial_not_stopped',
    });
    expect(counter.started).toBe(0);
  });
});

describe('a production trial’s idempotency key', () => {
  it('lives apart from the run route’s keys, so a run-route key of the same principal never conflicts with it or replays for it', async () => {
    const { port, ctx, agentId, version, api, counter } = await runnerOver((base) => base);
    if (ctx.caller.kind !== 'person') throw new Error('the fixture has a person');
    const { principal } = ctx.caller;
    const target = await api.findAgent(
      { ...principal, workspaceId: ctx.workspaceId, scope: null },
      agentId,
    );
    if (target === null) throw new Error('the fixture agent is missing');
    const routeStart = await startRunOnSession(
      api,
      { ...principal, workspaceId: ctx.workspaceId, scope: null },
      target,
      {
        prompt: 'Started by the run route',
        sessionId: null,
        modelOverride: null,
        idempotency: { principalId: principal.principalId, key: 'same-key', requestHash: 'route' },
      },
    );
    if (routeStart.kind === 'refused') throw new Error('the route start was refused');

    const trial = await port.trial(ctx, agentId, version, 'A trial', 0.1, 'same-key');

    if (!trial.ok) throw new Error(`the trial was refused: ${trial.code}`);
    expect(trial.runId).not.toBe(routeStart.run.id);
    expect(counter.started).toBe(2);
    const stored = (key: string) =>
      api.store.findByIdempotencyKey(ctx.workspaceId, principal.principalId, key);
    expect((await stored('same-key'))?.run.id).toBe(routeStart.run.id);
    expect((await stored(`${BUILDER_TRIAL_KEY_PREFIX}same-key`))?.run.id).toBe(trial.runId);
  });

  it('carries a character no Idempotency-Key header can hold, so the run route cannot send it', () => {
    expect(() => new Headers({ 'idempotency-key': `${BUILDER_TRIAL_KEY_PREFIX}k` })).toThrow();
  });
});

describe.skipIf(!hasDatabase)('RunnerPort on PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceId = crypto.randomUUID();
  const otherWorkspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_builder_runner');
    await isolated.db.insert(workspaces).values([
      { id: workspaceId, slug: 'runner', name: 'Runner' },
      { id: otherWorkspaceId, slug: 'other', name: 'Other' },
    ]);
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: 'M' });
    await isolated.db.transaction(async (tx) => {
      await tx
        .insert(memberships)
        .values({ id: membershipId, workspaceId, userId, role: 'builder' });
      await tx
        .insert(workspacePrincipals)
        .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
    });
  }, 180_000);

  afterAll(async () => isolated.close());

  function postgresFixture(): Promise<RunnerFixture> {
    const scopes = createDatabaseWorkspaceScopeResolver(isolated.db);
    const agents = createRepositoryAgentStoreProvider({
      repositories: createDatabaseAgentRepositoryProvider(isolated.db),
      scopes,
    });
    const versions = createRepositoryAgentVersionStoreProvider({
      repositories: createDatabaseAgentVersionRepositoryProvider(isolated.db),
      evaluations: createDatabaseAgentVersionEvaluationRepositoryProvider(isolated.db),
      scopes,
    });
    return productionFixture(
      agents,
      versions,
      { workspaceId, otherWorkspaceId, principalId },
      async (agentId) => {
        await isolated.db
          .update(agentRows)
          .set({ builtinKey: 'builder' })
          .where(eq(agentRows.id, agentId));
      },
    );
  }

  describeRunnerConformance('the production adapter over PostgreSQL', postgresFixture);
  describeTrialConformance('the production adapter over PostgreSQL', postgresFixture);
});
