import type { EndpointClientResource } from '@indx-workspace/contracts/endpoint-clients';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect } from 'vitest';
import { POST as MINT } from '../../app/api/endpoint-clients/[id]/keys/route';
import { POST as ROTATE } from '../../app/api/endpoint-clients/[id]/secret/route';
import { POST as CREATE } from '../../app/api/endpoint-clients/route';
import { clearApplicationContext } from '../application-context';
import { installRbacHarness, TEST_WORKSPACE_ID, type RbacHarness } from '../rbac/testing';
import {
  installEndpointClientRuntime,
  type EndpointClientState,
} from './handlers.runtime.test-support';

export const OTHER_WORKSPACE = 'some-other-workspace';
export const ownerCaller = { email: 'owner@example.com' };
export const adminCaller = { email: 'admin@example.com' };
export const builderCaller = { email: 'builder@example.com' };
export const otherBuilderCaller = { email: 'other-builder@example.com' };
export const viewerCaller = { email: 'viewer@example.com' };

interface EndpointClientFixtureState {
  readonly harness: RbacHarness;
  readonly fake: EndpointClientState;
  readonly principalIds: Record<string, string>;
}

export function installEndpointClientFixture(isLocalPosture: () => boolean = () => true) {
  let current: EndpointClientFixtureState | undefined;
  const read = (): EndpointClientFixtureState => {
    if (current === undefined) throw new Error('Endpoint-client fixture has not been installed.');
    return current;
  };
  beforeEach(async () => {
    const harness = installRbacHarness([
      { email: ownerCaller.email, name: 'Owner', workspaceId: TEST_WORKSPACE_ID, role: 'owner' },
      { email: adminCaller.email, name: 'Admin', workspaceId: TEST_WORKSPACE_ID, role: 'admin' },
      {
        email: builderCaller.email,
        name: 'Builder',
        workspaceId: TEST_WORKSPACE_ID,
        role: 'builder',
      },
      {
        email: otherBuilderCaller.email,
        name: 'Other',
        workspaceId: TEST_WORKSPACE_ID,
        role: 'builder',
      },
      { email: viewerCaller.email, name: 'Viewer', workspaceId: TEST_WORKSPACE_ID, role: 'viewer' },
    ]);
    const fake = installEndpointClientRuntime(isLocalPosture);
    const memberships = await harness.directory.forWorkspace(TEST_WORKSPACE_ID).listMemberships();
    const principalIds = Object.fromEntries(memberships.map((m) => [m.email, m.principalId]));
    current = { harness, fake, principalIds };
  });
  afterEach(() => {
    clearApplicationContext();
    read().harness.teardown();
    current = undefined;
  });

  return {
    ...endpointClientRequests(read),
    get harness() {
      return read().harness;
    },
    get fake() {
      return read().fake;
    },
    get principalIds() {
      return read().principalIds;
    },
  };
}

function endpointClientRequests(read: () => EndpointClientFixtureState) {
  /** An agent the given caller owns. */
  function agentOf(caller: { email: string }): string {
    const id = randomUUID();
    read().fake.agentOwners.set(id, read().principalIds[caller.email] ?? 'missing');
    return id;
  }

  function createBody(agentIds: string[], overrides: Record<string, unknown> = {}) {
    return { name: 'support-bot', kind: 'a2a-agent', agentIds, ...overrides };
  }

  async function createAs(caller: { email: string }, body: unknown) {
    return read().harness.call(CREATE, {
      method: 'POST',
      path: '/api/endpoint-clients',
      as: caller,
      body,
    });
  }

  async function mintAs(caller: { email: string }, id: string, name = 'key-one') {
    return read().harness.call(MINT, {
      method: 'POST',
      path: `/api/endpoint-clients/${id}/keys`,
      as: caller,
      id,
      body: { name },
    });
  }

  async function rotateAs(caller: { email: string }, id: string) {
    return read().harness.call(ROTATE, {
      method: 'POST',
      path: `/api/endpoint-clients/${id}/secret`,
      as: caller,
      id,
    });
  }

  async function seedClient(caller: { email: string }) {
    const created = await createAs(caller, createBody([agentOf(caller)]));
    expect(created.status).toBe(201);
    return (created.body as { endpointClient: EndpointClientResource }).endpointClient;
  }

  return { agentOf, createBody, createAs, mintAs, rotateAs, seedClient };
}
