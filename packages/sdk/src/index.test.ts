import { describe, expect, it } from 'vitest';

import { CONTRACTS_VERSION, CONTRACTS_VERSION_HEADER } from '@indx-workspace/contracts';
import { signIdentity } from '@indx-workspace/contracts/identity-assertion';

import { ApiProblemError, createClient, verifyIdentity } from './index.js';
import { fetchDouble, jsonResponse } from './testing.js';

const agent = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: '44444444-4444-4444-8444-444444444444',
  name: 'Support',
  instructions: '',
  modelConnectionId: null,
  model: null,
  runtimeProfileId: null,
  permissions: {
    readFiles: true,
    writeFiles: false,
    runCommands: false,
    unrestrictedNetwork: false,
  },
  createdBy: null,
  ownerPrincipalId: 'p1',
  createdAt: '2026-09-21T10:00:00.000Z',
  updatedAt: '2026-09-21T10:00:00.000Z',
};

const project = {
  id: '66666666-6666-4666-8666-666666666666',
  workspaceId: agent.workspaceId,
  name: 'Ops',
  instructions: null,
  defaultAgentId: agent.id,
  defaultModelConnectionId: null,
  defaultModel: null,
  visibility: 'workspace',
  createdBy: null,
  ownerPrincipalId: 'p1',
  archivedAt: null,
  createdAt: '2026-09-21T10:00:00.000Z',
  updatedAt: '2026-09-21T10:00:00.000Z',
  fileIds: [],
  mcpServerIds: [],
};

const session = {
  id: '55555555-5555-4555-8555-555555555555',
  workspaceId: agent.workspaceId,
  agentId: agent.id,
  userId: null,
  ownerPrincipalId: 'p1',
  projectId: project.id,
  engineSessionId: null,
  engine: null,
  title: null,
  status: 'active',
  resumable: false,
  createdAt: '2026-09-21T10:00:00.000Z',
  updatedAt: '2026-09-21T10:00:00.000Z',
};

const workspace = {
  id: agent.workspaceId,
  slug: 'acme',
  name: 'Acme',
  publicSharingEnabled: false,
  archivedAt: null,
  createdAt: '2026-09-21T10:00:00.000Z',
  updatedAt: '2026-09-21T10:00:00.000Z',
};

type Answer = readonly [status: number, body: unknown];

/** Routes by `METHOD /path`; anything else is the platform's own 404 envelope. */
function fakeApi(routes: Readonly<Record<string, (body: unknown) => Answer>>) {
  return fetchDouble((request) => {
    const route = routes[`${request.method} ${request.url.pathname}`];
    if (route === undefined) {
      return jsonResponse(404, { error: { code: 'not_found', message: 'no route' } });
    }
    const [status, body] = route(request.json);
    return jsonResponse(status, body);
  });
}

describe('createClient', () => {
  it('wires every resource family over one transport and validates each answer', async () => {
    const api = fakeApi({
      'GET /api/workspaces': () => [200, { workspaces: [{ ...workspace, role: 'owner' }] }],
      [`PATCH /api/workspaces/${workspace.id}`]: (body) => [
        200,
        { workspace: { ...workspace, name: (body as { name: string }).name } },
      ],
      'GET /api/agents': () => [200, { agents: [agent] }],
      'POST /api/agents': (body) => [201, { ...agent, ...(body as object) }],
      [`DELETE /api/agents/${agent.id}`]: () => [204, null],
      [`GET /api/agents/${agent.id}/resources`]: () => [
        200,
        { assignments: { files: [], skillIds: ['s1'], connectorIds: [] } },
      ],
      'GET /api/projects': () => [200, { projects: [project] }],
      [`POST /api/projects/${project.id}/archive`]: () => [
        200,
        { ...project, archivedAt: '2026-09-21T11:00:00.000Z' },
      ],
      [`POST /api/projects/${project.id}/sessions`]: () => [
        201,
        { id: session.id, projectId: project.id, agentId: agent.id },
      ],
      'GET /api/sessions': () => [
        200,
        { sessions: [session], projectKey: 'ws-acme', nextCursor: null },
      ],
      [`PATCH /api/sessions/${session.id}`]: (body) => [
        200,
        { session: { ...session, ...(body as object) } },
      ],
    });
    const aw = createClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'api-key', apiKey: 'ak_live_k' },
      fetch: api.fetch,
    });

    expect((await aw.workspaces.list())[0]?.role).toBe('owner');
    expect((await aw.workspaces.update(workspace.id, { name: 'Acme Inc' })).name).toBe('Acme Inc');
    expect((await aw.agents.list())[0]?.name).toBe('Support');
    const created = await aw.agents.create({
      name: 'Triage',
      instructions: 'Be brief.',
      modelConnectionId: null,
      model: null,
      permissions: agent.permissions,
    });
    expect(created.name).toBe('Triage');
    await aw.agents.remove(agent.id);
    expect((await aw.agents.getResourceAssignments(agent.id)).skillIds).toEqual(['s1']);
    expect((await aw.projects.list({ archived: 'all' }))[0]?.name).toBe('Ops');
    expect((await aw.projects.archive(project.id)).archivedAt).not.toBeNull();
    expect((await aw.projects.startSession(project.id)).id).toBe(session.id);
    expect((await aw.sessions.list({ status: 'active' })).projectKey).toBe('ws-acme');
    expect((await aw.sessions.update(session.id, { title: 'Incident 42' })).title).toBe(
      'Incident 42',
    );

    expect(api.calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      'GET /api/workspaces',
      `PATCH /api/workspaces/${workspace.id}`,
      'GET /api/agents',
      'POST /api/agents',
      `DELETE /api/agents/${agent.id}`,
      `GET /api/agents/${agent.id}/resources`,
      'GET /api/projects',
      `POST /api/projects/${project.id}/archive`,
      `POST /api/projects/${project.id}/sessions`,
      'GET /api/sessions',
      `PATCH /api/sessions/${session.id}`,
    ]);
    expect(api.calls[8]?.json).toEqual({});
    // Issue #244 (S-7): the recording double sees the contracts version on every method.
    for (const call of api.calls) {
      expect(call.headers.get(CONTRACTS_VERSION_HEADER), call.url.pathname).toBe(CONTRACTS_VERSION);
    }
  });

  it('wires every family added for full coverage, each over the same transport', async () => {
    const api = fakeApi({
      'GET /api/secrets': () => [200, { secrets: [] }],
      'GET /api/runtime-profiles': () => [200, { runtimeProfiles: [] }],
      'GET /api/runtime-connections': () => [200, { runtimeConnections: [] }],
      'GET /api/model-connections': () => [200, { models: [] }],
      'GET /api/files': () => [200, { files: [] }],
      'GET /api/skills': () => [200, { skills: [] }],
      'GET /api/connectors': () => [200, { connectors: [] }],
      'GET /api/memberships': () => [200, { memberships: [] }],
      'GET /api/users': () => [200, { users: [] }],
      'GET /api/invitations': () => [200, { invitations: [] }],
      'GET /api/api-keys': () => [200, { apiKeys: [] }],
      'GET /api/shares': () => [200, { shares: [] }],
      'GET /api/sharing-policies': () => [200, { publicSharing: false }],
      'GET /api/metrics': () => [200, { runs: [] }],
      'GET /api/audit-events': () => [200, { events: [], nextCursor: null }],
    });
    const aw = createClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'api-key', apiKey: 'ak_live_k' },
      fetch: api.fetch,
    });

    expect(await aw.secrets.list()).toEqual([]);
    expect(await aw.runtimes.profiles.list()).toEqual([]);
    expect(await aw.runtimes.connections.list()).toEqual([]);
    expect(await aw.models.connections.list()).toEqual([]);
    expect(await aw.files.list()).toEqual([]);
    expect(await aw.skills.list()).toEqual([]);
    expect(await aw.connectors.list()).toEqual([]);
    expect(await aw.team.members.list()).toEqual([]);
    expect(await aw.team.users.list()).toEqual([]);
    expect(await aw.team.invitations.list()).toEqual([]);
    expect(await aw.team.apiKeys.list()).toEqual([]);
    expect(await aw.shares.list()).toEqual([]);
    expect((await aw.workspaces.sharingPolicy.get()).publicSharing).toBe(false);
    expect(await aw.observability.metrics.recentRuns()).toEqual([]);
    expect(await aw.observability.audit.list()).toEqual({ events: [], nextCursor: null });

    expect(api.calls).toHaveLength(15);
    for (const call of api.calls) {
      expect(call.headers.get(CONTRACTS_VERSION_HEADER), call.url.pathname).toBe(CONTRACTS_VERSION);
    }
    expect(
      api.calls.every((call) => call.headers.get('authorization') === 'Bearer ak_live_k'),
    ).toBe(true);
  });

  it('encodes a caller-supplied id into the path', async () => {
    const api = fakeApi({});
    const aw = createClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'session' },
      fetch: api.fetch,
    });
    await expect(aw.agents.get('../admin?x=1')).rejects.toBeInstanceOf(ApiProblemError);
    expect(api.calls[0]?.url.pathname).toBe('/api/agents/..%2Fadmin%3Fx%3D1');
  });
});

describe('verifyIdentity (ADR-0142 D1)', () => {
  const payload = {
    sub: 'customer-17',
    principalKind: 'api-key',
    workspace: 'ws-1',
    runId: 'run-1',
    aud: 'connector-1',
    exp: 2_000_000_000,
  } as const;
  const expected = { audience: 'connector-1', workspace: 'ws-1' };
  const now = new Date((payload.exp - 60) * 1000);

  it('accepts what the platform signs, with a rotated key list', async () => {
    const header = await signIdentity(payload, 'k2');
    expect(await verifyIdentity(header, ['k1', 'k2'], now, expected)).toStrictEqual({
      ok: true,
      payload,
    });
  });

  it('refuses a tampered, foreign, wrong-key or expired assertion by code only', async () => {
    const header = await signIdentity(payload, 'k1');
    const [body = '', mac = ''] = header.split('.');
    const forged = `${body.slice(0, -2)}AA.${mac}`;
    const late = new Date((payload.exp + 31) * 1000);
    const cases = [
      [forged, 'k1', now, expected, 'identity_assertion_invalid'],
      [header, 'other', now, expected, 'identity_assertion_invalid'],
      [header, 'k1', late, expected, 'identity_assertion_expired'],
      [header, 'k1', now, { ...expected, audience: 'x' }, 'identity_audience_mismatch'],
      [header, 'k1', now, { ...expected, workspace: 'x' }, 'identity_workspace_mismatch'],
    ] as const;
    for (const [value, key, at, wanted, code] of cases) {
      expect(await verifyIdentity(value, key, at, wanted)).toStrictEqual({ ok: false, code });
    }
  });
});
