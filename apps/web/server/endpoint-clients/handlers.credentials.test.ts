import { randomUUID } from 'node:crypto';
import { captureLog } from '../telemetry/capture-log';

import type { EndpointClientResource } from '@indx-workspace/contracts/endpoint-clients';
import { describe, expect, it, vi } from 'vitest';

import { POST as MINT } from '../../app/api/endpoint-clients/[id]/keys/route';
import { DELETE, GET as GET_ONE, PATCH } from '../../app/api/endpoint-clients/[id]/route';
import { POST as ROTATE } from '../../app/api/endpoint-clients/[id]/secret/route';
import { GET as LIST } from '../../app/api/endpoint-clients/route';
import { POST as TOKEN } from '../../app/oauth/token/route';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { LOCAL_RUNTIME_API_KEY_NAME_PREFIX } from '../cli-auth/local-credential';
import { resetOAuthLimits } from '../oauth/limits';
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

const fixture = installEndpointClientFixture();
const { agentOf, createBody, createAs, mintAs, rotateAs, seedClient } = fixture;

const secretOf = (response: { body: unknown }): string =>
  (response.body as { clientSecret: string }).clientSecret;

describe('minting a key', () => {
  it('shows the plaintext once, in the mint response only', async () => {
    const client = await seedClient(ownerCaller);
    const mint = await mintAs(ownerCaller, client.id);
    expect(mint.status).toBe(201);
    expect(mint.body).toMatchObject({ key: 'aw_live_PLAINTEXT-SECRET-VALUE' });

    await fixture.harness.call(GET_ONE, {
      method: 'GET',
      path: `/api/endpoint-clients/${client.id}`,
      as: ownerCaller,
      id: client.id,
    });
    await fixture.harness.call(LIST, {
      method: 'GET',
      path: '/api/endpoint-clients',
      as: ownerCaller,
    });

    const carrying = fixture.harness.responses.filter((r) =>
      r.text.includes('PLAINTEXT-SECRET-VALUE'),
    );
    expect(carrying).toHaveLength(1);
    expect(carrying[0]?.method).toBe('POST');
    expect(JSON.stringify(fixture.fake.audits)).not.toContain('PLAINTEXT-SECRET-VALUE');
    expect(fixture.fake.audits.map((a) => a.action)).toEqual([
      'endpoint-client-created',
      'api-key-created',
    ]);
  });

  it('never writes the plaintext secret to a log', async () => {
    const capture = captureLog();
    try {
      const client = await seedClient(ownerCaller);
      const mint = await mintAs(ownerCaller, client.id);
      expect(mint.body).toMatchObject({ key: 'aw_live_PLAINTEXT-SECRET-VALUE' });
      await fixture.harness.call(DELETE, {
        method: 'DELETE',
        path: `/api/endpoint-clients/${client.id}`,
        as: ownerCaller,
        id: client.id,
      });
      expect(capture.text()).not.toContain('PLAINTEXT-SECRET-VALUE');
    } finally {
      capture.restore();
    }
  });
});

describe('minting a key: refusals', () => {
  it('refuses a viewer and a taken name', async () => {
    const client = await seedClient(ownerCaller);
    expect((await mintAs(viewerCaller, client.id)).status).toBe(403);
    expect((await mintAs(ownerCaller, client.id, 'dup')).status).toBe(201);
    expect((await mintAs(ownerCaller, client.id, 'dup')).status).toBe(409);
  });

  it("refuses the local runtime's key (ADR-0109, S1-21)", async () => {
    const client = await seedClient(ownerCaller);
    const created = await fixture.harness.directory.forWorkspace(TEST_WORKSPACE_ID).createApiKey({
      name: `${LOCAL_RUNTIME_API_KEY_NAME_PREFIX}AAAAAAAA`,
      role: conferredBy('owner', 'admin', 'test'),
      expiresAt: null,
    });
    if (created.kind !== 'created') throw new Error(created.kind);
    const response = await fixture.harness.call(MINT, {
      method: 'POST',
      path: `/api/endpoint-clients/${client.id}/keys`,
      as: null,
      bearer: created.presented,
      id: client.id,
      body: { name: 'outlives-the-run' },
    });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: 'local_runtime_key_not_permitted' } });
    expect(fixture.fake.keyNames.size).toBe(0);
  });

  it('refuses a key name carrying the reserved local-runtime prefix', async () => {
    const client = await seedClient(ownerCaller);
    const response = await mintAs(ownerCaller, client.id, `${LOCAL_RUNTIME_API_KEY_NAME_PREFIX}x`);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'reserved_name' } });
    expect(fixture.fake.keyNames.size).toBe(0);
  });
});

describe('rotating the OAuth client secret', () => {
  it.each([ownerCaller, adminCaller])(
    'lets $email rotate and shows the secret once',
    async (caller) => {
      const client = await seedClient(caller);
      const rotated = await rotateAs(caller, client.id);
      expect(rotated.status).toBe(201);
      const secret = secretOf(rotated);
      expect(secret).toMatch(/^awcs_live_[A-Za-z0-9_-]{43}$/u);
      expect(rotated.body).toMatchObject({ clientId: client.id });
      expect(fixture.fake.secretHashes.get(client.id)).toMatch(/^[0-9a-f]{64}$/u);
      expect(fixture.fake.secretHashes.get(client.id)).not.toContain(secret);

      await fixture.harness.call(GET_ONE, {
        method: 'GET',
        path: `/api/endpoint-clients/${client.id}`,
        as: caller,
        id: client.id,
      });
      await fixture.harness.call(LIST, {
        method: 'GET',
        path: '/api/endpoint-clients',
        as: caller,
      });
      expect(fixture.harness.responses.filter((r) => r.text.includes(secret))).toHaveLength(1);
      expect(JSON.stringify(fixture.fake.audits)).not.toContain(secret);
      expect(fixture.fake.audits.at(-1)).toMatchObject({
        action: 'oauth-client-secret-rotated',
        subjectId: client.id,
      });
    },
  );

  it('replaces the previous secret on each rotation', async () => {
    const client = await seedClient(ownerCaller);
    await rotateAs(ownerCaller, client.id);
    const first = fixture.fake.secretHashes.get(client.id);
    await rotateAs(ownerCaller, client.id);
    expect(fixture.fake.secretHashes.get(client.id)).not.toBe(first);
    expect(
      fixture.fake.audits.filter((a) => a.action === 'oauth-client-secret-rotated'),
    ).toHaveLength(2);
  });
});

describe('rotating the OAuth client secret: token exchange', () => {
  it('refuses the old secret at /oauth/token after a rotation and accepts the new one', async () => {
    vi.stubEnv('AW_PUBLIC_URL', 'https://aw.example');
    resetOAuthLimits();
    installTestDomains({
      oauth: {
        findClient: (id) => {
          const client = fixture.fake.clients.get(id);
          if (client === undefined || client.revokedAt !== null) return Promise.resolve(null);
          return Promise.resolve({
            ...client,
            clientSecretHash: fixture.fake.secretHashes.get(id) ?? null,
            resourcePath: '/api/a2a/agents/helper',
          });
        },
        canRunAll: () => Promise.resolve(true),
        agentNames: () => Promise.resolve(null),
        tokens: () =>
          Promise.resolve({
            issue: () => Promise.resolve(),
            consume: () => Promise.resolve({ kind: 'invalid' }),
            revokeFamily: () => Promise.resolve(0),
            revoke: () => Promise.resolve(null),
          }),
        audit: () => Promise.resolve(),
        findMember: () => Promise.resolve(null),
        issueExchanged: () => Promise.resolve(),
      },
    });
    try {
      const client = await seedClient(ownerCaller);
      const oldSecret = secretOf(await rotateAs(ownerCaller, client.id));
      const newSecret = secretOf(await rotateAs(ownerCaller, client.id));
      const exchange = (secret: string) =>
        TOKEN(
          new Request('https://aw.example/oauth/token', {
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              authorization: `Basic ${btoa(`${client.id}:${secret}`)}`,
            },
            body: 'grant_type=client_credentials',
          }),
        );

      const stale = await exchange(oldSecret);
      expect(stale.status).toBe(401);
      expect(await stale.json()).toMatchObject({ error: 'invalid_client' });
      expect((await exchange(newSecret)).status).toBe(200);
    } finally {
      clearApplicationContext();
      resetOAuthLimits();
      vi.unstubAllEnvs();
    }
  });
});

describe('rotating the OAuth client secret: authorization', () => {
  it("lets a builder rotate their own client but not another member's", async () => {
    const own = await seedClient(builderCaller);
    expect((await rotateAs(builderCaller, own.id)).status).toBe(201);
    const created = await createAs(
      ownerCaller,
      createBody([agentOf(ownerCaller)], { name: 'owners' }),
    );
    const theirs = (created.body as { endpointClient: EndpointClientResource }).endpointClient;
    expect((await rotateAs(builderCaller, theirs.id)).status).toBe(403);
    expect((await rotateAs(otherBuilderCaller, own.id)).status).toBe(403);
    expect(fixture.fake.secretHashes.has(theirs.id)).toBe(false);
  });

  it('refuses a viewer', async () => {
    const client = await seedClient(ownerCaller);
    expect((await rotateAs(viewerCaller, client.id)).status).toBe(403);
    expect(fixture.fake.secretHashes.size).toBe(0);
  });

  it.each(['owner', 'admin', 'builder'] as const)('refuses a %s API key', async (role) => {
    const client = await seedClient(ownerCaller);
    const created = await fixture.harness.directory.forWorkspace(TEST_WORKSPACE_ID).createApiKey({
      name: `${role}-key`,
      role: conferredBy('owner', role, 'test'),
      expiresAt: null,
    });
    if (created.kind !== 'created') throw new Error(created.kind);
    const response = await fixture.harness.call(ROTATE, {
      method: 'POST',
      path: `/api/endpoint-clients/${client.id}/secret`,
      as: null,
      bearer: created.presented,
      id: client.id,
    });
    expect(response.status).toBe(403);
    expect(fixture.fake.secretHashes.size).toBe(0);
  });
});

describe('rotating the OAuth client secret: isolation and revocation', () => {
  it('answers one 404 for a foreign, an absent and a malformed id', async () => {
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
      createdAt: '',
      updatedAt: '',
    });
    const codes = new Set<string>();
    for (const id of [foreign, randomUUID(), 'not-an-id']) {
      const response = await rotateAs(ownerCaller, id);
      expect(response.status).toBe(404);
      codes.add((response.body as { error: { code: string } }).error.code);
    }
    expect(codes.size).toBe(1);
    expect(fixture.fake.secretHashes.size).toBe(0);
  });

  it('refuses a revoked client with 409', async () => {
    const client = await seedClient(ownerCaller);
    await fixture.harness.call(DELETE, {
      method: 'DELETE',
      path: `/api/endpoint-clients/${client.id}`,
      as: ownerCaller,
      id: client.id,
    });
    const response = await rotateAs(ownerCaller, client.id);
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: 'endpoint_client_revoked' } });
  });

  it('never writes the secret to a log', async () => {
    const capture = captureLog();
    try {
      const client = await seedClient(ownerCaller);
      const secret = secretOf(await rotateAs(ownerCaller, client.id));
      expect(capture.text()).not.toContain(secret);
    } finally {
      capture.restore();
    }
  });
});

describe('redirect URIs', () => {
  const patchUris = async (id: string, redirectUris: unknown) =>
    fixture.harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/endpoint-clients/${id}`,
      as: ownerCaller,
      id,
      body: { redirectUris },
    });

  it('stores https and loopback addresses', async () => {
    const client = await seedClient(ownerCaller);
    const response = await patchUris(client.id, [
      'https://platform.example/callback',
      'http://127.0.0.1:8123/cb',
    ]);
    expect(response.status).toBe(200);
    expect(fixture.fake.clients.get(client.id)?.redirectUris).toHaveLength(2);
  });

  it.each([
    ['plain http on a public host', ['http://platform.example/cb']],
    ['a fragment', ['https://platform.example/cb#x']],
    ['embedded credentials', ['https://user:pw@platform.example/cb']],
    ['a non-URL', ['not a url']],
    ['more than ten', Array.from({ length: 11 }, (_, i) => `https://p${String(i)}.example/cb`)],
  ])('refuses %s', async (_label, uris) => {
    const client = await seedClient(ownerCaller);
    expect((await patchUris(client.id, uris)).status).toBe(400);
    expect(fixture.fake.clients.get(client.id)?.redirectUris).toEqual([]);
  });
});
