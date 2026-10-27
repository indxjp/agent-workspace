/**
 * A built-in agent (#1848) is read-only through every write route, for every role: the refusal is
 * the resolvers', before RBAC's `decide()`, so an Owner is answered the same `403` as a Viewer.
 * Reads, evaluations and platform exports are not refused, so people may inspect and evaluate it;
 * running the agent is another route.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DELETE, GET, PATCH } from '../../app/api/agents/[id]/route';
import { POST as postEvaluationAdvance } from '../../app/api/agents/[id]/evaluation-advance/route';
import { POST as postEvaluationRun } from '../../app/api/agents/[id]/evaluation-runs/route';
import { POST as postEvaluation } from '../../app/api/agents/[id]/evaluations/route';
import { GET as getGrants, PUT as putGrants } from '../../app/api/agents/[id]/grants/route';
import { POST as postPlatformArchive } from '../../app/api/agents/[id]/platform-archives/route';
import { POST as postPlatformExport } from '../../app/api/agents/[id]/platform-exports/route';
import { PUT as putPointer } from '../../app/api/agents/[id]/pointers/route';
import { POST as postPromote } from '../../app/api/agents/[id]/promote/route';
import {
  GET as getResources,
  PUT as putResources,
} from '../../app/api/agents/[id]/resources/route';
import { POST as postRollback } from '../../app/api/agents/[id]/rollback/route';
import { GET as getPolicy, PUT as putPolicy } from '../../app/api/agents/[id]/policy/route';
import { GET as getVersions, POST as postVersion } from '../../app/api/agents/[id]/versions/route';
import { FIXTURE_PERMISSIONS, versionRequest } from '../agent-versions/fixtures';
import { createInMemoryAgentVersionStoreProvider } from '../agent-versions/memory-store';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { ROLES, type Role } from '../rbac/roles';
import { createInMemoryAgentStoreProvider } from './memory-store';
import type { AgentStoreProvider } from './store';

const WORKSPACE = '66666666-6666-4666-8666-666666666666';
const OWNER_PRINCIPAL = 'a0000000-0000-4000-8000-000000000001';
const ROLE_HEADER = 'x-test-role';

let builtinId: string;
let ordinaryId: string;
/** Cleared by a test that seeds the agent first, so it can be written like any agent. */
let builtinMarked = true;

beforeEach(async () => {
  builtinMarked = true;
  const stored = createInMemoryAgentStoreProvider();
  const store = stored.forWorkspace(WORKSPACE);
  const input = (name: string) => ({
    name,
    instructions: 'Help.',
    modelConnectionId: null,
    model: null,
    permissions: FIXTURE_PERMISSIONS,
  });
  const owner = { principalId: OWNER_PRINCIPAL, userId: null };
  const [builtin, ordinary] = [
    await store.create(input('builder'), owner),
    await store.create(input('ordinary'), owner),
  ];
  if (builtin.kind !== 'created' || ordinary.kind !== 'created') throw new Error('fixture agents');
  builtinId = builtin.agent.id;
  ordinaryId = ordinary.agent.id;
  // The memory store has no built-in rows; the resolvers only read the marker off what `get` returns.
  const agents: AgentStoreProvider = {
    forWorkspace: (workspaceId) => {
      const bound = stored.forWorkspace(workspaceId);
      return {
        ...bound,
        get: async (id) => {
          const agent = await bound.get(id);
          return builtinMarked && agent !== null && id === builtinId
            ? { ...agent, builtin: 'builder' }
            : agent;
        },
      };
    },
  };
  installTestDomains({
    agents: {
      agents,
      // A PATCH saves a console-edit version, which reads the agent's assignments.
      agentResources: {
        forWorkspace: () => ({
          get: () =>
            Promise.resolve({ files: [], skillIds: [], connectorIds: [], storageGrants: [] }),
          replace: () => Promise.resolve({ kind: 'not-found' as const }),
        }),
      },
      resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE }),
    },
  });
  installTestDomains({
    agentVersions: { versions: createInMemoryAgentVersionStoreProvider({ agents: stored }) },
  });
  installTestDomains({
    rbac: {
      directory: createMemoryDirectory({ users: [] }),
      identify: (request) => {
        const role = ROLES.find((candidate) => candidate === request.headers.get(ROLE_HEADER));
        return Promise.resolve(
          role === undefined
            ? null
            : Principal.fromApiKey({
                principalId: OWNER_PRINCIPAL,
                apiKeyId: 'b0000000-0000-4000-8000-000000000001',
                workspaceId: WORKSPACE,
                role,
                label: `${role} key`,
              }),
        );
      },
    },
  });
});

afterEach(() => {
  clearApplicationContext();
});

const routeContext = (id: string) => ({ params: Promise.resolve({ id }) });

function call(method: string, role: Role, body?: unknown): Request {
  return new Request('http://localhost/api/agents/x', {
    method,
    headers: { 'Content-Type': 'application/json', [ROLE_HEADER]: role },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function answer(
  run: (request: Request, context: ReturnType<typeof routeContext>) => unknown,
  request: Request,
  id: string,
): Promise<{ status: number; code: unknown }> {
  const response = (await run(request, routeContext(id))) as Response;
  const text = await response.text();
  const parsed: unknown = text === '' ? null : JSON.parse(text);
  const code = (parsed as { error?: { code?: unknown } } | null)?.error?.code;
  return { status: response.status, code };
}

// The last column is the status an ordinary agent answers, where the fixture makes it certain.
const WRITES = [
  ['PATCH /api/agents/:id', PATCH, 'PATCH', { name: 'renamed' }, 200],
  ['DELETE /api/agents/:id', DELETE, 'DELETE', undefined, 204],
  ['PUT /api/agents/:id/policy', putPolicy, 'PUT', { engine: 'claude' }, null],
  ['POST /api/agents/:id/versions', postVersion, 'POST', versionRequest(), null],
  ['PUT /api/agents/:id/pointers', putPointer, 'PUT', { environment: 'local', version: 1 }, null],
  [
    'PUT /api/agents/:id/resources',
    putResources,
    'PUT',
    { files: [], skillIds: [], connectorIds: [] },
    null,
  ],
  ['POST /api/agents/:id/promote', postPromote, 'POST', {}, null],
  ['POST /api/agents/:id/rollback', postRollback, 'POST', { environment: 'local' }, null],
  ['POST /api/agents/:id/evaluation-advance', postEvaluationAdvance, 'POST', {}, null],
  ['PUT /api/agents/:id/grants', putGrants, 'PUT', { principalIds: [] }, null],
] as const;

// Inspecting and evaluating a built-in agent stays open; what each then answers is its route's.
const ALLOWED = [
  ['POST /api/agents/:id/evaluations', postEvaluation, { version: 1 }],
  ['POST /api/agents/:id/evaluation-runs', postEvaluationRun, { version: 1 }],
  ['POST /api/agents/:id/platform-exports', postPlatformExport, { platform: 'claude-code' }],
  ['POST /api/agents/:id/platform-archives', postPlatformArchive, { platform: 'claude-code' }],
] as const;

describe.each(WRITES)('%s', (_name, run, method, body, ordinaryStatus) => {
  it.each(ROLES)(
    'refuses a %s on a built-in agent with 403 builtin_agent_read_only',
    async (role) => {
      expect(await answer(run, call(method, role, body), builtinId)).toEqual({
        status: 403,
        code: 'builtin_agent_read_only',
      });
    },
  );

  it('does not give the refusal to an ordinary agent', async () => {
    const outcome = await answer(run, call(method, 'owner', body), ordinaryId);
    expect(outcome.code).not.toBe('builtin_agent_read_only');
    if (ordinaryStatus !== null) expect(outcome).toEqual({ status: ordinaryStatus });
  });
});

describe('refused writes to a built-in agent', () => {
  it('leave its row, versions, pointers, policy, resources and grants unchanged', async () => {
    // A version and a `local` pointer, written before the agent is marked built-in.
    builtinMarked = false;
    const seeded = await answer(
      postVersion,
      call('POST', 'owner', versionRequest({ name: 'builder' })),
      builtinId,
    );
    expect(seeded.status).toBe(201);
    const moved = await answer(
      putPointer,
      call('PUT', 'owner', { environment: 'local', version: 1 }),
      builtinId,
    );
    expect(moved.status).toBe(200);
    builtinMarked = true;

    const read = async (
      run: (request: Request, context: ReturnType<typeof routeContext>) => Promise<Response>,
    ): Promise<unknown> => (await run(call('GET', 'owner'), routeContext(builtinId))).json();
    const snapshot = async () => ({
      agent: await read(GET),
      versions: await read(getVersions),
      policy: await read(getPolicy),
      resources: await read(getResources),
      grants: await read(getGrants),
    });
    const before = await snapshot();
    expect(before.agent).toMatchObject({ name: 'builder' });
    expect(JSON.stringify(before.versions)).toContain('"local"');
    for (const [, run, method, body] of WRITES) {
      for (const role of ROLES) {
        expect((await answer(run, call(method, role, body), builtinId)).status).toBe(403);
        expect(await snapshot()).toEqual(before);
      }
    }
  });
});

describe.each(ALLOWED)('%s', (_name, run, body) => {
  it.each(ROLES)('is not refused on a built-in agent for a %s', async (role) => {
    expect((await answer(run, call('POST', role, body), builtinId)).code).not.toBe(
      'builtin_agent_read_only',
    );
  });
});

describe('reads of a built-in agent', () => {
  it.each(ROLES)('are not refused for a %s', async (role) => {
    expect(await answer(GET, call('GET', role), builtinId)).toEqual({
      status: 200,
      code: undefined,
    });
    expect((await answer(getVersions, call('GET', role), builtinId)).code).not.toBe(
      'builtin_agent_read_only',
    );
    for (const read of [getPolicy, getResources, getGrants]) {
      expect((await answer(read, call('GET', role), builtinId)).code).not.toBe(
        'builtin_agent_read_only',
      );
    }
  });
});
