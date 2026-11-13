import { randomUUID } from 'node:crypto';
import { log as webLogger } from '../telemetry/logger';

import type { EndpointClientResource } from '@indx-workspace/contracts/endpoint-clients';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DELETE, PATCH } from '../../app/api/endpoint-clients/[id]/route';
import { applicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { TEST_WORKSPACE_ID } from '../rbac/testing';
import type { ToolEndpointEnvironment } from '../tool-endpoint/env';

import {
  adminCaller,
  builderCaller,
  installEndpointClientFixture,
  OTHER_WORKSPACE,
  otherBuilderCaller,
  ownerCaller,
  viewerCaller,
} from './handlers.fixture.test-support';

const fixture = installEndpointClientFixture();
const { agentOf, createBody, createAs, mintAs, seedClient } = fixture;

describe('revoke and update', () => {
  it('is idempotent and leaves one audit row', async () => {
    const client = await seedClient(ownerCaller);
    for (let i = 0; i < 2; i += 1) {
      const response = await fixture.harness.call(DELETE, {
        method: 'DELETE',
        path: `/api/endpoint-clients/${client.id}`,
        as: ownerCaller,
        id: client.id,
      });
      expect(response.status).toBe(200);
      expect(
        (response.body as { endpointClient: EndpointClientResource }).endpointClient.revokedAt,
      ).not.toBeNull();
    }
    expect(fixture.fake.audits.filter((a) => a.action === 'endpoint-client-revoked')).toHaveLength(
      1,
    );
  });

  it('writes one api-key-revoked row per bound key, on the first revoke only', async () => {
    const client = await seedClient(ownerCaller);
    const first = await mintAs(ownerCaller, client.id, 'key-one');
    const second = await mintAs(ownerCaller, client.id, 'key-two');
    const keyIds = [first, second].map((r) => (r.body as { apiKey: { id: string } }).apiKey.id);
    for (let i = 0; i < 2; i += 1) {
      await fixture.harness.call(DELETE, {
        method: 'DELETE',
        path: `/api/endpoint-clients/${client.id}`,
        as: ownerCaller,
        id: client.id,
      });
    }
    expect(fixture.fake.audits.filter((a) => a.action === 'api-key-revoked')).toEqual([
      { action: 'api-key-revoked', subjectId: keyIds[0], subjectLabel: 'key-one' },
      { action: 'api-key-revoked', subjectId: keyIds[1], subjectLabel: 'key-two' },
    ]);
  });
});

describe('revoke and update: concurrent revocation', () => {
  it('answers 409 when the client is revoked between the read and the row lock', async () => {
    const client = await seedClient(ownerCaller);
    const runtime = applicationContext()?.endpointClients ?? null;
    if (runtime === null) throw new Error('runtime not installed');
    installTestDomains({
      endpointClients: {
        ...runtime,
        update: () => Promise.resolve({ kind: 'revoked' }),
      },
    });
    const response = await fixture.harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/endpoint-clients/${client.id}`,
      as: ownerCaller,
      id: client.id,
      body: { agentIds: [agentOf(ownerCaller)] },
    });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: 'endpoint_client_revoked' } });
    expect(fixture.fake.audits.map((a) => a.action)).toEqual(['endpoint-client-created']);
  });

  it('refuses to change or key a revoked client with 409', async () => {
    const client = await seedClient(ownerCaller);
    await fixture.harness.call(DELETE, {
      method: 'DELETE',
      path: `/api/endpoint-clients/${client.id}`,
      as: ownerCaller,
      id: client.id,
    });
    const patch = await fixture.harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/endpoint-clients/${client.id}`,
      as: ownerCaller,
      id: client.id,
      body: { agentIds: [agentOf(ownerCaller)] },
    });
    expect(patch.status).toBe(409);
    const mint = await mintAs(ownerCaller, client.id);
    expect(mint.status).toBe(409);
    expect(mint.body).toMatchObject({ error: { code: 'endpoint_client_revoked' } });
  });
});

describe('revoke and update: client shape', () => {
  it('keeps an a2a-agent client to exactly one agent and no tool names', async () => {
    const client = await seedClient(ownerCaller);
    const two = await fixture.harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/endpoint-clients/${client.id}`,
      as: ownerCaller,
      id: client.id,
      body: { agentIds: [agentOf(ownerCaller), agentOf(ownerCaller)] },
    });
    expect(two.status).toBe(400);
    expect(two.body).toMatchObject({ error: { code: 'endpoint_client_invalid' } });
    const tools = await fixture.harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/endpoint-clients/${client.id}`,
      as: ownerCaller,
      id: client.id,
      body: { toolNames: ['a_tool'] },
    });
    expect(tools.status).toBe(400);
  });

  it('creates a builder client with no agent, and keeps it that way and keyless', async () => {
    const body = { name: 'builder-door', kind: 'builder', agentIds: [] };
    expect((await createAs(viewerCaller, body)).status).toBe(403);
    const byBuilder = await createAs(builderCaller, body);
    expect(byBuilder.status).toBe(403);
    expect(byBuilder.body).toMatchObject({ error: { code: 'forbidden' } });
    expect((await createAs(adminCaller, { ...body, name: 'by-admin' })).status).toBe(201);
    const created = await createAs(ownerCaller, body);
    expect(created.status).toBe(201);
    const client = (created.body as { endpointClient: EndpointClientResource }).endpointClient;
    expect(client).toMatchObject({ kind: 'builder', agentIds: [] });

    const bind = await fixture.harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/endpoint-clients/${client.id}`,
      as: ownerCaller,
      id: client.id,
      body: { agentIds: [agentOf(ownerCaller)] },
    });
    expect(bind.status).toBe(400);
    expect(bind.body).toMatchObject({ error: { code: 'endpoint_client_invalid' } });
    const key = await mintAs(ownerCaller, client.id);
    expect(key.status).toBe(400);
    expect(key.body).toMatchObject({ error: { code: 'endpoint_client_invalid' } });
  });

  it('re-checks that a replaced agent is runnable by the caller', async () => {
    const client = await seedClient(builderCaller);
    const response = await fixture.harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/endpoint-clients/${client.id}`,
      as: builderCaller,
      id: client.id,
      body: { agentIds: [agentOf(otherBuilderCaller)] },
    });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: 'endpoint_client_agent_not_runnable' } });
  });
});

describe('revoking closes the client tool sandbox', () => {
  const closeSandbox = vi.fn<ToolEndpointEnvironment['closeSandbox']>();

  beforeEach(() => {
    closeSandbox.mockReset();
    closeSandbox.mockResolvedValue(undefined);
    installTestDomains({
      toolEndpoint: {
        kind: 'serving',
        environment: { closeSandbox } as unknown as ToolEndpointEnvironment,
      },
    });
  });

  async function revokeAs(caller: { email: string }, id: string) {
    return fixture.harness.call(DELETE, {
      method: 'DELETE',
      path: `/api/endpoint-clients/${id}`,
      as: caller,
      id,
    });
  }

  async function seedProject(caller: { email: string }) {
    const created = await createAs(caller, createBody([agentOf(caller)], { kind: 'mcp-project' }));
    expect(created.status).toBe(201);
    return (created.body as { endpointClient: EndpointClientResource }).endpointClient;
  }

  it('closes an mcp-project sandbox once, in the caller workspace, and not again on a repeat', async () => {
    const client = await seedProject(ownerCaller);
    expect((await revokeAs(ownerCaller, client.id)).status).toBe(200);
    expect((await revokeAs(ownerCaller, client.id)).status).toBe(200);
    expect(closeSandbox).toHaveBeenCalledTimes(1);
    expect(closeSandbox).toHaveBeenCalledWith(TEST_WORKSPACE_ID, client.id);
  });

  it('does not close for an a2a-agent client', async () => {
    const client = await seedClient(ownerCaller);
    expect((await revokeAs(ownerCaller, client.id)).status).toBe(200);
    expect(closeSandbox).not.toHaveBeenCalled();
  });

  it("does not close another workspace's client, and answers 404", async () => {
    const foreign = randomUUID();
    fixture.fake.clients.set(foreign, {
      id: foreign,
      workspaceId: OTHER_WORKSPACE,
      name: 'theirs',
      kind: 'mcp-project',
      agentIds: [randomUUID()],
      toolNames: null,
      actsForPrincipalId: 'p',
      apiKeyIds: [],
      redirectUris: [],
      oidcAudience: null,
      hasClientSecret: false,
      revokedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect((await revokeAs(ownerCaller, foreign)).status).toBe(404);
    expect(closeSandbox).not.toHaveBeenCalled();
  });

  it('still revokes, and writes every audit row, when the close fails', async () => {
    const log = vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    try {
      closeSandbox.mockRejectedValue(new Error('runner unreachable'));
      const client = await seedProject(ownerCaller);
      await mintAs(ownerCaller, client.id);
      const response = await revokeAs(ownerCaller, client.id);
      expect(response.status).toBe(200);
      expect(fixture.fake.clients.get(client.id)?.revokedAt).not.toBeNull();
      expect(fixture.fake.audits.map((a) => a.action)).toEqual([
        'endpoint-client-created',
        'api-key-created',
        'endpoint-client-revoked',
        'api-key-revoked',
      ]);
    } finally {
      log.mockRestore();
    }
  });
});
