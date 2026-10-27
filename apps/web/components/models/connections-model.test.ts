import { createClient } from '@indx-workspace/sdk';
import {
  fetchDouble,
  fixtures,
  jsonResponse,
  type RecordedRequest,
} from '@indx-workspace/sdk/testing';
import { describe, expect, it } from 'vitest';

import {
  createConnection,
  loadCatalog,
  loadConnections,
  referencingAgents,
  removeConnection,
  rotateCredential,
  testAfterRotation,
  testConnection,
  updateConnection,
} from './connections-model';

const connection = fixtures.modelConnection();
const id = connection.id;

const problem = (status: number, details?: readonly string[]) =>
  jsonResponse(status, {
    error: { code: 'invalid_request', message: 'Name is taken.', ...(details ? { details } : {}) },
  });
const proxyPage = (status: number) => new Response('<html>bad gateway</html>', { status });

function api(route: (request: RecordedRequest) => Response) {
  const double = fetchDouble(route);
  const client = createClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'session' },
    fetch: double.fetch,
  });
  return { client, calls: double.calls };
}

const line = (call: RecordedRequest) => `${call.method} ${call.url.pathname}`;

describe('loadConnections', () => {
  it('reads the connections with the session cookie and drops undeclared fields', async () => {
    const { client, calls } = api(() => jsonResponse(200, { models: [connection] }));
    await expect(loadConnections(client)).resolves.toEqual([
      {
        id,
        name: 'default',
        provider: 'anthropic',
        config: {},
        hasCredential: true,
        ready: true,
      },
    ]);
    expect(calls.map(line)).toEqual(['GET /api/model-connections']);
    expect(calls[0]?.init.credentials).toBe('include');
  });

  it('names the refused status, as the screen always has', async () => {
    const { client } = api(() => problem(403));
    await expect(loadConnections(client)).rejects.toThrow(
      'Model connections request returned 403.',
    );
  });
});

describe('loadCatalog', () => {
  const discovered = {
    connectionId: id,
    providerModelId: 'claude-sonnet',
    displayName: 'Claude Sonnet',
    capabilities: {
      streaming: true,
      toolUse: true,
      thinking: false,
      promptCaching: true,
      structuredOutput: false,
      contextManagement: false,
      webSearch: false,
      tokenCounting: false,
    },
  };

  it('joins discovered models with the connections', async () => {
    const { client, calls } = api((request) =>
      request.url.pathname === '/api/models'
        ? jsonResponse(200, { models: [discovered] })
        : jsonResponse(200, { models: [connection] }),
    );
    const catalog = await loadCatalog(client);
    expect(catalog.models.map((model) => model.providerModelId)).toEqual(['claude-sonnet']);
    expect(catalog.models[0]?.connectionName).toBe('default');
    expect(calls.map(line).sort()).toEqual(['GET /api/model-connections', 'GET /api/models']);
  });

  it('treats a refused read (the models runtime is off) as an empty catalog', async () => {
    const { client } = api(() => problem(503));
    await expect(loadCatalog(client)).resolves.toEqual({ models: [], unavailable: [] });
  });

  it('rejects on a transport failure', async () => {
    const client = createClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'session' },
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await expect(loadCatalog(client)).rejects.toMatchObject({ kind: 'transport' });
  });
});

describe('createConnection', () => {
  const values = {
    name: ' Primary ',
    provider: 'anthropic' as const,
    apiKey: 'sk-test',
    baseUrl: '',
    deployment: '',
    apiVersion: '',
  };

  it('posts the credential to the create route only', async () => {
    const { client, calls } = api(() => jsonResponse(201, connection));
    await expect(createConnection(client, values)).resolves.toBeUndefined();
    expect(calls.map(line)).toEqual(['POST /api/model-connections']);
    expect(calls[0]?.json).toEqual({
      name: 'Primary',
      provider: 'anthropic',
      apiKey: 'sk-test',
      config: {},
    });
  });

  it("shows the server's message, or the status when it sent no envelope", async () => {
    await expect(createConnection(api(() => problem(409)).client, values)).rejects.toThrow(
      'Name is taken.',
    );
    await expect(createConnection(api(() => proxyPage(502)).client, values)).rejects.toThrow(
      'Provider request returned 502.',
    );
  });
});

describe('testConnection', () => {
  const outcome = (ok: boolean) => ({
    ok,
    status: ok ? 200 : 401,
    latencyMs: 12,
    message: ok ? 'Connected.' : 'Credential rejected.',
  });

  it("shows the server's message when the probe passes", async () => {
    const { client, calls } = api(() => jsonResponse(200, outcome(true)));
    await expect(testConnection(client, id)).resolves.toBe('Connected.');
    expect(calls.map(line)).toEqual([`POST /api/model-connections/${id}/test`]);
  });

  it('names the status when the probe fails or the request is refused', async () => {
    await expect(
      testConnection(api(() => jsonResponse(502, outcome(false))).client, id),
    ).rejects.toThrow('Connection test returned 502.');
    await expect(testConnection(api(() => problem(404)).client, id)).rejects.toThrow(
      'Connection test returned 404.',
    );
  });

  it('reports the probe after a rotation, whether or not it passed', async () => {
    await expect(
      testAfterRotation(api(() => jsonResponse(200, outcome(true))).client, id),
    ).resolves.toBe('Credential rotated. Connected.');
    await expect(
      testAfterRotation(api(() => jsonResponse(502, outcome(false))).client, id),
    ).resolves.toBe('Credential rotated. Test failed: Credential rejected.');
    await expect(testAfterRotation(api(() => problem(404)).client, id)).resolves.toBe(
      'Credential rotated. Test failed: HTTP 404',
    );
  });
});

describe('updateConnection', () => {
  const values = { name: 'Renamed', baseUrl: '', deployment: '', apiVersion: '' };

  it('patches the connection and returns it as the panel shows it', async () => {
    const { client, calls } = api(() => jsonResponse(200, { ...connection, name: 'Renamed' }));
    const updated = await updateConnection(client, connection, values);
    expect(updated?.name).toBe('Renamed');
    expect(calls.map(line)).toEqual([`PATCH /api/model-connections/${id}`]);
    expect(calls[0]?.json).toEqual({ name: 'Renamed', config: {} });
  });

  it("shows the server's message with its details, or a generic line without an envelope", async () => {
    await expect(
      updateConnection(
        api(() => problem(400, ['Base URL is required.'])).client,
        connection,
        values,
      ),
    ).rejects.toThrow('Name is taken. Base URL is required.');
    await expect(
      updateConnection(api(() => proxyPage(502)).client, connection, values),
    ).rejects.toThrow('The request failed.');
  });
});

describe('rotateCredential', () => {
  it('sends the key to the credential route only', async () => {
    const { client, calls } = api(() => new Response(null, { status: 204 }));
    await expect(rotateCredential(client, id, 'sk-new')).resolves.toBeUndefined();
    expect(calls.map(line)).toEqual([`POST /api/model-connections/${id}/credential`]);
    expect(calls[0]?.json).toEqual({ apiKey: 'sk-new' });
  });

  it("shows the server's message", async () => {
    await expect(rotateCredential(api(() => problem(400)).client, id, 'sk-new')).rejects.toThrow(
      'Name is taken.',
    );
  });
});

describe('referencingAgents', () => {
  it('names the agents that use the connection', async () => {
    const using = fixtures.agent({ modelConnectionId: id, name: 'Support' });
    const other = fixtures.agent({ id: '66666666-6666-4666-8666-666666666666' });
    const { client, calls } = api(() => jsonResponse(200, { agents: [using, other] }));
    await expect(referencingAgents(client, id)).resolves.toEqual([
      { agentId: using.id, agentName: 'Support' },
    ]);
    expect(calls.map(line)).toEqual(['GET /api/agents']);
  });

  it('rejects when the read is refused', async () => {
    await expect(referencingAgents(api(() => problem(403)).client, id)).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('removeConnection', () => {
  it('deletes the connection', async () => {
    const { client, calls } = api(() => jsonResponse(200, { deleted: true, referencedBy: [] }));
    await expect(removeConnection(client, id)).resolves.toBeUndefined();
    expect(calls.map(line)).toEqual([`DELETE /api/model-connections/${id}`]);
  });

  it("shows the server's message", async () => {
    await expect(removeConnection(api(() => problem(404)).client, id)).rejects.toThrow(
      'Name is taken.',
    );
  });
});
