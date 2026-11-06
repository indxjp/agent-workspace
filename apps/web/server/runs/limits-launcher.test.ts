/**
 * A run's lower-only limits override reaches the request the runner is sent (#1963, SPD-01/02).
 *
 * The real launcher runs over the in-memory run store and the real composer builds the request
 * (`buildRunRequestFor`); only the runner's HTTP end is a stub that records the body it was posted.
 * Nothing between the start call and that body is a fixture, so a launch path that drops the
 * override (an approval continuation is built from the stored row alone) fails here.
 */
import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import type { AgentPolicy } from '../../contracts/agents';
import type { RunAgent } from '../agent-versions/session-version';
import { buildRunRequestFor } from '../compose/run-request';
import { afterEach, describe, expect, it } from 'vitest';

import { decideRunApproval } from './approval';
import type { AgentRef, LaunchContext, RunApiEnvironment, RunPrincipal } from './environment';
import { createRunnerLauncher } from './launcher';
import { InMemoryRunStore } from './memory-store';
import { startRunOnSession } from './service';
import type { ApprovalCall } from './store';
import { installTestRunApi, resetTestRunApi } from '../application-context-fixtures';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const SESSION = '44444444-4444-4444-8444-444444444444';
const CONNECTION = '88888888-8888-4888-8888-888888888888';
const CALL: ApprovalCall = { toolName: 'send_email', canonicalCall: '{"to":"a@b.c"}' };
const PRINCIPAL: RunPrincipal = {
  principalId: '77777777-7777-4777-8777-777777777777',
  ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
  userId: '66666666-6666-4666-8666-666666666666',
  workspaceId: WORKSPACE,
  role: 'owner',
  scope: null,
};

afterEach(() => resetTestRunApi());

interface Limits {
  readonly maxTurns: number | null;
  readonly maxBudgetUsd: number | null;
}

async function world(policyLimits: Limits) {
  const agents = createInMemoryAgentStoreProvider();
  const created = await agents.forWorkspace(WORKSPACE).create(
    {
      name: 'General',
      instructions: '',
      modelConnectionId: CONNECTION,
      model: null,
      permissions: {
        readFiles: false,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    },
    { principalId: PRINCIPAL.principalId, userId: PRINCIPAL.userId },
  );
  if (created.kind !== 'created') throw new Error(created.kind);
  const policy: AgentPolicy = {
    engine: 'claude-agent-sdk',
    tools: {
      base: 'claude_code_preset',
      autoApprove: [],
      deny: [],
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
    },
    skills: { mode: 'all' },
    limits: policyLimits,
  };
  await agents.forWorkspace(WORKSPACE).replacePolicy(created.agent.id, policy);
  const agentRef: AgentRef = {
    id: created.agent.id,
    workspaceId: WORKSPACE,
    engine: 'claude-agent-sdk',
  };

  const store = new InMemoryRunStore();
  /** The `portable.limits` of each request the runner was posted, in order. */
  const posted: Limits[] = [];
  const launch = createRunnerLauncher({
    store,
    runtime: {
      resolve: () =>
        Promise.resolve({
          runtimeProfileId: 'profile-local',
          driver: 'local',
          networkPolicy: 'none',
          filesystem: 'read-write',
          persistPaths: [],
          runnerUrl: 'http://runtime:8080',
          workspaceRoot: '/workspace',
          fileTransfer: 'local-disk',
        }),
    },
    buildRunRequest: async (context: LaunchContext) => {
      const agent = await agents.forWorkspace(WORKSPACE).get(context.agent.id);
      if (agent === null) throw new Error('the agent vanished');
      const runAgent: RunAgent = {
        agent,
        assignments: { files: [], skillIds: [], connectorIds: [], storageGrants: [] },
        toolBundles: [],
        subagents: [],
      };
      return buildRunRequestFor(
        context,
        runAgent,
        { runnerUrl: 'http://runner:8080', workspaceRoot: '/workspace' },
        { baseUrl: 'http://gateway:4000', issue: () => Promise.resolve('run-token') },
        {},
      );
    },
    workspaceLifecycle: {
      inputArchive: () => Promise.resolve(null),
      promoteOutputs: () => Promise.resolve(),
    },
    fetch: (_input, init) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        portable?: { limits?: Limits };
      };
      if (body.portable?.limits !== undefined) posted.push(body.portable.limits);
      return Promise.resolve(
        new Response('event: run-done\ndata: {}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );
    },
  });
  const env: RunApiEnvironment = {
    authenticate: () => Promise.resolve(PRINCIPAL),
    findAgent: () => Promise.resolve(agentRef),
    openSession: (_principal, agent) =>
      Promise.resolve({ id: SESSION, agentId: agent.id, engine: null }),
    ownsRun: () => Promise.resolve(true),
    store,
    launch,
  };
  installTestRunApi(env);

  async function settled(runId: string): Promise<void> {
    for (let i = 0; i < 400; i += 1) {
      if ((await store.get(runId))?.endedAt != null) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('the run never reached a terminal status');
  }
  async function waitForPost(): Promise<void> {
    for (let i = 0; i < 400 && posted.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  return { agentRef, env, store, posted, settled, waitForPost };
}

const START = { prompt: 'hello', sessionId: null, modelOverride: null } as const;

describe('a run started under a lower-only limits override', () => {
  it('composes the request at the override when it is below the agent policy', async () => {
    const { agentRef, env, posted, settled } = await world({ maxTurns: 20, maxBudgetUsd: 1 });
    const started = await startRunOnSession(env, PRINCIPAL, agentRef, {
      ...START,
      limits: { maxBudgetUsd: 0.3 },
    });
    if (started.kind !== 'started') throw new Error('start refused');
    await settled(started.run.id);
    expect(posted).toEqual([{ maxTurns: 20, maxBudgetUsd: 0.3 }]);
  });

  it("builds the request from the stored row alone: the launch context's own copy is not what carries the cap", async () => {
    const { agentRef, env, store, posted, settled } = await world({
      maxTurns: null,
      maxBudgetUsd: null,
    });
    const started = await startRunOnSession(
      { ...env, launch: () => undefined },
      PRINCIPAL,
      agentRef,
      { ...START, limits: { maxBudgetUsd: 0.3 } },
    );
    if (started.kind !== 'started') throw new Error('start refused');
    const stored = await store.get(started.run.id);
    if (stored === null) throw new Error('the run vanished');
    // What a resume or a requeue has: the row, and no `limits` in the context.
    env.launch({
      run: stored,
      agent: agentRef,
      session: started.session,
      principal: PRINCIPAL,
      prompt: 'hello',
    });
    await settled(started.run.id);
    expect(posted).toEqual([{ maxTurns: null, maxBudgetUsd: 0.3 }]);
  });

  async function pause(
    world_: Awaited<ReturnType<typeof world>>,
    limits?: { maxBudgetUsd: number },
  ) {
    const { agentRef, env, store } = world_;
    const first = await startRunOnSession(
      { ...env, launch: () => undefined },
      PRINCIPAL,
      agentRef,
      { ...START, ...(limits === undefined ? {} : { limits }) },
    );
    if (first.kind !== 'started') throw new Error('start refused');
    await store.markRunning(first.run.id);
    await store.awaitApproval(first.run.id, CALL);
    return first.run.id;
  }

  async function approve(runId: string): Promise<void> {
    const response = await decideRunApproval(
      new Request(`http://web/api/runs/${runId}/approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-user': '1' },
        body: JSON.stringify({ decision: 'approve' }),
      }),
      runId,
    );
    expect(response.status).toBe(202);
  }

  it('keeps maxBudgetUsd 0.30 across an approval continuation', async () => {
    const w = await world({ maxTurns: null, maxBudgetUsd: null });
    const pausedId = await pause(w, { maxBudgetUsd: 0.3 });
    await approve(pausedId);
    await w.waitForPost();
    expect(w.posted).toEqual([{ maxTurns: null, maxBudgetUsd: 0.3 }]);
  });

  it('lets a lower policy budget win over the carried cap', async () => {
    const w = await world({ maxTurns: null, maxBudgetUsd: 0.1 });
    const pausedId = await pause(w, { maxBudgetUsd: 0.3 });
    await approve(pausedId);
    await w.waitForPost();
    expect(w.posted).toEqual([{ maxTurns: null, maxBudgetUsd: 0.1 }]);
  });
});
