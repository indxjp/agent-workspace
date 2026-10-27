import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentVersionResourceSchema } from '@indx-workspace/contracts/agent-versions';
import { EvaluationResourceSchema } from '@indx-workspace/contracts/evaluations';

import { POST } from './route';
import { createInMemoryAgentStoreProvider } from '../../../../../server/agents/memory-store';
import { type WorkspaceResolution } from '../../../../../server/agents/runtime';
import { FIXTURE_PERMISSIONS, versionRequest } from '../../../../../server/agent-versions/fixtures';
import { createAgentVersion } from '../../../../../server/agent-versions/handlers';
import { createInMemoryAgentVersionStoreProvider } from '../../../../../server/agent-versions/memory-store';
import { setAgentPointer } from '../../../../../server/agent-versions/pointers';
import { clearApplicationContext } from '../../../../../server/application-context';
import {
  installTestDomains,
  installTestRunApi,
  resetTestRunApi,
} from '../../../../../server/application-context-fixtures';
import { assistantSays } from '../../../../../server/evaluations/fixtures';
import { createMemoryDirectory } from '../../../../../server/rbac/memory-directory';
import { Principal } from '../../../../../server/rbac/principal';
import { InMemoryRunStore } from '../../../../../server/runs/memory-store';

/**
 * `POST /api/agents/:id/evaluations` (issue #618) through `serveAgentVersionRoute`, driven with
 * real `Request` objects. RBAC is real: `decide()` answers `403 forbidden` for a Viewer and for a
 * Builder on another principal's agent before any case runs. The scoring itself is
 * `server/evaluations/handlers.test.ts`'s.
 */
const WORKSPACE = '66666666-6666-4666-8666-666666666666';
const WORKSPACE_HEADER = 'x-test-workspace';
const ACTOR_HEADER = 'x-test-actor';

const ACTORS = {
  builderA: { principalId: 'a0000000-0000-4000-8000-000000000002', role: 'builder' },
  builderB: { principalId: 'a0000000-0000-4000-8000-000000000003', role: 'builder' },
  viewer: { principalId: 'a0000000-0000-4000-8000-000000000004', role: 'viewer' },
} as const;
type Actor = keyof typeof ACTORS;

const BODY = {
  version: 1,
  cases: [{ name: 'greets', input: 'Hello', expect: { contains: ['Hi'] } }],
};

let agentOfBuilderA: string;
let runs: InMemoryRunStore;
let recorded: unknown[];
/** The `limits` each launched case run carried (`undefined` when it carried none). */
let launchedLimits: unknown[];

function isActor(value: string): value is Actor {
  return Object.hasOwn(ACTORS, value);
}

beforeEach(async () => {
  recorded = [];
  launchedLimits = [];
  const agents = createInMemoryAgentStoreProvider();
  const created = await agents.forWorkspace(WORKSPACE).create(
    {
      name: 'Support triage',
      instructions: 'Before any version.',
      modelConnectionId: null,
      model: null,
      permissions: FIXTURE_PERMISSIONS,
    },
    { principalId: ACTORS.builderA.principalId, userId: null },
  );
  if (created.kind !== 'created') throw new Error('the memory store creates the fixture agent');
  agentOfBuilderA = created.agent.id;
  const versions = createInMemoryAgentVersionStoreProvider({ agents });
  const store = await versions.forWorkspace(WORKSPACE);
  if (store === null) throw new Error('the memory store answers every workspace');
  const saved = await createAgentVersion(
    versionRequest({ instructions: 'Version one.' }),
    created.agent,
    ACTORS.builderA.principalId,
    { store },
  );
  AgentVersionResourceSchema.parse(saved.body);
  const pointed = await setAgentPointer(
    { environment: 'local', version: 1 },
    created.agent,
    { principalId: ACTORS.builderA.principalId, userId: null, actor: 'builderA' },
    { store },
  );
  expect(pointed.status).toBe(200);

  installTestDomains({
    agents: {
      agents,
      resolveWorkspace(request: Request): Promise<WorkspaceResolution> {
        const workspaceId = request.headers.get(WORKSPACE_HEADER);
        return Promise.resolve(
          workspaceId === null
            ? { kind: 'unauthenticated', reason: 'no test workspace header' }
            : { kind: 'workspace', workspaceId },
        );
      },
    },
  });
  installTestDomains({ agentVersions: { versions } });
  installTestDomains({
    rbac: {
      directory: createMemoryDirectory({ users: [] }),
      identify: (request) => {
        const workspaceId = request.headers.get(WORKSPACE_HEADER);
        const actor = request.headers.get(ACTOR_HEADER);
        if (workspaceId === null || actor === null || !isActor(actor)) return Promise.resolve(null);
        return Promise.resolve(
          Principal.fromApiKey({
            ...ACTORS[actor],
            apiKeyId: ACTORS[actor].principalId.replace(/^a/u, 'b'),
            workspaceId,
            label: `${actor} evaluations key`,
          }),
        );
      },
    },
  });

  runs = new InMemoryRunStore();
  installTestRunApi({
    authenticate: () => Promise.reject(new Error('the evaluation route authenticates via RBAC')),
    findAgent: (_principal, agentId) =>
      Promise.resolve({ id: agentId, workspaceId: WORKSPACE, engine: 'claude-agent-sdk' }),
    openSession: (_principal, agent) =>
      Promise.resolve({ id: crypto.randomUUID(), agentId: agent.id, engine: null }),
    ownsRun: () => Promise.resolve(true),
    store: runs,
    launch: ({ run, limits }) => {
      launchedLimits.push(limits);
      void (async () => {
        const frame = assistantSays('Hi there.');
        await runs.append(run.id, { type: frame.frame, data: frame });
        await runs.finish(run.id, 'completed', null, true);
      })();
    },
    recordEvaluation: (_principal, evaluation) => {
      recorded.push(evaluation);
      return Promise.resolve({ id: crypto.randomUUID(), createdAt: new Date() });
    },
  });
});

afterEach(() => {
  clearApplicationContext();
  resetTestRunApi();
});

function post(actor: Actor, body: unknown = BODY): Promise<Response> {
  const request = new Request(`https://example.invalid/api/agents/${agentOfBuilderA}/evaluations`, {
    method: 'POST',
    headers: new Headers({
      [WORKSPACE_HEADER]: WORKSPACE,
      [ACTOR_HEADER]: actor,
      'content-type': 'application/json',
    }),
    body: JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ id: agentOfBuilderA }) });
}

async function errorOf(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  return typeof body === 'object' && body !== null && 'error' in body ? body.error : body;
}

describe('POST /api/agents/:id/evaluations', () => {
  it('scores and stores an evaluation of the Builder own agent with 201', async () => {
    const response = await post('builderA');
    expect(response.status).toBe(201);
    const evaluation = EvaluationResourceSchema.parse(await response.json());
    expect(evaluation).toMatchObject({ agentId: agentOfBuilderA, version: 1, score: 1 });
    expect(recorded).toHaveLength(1);
    expect(launchedLimits).toEqual([undefined]);
  });

  it('cannot be given run limits: a limits key in the body is invalid_body and starts no run', async () => {
    const response = await post('builderA', { ...BODY, limits: { maxBudgetUsd: 100 } });
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({ code: 'invalid_body' });
    expect(launchedLimits).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it.each(['viewer', 'builderB'] as const)(
    'refuses %s with 403 forbidden before any case runs',
    async (actor) => {
      const response = await post(actor);
      expect(response.status).toBe(403);
      expect(await errorOf(response)).toMatchObject({ code: 'forbidden' });
      expect((await runs.listRuns(WORKSPACE, { limit: 10 })).items).toEqual([]);
      expect(recorded).toEqual([]);
    },
  );
});
