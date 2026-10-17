import { describe, expect, it } from 'vitest';

import { ApiProblemError, ContractViolationError } from '../errors.js';
import { HttpClient } from '../http.js';
import { fetchDouble, jsonResponse as json, type RecordedRequest } from '../testing.js';
import { EndpointClientsClient } from './endpointClients.js';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';
const KEY = 'ak_live_AbCdEfGhIjKlMnOpQrStUv_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';

const endpointClient = {
  id: CLIENT_ID,
  name: 'support-bot',
  kind: 'a2a-agent',
  agentIds: [AGENT_ID],
  toolNames: null,
  redirectUris: ['https://app.example.com/oauth/callback'],
  hasClientSecret: false,
  actsForPrincipalId: '33333333-3333-4333-8333-333333333333',
  apiKeyIds: [],
  revokedAt: null,
  createdAt: '2026-10-11T00:00:00.000Z',
  updatedAt: '2026-10-11T00:00:00.000Z',
};

function client(route: (request: RecordedRequest) => Response | Promise<Response>): {
  readonly endpointClients: EndpointClientsClient;
  readonly calls: RecordedRequest[];
} {
  const api = fetchDouble(route);
  const http = new HttpClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'api-key', apiKey: 'ak_live_k' },
    fetch: api.fetch,
  });
  return { endpointClients: new EndpointClientsClient(http), calls: api.calls };
}

describe('EndpointClientsClient', () => {
  it('lists and unwraps the envelope', async () => {
    const { endpointClients, calls } = client(() =>
      json(200, { endpointClients: [endpointClient] }),
    );
    expect(await endpointClients.list()).toEqual([endpointClient]);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url.href).toBe('https://aw.example.com/api/endpoint-clients');
  });

  it('gets one client by an encoded id', async () => {
    const { endpointClients, calls } = client(() => json(200, { endpointClient }));
    expect(await endpointClients.get('a/b')).toEqual(endpointClient);
    expect(calls[0]?.url.pathname).toBe('/api/endpoint-clients/a%2Fb');
  });

  it('creates with the body as given and expects 201', async () => {
    const { endpointClients, calls } = client(() => json(201, { endpointClient }));
    const input = { name: 'support-bot', kind: 'a2a-agent', agentIds: [AGENT_ID] } as const;
    expect(await endpointClients.create(input)).toEqual(endpointClient);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe('/api/endpoint-clients');
    expect(calls[0]?.json).toEqual(input);
  });

  it('updates with PATCH', async () => {
    const { endpointClients, calls } = client(() => json(200, { endpointClient }));
    await endpointClients.update(CLIENT_ID, { toolNames: null });
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url.pathname).toBe(`/api/endpoint-clients/${CLIENT_ID}`);
    expect(calls[0]?.json).toEqual({ toolNames: null });
  });

  it('revokes with DELETE and returns the client', async () => {
    const revoked = { ...endpointClient, revokedAt: '2026-10-11T01:00:00.000Z' };
    const { endpointClients, calls } = client(() => json(200, { endpointClient: revoked }));
    expect(await endpointClients.revoke(CLIENT_ID)).toEqual(revoked);
    expect(calls[0]?.method).toBe('DELETE');
  });

  it('mints a key under the client and returns the whole minted answer', async () => {
    const minted = {
      apiKey: {
        id: '44444444-4444-4444-8444-444444444444',
        name: 'vault',
        role: 'builder',
        keyPrefix: KEY.slice(0, 30),
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
        createdAt: '2026-10-11T00:00:00.000Z',
      },
      key: KEY,
      warning: 'Store this key now; it is not shown again.',
    };
    const { endpointClients, calls } = client(() => json(201, minted));
    const answer = await endpointClients.mintKey(CLIENT_ID, { name: 'vault' });
    expect(answer.key).toBe(KEY);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe(`/api/endpoint-clients/${CLIENT_ID}/keys`);
    expect(calls[0]?.json).toEqual({ name: 'vault' });
  });

  it('rotates the secret with an empty POST and returns the whole answer', async () => {
    const rotated = {
      clientId: CLIENT_ID,
      clientSecret: 'awcs_live_AbCdEfGhIjKlMnOpQrStUv_secret',
      warning: 'Store this secret now; it is not shown again.',
    };
    const { endpointClients, calls } = client(() => json(201, rotated));
    expect(await endpointClients.rotateSecret(CLIENT_ID)).toEqual(rotated);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe(`/api/endpoint-clients/${CLIENT_ID}/secret`);
    expect(calls[0]?.json).toBeUndefined();
  });

  it.each([
    [409, 'endpoint_client_revoked'],
    [403, 'api_key_not_permitted'],
  ])('surfaces a rotateSecret %i as %s', async (status, code) => {
    const { endpointClients } = client(() => json(status, { error: { code, message: 'No.' } }));
    const failure = await endpointClients.rotateSecret(CLIENT_ID).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).code).toBe(code);
  });

  it('surfaces a problem by code', async () => {
    const { endpointClients } = client(() =>
      json(404, { error: { code: 'endpoint_client_not_found', message: 'No client.' } }),
    );
    const failure = await endpointClients.get(CLIENT_ID).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).code).toBe('endpoint_client_not_found');
  });

  it('rejects an answer carrying an unknown key', async () => {
    const { endpointClients } = client(() =>
      json(200, { endpointClient: { ...endpointClient, secret: 'x' } }),
    );
    await expect(endpointClients.get(CLIENT_ID)).rejects.toBeInstanceOf(ContractViolationError);
  });
});
