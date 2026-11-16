/**
 * Issue #2075, ADR-0161's 2026-11-01 amendment (DI10): the app's `app-backend` endpoint client
 * under `aw dev`, against a stateful double of the endpoint-client routes through the SDK.
 */
import { randomBytes } from 'node:crypto';

import type { EndpointClientResource } from '@indx-workspace/contracts/endpoint-clients';
import { createClient } from '@indx-workspace/sdk';
import { fixtures } from '@indx-workspace/sdk/testing';
import { describe, expect, it, vi } from 'vitest';

import { json } from '../testing.js';
import {
  appBackendNotConfiguredNotice,
  ensureAppBackendClient,
  findAppBackendClient,
  mintAppBackendSecret,
  projectAgentIds,
} from './app-backend.js';

const AT = '2026-11-01T10:00:00.000Z';
const AGENT_A = '1a9d6c1e-4f3a-4b2c-9d8e-7f6a5b4c3d2e';
const AGENT_B = '2b9d6c1e-4f3a-4b2c-9d8e-7f6a5b4c3d2e';
const CLIENT_ID = '3c9d6c1e-4f3a-4b2c-9d8e-7f6a5b4c3d2e';

function endpointClient(overrides: Partial<EndpointClientResource> = {}): EndpointClientResource {
  return {
    id: CLIENT_ID,
    name: 'desk',
    kind: 'app-backend',
    agentIds: [AGENT_A],
    toolNames: null,
    actsForPrincipalId: '4d9d6c1e-4f3a-4b2c-9d8e-7f6a5b4c3d2e',
    apiKeyIds: [],
    redirectUris: [],
    oidcAudience: 'desk',
    hasClientSecret: false,
    revokedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function agent(id: string, name: string) {
  return fixtures.agent({ id, name });
}

/** The endpoint-client and agent routes, recording each write. */
function plane(clients: EndpointClientResource[] = []) {
  const writes: { readonly method: string; readonly path: string; readonly body: unknown }[] = [];
  const secret = randomBytes(32).toString('base64url');
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    await Promise.resolve();
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    if (method !== 'GET') writes.push({ method, path: url.pathname, body });
    if (method === 'GET' && url.pathname === '/api/endpoint-clients')
      return json(200, { endpointClients: clients });
    if (method === 'GET' && url.pathname === '/api/agents')
      return json(200, { agents: [agent(AGENT_B, 'triage'), agent(AGENT_A, 'assistant')] });
    if (method === 'POST' && url.pathname === '/api/endpoint-clients') {
      const created = endpointClient(body as Partial<EndpointClientResource>);
      clients.push(created);
      return json(201, { endpointClient: created });
    }
    if (method === 'PATCH') {
      return json(200, { endpointClient: endpointClient(body as Partial<EndpointClientResource>) });
    }
    if (method === 'POST' && url.pathname.endsWith('/secret'))
      return json(201, { clientId: CLIENT_ID, clientSecret: secret, warning: 'shown once' });
    return json(404, { error: { code: 'not_found', message: `${method} ${url.pathname}` } });
  };
  const client = createClient({
    baseUrl: 'http://127.0.0.1:3000',
    auth: { kind: 'api-key', apiKey: 'ak_live_local' },
    fetch,
  });
  return { client, writes, secret };
}

const signal = AbortSignal.timeout(5000);

describe('the app-backend client (ADR-0161 amendment DI10)', () => {
  it('creates one client binding the project agents, with the app as its audience', async () => {
    const { client, writes } = plane();
    const ensured = await ensureAppBackendClient(client, {
      appName: 'desk',
      oidcAudience: 'desk',
      agentIds: await projectAgentIds(client, ['assistant', 'triage'], signal),
      existing: await findAppBackendClient(client, 'desk', signal),
      signal,
    });
    expect(ensured.kind).toBe('created');
    expect(writes).toEqual([
      {
        method: 'POST',
        path: '/api/endpoint-clients',
        body: {
          name: 'desk',
          kind: 'app-backend',
          agentIds: [AGENT_A, AGENT_B],
          oidcAudience: 'desk',
        },
      },
    ]);
  });

  it('sends nothing on a second start with the same agents, and re-binds a changed set', async () => {
    const existing = endpointClient({ agentIds: [AGENT_A] });
    const { client, writes } = plane([existing]);
    const found = await findAppBackendClient(client, 'desk', signal);
    expect(found?.id).toBe(CLIENT_ID);
    const same = await ensureAppBackendClient(client, {
      appName: 'desk',
      oidcAudience: 'desk',
      agentIds: [AGENT_A],
      existing: found,
      signal,
    });
    expect(same.kind).toBe('unchanged');
    expect(writes).toEqual([]);
    const changed = await ensureAppBackendClient(client, {
      appName: 'desk',
      oidcAudience: 'desk',
      agentIds: [AGENT_A, AGENT_B],
      existing: found,
      signal,
    });
    expect(changed.kind).toBe('rebound');
    expect(writes).toEqual([
      {
        method: 'PATCH',
        path: `/api/endpoint-clients/${CLIENT_ID}`,
        body: { agentIds: [AGENT_A, AGENT_B], oidcAudience: 'desk' },
      },
    ]);
  });

  it('ignores a revoked client, another kind and another name', async () => {
    const { client } = plane([
      endpointClient({ revokedAt: AT }),
      endpointClient({ kind: 'builder', oidcAudience: null }),
      endpointClient({ name: 'other' }),
    ]);
    expect(await findAppBackendClient(client, 'desk', signal)).toBeUndefined();
  });

  it('mints the secret through rotate-secret and never prints it', async () => {
    const { client, writes, secret } = plane([endpointClient()]);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await mintAppBackendSecret(client, CLIENT_ID, signal)).toEqual({
        clientId: CLIENT_ID,
        clientSecret: secret,
      });
      const printed = [...stdout.mock.calls, ...stderr.mock.calls].flat().map(String).join('');
      expect(printed).not.toContain(secret);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
    expect(writes).toEqual([
      { method: 'POST', path: `/api/endpoint-clients/${CLIENT_ID}/secret`, body: undefined },
    ]);
  });

  it('makes no client without an agent, past 64 agents, or without an audience', async () => {
    const { client, writes } = plane();
    const base = { appName: 'desk', oidcAudience: 'desk', existing: undefined, signal };
    expect(await ensureAppBackendClient(client, { ...base, agentIds: [] })).toEqual({
      kind: 'not-configured',
      reason: 'no-agents',
    });
    const many = Array.from({ length: 65 }, (_, index) => `${String(index)}`);
    expect(await ensureAppBackendClient(client, { ...base, agentIds: many })).toEqual({
      kind: 'not-configured',
      reason: 'too-many-agents',
    });
    expect(
      await ensureAppBackendClient(client, {
        ...base,
        oidcAudience: undefined,
        agentIds: [AGENT_A],
      }),
    ).toEqual({ kind: 'not-configured', reason: 'no-audience' });
    expect(writes).toEqual([]);
    expect(appBackendNotConfiguredNotice('desk', 'no-agents')).toBe(
      'notice: app_backend_not_configured: the desk app’s sign-in is not configured because the project has no synced agent yet.\n',
    );
  });
});
