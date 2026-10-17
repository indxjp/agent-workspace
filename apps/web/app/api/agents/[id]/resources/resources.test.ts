import { afterEach, describe, expect, it } from 'vitest';

import { GET as getRoute, parseAssignments, PUT as putRoute } from './route';
import { POST as createAgentRoute } from '../../route';
import type { AgentResource, AgentResourceAssignments } from '../../../../../contracts/agents';
import {
  createInMemoryAgentVersionStoreProvider,
  type InMemoryAgentVersionStoreProvider,
} from '../../../../../server/agent-versions/memory-store';
import {
  clearAgentVersionsRuntime,
  configureAgentVersionsRuntime,
} from '../../../../../server/agent-versions/runtime';
import { createInMemoryAgentStoreProvider } from '../../../../../server/agents/memory-store';
import type { AgentResourceStoreProvider } from '../../../../../server/agents/resource-store';
import {
  clearAgentsRuntime,
  configureAgentsRuntime,
  type WorkspaceResolution,
} from '../../../../../server/agents/runtime';
import { createMemoryDirectory } from '../../../../../server/rbac/memory-directory';
import { Principal } from '../../../../../server/rbac/principal';
import { clearRbacRuntime, configureRbacRuntime } from '../../../../../server/rbac/runtime';

describe('agent resource assignment request', () => {
  it('accepts all three explicit assignment arrays and both file access modes', () => {
    expect(
      parseAssignments({
        files: [
          { fileId: 'file-a', access: 'read' },
          { fileId: 'file-b', access: 'read-write' },
        ],
        skillIds: ['skill-a'],
        connectorIds: ['connector-a'],
      }),
    ).toEqual({
      files: [
        { fileId: 'file-a', access: 'read' },
        { fileId: 'file-b', access: 'read-write' },
      ],
      skillIds: ['skill-a'],
      connectorIds: ['connector-a'],
    });
  });

  it.each([
    {},
    { files: [], skillIds: [], connectorIds: 'not-an-array' },
    { files: [{ fileId: 'x', access: 'write' }], skillIds: [], connectorIds: [] },
    { files: [], skillIds: [7], connectorIds: [] },
  ])('rejects malformed or privilege-widening input', (body) => {
    expect(parseAssignments(body)).toBeNull();
  });
});

/**
 * Verification round 2, finding 1 and finding 3: `ownershipOf` in `./route.ts` compares this
 * agent's `created_by` against the caller — the same comparison `apps/web/server/agents/
 * routes.test.ts` already proves for `agents/[id]/route.ts` — but nothing anywhere drove `GET`/
 * `PUT /api/agents/:id/resources` at all before this suite: every test in this file exercised only
 * `parseAssignments`, a pure function with no route, no runtime and no RBAC gate in the call path.
 * Mirrors `apps/web/server/agents/routes.test.ts`'s `useMemoryRuntime` shape — see that file's
 * header for why a header-driven test resolver is the strongest position to give an attacker.
 */
describe('own/other ownership on GET/PUT /api/agents/:id/resources (issue #117)', () => {
  const WORKSPACE_A = '55555555-5555-4555-8555-555555555555';
  const WORKSPACE_HEADER = 'x-test-workspace';
  const ACTOR_HEADER = 'x-test-actor';

  const FILE_ID = '88888888-8888-4888-8888-888888888888';

  afterEach(() => {
    clearAgentsRuntime();
    clearAgentVersionsRuntime();
    clearRbacRuntime();
  });

  function useMemoryRuntime(): InMemoryAgentVersionStoreProvider {
    const agents = createInMemoryAgentStoreProvider();
    const assignments = new Map<string, AgentResourceAssignments>();
    const agentResources: AgentResourceStoreProvider = {
      forWorkspace: (workspaceId) => ({
        get: async (agentId) => {
          if ((await agents.forWorkspace(workspaceId).get(agentId)) === null) return null;
          return (
            assignments.get(`${workspaceId}:${agentId}`) ?? {
              files: [],
              skillIds: [],
              connectorIds: [],
            }
          );
        },
        replace: async (agentId, next) => {
          if ((await agents.forWorkspace(workspaceId).get(agentId)) === null) {
            return { kind: 'not-found' as const };
          }
          assignments.set(`${workspaceId}:${agentId}`, next);
          return { kind: 'updated' as const, assignments: next };
        },
      }),
    };
    configureAgentsRuntime({
      agents,
      agentResources,
      resolveWorkspace(request: Request): Promise<WorkspaceResolution> {
        const workspaceId = request.headers.get(WORKSPACE_HEADER);
        return Promise.resolve(
          workspaceId === null
            ? { kind: 'unauthenticated', reason: 'no test workspace header' }
            : { kind: 'workspace', workspaceId },
        );
      },
    });
    // Issue #616: a resources PUT saves a version, so the version store is part of the runtime.
    const versions = createInMemoryAgentVersionStoreProvider({
      agents,
      resources: agentResources,
      references: { [WORKSPACE_A]: { file: [{ id: FILE_ID, name: 'handbook' }] } },
    });
    configureAgentVersionsRuntime({ versions });
    configureRbacRuntime({
      directory: createMemoryDirectory({
        users: [
          {
            email: 'builder-a@example.test',
            name: 'Builder A',
            workspaceId: WORKSPACE_A,
            role: 'builder',
          },
          {
            email: 'builder-b@example.test',
            name: 'Builder B',
            workspaceId: WORKSPACE_A,
            role: 'builder',
          },
        ],
      }),
      identify: (request) => {
        const workspaceId = request.headers.get(WORKSPACE_HEADER);
        const actor = request.headers.get(ACTOR_HEADER);
        return Promise.resolve(
          workspaceId === null || actor === null
            ? null
            : Principal.fromApiKey({
                principalId:
                  actor === 'builder-a@example.test'
                    ? '36377a6a-7a0b-4610-8efc-d31547dcc38a'
                    : 'c1353585-43d3-45dd-8276-edf59109fdfa',
                apiKeyId:
                  actor === 'builder-a@example.test'
                    ? '04aa9a6d-4862-41ce-b910-b43ba3f4d12f'
                    : 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                workspaceId,
                role: 'builder',
                label:
                  actor === 'builder-a@example.test'
                    ? 'Builder A resource key'
                    : 'Builder B resource key',
              }),
        );
      },
    });
    return versions;
  }

  function request(
    method: string,
    url: string,
    options: { workspace?: string; body?: string; actor?: string } = {},
  ): Request {
    const headers = new Headers();
    if (options.workspace !== undefined) headers.set(WORKSPACE_HEADER, options.workspace);
    if (options.actor !== undefined) headers.set(ACTOR_HEADER, options.actor);
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    return new Request(`https://example.invalid${url}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: options.body }),
    });
  }

  function idContext(id: string): { params: Promise<{ id: string }> } {
    return { params: Promise.resolve({ id }) };
  }

  const CREATE_BODY = JSON.stringify({
    name: 'Support triage',
    instructions: 'Answer support mail.',
    modelConnectionId: null,
    model: 'claude-sonnet-4-5',
    permissions: {
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    },
  });

  async function createAsBuilderA(): Promise<AgentResource> {
    const response = await createAgentRoute(
      request('POST', '/api/agents', {
        workspace: WORKSPACE_A,
        body: CREATE_BODY,
        actor: 'builder-a@example.test',
      }),
    );
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as AgentResource;
  }

  it('a Builder may replace the resource assignments of the agent it created, and no other Builder may', async () => {
    useMemoryRuntime();
    const agent = await createAsBuilderA();
    const putBody = JSON.stringify({ files: [], skillIds: [], connectorIds: [] });

    // Builder's grant on `agents` is `{ read: 'any', write: 'own', run: 'own' }`
    // (`permissions.ts`) — the same width `agents/[id]/route.ts`'s own GET carries, and this
    // `resources` sub-resource inherits its parent's grants verbatim
    // (`declarations/W1-CP-05.ts`). So `GET` is readable workspace-wide by design and is not an
    // own/other gate; `PUT` is the write this task's `ownershipOf` stands in front of, and it is
    // the one this test proves. Both builders can read the same current (empty) assignments
    // first, so the denial below is provably about `PUT`, not a workspace mismatch.
    const readByOther = await getRoute(
      request('GET', `/api/agents/${agent.id}/resources`, {
        workspace: WORKSPACE_A,
        actor: 'builder-b@example.test',
      }),
      idContext(agent.id),
    );
    expect(readByOther.status, await readByOther.clone().text()).toBe(200);

    // Builder B did not create this agent: `own` is denied, and `decide()` never sees a role wide
    // enough to substitute for it (Builder's write grant on agents is `own`, not `any`).
    const deniedPut = await putRoute(
      request('PUT', `/api/agents/${agent.id}/resources`, {
        workspace: WORKSPACE_A,
        actor: 'builder-b@example.test',
        body: putBody,
      }),
      idContext(agent.id),
    );
    expect(deniedPut.status).toBe(403);

    // Builder A did create it: the same route, the same agent, only the caller differs.
    const allowedPut = await putRoute(
      request('PUT', `/api/agents/${agent.id}/resources`, {
        workspace: WORKSPACE_A,
        actor: 'builder-a@example.test',
        body: putBody,
      }),
      idContext(agent.id),
    );
    expect(allowedPut.status, await allowedPut.clone().text()).toBe(200);
  });

  it('saves a PUT as one ui version and points local at it (issue #616)', async () => {
    const versions = useMemoryRuntime();
    const agent = await createAsBuilderA();
    const put = (assignments: AgentResourceAssignments): Promise<Response> =>
      putRoute(
        request('PUT', `/api/agents/${agent.id}/resources`, {
          workspace: WORKSPACE_A,
          actor: 'builder-a@example.test',
          body: JSON.stringify(assignments),
        }),
        idContext(agent.id),
      );

    const unknown = await put({
      files: [{ fileId: '99999999-9999-4999-8999-999999999999', access: 'read' }],
      skillIds: [],
      connectorIds: [],
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: { code: 'unknown-file' } });
    expect(versions.versionCount()).toBe(0);

    const saved = await put({
      files: [{ fileId: FILE_ID, access: 'read-write' }],
      skillIds: [],
      connectorIds: [],
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    // The agent cannot write files, so the materialised grant is narrowed (#133).
    expect(await saved.json()).toEqual({
      assignments: { files: [{ fileId: FILE_ID, access: 'read' }], skillIds: [], connectorIds: [] },
    });
    const listing = await (await versions.forWorkspace(WORKSPACE_A))?.list(agent.id);
    expect(listing?.versions).toHaveLength(1);
    expect(listing?.versions[0]).toMatchObject({
      via: 'ui',
      summary: 'Console edit: resources',
      body: {
        definition: {
          resources: { files: [{ path: 'handbook', access: 'read-write' }] },
          policySource: 'compiled',
        },
      },
    });
    expect(listing?.pointers).toMatchObject([{ environment: 'local', number: 1 }]);
    expect(listing?.materialisedVersionId).toBe(listing?.versions[0]?.id);
  });
});
