import { randomUUID } from 'node:crypto';

import type { EndpointClientResource } from '@indx-workspace/contracts/endpoint-clients';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DELETE, GET as GET_ONE, PATCH } from '../../app/api/endpoint-clients/[id]/route';
import { POST as ROTATE } from '../../app/api/endpoint-clients/[id]/secret/route';
import { POST as CREATE, GET as LIST } from '../../app/api/endpoint-clients/route';
import { clearApplicationContext } from '../application-context';
import { LOCAL_RUNTIME_API_KEY_NAME_PREFIX } from '../cli-auth/local-credential';
import { conferredBy } from '../rbac/core/conferral';
import { TEST_WORKSPACE_ID } from '../rbac/testing';

import {
  adminCaller,
  builderCaller,
  installEndpointClientFixture,
  OTHER_WORKSPACE,
  otherBuilderCaller,
  ownerCaller,
  viewerCaller,
} from './handlers.fixture.test-support';

const fixture = installEndpointClientFixture(
  () => (process.env['AW_DEPLOYMENT_POSTURE'] ?? '').trim() !== 'production',
);
const { agentOf, createBody, createAs, mintAs, seedClient } = fixture;

describe('create: the four-role matrix', () => {
  it('refuses a viewer', async () => {
    const response = await createAs(viewerCaller, createBody([agentOf(ownerCaller)]));
    expect(response.status).toBe(403);
    expect(fixture.fake.clients.size).toBe(0);
  });

  it('lets a builder bind an agent they own, and acts for them', async () => {
    const response = await createAs(builderCaller, createBody([agentOf(builderCaller)]));
    expect(response.status).toBe(201);
    const client = (response.body as { endpointClient: EndpointClientResource }).endpointClient;
    expect(client.actsForPrincipalId).toBe(fixture.principalIds[builderCaller.email]);
    expect(fixture.fake.audits.map((a) => a.action)).toEqual(['endpoint-client-created']);
  });

  it("refuses a builder binding another member's agent", async () => {
    const response = await createAs(builderCaller, createBody([agentOf(otherBuilderCaller)]));
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: 'endpoint_client_agent_not_runnable' } });
    expect(fixture.fake.clients.size).toBe(0);
  });

  it('lets a builder bind another member’s agent it was granted (ADR-0152)', async () => {
    const agent = agentOf(otherBuilderCaller);
    fixture.fake.agentGrants.add(
      `${agent}:${fixture.principalIds[builderCaller.email] ?? 'missing'}`,
    );
    const response = await createAs(builderCaller, createBody([agent]));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  });

  it('answers an absent agent the same as a foreign one', async () => {
    const response = await createAs(builderCaller, createBody([randomUUID()]));
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: 'endpoint_client_agent_not_runnable' } });
  });

  it.each([ownerCaller, adminCaller])('lets $email bind an agent they own', async (caller) => {
    const response = await createAs(caller, createBody([agentOf(caller)]));
    expect(response.status).toBe(201);
  });

  it('rejects a duplicate name with 409', async () => {
    const agent = agentOf(ownerCaller);
    expect((await createAs(ownerCaller, createBody([agent]))).status).toBe(201);
    const again = await createAs(ownerCaller, createBody([agent]));
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: { code: 'endpoint_client_name_taken' } });
  });

  it('rejects a malformed body with 400', async () => {
    const response = await createAs(ownerCaller, { name: 'x', kind: 'a2a-agent', agentIds: [] });
    expect(response.status).toBe(400);
  });
});

describe('create: API-key callers are refused', () => {
  it.each(['owner', 'admin', 'builder'] as const)('refuses a %s API key', async (role) => {
    const created = await fixture.harness.directory.forWorkspace(TEST_WORKSPACE_ID).createApiKey({
      name: `${role}-key`,
      role: conferredBy('owner', role, 'test'),
      expiresAt: null,
    });
    if (created.kind !== 'created') throw new Error(created.kind);
    const response = await fixture.harness.call(CREATE, {
      method: 'POST',
      path: '/api/endpoint-clients',
      as: null,
      bearer: created.presented,
      body: createBody([agentOf(ownerCaller)]),
    });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: 'api_key_not_permitted' } });
    expect(fixture.fake.clients.size).toBe(0);
    expect(fixture.fake.audits).toEqual([]);
  });
});

describe("the local runtime's key and an app-backend client (ADR-0161 amendment DI10, issue #2075)", () => {
  async function keyNamed(name: string): Promise<string> {
    const created = await fixture.harness.directory.forWorkspace(TEST_WORKSPACE_ID).createApiKey({
      name,
      role: conferredBy('owner', 'admin', 'test'),
      expiresAt: null,
    });
    if (created.kind !== 'created') throw new Error(created.kind);
    return created.presented;
  }
  const localKey = () => keyNamed(`${LOCAL_RUNTIME_API_KEY_NAME_PREFIX}AAAAAAAA`);
  const appBackend = () =>
    createBody([agentOf(ownerCaller)], {
      name: 'desk',
      kind: 'app-backend',
      oidcAudience: 'desk',
    });
  const createWith = (bearer: string, body: unknown) =>
    fixture.harness.call(CREATE, {
      method: 'POST',
      path: '/api/endpoint-clients',
      as: null,
      bearer,
      body,
    });
  const rotateWith = (bearer: string, id: string) =>
    fixture.harness.call(ROTATE, {
      method: 'POST',
      path: `/api/endpoint-clients/${id}/secret`,
      as: null,
      bearer,
      id,
    });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('creates an app-backend client and rotates its secret in the local posture', async () => {
    const bearer = await localKey();
    const created = await createWith(bearer, appBackend());
    expect(created.status).toBe(201);
    const client = (created.body as { endpointClient: EndpointClientResource }).endpointClient;
    expect(client).toMatchObject({ kind: 'app-backend', oidcAudience: 'desk' });
    const rotated = await rotateWith(bearer, client.id);
    expect(rotated.status).toBe(201);
    expect(fixture.fake.audits.map((audit) => audit.action)).toEqual([
      'endpoint-client-created',
      'oauth-client-secret-rotated',
    ]);
  });

  it('still refuses every other kind, with the code it answered before', async () => {
    const bearer = await localKey();
    const response = await createWith(bearer, createBody([agentOf(ownerCaller)]));
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: 'api_key_not_permitted' } });
    const other = await seedClient(ownerCaller);
    const rotated = await rotateWith(bearer, other.id);
    expect(rotated.status).toBe(403);
    expect(rotated.body).toMatchObject({ error: { code: 'local_runtime_key_not_permitted' } });
  });

  it('still refuses every other API key, an app-backend client included', async () => {
    const bearer = await keyNamed('ordinary-admin-key');
    const response = await createWith(bearer, appBackend());
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: 'api_key_not_permitted' } });
    const seeded = await createAs(ownerCaller, appBackend());
    const client = (seeded.body as { endpointClient: EndpointClientResource }).endpointClient;
    const rotated = await rotateWith(bearer, client.id);
    expect(rotated.status).toBe(403);
    expect(rotated.body).toMatchObject({ error: { code: 'api_key_not_permitted' } });
  });

  it("refuses the local runtime's key under the production posture", async () => {
    const bearer = await localKey();
    const seeded = await createAs(ownerCaller, appBackend());
    const client = (seeded.body as { endpointClient: EndpointClientResource }).endpointClient;
    vi.stubEnv('AW_DEPLOYMENT_POSTURE', 'production');
    const response = await createWith(bearer, appBackend());
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: 'api_key_not_permitted' } });
    const rotated = await rotateWith(bearer, client.id);
    expect(rotated.status).toBe(403);
    expect(rotated.body).toMatchObject({ error: { code: 'local_runtime_key_not_permitted' } });
  });
});

describe('tenant isolation: one 404 for absent, foreign and malformed ids', () => {
  it('answers identically for a client in another workspace, a random id and a non-id', async () => {
    const foreign = randomUUID();
    fixture.fake.clients.set(foreign, {
      id: foreign,
      workspaceId: OTHER_WORKSPACE,
      name: 'theirs',
      kind: 'a2a-agent',
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
    const codes = new Set<string>();
    for (const id of [foreign, randomUUID(), 'not-an-id']) {
      for (const [handler, method, body] of [
        [GET_ONE, 'GET', undefined],
        [PATCH, 'PATCH', { toolNames: null }],
        [DELETE, 'DELETE', undefined],
      ] as const) {
        const response = await fixture.harness.call(handler, {
          method,
          path: `/api/endpoint-clients/${id}`,
          as: ownerCaller,
          id,
          ...(body === undefined ? {} : { body }),
        });
        expect(response.status, `${method} ${id}`).toBe(404);
        codes.add(JSON.stringify((response.body as { error: { code: string } }).error.code));
      }
      expect((await mintAs(ownerCaller, id)).status).toBe(404);
    }
    expect(codes.size).toBe(1);
    expect(fixture.fake.clients.get(foreign)?.revokedAt).toBeNull();
  });

  it('lists only the caller workspace', async () => {
    await seedClient(ownerCaller);
    fixture.fake.clients.set('x', {
      id: 'x',
      workspaceId: OTHER_WORKSPACE,
      name: 'theirs',
      kind: 'a2a-agent',
      agentIds: [randomUUID()],
      toolNames: null,
      actsForPrincipalId: 'p',
      apiKeyIds: [],
      redirectUris: [],
      oidcAudience: null,
      hasClientSecret: false,
      revokedAt: null,
      createdAt: '',
      updatedAt: '',
    });
    const response = await fixture.harness.call(LIST, {
      method: 'GET',
      path: '/api/endpoint-clients',
      as: ownerCaller,
    });
    expect(response.status).toBe(200);
    expect((response.body as { endpointClients: unknown[] }).endpointClients).toHaveLength(1);
  });
});

describe('own versus other', () => {
  it("refuses a builder changing, revoking or keying another member's client", async () => {
    const client = await seedClient(ownerCaller);
    const patch = await fixture.harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/endpoint-clients/${client.id}`,
      as: builderCaller,
      id: client.id,
      body: { toolNames: null },
    });
    const revoke = await fixture.harness.call(DELETE, {
      method: 'DELETE',
      path: `/api/endpoint-clients/${client.id}`,
      as: builderCaller,
      id: client.id,
    });
    expect(patch.status).toBe(403);
    expect(revoke.status).toBe(403);
    expect((await mintAs(builderCaller, client.id)).status).toBe(403);
    expect(fixture.fake.clients.get(client.id)?.revokedAt).toBeNull();
  });

  it("lets an admin revoke another member's client", async () => {
    const client = await seedClient(builderCaller);
    const revoke = await fixture.harness.call(DELETE, {
      method: 'DELETE',
      path: `/api/endpoint-clients/${client.id}`,
      as: adminCaller,
      id: client.id,
    });
    expect(revoke.status).toBe(200);
  });
});

describe('without a runtime', () => {
  it('answers 503', async () => {
    clearApplicationContext();
    const response = await fixture.harness.call(LIST, {
      method: 'GET',
      path: '/api/endpoint-clients',
      as: ownerCaller,
    });
    expect(response.status).toBe(503);
  });
});
