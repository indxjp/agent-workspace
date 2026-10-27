import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentVersionResourceSchema } from '@indx-workspace/contracts/agent-versions';
import { EvaluationRunResourceSchema } from '@indx-workspace/contracts/evaluations';

import { GET, POST } from './route';
import { POST as ADVANCE } from '../evaluation-advance/route';
import { createInMemoryAgentStoreProvider } from '../../../../../server/agents/memory-store';
import { type WorkspaceResolution } from '../../../../../server/agents/runtime';
import { FIXTURE_PERMISSIONS, versionRequest } from '../../../../../server/agent-versions/fixtures';
import { createAgentVersion } from '../../../../../server/agent-versions/handlers';
import { createInMemoryAgentVersionStoreProvider } from '../../../../../server/agent-versions/memory-store';
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
 * The three evaluation-run routes (issue #799) through `serveAgentVersionRoute`, driven with real
 * `Request` objects and real RBAC: a Viewer and a Builder on another principal's agent are refused
 * before anything is stored or run. The run logic is `server/evaluations/runs.test.ts`'s.
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
  cases: [
    { name: 'greets', input: 'Hello', expect: { contains: ['Hi'] } },
    { name: 'greets again', input: 'Hello again', expect: { contains: ['Hi'] } },
  ],
};

interface Row {
  id: string;
  versionId: string;
  status: 'running' | 'completed';
  passed: number;
  total: number;
  casesSnapshot: unknown;
  results: unknown;
}

let agentOfBuilderA: string;
let runs: InMemoryRunStore;
let rows: Map<string, Row>;

function isActor(value: string): value is Actor {
  return Object.hasOwn(ACTORS, value);
}

beforeEach(async () => {
  rows = new Map();
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
            label: `${actor} evaluation runs key`,
          }),
        );
      },
    },
  });

  runs = new InMemoryRunStore();
  const stored = (row: Row) => ({
    ...row,
    agentId: agentOfBuilderA,
    version: 1,
    score: (row.passed / row.total).toFixed(4),
    createdAt: new Date('2026-10-07T00:00:00Z'),
  });
  installTestRunApi({
    authenticate: () => Promise.reject(new Error('the evaluation route authenticates via RBAC')),
    findAgent: (_principal, agentId) =>
      Promise.resolve({ id: agentId, workspaceId: WORKSPACE, engine: 'claude-agent-sdk' }),
    openSession: (_principal, agent) =>
      Promise.resolve({ id: crypto.randomUUID(), agentId: agent.id, engine: null }),
    ownsRun: () => Promise.resolve(true),
    store: runs,
    launch: ({ run }) => {
      void (async () => {
        const frame = assistantSays('Hi there.');
        await runs.append(run.id, { type: frame.frame, data: frame });
        await runs.finish(run.id, 'completed', null, true);
      })();
    },
    evaluationRuns: {
      start: (_principal, run) => {
        const row: Row = {
          ...run,
          id: crypto.randomUUID(),
          status: 'running',
          passed: 0,
          results: [],
        };
        rows.set(row.id, row);
        return Promise.resolve({ id: row.id, createdAt: new Date('2026-10-07T00:00:00Z') });
      },
      find: (_principal, id) => {
        const row = rows.get(id);
        return Promise.resolve(row === undefined ? null : stored(row));
      },
      claim: (_principal, id) => {
        const row = rows.get(id);
        return Promise.resolve(row === undefined || row.status !== 'running' ? null : stored(row));
      },
      progress: (_principal, id, progress) => {
        const row = rows.get(id);
        if (row === undefined) return Promise.resolve();
        row.results = progress.results;
        row.passed = progress.passed;
        if (progress.completed) row.status = 'completed';
        return Promise.resolve();
      },
    },
  });
});

afterEach(() => {
  clearApplicationContext();
  resetTestRunApi();
});

function request(actor: Actor, path: string, method: 'GET' | 'POST', body?: unknown): Request {
  return new Request(`https://example.invalid/api/agents/${agentOfBuilderA}/${path}`, {
    method,
    headers: new Headers({
      [WORKSPACE_HEADER]: WORKSPACE,
      [ACTOR_HEADER]: actor,
      'content-type': 'application/json',
    }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const create = (actor: Actor) =>
  POST(request(actor, 'evaluation-runs', 'POST', BODY), {
    params: Promise.resolve({ id: agentOfBuilderA }),
  });
const advance = (actor: Actor, evaluationId: string) =>
  ADVANCE(request(actor, 'evaluation-advance', 'POST', { evaluationId }), {
    params: Promise.resolve({ id: agentOfBuilderA }),
  });
const read = (actor: Actor, evaluationId: string) =>
  GET(request(actor, `evaluation-runs?evaluation=${evaluationId}`, 'GET'), {
    params: Promise.resolve({ id: agentOfBuilderA }),
  });

async function errorOf(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  return typeof body === 'object' && body !== null && 'error' in body ? body.error : body;
}

describe('evaluation run routes (issue #799)', () => {
  it('creates a run with 202, advances it to completed and reads it at each step', async () => {
    const created = await create('builderA');
    expect(created.status).toBe(202);
    const run = EvaluationRunResourceSchema.parse(await created.json());
    expect(run).toMatchObject({ status: 'running', total: 2, results: [] });

    const reading = await read('builderA', run.id);
    expect(reading.status).toBe(200);
    expect(EvaluationRunResourceSchema.parse(await reading.json())).toMatchObject({
      id: run.id,
      status: 'running',
    });

    const advanced = await advance('builderA', run.id);
    expect(advanced.status).toBe(200);
    expect(EvaluationRunResourceSchema.parse(await advanced.json())).toMatchObject({
      status: 'completed',
      score: 1,
      passed: 2,
    });

    const evaluation = await read('builderA', run.id);
    expect(evaluation.status).toBe(200);
    expect(EvaluationRunResourceSchema.parse(await evaluation.json())).toMatchObject({
      id: run.id,
      agentId: agentOfBuilderA,
      status: 'completed',
      score: 1,
    });
  });

  it.each(['viewer', 'builderB'] as const)(
    'refuses %s with 403 forbidden on both writing routes before anything is stored or run',
    async (actor) => {
      const id = '55555555-5555-4555-8555-555555555555';
      const responses = [await create(actor), await advance(actor, id)];
      expect(responses.map((response) => response.status)).toEqual([403, 403]);
      expect(await errorOf(responses[0] ?? new Response())).toMatchObject({ code: 'forbidden' });
      expect(rows.size).toBe(0);
      expect((await runs.listRuns(WORKSPACE, { limit: 10 })).items).toEqual([]);
    },
  );

  it('lets a reader read a run, as it reads the agent, and answers 404 for an unknown run', async () => {
    const created = EvaluationRunResourceSchema.parse(await (await create('builderA')).json());
    expect((await read('viewer', created.id)).status).toBe(200);
    expect((await read('viewer', '55555555-5555-4555-8555-555555555555')).status).toBe(404);
  });
});
