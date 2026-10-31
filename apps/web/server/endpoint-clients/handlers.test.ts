/**
 * `/api/endpoint-clients` (issue #949, ADR-0134): the four-role matrix, tenant isolation, the
 * refusal of API-key callers on create, the audit trail, and that a key's plaintext is in exactly
 * one response.
 */
import { captureLog } from '../telemetry/capture-log';
import { log as webLogger } from '../telemetry/logger';
import { randomUUID } from 'node:crypto';

import type { EndpointClientResource } from '@indx-workspace/contracts/endpoint-clients';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DELETE, GET as GET_ONE, PATCH } from '../../app/api/endpoint-clients/[id]/route';
import { POST as MINT } from '../../app/api/endpoint-clients/[id]/keys/route';
import { POST as ROTATE } from '../../app/api/endpoint-clients/[id]/secret/route';
import { GET as LIST, POST as CREATE } from '../../app/api/endpoint-clients/route';
import { POST as TOKEN } from '../../app/oauth/token/route';
import { applicationContext, clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { LOCAL_RUNTIME_API_KEY_NAME_PREFIX } from '../cli-auth/local-credential';
import { resetOAuthLimits } from '../oauth/limits';
import { conferredBy } from '../rbac/conferral';
import type { ToolEndpointEnvironment } from '../tool-endpoint/env';
import { installRbacHarness, TEST_WORKSPACE_ID, type RbacHarness } from '../rbac/testing';
import type { EndpointClientAuditEvent, EndpointClientsRuntime } from './runtime';

const OTHER_WORKSPACE = 'some-other-workspace';
const ownerCaller = { email: 'owner@example.com' };
const adminCaller = { email: 'admin@example.com' };
const builderCaller = { email: 'builder@example.com' };
const otherBuilderCaller = { email: 'other-builder@example.com' };
const viewerCaller = { email: 'viewer@example.com' };

interface Fake {
  readonly clients: Map<string, EndpointClientResource & { workspaceId: string }>;
  readonly agentOwners: Map<string, string>;
  /** `agentId:ownerPrincipalId` pairs an `agent_grants` row names. */
  readonly agentGrants: Set<string>;
  readonly audits: EndpointClientAuditEvent[];
  /** Key id to key name, for every key minted. */
  readonly keyNames: Map<string, string>;
  /** Client id to the stored secret hash. */
  readonly secretHashes: Map<string, string>;
}

/** The runtime with each method's `Promise` removed, so the fake needs no `async`. */
type SyncRuntime = {
  [K in keyof EndpointClientsRuntime]: EndpointClientsRuntime[K] extends (
    ...args: infer A
  ) => Promise<infer R>
    ? (...args: A) => R
    : never;
};

let harness: RbacHarness;
let fake: Fake;
let principalIds: Record<string, string>;

function installFake(): Fake {
  const state: Fake = {
    clients: new Map(),
    agentOwners: new Map(),
    agentGrants: new Set(),
    audits: [],
    keyNames: new Map(),
    secretHashes: new Map(),
  };
  const view = (c: EndpointClientResource & { workspaceId: string }): EndpointClientResource => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
    agentIds: c.agentIds,
    toolNames: c.toolNames,
    actsForPrincipalId: c.actsForPrincipalId,
    apiKeyIds: c.apiKeyIds,
    redirectUris: c.redirectUris,
    oidcAudience: c.oidcAudience,
    hasClientSecret: c.hasClientSecret,
    revokedAt: c.revokedAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  });
  const inWorkspace = (workspaceId: string, id: string) => {
    const client = state.clients.get(id);
    return client !== undefined && client.workspaceId === workspaceId ? client : null;
  };
  const sync: SyncRuntime = {
    list: (workspaceId) =>
      [...state.clients.values()].filter((c) => c.workspaceId === workspaceId).map(view),
    get: (workspaceId, id) => {
      const client = inWorkspace(workspaceId, id);
      return client === null ? null : view(client);
    },
    create: (workspaceId, input) => {
      for (const c of state.clients.values()) {
        if (c.workspaceId === workspaceId && c.kind === input.kind && c.name === input.name) {
          return { kind: 'name-taken' };
        }
      }
      const now = new Date().toISOString();
      const client = {
        id: randomUUID(),
        workspaceId,
        name: input.name,
        kind: input.kind,
        agentIds: input.agentIds,
        toolNames: input.toolNames,
        oidcAudience: input.oidcAudience,
        actsForPrincipalId: input.actsForPrincipalId,
        apiKeyIds: [],
        redirectUris: [],
        hasClientSecret: false,
        revokedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      state.clients.set(client.id, client);
      return { kind: 'created', client: view(client) };
    },
    update: (workspaceId, id, patch) => {
      const client = inWorkspace(workspaceId, id);
      if (client === null) return { kind: 'not-found' };
      if (client.revokedAt !== null) return { kind: 'revoked' };
      const next = {
        ...client,
        agentIds: patch.agentIds ?? client.agentIds,
        toolNames: patch.toolNames === undefined ? client.toolNames : patch.toolNames,
        redirectUris: patch.redirectUris ?? client.redirectUris,
        oidcAudience: patch.oidcAudience ?? client.oidcAudience,
      };
      state.clients.set(id, next);
      return { kind: 'updated', client: view(next) };
    },
    revoke: (workspaceId, id) => {
      const client = inWorkspace(workspaceId, id);
      if (client === null) return null;
      const revokedKeys =
        client.revokedAt === null
          ? client.apiKeyIds.map((keyId) => ({ id: keyId, name: state.keyNames.get(keyId) ?? '' }))
          : [];
      const next = { ...client, revokedAt: client.revokedAt ?? new Date().toISOString() };
      state.clients.set(id, next);
      return { client: view(next), revokedKeys };
    },
    rotateSecret: (workspaceId, id, secretHash) => {
      const client = inWorkspace(workspaceId, id);
      if (client === null) return { kind: 'not-found' };
      if (client.revokedAt !== null) return { kind: 'revoked' };
      state.secretHashes.set(id, secretHash);
      const next = { ...client, hasClientSecret: true };
      state.clients.set(id, next);
      return { kind: 'rotated', client: view(next) };
    },
    mintKey: (workspaceId, id, input) => {
      const client = inWorkspace(workspaceId, id);
      if (client === null) return { kind: 'not-found' };
      if (client.revokedAt !== null) return { kind: 'revoked' };
      if ([...state.keyNames.values()].includes(input.name)) {
        return { kind: 'name-taken', name: input.name };
      }
      const keyId = randomUUID();
      state.keyNames.set(keyId, input.name);
      state.clients.set(id, { ...client, apiKeyIds: [...client.apiKeyIds, keyId] });
      return {
        kind: 'created',
        presented: 'aw_live_PLAINTEXT-SECRET-VALUE',
        apiKey: {
          id: keyId,
          name: input.name,
          role: 'builder',
          keyPrefix: 'aw_live_PLAI',
          lastUsedAt: null,
          expiresAt: input.expiresAt,
          revokedAt: null,
          createdAt: new Date().toISOString(),
        },
      };
    },
    agentOwnership: (principal, agentId) => {
      const owner = state.agentOwners.get(agentId);
      if (owner === undefined) return 'unknown';
      if (owner === principal.ownerPrincipalId) return 'own';
      return state.agentGrants.has(`${agentId}:${principal.ownerPrincipalId}`)
        ? 'permitted'
        : 'other';
    },
    audit: (_principal, event) => {
      state.audits.push(event);
    },
  };
  installTestDomains({
    endpointClients: {
      list: (...a) => Promise.resolve(sync.list(...a)),
      get: (...a) => Promise.resolve(sync.get(...a)),
      create: (...a) => Promise.resolve(sync.create(...a)),
      update: (...a) => Promise.resolve(sync.update(...a)),
      revoke: (...a) => Promise.resolve(sync.revoke(...a)),
      rotateSecret: (...a) => Promise.resolve(sync.rotateSecret(...a)),
      mintKey: (...a) => Promise.resolve(sync.mintKey(...a)),
      agentOwnership: (...a) => Promise.resolve(sync.agentOwnership(...a)),
      audit: (...a) => Promise.resolve(sync.audit(...a)),
    },
  });
  return state;
}

beforeEach(async () => {
  harness = installRbacHarness([
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
  fake = installFake();
  const memberships = await harness.directory.forWorkspace(TEST_WORKSPACE_ID).listMemberships();
  principalIds = Object.fromEntries(memberships.map((m) => [m.email, m.principalId]));
});

afterEach(() => {
  clearApplicationContext();
  clearApplicationContext();
  harness.teardown();
});

/** An agent the given caller owns. */
function agentOf(caller: { email: string }): string {
  const id = randomUUID();
  fake.agentOwners.set(id, principalIds[caller.email] ?? 'missing');
  return id;
}

function createBody(agentIds: string[], overrides: Record<string, unknown> = {}) {
  return { name: 'support-bot', kind: 'a2a-agent', agentIds, ...overrides };
}

async function createAs(caller: { email: string }, body: unknown) {
  return harness.call(CREATE, {
    method: 'POST',
    path: '/api/endpoint-clients',
    as: caller,
    body,
  });
}

async function mintAs(caller: { email: string }, id: string, name = 'key-one') {
  return harness.call(MINT, {
    method: 'POST',
    path: `/api/endpoint-clients/${id}/keys`,
    as: caller,
    id,
    body: { name },
  });
}

async function rotateAs(caller: { email: string }, id: string) {
  return harness.call(ROTATE, {
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

describe('create: the four-role matrix', () => {
  it('refuses a viewer', async () => {
    const response = await createAs(viewerCaller, createBody([agentOf(ownerCaller)]));
    expect(response.status).toBe(403);
    expect(fake.clients.size).toBe(0);
  });

  it('lets a builder bind an agent they own, and acts for them', async () => {
    const response = await createAs(builderCaller, createBody([agentOf(builderCaller)]));
    expect(response.status).toBe(201);
    const client = (response.body as { endpointClient: EndpointClientResource }).endpointClient;
    expect(client.actsForPrincipalId).toBe(principalIds[builderCaller.email]);
    expect(fake.audits.map((a) => a.action)).toEqual(['endpoint-client-created']);
  });

  it("refuses a builder binding another member's agent", async () => {
    const response = await createAs(builderCaller, createBody([agentOf(otherBuilderCaller)]));
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: 'endpoint_client_agent_not_runnable' } });
    expect(fake.clients.size).toBe(0);
  });

  it('lets a builder bind another member’s agent it was granted (ADR-0152)', async () => {
    const agent = agentOf(otherBuilderCaller);
    fake.agentGrants.add(`${agent}:${principalIds[builderCaller.email] ?? 'missing'}`);
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
    const created = await harness.directory.forWorkspace(TEST_WORKSPACE_ID).createApiKey({
      name: `${role}-key`,
      role: conferredBy('owner', role, 'test'),
      expiresAt: null,
    });
    if (created.kind !== 'created') throw new Error(created.kind);
    const response = await harness.call(CREATE, {
      method: 'POST',
      path: '/api/endpoint-clients',
      as: null,
      bearer: created.presented,
      body: createBody([agentOf(ownerCaller)]),
    });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: 'api_key_not_permitted' } });
    expect(fake.clients.size).toBe(0);
    expect(fake.audits).toEqual([]);
  });
});

describe('tenant isolation: one 404 for absent, foreign and malformed ids', () => {
  it('answers identically for a client in another workspace, a random id and a non-id', async () => {
    const foreign = randomUUID();
    fake.clients.set(foreign, {
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
        const response = await harness.call(handler, {
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
    expect(fake.clients.get(foreign)?.revokedAt).toBeNull();
  });

  it('lists only the caller workspace', async () => {
    await seedClient(ownerCaller);
    fake.clients.set('x', {
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
    const response = await harness.call(LIST, {
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
    const patch = await harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/endpoint-clients/${client.id}`,
      as: builderCaller,
      id: client.id,
      body: { toolNames: null },
    });
    const revoke = await harness.call(DELETE, {
      method: 'DELETE',
      path: `/api/endpoint-clients/${client.id}`,
      as: builderCaller,
      id: client.id,
    });
    expect(patch.status).toBe(403);
    expect(revoke.status).toBe(403);
    expect((await mintAs(builderCaller, client.id)).status).toBe(403);
    expect(fake.clients.get(client.id)?.revokedAt).toBeNull();
  });

  it("lets an admin revoke another member's client", async () => {
    const client = await seedClient(builderCaller);
    const revoke = await harness.call(DELETE, {
      method: 'DELETE',
      path: `/api/endpoint-clients/${client.id}`,
      as: adminCaller,
      id: client.id,
    });
    expect(revoke.status).toBe(200);
  });
});

describe('revoke and update', () => {
  it('is idempotent and leaves one audit row', async () => {
    const client = await seedClient(ownerCaller);
    for (let i = 0; i < 2; i += 1) {
      const response = await harness.call(DELETE, {
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
    expect(fake.audits.filter((a) => a.action === 'endpoint-client-revoked')).toHaveLength(1);
  });

  it('writes one api-key-revoked row per bound key, on the first revoke only', async () => {
    const client = await seedClient(ownerCaller);
    const first = await mintAs(ownerCaller, client.id, 'key-one');
    const second = await mintAs(ownerCaller, client.id, 'key-two');
    const keyIds = [first, second].map((r) => (r.body as { apiKey: { id: string } }).apiKey.id);
    for (let i = 0; i < 2; i += 1) {
      await harness.call(DELETE, {
        method: 'DELETE',
        path: `/api/endpoint-clients/${client.id}`,
        as: ownerCaller,
        id: client.id,
      });
    }
    expect(fake.audits.filter((a) => a.action === 'api-key-revoked')).toEqual([
      { action: 'api-key-revoked', subjectId: keyIds[0], subjectLabel: 'key-one' },
      { action: 'api-key-revoked', subjectId: keyIds[1], subjectLabel: 'key-two' },
    ]);
  });

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
    const response = await harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/endpoint-clients/${client.id}`,
      as: ownerCaller,
      id: client.id,
      body: { agentIds: [agentOf(ownerCaller)] },
    });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: 'endpoint_client_revoked' } });
    expect(fake.audits.map((a) => a.action)).toEqual(['endpoint-client-created']);
  });

  it('refuses to change or key a revoked client with 409', async () => {
    const client = await seedClient(ownerCaller);
    await harness.call(DELETE, {
      method: 'DELETE',
      path: `/api/endpoint-clients/${client.id}`,
      as: ownerCaller,
      id: client.id,
    });
    const patch = await harness.call(PATCH, {
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

  it('keeps an a2a-agent client to exactly one agent and no tool names', async () => {
    const client = await seedClient(ownerCaller);
    const two = await harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/endpoint-clients/${client.id}`,
      as: ownerCaller,
      id: client.id,
      body: { agentIds: [agentOf(ownerCaller), agentOf(ownerCaller)] },
    });
    expect(two.status).toBe(400);
    expect(two.body).toMatchObject({ error: { code: 'endpoint_client_invalid' } });
    const tools = await harness.call(PATCH, {
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

    const bind = await harness.call(PATCH, {
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

  describe('an app-backend client (ADR-0161 D4)', () => {
    const appBody = (agentIds: string[], overrides: Record<string, unknown> = {}) => ({
      name: 'portal',
      kind: 'app-backend',
      agentIds,
      oidcAudience: 'portal-web',
      ...overrides,
    });
    const patchAs = (caller: { email: string }, id: string, body: unknown) =>
      harness.call(PATCH, {
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
      expect(fake.audits.map((a) => a.action)).toEqual(['endpoint-client-created']);
      const byAdmin = await createAs(adminCaller, appBody([agentOf(adminCaller)], { name: 'p2' }));
      expect(byAdmin.status).toBe(201);
    });

    it('refuses a builder: its tokens act as any member who signs in to the app', async () => {
      const response = await createAs(builderCaller, appBody([agentOf(builderCaller)]));
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ error: { code: 'forbidden' } });
      expect(fake.clients.size).toBe(0);
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
      expect(fake.clients.size).toBe(0);
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
      expect(
        (moved.body as { endpointClient: EndpointClientResource }).endpointClient,
      ).toMatchObject({ oidcAudience: 'portal-web-2' });
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
      const row = fake.clients.get(client.id);
      if (row === undefined) throw new Error('the seeded client is missing');
      fake.clients.set(client.id, {
        ...row,
        actsForPrincipalId: principalIds[caller.email] ?? 'missing',
      });
      return client;
    }

    it('refuses that member changing its redirect URIs and rotating its secret', async () => {
      const client = await builderClientOf(builderCaller);
      const patch = await harness.call(PATCH, {
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
      expect(fake.clients.get(client.id)?.redirectUris).toEqual([]);
      expect(fake.secretHashes.has(client.id)).toBe(false);
    });

    it('lets an admin change it and rotate its secret', async () => {
      const client = await builderClientOf(builderCaller);
      const patch = await harness.call(PATCH, {
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

  it('re-checks that a replaced agent is runnable by the caller', async () => {
    const client = await seedClient(builderCaller);
    const response = await harness.call(PATCH, {
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
    return harness.call(DELETE, {
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
    fake.clients.set(foreign, {
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
      expect(fake.clients.get(client.id)?.revokedAt).not.toBeNull();
      expect(fake.audits.map((a) => a.action)).toEqual([
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

describe('minting a key', () => {
  it('shows the plaintext once, in the mint response only', async () => {
    const client = await seedClient(ownerCaller);
    const mint = await mintAs(ownerCaller, client.id);
    expect(mint.status).toBe(201);
    expect(mint.body).toMatchObject({ key: 'aw_live_PLAINTEXT-SECRET-VALUE' });

    await harness.call(GET_ONE, {
      method: 'GET',
      path: `/api/endpoint-clients/${client.id}`,
      as: ownerCaller,
      id: client.id,
    });
    await harness.call(LIST, { method: 'GET', path: '/api/endpoint-clients', as: ownerCaller });

    const carrying = harness.responses.filter((r) => r.text.includes('PLAINTEXT-SECRET-VALUE'));
    expect(carrying).toHaveLength(1);
    expect(carrying[0]?.method).toBe('POST');
    expect(JSON.stringify(fake.audits)).not.toContain('PLAINTEXT-SECRET-VALUE');
    expect(fake.audits.map((a) => a.action)).toEqual([
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
      await harness.call(DELETE, {
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

  it('refuses a viewer and a taken name', async () => {
    const client = await seedClient(ownerCaller);
    expect((await mintAs(viewerCaller, client.id)).status).toBe(403);
    expect((await mintAs(ownerCaller, client.id, 'dup')).status).toBe(201);
    expect((await mintAs(ownerCaller, client.id, 'dup')).status).toBe(409);
  });

  it("refuses the local runtime's key (ADR-0109, S1-21)", async () => {
    const client = await seedClient(ownerCaller);
    const created = await harness.directory.forWorkspace(TEST_WORKSPACE_ID).createApiKey({
      name: `${LOCAL_RUNTIME_API_KEY_NAME_PREFIX}AAAAAAAA`,
      role: conferredBy('owner', 'admin', 'test'),
      expiresAt: null,
    });
    if (created.kind !== 'created') throw new Error(created.kind);
    const response = await harness.call(MINT, {
      method: 'POST',
      path: `/api/endpoint-clients/${client.id}/keys`,
      as: null,
      bearer: created.presented,
      id: client.id,
      body: { name: 'outlives-the-run' },
    });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: 'local_runtime_key_not_permitted' } });
    expect(fake.keyNames.size).toBe(0);
  });

  it('refuses a key name carrying the reserved local-runtime prefix', async () => {
    const client = await seedClient(ownerCaller);
    const response = await mintAs(ownerCaller, client.id, `${LOCAL_RUNTIME_API_KEY_NAME_PREFIX}x`);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'reserved_name' } });
    expect(fake.keyNames.size).toBe(0);
  });
});

describe('rotating the OAuth client secret', () => {
  const secretOf = (response: { body: unknown }): string =>
    (response.body as { clientSecret: string }).clientSecret;

  it.each([ownerCaller, adminCaller])(
    'lets $email rotate and shows the secret once',
    async (caller) => {
      const client = await seedClient(caller);
      const rotated = await rotateAs(caller, client.id);
      expect(rotated.status).toBe(201);
      const secret = secretOf(rotated);
      expect(secret).toMatch(/^awcs_live_[A-Za-z0-9_-]{43}$/u);
      expect(rotated.body).toMatchObject({ clientId: client.id });
      expect(fake.secretHashes.get(client.id)).toMatch(/^[0-9a-f]{64}$/u);
      expect(fake.secretHashes.get(client.id)).not.toContain(secret);

      await harness.call(GET_ONE, {
        method: 'GET',
        path: `/api/endpoint-clients/${client.id}`,
        as: caller,
        id: client.id,
      });
      await harness.call(LIST, { method: 'GET', path: '/api/endpoint-clients', as: caller });
      expect(harness.responses.filter((r) => r.text.includes(secret))).toHaveLength(1);
      expect(JSON.stringify(fake.audits)).not.toContain(secret);
      expect(fake.audits.at(-1)).toMatchObject({
        action: 'oauth-client-secret-rotated',
        subjectId: client.id,
      });
    },
  );

  it('replaces the previous secret on each rotation', async () => {
    const client = await seedClient(ownerCaller);
    await rotateAs(ownerCaller, client.id);
    const first = fake.secretHashes.get(client.id);
    await rotateAs(ownerCaller, client.id);
    expect(fake.secretHashes.get(client.id)).not.toBe(first);
    expect(fake.audits.filter((a) => a.action === 'oauth-client-secret-rotated')).toHaveLength(2);
  });

  it('refuses the old secret at /oauth/token after a rotation and accepts the new one', async () => {
    vi.stubEnv('AW_PUBLIC_URL', 'https://aw.example');
    resetOAuthLimits();
    installTestDomains({
      oauth: {
        findClient: (id) => {
          const client = fake.clients.get(id);
          if (client === undefined || client.revokedAt !== null) return Promise.resolve(null);
          return Promise.resolve({
            ...client,
            clientSecretHash: fake.secretHashes.get(id) ?? null,
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
    expect(fake.secretHashes.has(theirs.id)).toBe(false);
  });

  it('refuses a viewer', async () => {
    const client = await seedClient(ownerCaller);
    expect((await rotateAs(viewerCaller, client.id)).status).toBe(403);
    expect(fake.secretHashes.size).toBe(0);
  });

  it.each(['owner', 'admin', 'builder'] as const)('refuses a %s API key', async (role) => {
    const client = await seedClient(ownerCaller);
    const created = await harness.directory.forWorkspace(TEST_WORKSPACE_ID).createApiKey({
      name: `${role}-key`,
      role: conferredBy('owner', role, 'test'),
      expiresAt: null,
    });
    if (created.kind !== 'created') throw new Error(created.kind);
    const response = await harness.call(ROTATE, {
      method: 'POST',
      path: `/api/endpoint-clients/${client.id}/secret`,
      as: null,
      bearer: created.presented,
      id: client.id,
    });
    expect(response.status).toBe(403);
    expect(fake.secretHashes.size).toBe(0);
  });

  it('answers one 404 for a foreign, an absent and a malformed id', async () => {
    const foreign = randomUUID();
    fake.clients.set(foreign, {
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
    expect(fake.secretHashes.size).toBe(0);
  });

  it('refuses a revoked client with 409', async () => {
    const client = await seedClient(ownerCaller);
    await harness.call(DELETE, {
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
    harness.call(PATCH, {
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
    expect(fake.clients.get(client.id)?.redirectUris).toHaveLength(2);
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
    expect(fake.clients.get(client.id)?.redirectUris).toEqual([]);
  });
});

describe('without a runtime', () => {
  it('answers 503', async () => {
    clearApplicationContext();
    const response = await harness.call(LIST, {
      method: 'GET',
      path: '/api/endpoint-clients',
      as: ownerCaller,
    });
    expect(response.status).toBe(503);
  });
});
