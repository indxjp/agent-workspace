import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DELETE as deleteConnectorRoute,
  GET as getConnectorRoute,
  PATCH as patchConnectorRoute,
} from '../../app/api/connectors/[id]/route';
import { POST as testConnectorRoute } from '../../app/api/connectors/[id]/test-connection/route';
import { clearRbacRuntime } from '../rbac/runtime';
import { installRbacHarness, TEST_WORKSPACE_ID } from '../rbac/testing';
import { createInMemoryConnectorsStoreProvider } from './memory-store';
import {
  clearConnectorsRuntime,
  configureConnectorsRuntime,
  type ConnectorsRuntime,
} from './runtime';
import type { ConnectorsStoreProvider } from './store';

const rotateConnectorCredentialObservation = vi.hoisted(() => ({ calls: 0 }));

vi.mock('./handlers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./handlers')>();
  return {
    ...actual,
    rotateConnectorCredential: async (
      ...args: Parameters<typeof actual.rotateConnectorCredential>
    ) => {
      rotateConnectorCredentialObservation.calls += 1;
      return actual.rotateConnectorCredential(...args);
    },
  };
});

const CREATOR = {
  principalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  id: '11111111-1111-4111-8111-111111111111',
  email: 'creator@example.test',
  name: 'Creator',
  workspaceId: TEST_WORKSPACE_ID,
  role: 'builder' as const,
};
const OTHER_BUILDER = {
  principalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  id: '22222222-2222-4222-8222-222222222222',
  email: 'other@example.test',
  name: 'Other Builder',
  workspaceId: TEST_WORKSPACE_ID,
  role: 'builder' as const,
};
const OWNER = {
  principalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  id: '33333333-3333-4333-8333-333333333333',
  email: 'owner@example.test',
  name: 'Owner',
  workspaceId: TEST_WORKSPACE_ID,
  role: 'owner' as const,
};
const ADMIN = {
  principalId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  id: '44444444-4444-4444-8444-444444444444',
  email: 'admin@example.test',
  name: 'Admin',
  workspaceId: TEST_WORKSPACE_ID,
  role: 'admin' as const,
};
const VIEWER = {
  principalId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  id: '55555555-5555-4555-8555-555555555555',
  email: 'viewer@example.test',
  name: 'Viewer',
  workspaceId: TEST_WORKSPACE_ID,
  role: 'viewer' as const,
};

afterEach(() => {
  clearConnectorsRuntime();
  clearRbacRuntime();
});

async function connectorFixture(): Promise<{
  readonly id: string;
  readonly connector: {
    readonly id: string;
    readonly ownerPrincipalId: string;
    readonly createdBy: string | null;
  };
  readonly stores: ConnectorsStoreProvider;
}> {
  const stores = createInMemoryConnectorsStoreProvider();
  const outcome = await stores.forWorkspace(TEST_WORKSPACE_ID).create(
    {
      name: 'Filesystem',
      transport: 'stdio',
      command: 'synthetic-command',
      args: [],
      url: null,
      authType: 'none',
      credential: null,
    },
    { principalId: CREATOR.principalId, userId: CREATOR.id },
  );
  if (outcome.kind !== 'created') throw new Error(`fixture setup failed: ${outcome.kind}`);
  return { id: outcome.server.id, connector: outcome.server, stores };
}

function expectOwnedConnectorFixture(fixture: Awaited<ReturnType<typeof connectorFixture>>): void {
  expect(fixture.connector).toMatchObject({
    id: fixture.id,
    ownerPrincipalId: CREATOR.principalId,
    createdBy: CREATOR.id,
  });
}

function configureConnectorRuntime(stores: ConnectorsStoreProvider): void {
  const runtime: ConnectorsRuntime = {
    connectors: stores,
    resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: TEST_WORKSPACE_ID }),
    identifyActor: () => Promise.resolve({ principalId: CREATOR.principalId, userId: CREATOR.id }),
    recordAudit: () => Promise.resolve(),
  };
  configureConnectorsRuntime(runtime);
}

describe('connector item authorization characterization', () => {
  it('reports an unwired connector runtime as itself on both item route families', async () => {
    const id = crypto.randomUUID();
    const harness = installRbacHarness([OWNER]);
    for (const [method, path, handler] of [
      ['GET', `/api/connectors/${id}`, getConnectorRoute],
      ['POST', `/api/connectors/${id}/test-connection`, testConnectorRoute],
    ] as const) {
      const response = await harness.call(handler, { method, path, id, as: OWNER });
      expect(response).toMatchObject({
        status: 503,
        body: { error: { code: 'connectors_runtime_not_configured' } },
      });
    }
  });

  for (const route of [
    { method: 'GET' as const, handler: getConnectorRoute, body: undefined },
    {
      method: 'PATCH' as const,
      handler: patchConnectorRoute,
      body: { credential: 'rotated' },
    },
    { method: 'DELETE' as const, handler: deleteConnectorRoute, body: undefined },
    { method: 'POST' as const, handler: testConnectorRoute, body: undefined },
  ]) {
    for (const caller of [OWNER, ADMIN, CREATOR, VIEWER]) {
      const allowed = caller.role !== 'viewer';
      it(`drives the real ${route.method} connector item route for ${caller.role}`, async () => {
        const fixture = await connectorFixture();
        configureConnectorRuntime(fixture.stores);
        const harness = installRbacHarness([OWNER, ADMIN, CREATOR, VIEWER]);
        const response = await harness.call(route.handler, {
          method: route.method,
          path:
            route.method === 'POST'
              ? `/api/connectors/${fixture.id}/test-connection`
              : `/api/connectors/${fixture.id}`,
          id: fixture.id,
          as: caller,
          ...(route.body === undefined ? {} : { body: route.body }),
        });
        expect(response.status === 403, response.text).toBe(!allowed);
      });
    }
  }

  it('conceals malformed, nonexistent, and foreign connector ids identically', async () => {
    const stores = createInMemoryConnectorsStoreProvider();
    const foreignWorkspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const foreign = await stores.forWorkspace(foreignWorkspaceId).create(
      {
        name: 'Foreign',
        transport: 'stdio',
        command: 'synthetic-command',
        args: [],
        url: null,
        authType: 'none',
        credential: null,
      },
      { principalId: CREATOR.principalId, userId: CREATOR.id },
    );
    if (foreign.kind !== 'created') throw new Error(`fixture setup failed: ${foreign.kind}`);
    configureConnectorRuntime(stores);
    const harness = installRbacHarness([CREATOR]);
    const ids = ['not-a-uuid', crypto.randomUUID(), foreign.server.id];
    const responses = await Promise.all(
      ids.map((id) =>
        harness.call(getConnectorRoute, {
          method: 'GET',
          path: `/api/connectors/${id}`,
          id,
          as: CREATOR,
        }),
      ),
    );
    expect(responses.map(({ status, body }) => ({ status, body }))).toEqual(
      ids.map(() => ({
        status: 404,
        body: {
          error: {
            code: 'connector_not_found',
            message: 'This workspace has no connector with that id.',
          },
        },
      })),
    );
  });

  describe('get', () => {
    let fixture: Awaited<ReturnType<typeof connectorFixture>>;
    let response: Awaited<ReturnType<ReturnType<typeof installRbacHarness>['call']>>;

    beforeEach(async () => {
      fixture = await connectorFixture();
      configureConnectorRuntime(fixture.stores);
      const harness = installRbacHarness([CREATOR, OTHER_BUILDER]);

      response = await harness.call(getConnectorRoute, {
        method: 'GET',
        path: `/api/connectors/${fixture.id}`,
        id: fixture.id,
        as: OTHER_BUILDER,
      });
    });

    it('RF-102 creates a connector owned by the Creator for the route characterization', () => {
      expectOwnedConnectorFixture(fixture);
      expect(response).toMatchObject({
        status: 200,
        body: { id: fixture.id, createdBy: CREATOR.id },
      });
    });

    it('allows another Builder to read the connector, matching the published read-any cell', () => {
      expect(response).toMatchObject({ status: 200, body: { id: fixture.id } });
    });
  });

  describe('patch credential', () => {
    let fixture: Awaited<ReturnType<typeof connectorFixture>>;
    let response: Awaited<ReturnType<ReturnType<typeof installRbacHarness>['call']>>;

    beforeEach(async () => {
      fixture = await connectorFixture();
      configureConnectorRuntime(fixture.stores);
      const harness = installRbacHarness([CREATOR, OTHER_BUILDER]);
      rotateConnectorCredentialObservation.calls = 0;

      response = await harness.call(patchConnectorRoute, {
        method: 'PATCH',
        path: `/api/connectors/${fixture.id}`,
        id: fixture.id,
        as: OTHER_BUILDER,
        body: { credential: 'replacement-secret' },
      });
    });

    it('RF-102 creates a connector owned by the Creator for the route characterization', () => {
      expectOwnedConnectorFixture(fixture);
      expect(rotateConnectorCredentialObservation.calls).toBe(0);
    });

    it('denies another Builder before rotating the connector credential', () => {
      expect({
        response,
        rotateConnectorCredentialCalls: rotateConnectorCredentialObservation.calls,
      }).toMatchObject({
        response: { status: 403, body: { error: { code: 'forbidden' } } },
        rotateConnectorCredentialCalls: 0,
      });
    });
  });

  describe('delete', () => {
    let fixture: Awaited<ReturnType<typeof connectorFixture>>;
    let response: Awaited<ReturnType<ReturnType<typeof installRbacHarness>['call']>>;
    let remaining: Awaited<ReturnType<ReturnType<ConnectorsStoreProvider['forWorkspace']>['get']>> =
      null;

    beforeEach(async () => {
      fixture = await connectorFixture();
      configureConnectorRuntime(fixture.stores);
      const harness = installRbacHarness([CREATOR, OTHER_BUILDER]);

      response = await harness.call(deleteConnectorRoute, {
        method: 'DELETE',
        path: `/api/connectors/${fixture.id}`,
        id: fixture.id,
        as: OTHER_BUILDER,
      });
      remaining = await fixture.stores.forWorkspace(TEST_WORKSPACE_ID).get(fixture.id);
    });

    it('RF-102 creates a connector owned by the Creator for the route characterization', () => {
      expectOwnedConnectorFixture(fixture);
      expect(remaining).toMatchObject({ id: fixture.id });
    });

    it('denies another Builder before deleting the connector', () => {
      expect(response).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } });
      expect(remaining).toMatchObject({ createdBy: CREATOR.id });
    });
  });

  describe('test connection', () => {
    let fixture: Awaited<ReturnType<typeof connectorFixture>>;
    let response: Awaited<ReturnType<ReturnType<typeof installRbacHarness>['call']>>;
    let probeReads = 0;

    beforeEach(async () => {
      fixture = await connectorFixture();
      probeReads = 0;
      const countingStores: ConnectorsStoreProvider = {
        forWorkspace(workspaceId) {
          const store = fixture.stores.forWorkspace(workspaceId);
          return {
            ...store,
            resolveForProbe(id) {
              probeReads += 1;
              return store.resolveForProbe(id);
            },
          };
        },
      };
      configureConnectorRuntime(countingStores);
      const harness = installRbacHarness([CREATOR, OTHER_BUILDER]);

      response = await harness.call(testConnectorRoute, {
        method: 'POST',
        path: `/api/connectors/${fixture.id}/test-connection`,
        id: fixture.id,
        as: OTHER_BUILDER,
      });
    });

    it('RF-102 creates a connector owned by the Creator for the route characterization', () => {
      expectOwnedConnectorFixture(fixture);
      expect(probeReads).toBe(0);
    });

    it('denies another Builder before resolving probe material', () => {
      expect(response).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } });
      expect(probeReads).toBe(0);
    });
  });
});
