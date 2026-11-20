/**
 * The locked-down guest role (spec §21 "Guest", the Agent Store's `#guest` section), proved one
 * denial at a time through the real route files.
 *
 * The route tests install the real RBAC harness (`testing.ts`), seed a member whose membership role
 * is `guest`, and call the exported route handler with a real `Request`. The approval tests use the
 * run-API harness (`installRunApi`) instead, and their ownership answer stands in for
 * `composition/wiring/run-api-sessions.ts` (the route only needs the own/other answer). Nothing
 * here asks `decide()` directly: a gate a handler forgot to call would pass such a test, and the point of
 * these tests is that the guest is refused where the request arrives. Each refusal is followed by
 * a read of the store, so "403" is never the only evidence that nothing was created.
 */
import crypto from 'node:crypto';

import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';

import { GET as getAgentRoute } from '../../app/api/agents/[id]/route';
import { GET as listAgentsRoute, POST as createAgentRoute } from '../../app/api/agents/route';
import { POST as createApiKeyRoute, GET as listApiKeysRoute } from '../../app/api/api-keys/route';
import {
  POST as createConnectorRoute,
  GET as listConnectorsRoute,
} from '../../app/api/connectors/route';
import { POST as createInvitationRoute } from '../../app/api/invitations/route';
import { PATCH as patchMembershipRoute } from '../../app/api/memberships/[id]/route';
import { POST as decideApprovalRoute } from '../../app/api/runs/[id]/approval/route';
import { GET as getWorkspaceRoute } from '../../app/api/workspaces/[id]/route';
import { POST as createWorkspaceRoute } from '../../app/api/workspaces/route';
import { clearApplicationContext } from '../application-context';
import { installTestDomains, resetTestRunApi } from '../application-context-fixtures';
import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import { createInMemoryConnectorsStoreProvider } from '../connectors/memory-store';
import type { ConnectorsRuntime } from '../connectors/wiring';
import {
  CALL,
  PRINCIPAL,
  decision,
  install as installRunApi,
  newRun,
  pausedRun,
} from '../runs/approval.test-support';
import { createMemoryWorkspaceRepository } from '../workspaces/testing';
import { installRbacHarness, TEST_WORKSPACE_ID, type RbacHarness } from './testing';

const GUEST = {
  principalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  id: '11111111-1111-4111-8111-111111111111',
  email: 'guest@example.test',
  name: 'Guest',
  workspaceId: TEST_WORKSPACE_ID,
  role: 'guest' as const,
};
const OWNER = {
  principalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  id: '33333333-3333-4333-8333-333333333333',
  email: 'owner@example.test',
  name: 'Owner',
  workspaceId: TEST_WORKSPACE_ID,
  role: 'owner' as const,
};
const VIEWER = {
  principalId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  id: '44444444-4444-4444-8444-444444444444',
  email: 'viewer@example.test',
  name: 'Viewer',
  workspaceId: TEST_WORKSPACE_ID,
  role: 'viewer' as const,
};
const DEMO_WORKSPACE_ID = 'c75a16a5-ab05-4309-9cbb-449baf33c4c1';
const OTHER_WORKSPACE_ID = '7a2e98e6-dd85-4fef-a38e-ee176fbdb0ff';

const AGENT_INPUT = {
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

afterEach(() => {
  resetTestRunApi();
  clearApplicationContext();
});

function harness(): RbacHarness {
  return installRbacHarness([GUEST, OWNER], { newId: crypto.randomUUID });
}

function errorCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as { error?: { code?: unknown } }).error;
  return typeof error?.code === 'string' ? error.code : undefined;
}

describe('a guest cannot create an agent', () => {
  it('answers POST /api/agents with 403 and leaves no agent row behind', async () => {
    const h = harness();
    const agents = createInMemoryAgentStoreProvider();
    installTestDomains({
      agents: {
        agents,
        resolveWorkspace: () =>
          Promise.resolve({ kind: 'workspace', workspaceId: TEST_WORKSPACE_ID }),
      },
    });
    const refused = await h.call(createAgentRoute, {
      method: 'POST',
      path: '/api/agents',
      as: GUEST,
      body: AGENT_INPUT,
    });
    expect(refused.status, refused.text).toBe(403);
    expect(await agents.forWorkspace(TEST_WORKSPACE_ID).list()).toEqual([]);

    // The same body from an Owner is accepted, so the 403 above is the role and not the body.
    const accepted = await h.call(createAgentRoute, {
      method: 'POST',
      path: '/api/agents',
      as: OWNER,
      body: AGENT_INPUT,
    });
    expect(accepted.status, accepted.text).toBe(201);
    expect(await agents.forWorkspace(TEST_WORKSPACE_ID).list()).toHaveLength(1);
  });
});

describe('a guest cannot create a connector', () => {
  it('answers POST /api/connectors with 403 and creates nothing', async () => {
    const h = harness();
    const stores = createInMemoryConnectorsStoreProvider();
    const runtime: ConnectorsRuntime = {
      connectors: stores,
      resolveWorkspace: () =>
        Promise.resolve({ kind: 'workspace', workspaceId: TEST_WORKSPACE_ID }),
      identifyActor: () => Promise.resolve({ principalId: GUEST.principalId, userId: GUEST.id }),
      recordAudit: () => Promise.resolve(),
    };
    installTestDomains({ connectors: { kind: 'serving', runtime } });
    const refused = await h.call(createConnectorRoute, {
      method: 'POST',
      path: '/api/connectors',
      as: GUEST,
      body: {
        name: 'Filesystem',
        transport: 'stdio',
        command: 'synthetic-command',
        args: [],
        authType: 'none',
      },
    });
    expect(refused.status, refused.text).toBe(403);
    expect(await stores.forWorkspace(TEST_WORKSPACE_ID).list()).toEqual([]);
    // Nor may it list them: connectors are not a resource a guest holds at all.
    const listed = await h.call(listConnectorsRoute, {
      method: 'GET',
      path: '/api/connectors',
      as: GUEST,
    });
    expect(listed.status, listed.text).toBe(403);
  });
});

describe('a guest cannot create an API key, and nobody can mint a guest key', () => {
  it('answers POST /api/api-keys with 403 and stores no key', async () => {
    const h = harness();
    const refused = await h.call(createApiKeyRoute, {
      method: 'POST',
      path: '/api/api-keys',
      as: GUEST,
      body: { name: 'sneaky', role: 'viewer' },
    });
    expect(refused.status, refused.text).toBe(403);
    expect(await h.directory.forWorkspace(TEST_WORKSPACE_ID).listApiKeys()).toEqual([]);
    expect(
      (await h.call(listApiKeysRoute, { method: 'GET', path: '/api/api-keys', as: GUEST })).status,
    ).toBe(403);
  });

  it('refuses an Owner who asks for a key with role guest, and stores no key', async () => {
    const h = harness();
    const refused = await h.call(createApiKeyRoute, {
      method: 'POST',
      path: '/api/api-keys',
      as: OWNER,
      body: { name: 'guest key', role: 'guest' },
    });
    expect(refused.status, refused.text).toBe(400);
    expect(errorCode(refused.body)).toBe('invalid_field');
    expect(await h.directory.forWorkspace(TEST_WORKSPACE_ID).listApiKeys()).toEqual([]);
  });
});

describe('a guest cannot invite, and nobody can invite a guest', () => {
  it('answers POST /api/invitations with 403 and stores no invitation', async () => {
    const h = harness();
    const refused = await h.call(createInvitationRoute, {
      method: 'POST',
      path: '/api/invitations',
      as: GUEST,
      body: { email: 'friend@example.test', role: 'viewer' },
    });
    expect(refused.status, refused.text).toBe(403);
    expect(await h.directory.forWorkspace(TEST_WORKSPACE_ID).listInvitations()).toEqual([]);
  });

  it('refuses an Owner who invites someone as guest, and stores no invitation', async () => {
    const h = harness();
    const refused = await h.call(createInvitationRoute, {
      method: 'POST',
      path: '/api/invitations',
      as: OWNER,
      body: { email: 'friend@example.test', role: 'guest' },
    });
    expect(refused.status, refused.text).toBe(400);
    expect(errorCode(refused.body)).toBe('invalid_field');
    expect(await h.directory.forWorkspace(TEST_WORKSPACE_ID).listInvitations()).toEqual([]);
  });

  it('refuses an Owner who changes a member to guest, and the role stays what it was', async () => {
    const h = installRbacHarness([GUEST, OWNER, VIEWER], { newId: crypto.randomUUID });
    const target = (await h.directory.forWorkspace(TEST_WORKSPACE_ID).listMemberships()).find(
      (candidate) => candidate.email === VIEWER.email,
    );
    if (target === undefined) throw new Error('fixture failed');
    // A non-owner row, so no sole-owner guard could refuse this on its own: the only thing wrong
    // with the request is the value `guest`.
    const refused = await h.call(patchMembershipRoute, {
      method: 'PATCH',
      path: `/api/memberships/${target.id}`,
      id: target.id,
      as: OWNER,
      body: { role: 'guest' },
    });
    expect(refused.status, refused.text).toBe(400);
    expect(errorCode(refused.body)).toBe('invalid_field');
    const after = (await h.directory.forWorkspace(TEST_WORKSPACE_ID).listMemberships()).find(
      (candidate) => candidate.id === target.id,
    );
    expect(after?.role).toBe('viewer');
  });
});

describe('a guest cannot reach anything outside its own workspace', () => {
  it('answers GET /api/agents/:id of another workspace with 404, the same as a missing agent', async () => {
    const h = harness();
    const agents = createInMemoryAgentStoreProvider();
    installTestDomains({
      agents: {
        agents,
        resolveWorkspace: () =>
          Promise.resolve({ kind: 'workspace', workspaceId: TEST_WORKSPACE_ID }),
      },
    });
    const foreign = await agents.forWorkspace(OTHER_WORKSPACE_ID).create(AGENT_INPUT, {
      principalId: OWNER.principalId,
      userId: OWNER.id,
    });
    const own = await agents.forWorkspace(TEST_WORKSPACE_ID).create(AGENT_INPUT, {
      principalId: OWNER.principalId,
      userId: OWNER.id,
    });
    if (foreign.kind !== 'created' || own.kind !== 'created') throw new Error('fixture failed');

    const read = (id: string) =>
      h.call(getAgentRoute, { method: 'GET', path: `/api/agents/${id}`, id, as: GUEST });
    const refused = await read(foreign.agent.id);
    const missing = await read(crypto.randomUUID());
    expect(refused.status, refused.text).toBe(404);
    expect({ status: refused.status, code: errorCode(refused.body) }).toEqual({
      status: missing.status,
      code: errorCode(missing.body),
    });
    // The guest does read its own workspace's agents, and the list holds no foreign agent.
    expect((await read(own.agent.id)).status).toBe(200);
    const listed = await h.call(listAgentsRoute, {
      method: 'GET',
      path: '/api/agents',
      as: GUEST,
    });
    expect(listed.status).toBe(200);
    expect(listed.text).not.toContain(foreign.agent.id);
  });

  it('answers GET /api/workspaces/:id of another workspace with 404, and the guest’s own with 200', async () => {
    // The workspace routes read a uuid, so this test gives the demo workspace a real one.
    const h = installRbacHarness(
      [
        { ...GUEST, workspaceId: DEMO_WORKSPACE_ID },
        { ...OWNER, workspaceId: DEMO_WORKSPACE_ID },
      ],
      { newId: crypto.randomUUID, workspaceId: DEMO_WORKSPACE_ID },
    );
    const guestUserId = (await h.directory.findUserByEmail(GUEST.email))?.id;
    if (guestUserId === undefined) throw new Error('fixture failed');
    installTestDomains({
      workspaces: {
        repository: createMemoryWorkspaceRepository({
          workspaces: [
            {
              id: DEMO_WORKSPACE_ID,
              slug: DEMO_WORKSPACE_ID,
              name: 'Demo',
              members: [{ userId: guestUserId, role: 'guest' }],
            },
            { id: OTHER_WORKSPACE_ID, slug: OTHER_WORKSPACE_ID, name: 'Elsewhere', members: [] },
          ],
        }),
      },
    });
    const read = (id: string) =>
      h.call(getWorkspaceRoute, { method: 'GET', path: `/api/workspaces/${id}`, id, as: GUEST });
    const refused = await read(OTHER_WORKSPACE_ID);
    const missing = await read(crypto.randomUUID());
    expect(refused.status, refused.text).toBe(404);
    expect(refused.body).toEqual(missing.body);
    expect((await read(DEMO_WORKSPACE_ID)).status).toBe(200);
  });

  it('answers POST /api/workspaces with 403, so a guest cannot become the Owner of a new one', async () => {
    const h = harness();
    const guestUserId = (await h.directory.findUserByEmail(GUEST.email))?.id;
    if (guestUserId === undefined) throw new Error('fixture failed');
    const repository = createMemoryWorkspaceRepository();
    installTestDomains({ workspaces: { repository } });
    const refused = await h.call(createWorkspaceRoute, {
      method: 'POST',
      path: '/api/workspaces',
      as: GUEST,
      body: { name: 'Mine', slug: 'mine' },
    });
    expect(refused.status, refused.text).toBe(403);
    expect(await repository.listForUser(guestUserId)).toEqual([]);
  });
});

/** The approval route itself, as the signed-in caller `install` authenticates. */
function approve(runId: string): Promise<Response> {
  return decideApprovalRoute(new NextRequest(decision(runId, { decision: 'approve' })), {
    params: Promise.resolve({ id: runId }),
  });
}

describe('a guest decides approvals only on its own runs', () => {
  const guestPrincipal = { ...PRINCIPAL, role: 'guest' as const };
  /** What `composition/wiring/run-api-sessions.ts` does: a run is the caller's when its owner is. */
  const ownsRun = (_principal: unknown, run: { readonly ownerPrincipalId?: string | null }) =>
    Promise.resolve((run.ownerPrincipalId ?? null) === guestPrincipal.ownerPrincipalId);

  it('lets the guest approve its own paused run', async () => {
    const { store, launched } = installRunApi({
      authenticate: () => Promise.resolve(guestPrincipal),
      ownsRun,
    });
    const paused = await pausedRun(store);
    const response = await approve(paused.id);
    expect(response.status).toBe(202);
    expect(launched).toHaveLength(1);
  });

  it('refuses the guest another member’s paused run, and the run stays paused', async () => {
    const { store, launched } = installRunApi({
      authenticate: () => Promise.resolve(guestPrincipal),
      ownsRun,
    });
    const id = crypto.randomUUID();
    await store.create({
      ...newRun(undefined, id),
      ownerPrincipalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    await store.markRunning(id);
    await store.awaitApproval(id, CALL);
    const response = await approve(id);
    expect(response.status).toBe(403);
    expect(launched).toHaveLength(0);
    expect((await store.get(id))?.status).toBe('awaiting_approval');
  });
});
