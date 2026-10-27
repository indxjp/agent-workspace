/**
 * Who may start a run of the built-in Builder (#1848, slice 1b): every human member of the
 * workspace, through the real run-start route and the real agents runtime.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { clearApplicationContext } from '../application-context';
import {
  installTestDomains,
  installTestRunApi,
  resetTestRunApi,
} from '../application-context-fixtures';
import { versionRequest } from '../agent-versions/fixtures';
import { createInMemoryAgentVersionStoreProvider } from '../agent-versions/memory-store';
import { ensureBuilderAgent } from '../builder/agent/provision';
import type { AgentRef, RunApiEnvironment, RunPrincipal } from '../runs/environment';
import { createRunPreflight } from '../compose/run-preflight';
import { createInMemoryModelsStoreProvider } from '../models/memory-store';
import { decide } from '../rbac/decide';
import { createInMemoryRuntimeProfileStoreProvider } from '../runtimes/memory-store';
import { startRun } from '../runs/api';
import { InMemoryRunStore } from '../runs/memory-store';
import { createInMemoryAgentStoreProvider } from './memory-store';
import type { AgentStoreProvider } from './store';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const OWNER_PRINCIPAL = '77777777-7777-4777-8777-777777777777';
const VIEWER_PRINCIPAL = '88888888-8888-4888-8888-888888888888';
const LATER_MEMBER = '99999999-9999-4999-8999-999999999999';
const BUILDER_PATH_ID = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';

const PERMISSIONS = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};

function member(role: NonNullable<RunPrincipal['role']>, id: string): RunPrincipal {
  return {
    principalId: id,
    ownerPrincipalId: id,
    userId: id,
    workspaceId: WORKSPACE,
    role,
    scope: null,
  };
}
const viewer = member('viewer', VIEWER_PRINCIPAL);

/** The memory agent store keeps no built-in marker (PostgreSQL does); mark the row named `builder`. */
function markBuilder(memory: AgentStoreProvider): AgentStoreProvider {
  const mark = <T extends { readonly name: string }>(row: T) =>
    row.name === 'builder' ? { ...row, builtin: 'builder' as const } : row;
  return {
    forWorkspace: (id) => {
      const store = memory.forWorkspace(id);
      return {
        ...store,
        list: async () => (await store.list()).map(mark),
        get: async (agentId) => {
          const row = await store.get(agentId);
          return row === null ? null : mark(row);
        },
      };
    },
  };
}

async function provisionBuilder(agents: AgentStoreProvider): Promise<string> {
  const outcome = await ensureBuilderAgent(WORKSPACE, {
    shippedBody: versionRequest({ name: 'builder', instructions: 'Build.' }).body,
    owner: {
      principalId: OWNER_PRINCIPAL,
      ownerPrincipalId: OWNER_PRINCIPAL,
      userId: null,
      actorLabel: 'platform',
    },
    agents,
    versions: createInMemoryAgentVersionStoreProvider({ agents }),
  });
  if (outcome.kind !== 'created') throw new Error(`fixture setup failed: ${outcome.kind}`);
  return outcome.agentId;
}

function runApi(
  principal: RunPrincipal,
  agentIds: readonly string[],
  preflight?: RunApiEnvironment['preflight'],
): InMemoryRunStore {
  const store = new InMemoryRunStore();
  const environment: RunApiEnvironment = {
    authenticate: () => Promise.resolve(principal),
    findAgent: (p, id): Promise<AgentRef | null> =>
      Promise.resolve(
        agentIds.includes(id)
          ? { id, workspaceId: p.workspaceId, engine: 'claude-agent-sdk' }
          : null,
      ),
    openSession: (_p, agent) => Promise.resolve({ id: SESSION, agentId: agent.id, engine: null }),
    ownsRun: () => Promise.resolve(true),
    store,
    launch: () => undefined,
    ...(preflight === undefined ? {} : { preflight }),
  };
  installTestRunApi(environment);
  return store;
}

function post(agentId: string): Request {
  return new Request(`http://web/api/agents/${agentId}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'hi' }),
  });
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? '(none)';
}

afterEach(() => {
  resetTestRunApi();
  clearApplicationContext();
});

async function setUp(): Promise<{
  readonly agents: AgentStoreProvider;
  readonly builderId: string;
}> {
  const agents = markBuilder(createInMemoryAgentStoreProvider());
  installTestDomains({
    agents: {
      agents,
      resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE }),
    },
  });
  return { agents, builderId: await provisionBuilder(agents) };
}

describe('starting a run of the built-in Builder', () => {
  it('a Viewer can start a Builder run', async () => {
    const { builderId } = await setUp();
    runApi(viewer, [builderId]);

    const response = await startRun(post(builderId), builderId);

    expect(response.status, await response.clone().text()).toBe(202);
  });

  it('lets an Admin and a Builder-role member start a Builder run too', async () => {
    const { builderId } = await setUp();
    for (const role of ['admin', 'builder'] as const) {
      runApi(member(role, VIEWER_PRINCIPAL), [builderId]);
      const response = await startRun(post(builderId), builderId);
      expect(response.status, role).toBe(202);
    }
  });

  it('lets a member added after provisioning start a Builder run', async () => {
    const { builderId } = await setUp();
    runApi(member('viewer', LATER_MEMBER), [builderId]);

    const response = await startRun(post(builderId), builderId);

    expect(response.status, await response.clone().text()).toBe(202);
  });

  it('still refuses a Viewer another member’s agent, and a person-less caller the Builder', async () => {
    const { agents, builderId } = await setUp();
    const created = await agents.forWorkspace(WORKSPACE).create(
      {
        name: 'Support',
        instructions: '',
        modelConnectionId: null,
        model: null,
        permissions: PERMISSIONS,
      },
      { principalId: OWNER_PRINCIPAL, userId: null },
    );
    if (created.kind !== 'created') throw new Error(`fixture setup failed: ${created.kind}`);
    const privateId = created.agent.id;

    runApi(viewer, [builderId, privateId]);
    expect((await startRun(post(privateId), privateId)).status).toBe(403);

    runApi({ ...member('viewer', VIEWER_PRINCIPAL), userId: null }, [builderId]);
    expect((await startRun(post(builderId), builderId)).status).toBe(403);
  });

  it('never lets the run grant widen an edit of the Builder', () => {
    const editRoutes = [
      ['PATCH', `/api/agents/${BUILDER_PATH_ID}`],
      ['DELETE', `/api/agents/${BUILDER_PATH_ID}`],
      ['POST', `/api/agents/${BUILDER_PATH_ID}/versions`],
    ] as const;
    for (const role of ['viewer', 'builder'] as const) {
      for (const [method, path] of editRoutes) {
        const decision = decide({ role, method, path, ownership: 'permitted', scope: null });
        expect(decision.effect, `${role} ${method} ${path}`).toBe('deny');
      }
    }
  });

  it('refuses with builder_model_unavailable (503) before any run row exists when no connection serves the model', async () => {
    const { agents, builderId } = await setUp();
    const profiles = createInMemoryRuntimeProfileStoreProvider();
    const profile = await profiles.forWorkspace(WORKSPACE).create({
      name: 'docker default',
      driver: 'docker',
      runtimeConnectionId: null,
      cpu: null,
      memoryMb: null,
      diskMb: null,
      networkPolicy: 'open',
      allowedDomains: null,
      filesystem: 'read-write',
      persistPaths: null,
      timeoutSeconds: null,
      idleTimeoutSeconds: null,
      driverConfig: null,
    });
    if (profile.kind !== 'created') throw new Error('fixture profile');
    const preflight = createRunPreflight({
      // The Builder row as provisioned names no runtime profile; give it the fixture's.
      agents: {
        forWorkspace: (id) => ({
          ...agents.forWorkspace(id),
          get: async (agentId) => {
            const row = await agents.forWorkspace(id).get(agentId);
            return row === null ? null : { ...row, runtimeProfileId: profile.profile.id };
          },
        }),
      },
      profiles,
      models: {
        models: createInMemoryModelsStoreProvider([WORKSPACE]),
        discover: () => Promise.resolve({ ok: true, stale: false, models: [] }),
      },
      workspaceDefault: () => Promise.resolve(null),
      projectDefault: () => Promise.resolve(null),
      projectDefaults: () => Promise.resolve(new Map()),
      deploymentDefaultModels: {},
      policyCeiling: null,
    });
    const store = runApi(viewer, [builderId], (principal, agent, sessionId, modelOverride) =>
      preflight.check({
        workspaceId: principal.workspaceId,
        agentId: agent.id,
        sessionId,
        modelOverride,
      }),
    );

    const response = await startRun(post(builderId), builderId);

    expect(response.status, await response.clone().text()).toBe(503);
    expect(await errorCode(response)).toBe('builder_model_unavailable');
    expect((await store.listRuns(WORKSPACE, { limit: 10 })).items).toEqual([]);
  });
});
