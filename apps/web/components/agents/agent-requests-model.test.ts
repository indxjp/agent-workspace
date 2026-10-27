import { createClient } from '@indx-workspace/sdk';
import {
  fetchDouble,
  fixtures,
  jsonResponse,
  type RecordedRequest,
} from '@indx-workspace/sdk/testing';
import { describe, expect, it } from 'vitest';

import {
  createAgent,
  loadAgent,
  loadAgentProjects,
  loadAgents,
  loadEngines,
  loadNewAgentCatalogs,
  loadResourceCatalogs,
  saveAgentAssignments,
  saveAgentDefinition,
} from './agent-requests-model';

const refused = (status: number, code = 'forbidden') =>
  jsonResponse(status, { error: { code, message: `${code} message` } });

function api(route: (request: RecordedRequest) => Response) {
  const double = fetchDouble(route);
  const client = createClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'session' },
    fetch: double.fetch,
  });
  return { client, calls: double.calls };
}

const agent = fixtures.agent();
const assignments = { files: [], skillIds: [], connectorIds: [], storageGrants: [] };
const shape = (calls: readonly RecordedRequest[]) =>
  calls.map((call) => `${call.method} ${call.url.pathname}${call.url.search}`);

describe('loadAgents', () => {
  it('reads the list with the session cookie', async () => {
    const { client, calls } = api(() => jsonResponse(200, { agents: [agent] }));
    await expect(loadAgents(client)).resolves.toEqual({ ok: true, value: [agent] });
    expect(shape(calls)).toEqual(['GET /api/agents']);
    expect(calls[0]?.init.credentials).toBe('include');
  });

  it('words a refusal as the server did', async () => {
    const { client } = api(() => refused(403));
    await expect(loadAgents(client)).resolves.toEqual({
      ok: false,
      problem: { kind: 'api', status: 403, code: 'forbidden', message: 'forbidden message' },
    });
  });

  it('reports a body without the error envelope, and a dropped connection', async () => {
    const bare = api(() => new Response('nope', { status: 502 }));
    await expect(loadAgents(bare.client)).resolves.toEqual({
      ok: false,
      problem: {
        kind: 'transport',
        reason: 'The server answered 502 without the usual error envelope.',
      },
    });
    const dropped = api(() => {
      throw new TypeError('reset');
    });
    const result = await loadAgents(dropped.client);
    expect(result).toMatchObject({ ok: false, problem: { kind: 'transport' } });
  });

  it('refuses a malformed list instead of rendering it', async () => {
    const { client } = api(() => jsonResponse(200, { agents: [{ id: 'x' }] }));
    await expect(loadAgents(client)).resolves.toMatchObject({
      ok: false,
      problem: { kind: 'transport' },
    });
  });
});

describe('loadEngines', () => {
  it('reads the catalogue', async () => {
    const { client, calls } = api(() => jsonResponse(200, { engines: [] }));
    await expect(loadEngines(client)).resolves.toEqual({ ok: true, value: [] });
    expect(shape(calls)).toEqual(['GET /api/engines']);
  });

  it('reports drift as drift', async () => {
    const { client } = api(() => jsonResponse(200, { engines: [{ id: 'x' }] }));
    await expect(loadEngines(client)).resolves.toEqual({
      ok: false,
      problem: {
        kind: 'transport',
        reason: 'The engines response was not the published catalogue.',
      },
    });
  });
});

describe('loadAgent', () => {
  it('reads the agent and its assignments, encoding the id', async () => {
    const { client, calls } = api((request) =>
      request.url.pathname.endsWith('/resources')
        ? jsonResponse(200, { assignments })
        : jsonResponse(200, agent),
    );
    await expect(loadAgent(client, 'a b/c')).resolves.toEqual({
      ok: true,
      value: { agent, assignments },
    });
    expect(shape(calls).sort()).toEqual([
      'GET /api/agents/a%20b%2Fc',
      'GET /api/agents/a%20b%2Fc/resources',
    ]);
  });

  it('reports the refused half', async () => {
    const { client } = api((request) =>
      request.url.pathname.endsWith('/resources')
        ? refused(404, 'not_found')
        : jsonResponse(200, agent),
    );
    await expect(loadAgent(client, agent.id)).resolves.toMatchObject({
      ok: false,
      problem: { kind: 'api', status: 404, code: 'not_found' },
    });
  });
});

describe('saveAgentDefinition', () => {
  it('patches exactly the edited fields', async () => {
    const { client, calls } = api(() => jsonResponse(200, agent));
    await expect(saveAgentDefinition(client, agent)).resolves.toEqual({ ok: true, value: agent });
    expect(shape(calls)).toEqual([`PATCH /api/agents/${agent.id}`]);
    expect(calls[0]?.json).toEqual({
      name: agent.name,
      instructions: agent.instructions,
      modelConnectionId: agent.modelConnectionId,
      model: agent.model,
      runtimeProfileId: agent.runtimeProfileId,
      permissions: agent.permissions,
    });
  });

  it('reports a refusal', async () => {
    const { client } = api(() => refused(409, 'agent_name_conflict'));
    await expect(saveAgentDefinition(client, agent)).resolves.toMatchObject({
      ok: false,
      problem: { kind: 'api', status: 409, code: 'agent_name_conflict' },
    });
  });
});

describe('saveAgentAssignments', () => {
  it('puts the draft and returns what the server stored', async () => {
    const stored = { files: [], skillIds: ['s1'], connectorIds: [], storageGrants: [] };
    const { client, calls } = api(() => jsonResponse(200, { assignments: stored }));
    await expect(saveAgentAssignments(client, agent.id, stored)).resolves.toEqual({
      ok: true,
      value: stored,
    });
    expect(shape(calls)).toEqual([`PUT /api/agents/${agent.id}/resources`]);
    expect(calls[0]?.json).toEqual(stored);
  });
});

describe('createAgent', () => {
  it('posts the agent beside its assignments and returns the new id', async () => {
    const { client, calls } = api(() => jsonResponse(201, { agent, assignments }));
    const input = { name: 'A', instructions: '', modelConnectionId: null, model: null };
    await expect(createAgent(client, input as never, assignments)).resolves.toEqual({
      ok: true,
      value: agent.id,
    });
    expect(shape(calls)).toEqual(['POST /api/agents']);
    expect(calls[0]?.json).toEqual({ agent: input, assignments });
  });

  it('reports a refusal', async () => {
    const { client } = api(() => refused(422, 'engine_capability_unsupported'));
    await expect(createAgent(client, {} as never, assignments)).resolves.toMatchObject({
      ok: false,
      problem: { kind: 'api', status: 422 },
    });
  });
});

const profile = {
  id: 'p1',
  workspaceId: 'w1',
  name: 'Local',
  driver: 'local',
  runtimeConnectionId: 'rc1',
  cpu: 1,
  memoryMb: 512,
  diskMb: 1024,
  networkPolicy: 'none',
  allowedDomains: [],
  filesystem: 'read-only',
  persistPaths: [],
  timeoutSeconds: 60,
  idleTimeoutSeconds: 30,
  driverConfig: {},
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

describe('loadNewAgentCatalogs', () => {
  it('makes an unconfigured optional subsystem an empty group', async () => {
    const { client, calls } = api((request) =>
      request.url.pathname === '/api/runtime-profiles'
        ? jsonResponse(200, { runtimeProfiles: [profile] })
        : refused(503, 'files_unavailable'),
    );
    const result = await loadNewAgentCatalogs(client);
    expect(result.runtimeProfiles).toEqual([{ id: 'p1', name: 'Local', driver: 'local' }]);
    expect(result.resources).toEqual({ files: [], skills: [], connectors: [] });
    expect(shape(calls).sort()).toEqual([
      'GET /api/connectors',
      'GET /api/files',
      'GET /api/runtime-profiles',
      'GET /api/skills',
    ]);
  });

  it('names the status when runtime profiles are refused', async () => {
    const { client } = api(() => refused(403));
    await expect(loadNewAgentCatalogs(client)).rejects.toThrow(
      'Runtime profiles request returned 403.',
    );
  });
});

describe('loadResourceCatalogs', () => {
  it('walks the file tree one level at a time', async () => {
    const { client, calls } = api((request) => {
      if (request.url.pathname === '/api/skills') return jsonResponse(200, { skills: [] });
      if (request.url.pathname === '/api/connectors') return jsonResponse(200, { connectors: [] });
      return jsonResponse(200, { files: [] });
    });
    const result = await loadResourceCatalogs(client);
    expect(result.files.size).toBe(0);
    expect(shape(calls)).toContain('GET /api/files?path=');
  });

  it('reads an unconfigured subsystem as empty', async () => {
    const { client } = api(() => refused(503));
    const result = await loadResourceCatalogs(client);
    expect(result.skills.size).toBe(0);
    expect(result.connectors.size).toBe(0);
  });
});

describe('loadAgentProjects', () => {
  it('lists projects', async () => {
    const { client, calls } = api(() => jsonResponse(200, { projects: [] }));
    await expect(loadAgentProjects(client)).resolves.toEqual([]);
    expect(shape(calls)).toEqual(['GET /api/projects']);
  });

  it('names the refused status', async () => {
    const { client } = api(() => refused(500, 'internal'));
    await expect(loadAgentProjects(client)).rejects.toThrow('GET /api/projects returned 500.');
  });
});
