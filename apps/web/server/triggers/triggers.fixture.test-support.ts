import type { TriggerResource } from '@indx-workspace/contracts/triggers';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect } from 'vitest';
import { POST as FIRE } from '../../app/api/triggers/[id]/fire/[secret]/route';
import { POST as CREATE } from '../../app/api/triggers/route';
import { clearApplicationContext } from '../application-context';
import { resetTestRunApi } from '../application-context-fixtures';
import { clearEngineImagesConfiguredForTests } from '../engines/images';
import { clearFeatureSwitches } from '../features/runtime';
import { installRbacHarness, TEST_WORKSPACE_ID, type RbacHarness } from '../rbac/testing';
import { installTriggerFakes, type TriggerTestState } from './triggers.runtime.test-support';

export const ownerCaller = { email: 'owner@example.com' };
export const adminCaller = { email: 'admin@example.com' };
export const builderCaller = { email: 'builder@example.com' };
export const otherBuilderCaller = { email: 'other-builder@example.com' };
export const viewerCaller = { email: 'viewer@example.com' };

export interface Created {
  readonly trigger: TriggerResource;
  readonly secret: string;
  readonly firePath: string;
}

interface TriggerFixtureState {
  readonly harness: RbacHarness;
  readonly state: TriggerTestState;
  readonly principalIds: Record<string, string>;
}

export function installTriggerFixture() {
  let current: TriggerFixtureState | undefined;
  const read = (): TriggerFixtureState => {
    if (current === undefined) throw new Error('Trigger fixture has not been installed.');
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
    const memberships = await harness.directory.forWorkspace(TEST_WORKSPACE_ID).listMemberships();
    const principalIds = Object.fromEntries(memberships.map((m) => [m.email, m.principalId]));
    const state = installTriggerFakes(harness);
    current = { harness, principalIds, state };
  });
  afterEach(() => {
    clearFeatureSwitches();
    clearEngineImagesConfiguredForTests();
    resetTestRunApi();
    clearApplicationContext();
    read().harness.teardown();
    current = undefined;
  });

  return {
    ...triggerRequests(read),
    get harness() {
      return read().harness;
    },
    get state() {
      return read().state;
    },
    get principalIds() {
      return read().principalIds;
    },
  };
}

function triggerRequests(read: () => TriggerFixtureState) {
  function agentOf(caller: { email: string }): string {
    const id = randomUUID();
    read().state.agentOwners.set(id, read().principalIds[caller.email] ?? 'missing');
    return id;
  }

  const createBody = (agentId: string, overrides: Record<string, unknown> = {}) => ({
    kind: 'webhook',
    name: 'inbox',
    agentId,
    prompt: 'Handle this: {{body}}',
    ...overrides,
  });

  const createAs = (caller: { email: string }, body: unknown) =>
    read().harness.call(CREATE, { method: 'POST', path: '/api/triggers', as: caller, body });

  async function seed(
    caller: { email: string } = builderCaller,
    overrides: Record<string, unknown> = {},
  ): Promise<Created> {
    const response = await createAs(caller, createBody(agentOf(caller), overrides));
    expect(response.status).toBe(201);
    return response.body as Created;
  }

  async function fireRaw(
    id: string,
    secret: string,
    init: { body?: string; headers?: Record<string, string>; query?: string } = {},
  ) {
    const response = await FIRE(
      new Request(
        `https://control-plane.test/api/triggers/${id}/fire/${secret}${init.query ?? ''}`,
        {
          method: 'POST',
          headers: init.headers ?? {},
          ...(init.body === undefined ? {} : { body: init.body }),
        },
      ),
      { params: Promise.resolve({ id, secret }) },
    );
    const text = await response.text();
    return { status: response.status, text, headers: response.headers, response };
  }

  const jsonOf = (text: string): unknown => JSON.parse(text) as unknown;

  return { agentOf, createBody, createAs, seed, fireRaw, jsonOf };
}
