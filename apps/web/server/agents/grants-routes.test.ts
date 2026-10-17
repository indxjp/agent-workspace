import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  GET as getGrantsRoute,
  PUT as putGrantsRoute,
} from '../../app/api/agents/[id]/grants/route';
import { createInMemoryAgentStoreProvider } from './memory-store';
import { resolveAgentRunOwnership } from './run-ownership';
import { clearAgentsRuntime, configureAgentsRuntime } from './runtime';
import { clearRbacRuntime } from '../rbac/runtime';
import { installRbacHarness, TEST_WORKSPACE_ID } from '../rbac/testing';

const OWNER = {
  principalId: '11111111-1111-4111-8111-111111111111',
  id: '21111111-1111-4111-8111-111111111111',
  email: 'owner@example.test',
  name: 'Owner',
  workspaceId: TEST_WORKSPACE_ID,
  role: 'owner' as const,
};
const BUILDER = {
  principalId: '33333333-3333-4333-8333-333333333333',
  id: '43333333-3333-4333-8333-333333333333',
  email: 'builder@example.test',
  name: 'Builder',
  workspaceId: TEST_WORKSPACE_ID,
  role: 'builder' as const,
};
const ADMIN = {
  principalId: '29999999-9999-4999-8999-999999999999',
  id: '39999999-9999-4999-8999-999999999999',
  email: 'admin@example.test',
  name: 'Admin',
  workspaceId: TEST_WORKSPACE_ID,
  role: 'admin' as const,
};
const OTHER_BUILDER = {
  principalId: '55555555-5555-4555-8555-555555555555',
  id: '65555555-5555-4555-8555-555555555555',
  email: 'other-builder@example.test',
  name: 'Other Builder',
  workspaceId: TEST_WORKSPACE_ID,
  role: 'builder' as const,
};
const VIEWER = {
  principalId: '77777777-7777-4777-8777-777777777777',
  id: '87777777-7777-4777-8777-777777777777',
  email: 'viewer@example.test',
  name: 'Viewer',
  workspaceId: TEST_WORKSPACE_ID,
  role: 'viewer' as const,
};
const FOREIGN_PRINCIPAL = '99999999-9999-4999-8999-999999999999';

const CREATE_INPUT = {
  name: 'Support',
  instructions: '',
  modelConnectionId: null,
  model: null,
  permissions: {
    readFiles: true,
    writeFiles: false,
    runCommands: false,
    unrestrictedNetwork: false,
  },
} as const;

describe('GET/PUT /api/agents/:id/grants', () => {
  const principalUsers = new Map([
    [OWNER.principalId, OWNER.id],
    [ADMIN.principalId, ADMIN.id],
    [BUILDER.principalId, BUILDER.id],
    [OTHER_BUILDER.principalId, OTHER_BUILDER.id],
    [VIEWER.principalId, VIEWER.id],
  ]);
  const grants = new Map<string, readonly string[]>();
  let agents: ReturnType<typeof createInMemoryAgentStoreProvider>;
  let agentId = '';
  let harness: ReturnType<typeof installRbacHarness>;

  beforeEach(async () => {
    grants.clear();
    agents = createInMemoryAgentStoreProvider();
    harness = installRbacHarness([OWNER, ADMIN, BUILDER, OTHER_BUILDER, VIEWER]);
    configureAgentsRuntime({
      agents,
      resolveWorkspace: () =>
        Promise.resolve({ kind: 'workspace', workspaceId: TEST_WORKSPACE_ID }),
      agentGrants: {
        forWorkspace: () => ({
          hasGrant: (candidateAgentId, userId) =>
            Promise.resolve(
              (grants.get(candidateAgentId) ?? []).some(
                (principalId) => principalUsers.get(principalId) === userId,
              ),
            ),
          listPrincipalIds: (candidateAgentId) =>
            Promise.resolve(grants.get(candidateAgentId) ?? []),
          replacePrincipalIds: (candidateAgentId, principalIds) => {
            const missing = principalIds.find((principalId) => !principalUsers.has(principalId));
            if (missing !== undefined) {
              return Promise.resolve({
                kind: 'principal-not-found' as const,
                principalId: missing,
              });
            }
            grants.set(candidateAgentId, [...principalIds]);
            return Promise.resolve({ kind: 'updated' as const, principalIds });
          },
        }),
      },
    });
    const created = await agents.forWorkspace(TEST_WORKSPACE_ID).create(CREATE_INPUT, {
      principalId: BUILDER.principalId,
      userId: BUILDER.id,
    });
    if (created.kind !== 'created') throw new Error(`fixture failed: ${created.kind}`);
    agentId = created.agent.id;
  });

  afterEach(() => {
    clearAgentsRuntime();
    clearRbacRuntime();
  });

  for (const route of [
    { method: 'GET' as const, handler: getGrantsRoute, body: undefined },
    {
      method: 'PUT' as const,
      handler: putGrantsRoute,
      body: { principalIds: [VIEWER.principalId] },
    },
  ]) {
    for (const caller of [OWNER, ADMIN, BUILDER, VIEWER]) {
      const allowed = route.method === 'GET' || caller.role !== 'viewer';
      it(`drives the real ${route.method} grants route for ${caller.role}`, async () => {
        const response = await harness.call(route.handler, {
          method: route.method,
          path: `/api/agents/${agentId}/grants`,
          id: agentId,
          as: caller,
          ...(route.body === undefined ? {} : { body: route.body }),
        });
        expect(response.status === 403, response.text).toBe(!allowed);
      });
    }
  }

  it('adds, replaces, and removes a Viewer grant, taking effect on the next run check', async () => {
    const before = await resolveAgentRunOwnership(
      {
        workspaceId: TEST_WORKSPACE_ID,
        principalId: VIEWER.principalId,
        ownerPrincipalId: VIEWER.principalId,
        userId: VIEWER.id,
      },
      agentId,
    );
    expect(before).toBe('other');

    const added = await harness.call(putGrantsRoute, {
      method: 'PUT',
      path: `/api/agents/${agentId}/grants`,
      id: agentId,
      as: BUILDER,
      body: { principalIds: [VIEWER.principalId] },
    });
    expect(added).toMatchObject({
      status: 200,
      body: { principalIds: [VIEWER.principalId] },
    });
    expect(
      await resolveAgentRunOwnership(
        {
          workspaceId: TEST_WORKSPACE_ID,
          principalId: VIEWER.principalId,
          ownerPrincipalId: VIEWER.principalId,
          userId: VIEWER.id,
        },
        agentId,
      ),
    ).toBe('permitted');

    const removed = await harness.call(putGrantsRoute, {
      method: 'PUT',
      path: `/api/agents/${agentId}/grants`,
      id: agentId,
      as: BUILDER,
      body: { principalIds: [] },
    });
    expect(removed).toMatchObject({ status: 200, body: { principalIds: [] } });
    expect(
      await resolveAgentRunOwnership(
        {
          workspaceId: TEST_WORKSPACE_ID,
          principalId: VIEWER.principalId,
          ownerPrincipalId: VIEWER.principalId,
          userId: VIEWER.id,
        },
        agentId,
      ),
    ).toBe('other');
  });

  it('lets a Builder read any agent grants but write only their own agent', async () => {
    const read = await harness.call(getGrantsRoute, {
      method: 'GET',
      path: `/api/agents/${agentId}/grants`,
      id: agentId,
      as: OTHER_BUILDER,
    });
    expect(read).toMatchObject({ status: 200, body: { principalIds: [] } });

    const write = await harness.call(putGrantsRoute, {
      method: 'PUT',
      path: `/api/agents/${agentId}/grants`,
      id: agentId,
      as: OTHER_BUILDER,
      body: { principalIds: [VIEWER.principalId] },
    });
    expect(write).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } });
  });

  it('lets a Viewer read the grant list as part of the readable agent row but never replace it', async () => {
    const read = await harness.call(getGrantsRoute, {
      method: 'GET',
      path: `/api/agents/${agentId}/grants`,
      id: agentId,
      as: VIEWER,
    });
    expect(read).toMatchObject({ status: 200, body: { principalIds: [] } });

    const write = await harness.call(putGrantsRoute, {
      method: 'PUT',
      path: `/api/agents/${agentId}/grants`,
      id: agentId,
      as: VIEWER,
      body: { principalIds: [VIEWER.principalId] },
    });
    expect(write).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } });
  });

  it('conceals malformed, nonexistent, and foreign agent ids with the same response', async () => {
    const responses = await Promise.all(
      ['not-a-uuid', crypto.randomUUID(), FOREIGN_PRINCIPAL].map((id) =>
        harness.call(getGrantsRoute, {
          method: 'GET',
          path: `/api/agents/${id}/grants`,
          id,
          as: OWNER,
        }),
      ),
    );
    expect(responses.map(({ status, body }) => ({ status, body }))).toEqual([
      {
        status: 404,
        body: {
          error: { code: 'agent_not_found', message: 'This workspace has no agent with that id.' },
        },
      },
      {
        status: 404,
        body: {
          error: { code: 'agent_not_found', message: 'This workspace has no agent with that id.' },
        },
      },
      {
        status: 404,
        body: {
          error: { code: 'agent_not_found', message: 'This workspace has no agent with that id.' },
        },
      },
    ]);
  });

  it('refuses a foreign or nonexistent principal identically and leaves the grant set unchanged', async () => {
    const response = await harness.call(putGrantsRoute, {
      method: 'PUT',
      path: `/api/agents/${agentId}/grants`,
      id: agentId,
      as: BUILDER,
      body: { principalIds: [FOREIGN_PRINCIPAL] },
    });
    expect(response).toMatchObject({
      status: 404,
      body: { error: { code: 'principal_not_found' } },
    });
    expect(grants.get(agentId)).toBeUndefined();
  });
});
