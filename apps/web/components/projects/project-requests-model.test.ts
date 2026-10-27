import type { ProjectResource } from '@indx-workspace/contracts/projects';
import { createClient } from '@indx-workspace/sdk';
import {
  fetchDouble,
  fixtures,
  jsonResponse,
  type RecordedRequest,
} from '@indx-workspace/sdk/testing';
import { describe, expect, it } from 'vitest';

import type { ProjectDraft } from './model';
import {
  countArchiveImpact,
  createProject,
  loadAgentOptions,
  loadProject,
  loadProjectCatalogs,
  loadProjects,
  saveProject,
  transitionProject,
} from './project-requests-model';

const id = '11111111-1111-4111-8111-111111111111';
const project: ProjectResource = {
  id,
  workspaceId: '22222222-2222-4222-8222-222222222222',
  name: 'Launch',
  instructions: null,
  defaultAgentId: null,
  defaultModelConnectionId: null,
  defaultModel: null,
  visibility: 'private',
  createdBy: '33333333-3333-4333-8333-333333333333',
  ownerPrincipalId: '44444444-4444-4444-8444-444444444444',
  archivedAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  fileIds: [],
  mcpServerIds: [],
};
const archived: ProjectResource = { ...project, archivedAt: '2026-10-02T00:00:00.000Z' };
const draft: ProjectDraft = {
  name: ' Launch ',
  instructions: '',
  visibility: 'private',
  defaultAgentId: null,
  defaultModel: null,
  fileIds: [],
  mcpServerIds: [],
};

const problem = (status: number, code = 'project_name_taken') =>
  jsonResponse(status, { error: { code, message: 'A project with that name exists.' } });
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

const offline = createClient({
  baseUrl: 'https://aw.example.com',
  auth: { kind: 'session' },
  fetch: () => Promise.reject(new TypeError('Failed to fetch')),
});

const line = (call: RecordedRequest) => `${call.method} ${call.url.pathname}${call.url.search}`;

describe('loadProjects', () => {
  it('always asks for the slice the filter names, never relying on the route default', async () => {
    for (const filter of ['active', 'archived', 'all'] as const) {
      const { client, calls } = api(() => jsonResponse(200, { projects: [project] }));
      await expect(loadProjects(client, filter)).resolves.toEqual([project]);
      expect(calls.map(line)).toEqual([`GET /api/projects?archived=${filter}`]);
    }
  });

  it("shows the server's message, or the status when it sent no envelope", async () => {
    await expect(loadProjects(api(() => problem(403)).client, 'active')).rejects.toThrow(
      'A project with that name exists.',
    );
    await expect(loadProjects(api(() => proxyPage(502)).client, 'active')).rejects.toThrow(
      'Request returned 502',
    );
  });
});

describe('loadProject', () => {
  it('reads the project with the session cookie', async () => {
    const { client, calls } = api(() => jsonResponse(200, project));
    await expect(loadProject(client, id)).resolves.toEqual({ ok: true, value: project });
    expect(calls.map(line)).toEqual([`GET /api/projects/${id}`]);
    expect(calls[0]?.init.credentials).toBe('include');
  });

  it("shows the server's refusal as it worded it", async () => {
    await expect(
      loadProject(api(() => problem(404, 'project_not_found')).client, id),
    ).resolves.toEqual({
      ok: false,
      problem: {
        kind: 'api',
        status: 404,
        code: 'project_not_found',
        message: 'A project with that name exists.',
      },
    });
  });

  it('names a body without the envelope, a contract violation and a transport failure', async () => {
    await expect(loadProject(api(() => proxyPage(502)).client, id)).resolves.toEqual({
      ok: false,
      problem: {
        kind: 'transport',
        reason: 'The server answered 502 without the usual error envelope.',
      },
    });
    await expect(loadProject(api(() => jsonResponse(200, { id })).client, id)).resolves.toEqual({
      ok: false,
      problem: { kind: 'transport', reason: 'The server returned an invalid project.' },
    });
    const offlineResult = await loadProject(offline, id);
    expect(offlineResult.ok).toBe(false);
    expect(!offlineResult.ok && offlineResult.problem).toMatchObject({ kind: 'transport' });
    expect(
      !offlineResult.ok && offlineResult.problem.kind === 'transport'
        ? offlineResult.problem.reason
        : '',
    ).toMatch(/^The project could not be loaded: /);
  });
});

describe('createProject', () => {
  it('posts the trimmed draft', async () => {
    const { client, calls } = api(() => jsonResponse(201, project));
    await expect(createProject(client, draft)).resolves.toBeNull();
    expect(calls.map(line)).toEqual(['POST /api/projects']);
    expect(calls[0]?.json).toMatchObject({ name: 'Launch', visibility: 'private' });
  });

  it("returns the server's refusal", async () => {
    await expect(createProject(api(() => problem(409)).client, draft)).resolves.toMatchObject({
      kind: 'api',
      status: 409,
      code: 'project_name_taken',
    });
  });
});

describe('saveProject', () => {
  it('patches every editable field and returns what the server stored', async () => {
    const { client, calls } = api(() => jsonResponse(200, { ...project, name: 'Launch' }));
    await expect(saveProject(client, id, draft)).resolves.toEqual({ ok: true, value: project });
    expect(calls.map(line)).toEqual([`PATCH /api/projects/${id}`]);
    expect(calls[0]?.json).toMatchObject({ name: 'Launch', fileIds: [], mcpServerIds: [] });
  });

  it('names a transport failure as the save that failed', async () => {
    const result = await saveProject(offline, id, draft);
    expect(!result.ok && result.problem.kind === 'transport' ? result.problem.reason : '').toMatch(
      /^The request to save this project failed: /,
    );
  });
});

describe('transitionProject', () => {
  it('archives an active project and restores an archived one', async () => {
    const archiving = api(() => jsonResponse(200, archived));
    await expect(transitionProject(archiving.client, project)).resolves.toEqual({
      ok: true,
      value: archived,
    });
    expect(archiving.calls.map(line)).toEqual([`POST /api/projects/${id}/archive`]);

    const restoring = api(() => jsonResponse(200, project));
    await expect(transitionProject(restoring.client, archived)).resolves.toEqual({
      ok: true,
      value: project,
    });
    expect(restoring.calls.map(line)).toEqual([`POST /api/projects/${id}/restore`]);
  });

  it('reads a concealed 404 as a project that is no longer available', async () => {
    await expect(
      transitionProject(api(() => problem(404, 'project_not_found')).client, project),
    ).resolves.toEqual({
      ok: false,
      problem: {
        kind: 'api',
        status: 404,
        code: 'project_not_found',
        message: 'This project is no longer available.',
      },
    });
  });

  it('names the transition a transport failure interrupted', async () => {
    const result = await transitionProject(offline, archived);
    expect(!result.ok && result.problem.kind === 'transport' ? result.problem.reason : '').toMatch(
      /^The request to restore this project failed: /,
    );
  });
});

describe('countArchiveImpact', () => {
  it("counts this project's visible sessions and one page of its runs", async () => {
    const { client, calls } = api((request) =>
      request.url.pathname === '/api/sessions'
        ? jsonResponse(200, {
            sessions: [
              fixtures.session({ projectId: id }),
              fixtures.session({ id: '55555555-5555-4555-8555-555555555555', projectId: null }),
            ],
            projectKey: 'workspace',
            nextCursor: null,
          })
        : jsonResponse(200, { runs: [fixtures.run()], nextCursor: 'next' }),
    );
    await expect(countArchiveImpact(client, id)).resolves.toEqual({
      sessions: 1,
      runs: 1,
      runsTruncated: true,
    });
    expect(calls.map(line).sort()).toEqual([
      `GET /api/runs?project=${id}&limit=200`,
      'GET /api/sessions',
    ]);
  });

  it('reports nothing when either read fails, rather than a zero', async () => {
    const { client } = api((request) =>
      request.url.pathname === '/api/sessions'
        ? problem(403, 'forbidden')
        : jsonResponse(200, { runs: [], nextCursor: null }),
    );
    await expect(countArchiveImpact(client, id)).resolves.toBeNull();
  });
});

describe('loadProjectCatalogs', () => {
  const agent = fixtures.agent({ name: 'Support' });
  const connector = fixtures.connector();
  const file = {
    id: 'f1',
    path: 'docs',
    kind: 'folder',
    sizeBytes: null,
    contentType: null,
    lastModified: null,
  };

  it('reads the three catalogues into picker options', async () => {
    const { client, calls } = api((request) => {
      if (request.url.pathname === '/api/agents') return jsonResponse(200, { agents: [agent] });
      if (request.url.pathname === '/api/files') return jsonResponse(200, { files: [file] });
      return jsonResponse(200, { connectors: [connector] });
    });
    await expect(loadProjectCatalogs(client)).resolves.toEqual({
      agents: [{ id: agent.id, label: 'Support' }],
      files: [{ id: 'f1', label: 'docs' }],
      connectors: [{ id: connector.id, label: connector.name }],
    });
    expect(calls.map(line).sort()).toEqual([
      'GET /api/agents',
      'GET /api/connectors',
      'GET /api/files',
    ]);
  });

  it('treats a refused files or connectors read as no options', async () => {
    const { client } = api((request) =>
      request.url.pathname === '/api/agents'
        ? jsonResponse(200, { agents: [agent] })
        : problem(503, 'service_unavailable'),
    );
    await expect(loadProjectCatalogs(client)).resolves.toEqual({
      agents: [{ id: agent.id, label: 'Support' }],
      files: [],
      connectors: [],
    });
  });

  it('names the status when the required agents read is refused', async () => {
    const { client } = api((request) =>
      request.url.pathname === '/api/agents'
        ? problem(403, 'forbidden')
        : problem(503, 'service_unavailable'),
    );
    await expect(loadProjectCatalogs(client)).rejects.toThrow('Agents request returned 403.');
  });
});

describe('loadAgentOptions', () => {
  it('reads the agents, or no options when the read fails', async () => {
    const agent = fixtures.agent({ name: 'Support' });
    await expect(
      loadAgentOptions(api(() => jsonResponse(200, { agents: [agent] })).client),
    ).resolves.toEqual([{ id: agent.id, label: 'Support' }]);
    await expect(loadAgentOptions(api(() => problem(403, 'forbidden')).client)).resolves.toEqual(
      [],
    );
    await expect(loadAgentOptions(offline)).resolves.toEqual([]);
  });
});
