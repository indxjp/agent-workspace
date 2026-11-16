import { randomUUID } from 'node:crypto';

import type { EndpointClientResource } from '@indx-workspace/contracts/endpoint-clients';
import { describe, expect, it } from 'vitest';

import { PATCH } from '../../app/api/endpoint-clients/[id]/route';

import {
  adminCaller,
  builderCaller,
  installEndpointClientFixture,
  ownerCaller,
} from './handlers.fixture.test-support';

const fixture = installEndpointClientFixture();
const { agentOf, createBody, createAs, mintAs, rotateAs, seedClient } = fixture;

describe('an app-backend client (ADR-0161 D4)', () => {
  const appBody = (agentIds: string[], overrides: Record<string, unknown> = {}) => ({
    name: 'portal',
    kind: 'app-backend',
    agentIds,
    oidcAudience: 'portal-web',
    ...overrides,
  });
  const patchAs = (caller: { email: string }, id: string, body: unknown) =>
    fixture.harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/endpoint-clients/${id}`,
      as: caller,
      id,
      body,
    });

  it('is created by an owner or admin with its oidcAudience and 1-64 agents', async () => {
    const created = await createAs(ownerCaller, appBody([agentOf(ownerCaller)]));
    expect(created.status).toBe(201);
    const client = (created.body as { endpointClient: EndpointClientResource }).endpointClient;
    expect(client).toMatchObject({ kind: 'app-backend', oidcAudience: 'portal-web' });
    expect(fixture.fake.audits.map((a) => a.action)).toEqual(['endpoint-client-created']);
    const byAdmin = await createAs(adminCaller, appBody([agentOf(adminCaller)], { name: 'p2' }));
    expect(byAdmin.status).toBe(201);
  });

  it('refuses a builder: its tokens act as any member who signs in to the app', async () => {
    const response = await createAs(builderCaller, appBody([agentOf(builderCaller)]));
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: 'forbidden' } });
    expect(fixture.fake.clients.size).toBe(0);
  });

  it('answers a validation problem without oidcAudience, and for it on another kind', async () => {
    const bare = { name: 'portal', kind: 'app-backend', agentIds: [agentOf(ownerCaller)] };
    const missing = await createAs(ownerCaller, bare);
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ error: { code: 'invalid_field' } });
    const stray = await createAs(
      ownerCaller,
      createBody([agentOf(ownerCaller)], { oidcAudience: 'portal-web' }),
    );
    expect(stray.status).toBe(400);
    const none = await createAs(ownerCaller, appBody([]));
    expect(none.status).toBe(400);
    expect(fixture.fake.clients.size).toBe(0);
  });

  it('refuses an agent the creator could not run', async () => {
    const response = await createAs(adminCaller, appBody([randomUUID()]));
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      error: { code: 'endpoint_client_agent_not_runnable' },
    });
  });

  it('changes its audience and agents, but takes no redirect URIs, no toolNames and no key', async () => {
    const created = await createAs(ownerCaller, appBody([agentOf(ownerCaller)]));
    const client = (created.body as { endpointClient: EndpointClientResource }).endpointClient;
    const moved = await patchAs(ownerCaller, client.id, {
      oidcAudience: 'portal-web-2',
      agentIds: [agentOf(ownerCaller), agentOf(ownerCaller)],
    });
    expect(moved.status).toBe(200);
    expect((moved.body as { endpointClient: EndpointClientResource }).endpointClient).toMatchObject(
      { oidcAudience: 'portal-web-2' },
    );
    for (const body of [
      { redirectUris: ['https://app.example/callback'] },
      { toolNames: ['a_tool'] },
    ]) {
      const refused = await patchAs(ownerCaller, client.id, body);
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({ error: { code: 'endpoint_client_invalid' } });
    }
    const key = await mintAs(ownerCaller, client.id);
    expect(key.status).toBe(400);
    expect(key.body).toMatchObject({ error: { code: 'endpoint_client_invalid' } });
    expect((await rotateAs(ownerCaller, client.id)).status).toBe(201);
  });

  it('refuses oidcAudience in a patch of another kind', async () => {
    const client = await seedClient(ownerCaller);
    const refused = await patchAs(ownerCaller, client.id, { oidcAudience: 'portal-web' });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: { code: 'endpoint_client_invalid' } });
  });
});

describe('a builder client whose acting principal is a Builder-role member', () => {
  async function builderClientOf(caller: { email: string }) {
    const created = await createAs(adminCaller, {
      name: 'builder-door',
      kind: 'builder',
      agentIds: [],
    });
    expect(created.status).toBe(201);
    const client = (created.body as { endpointClient: EndpointClientResource }).endpointClient;
    const row = fixture.fake.clients.get(client.id);
    if (row === undefined) throw new Error('the seeded client is missing');
    fixture.fake.clients.set(client.id, {
      ...row,
      actsForPrincipalId: fixture.principalIds[caller.email] ?? 'missing',
    });
    return client;
  }

  it('refuses that member changing its redirect URIs and rotating its secret', async () => {
    const client = await builderClientOf(builderCaller);
    const patch = await fixture.harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/endpoint-clients/${client.id}`,
      as: builderCaller,
      id: client.id,
      body: { redirectUris: ['https://evil.example/callback'] },
    });
    expect(patch.status).toBe(403);
    expect(patch.body).toMatchObject({ error: { code: 'forbidden' } });
    const rotation = await rotateAs(builderCaller, client.id);
    expect(rotation.status).toBe(403);
    expect(rotation.body).toMatchObject({ error: { code: 'forbidden' } });
    expect(fixture.fake.clients.get(client.id)?.redirectUris).toEqual([]);
    expect(fixture.fake.secretHashes.has(client.id)).toBe(false);
  });

  it('lets an admin change it and rotate its secret', async () => {
    const client = await builderClientOf(builderCaller);
    const patch = await fixture.harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/endpoint-clients/${client.id}`,
      as: adminCaller,
      id: client.id,
      body: { redirectUris: ['https://app.example/callback'] },
    });
    expect(patch.status).toBe(200);
    expect((await rotateAs(adminCaller, client.id)).status).toBe(201);
  });
});
