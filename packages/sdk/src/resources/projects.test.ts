import { describe, expect, it } from 'vitest';

import { ApiProblemError, ContractViolationError, TransportError } from '../errors.js';
import { HttpClient } from '../http.js';
import { fetchDouble, jsonResponse as json, type RecordedRequest } from '../testing.js';
import { ProjectsClient } from './projects.js';

const PROJECT = '66666666-6666-4666-8666-666666666666';
const AGENT = '11111111-1111-4111-8111-111111111111';
const SESSION = '55555555-5555-4555-8555-555555555555';

const project = {
  id: PROJECT,
  workspaceId: '44444444-4444-4444-8444-444444444444',
  name: 'Ops',
  instructions: null,
  defaultAgentId: AGENT,
  defaultModelConnectionId: null,
  defaultModel: null,
  visibility: 'private',
  createdBy: null,
  ownerPrincipalId: 'principal-1',
  archivedAt: null,
  createdAt: '2026-09-21T10:00:00.000Z',
  updatedAt: '2026-09-21T10:00:00.000Z',
  fileIds: [],
  mcpServerIds: [],
};

function client(route: (request: RecordedRequest) => Response | Promise<Response>): {
  readonly projects: ProjectsClient;
  readonly calls: RecordedRequest[];
} {
  const api = fetchDouble(route);
  const http = new HttpClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'api-key', apiKey: 'ak_live_k' },
    fetch: api.fetch,
  });
  return { projects: new ProjectsClient(http), calls: api.calls };
}

function problem(status: number, code: string): Response {
  return json(status, { error: { code, message: `${code}.` } });
}

describe('ProjectsClient.list and get', () => {
  it('reads the list envelope, unwraps it, and sends the archived filter', async () => {
    const { projects, calls } = client(() => json(200, { projects: [project] }));
    expect(await projects.list({ archived: 'all' })).toEqual([project]);
    const [call] = calls;
    expect(call?.method).toBe('GET');
    expect(call?.url.href).toBe('https://aw.example.com/api/projects?archived=all');
    expect(call?.headers.get('authorization')).toBe('Bearer ak_live_k');
  });

  it('reads the bare item at the percent-encoded id', async () => {
    const { projects, calls } = client(() => json(200, project));
    expect(await projects.get(PROJECT)).toEqual(project);
    expect(calls[0]?.url.pathname).toBe(`/api/projects/${PROJECT}`);
    const escaped = client(() => problem(404, 'project_not_found'));
    await escaped.projects.get('../agents?x=1').catch(() => undefined);
    expect(escaped.calls[0]?.url.pathname).toBe('/api/projects/..%2Fagents%3Fx%3D1');
  });

  it('surfaces a missing project by code and refuses a wrapped item', async () => {
    const missing = client(() => problem(404, 'project_not_found'));
    const failure = await missing.projects.get(PROJECT).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).status).toBe(404);
    expect((failure as ApiProblemError).code).toBe('project_not_found');
    const wrapped = client(() => json(200, { project }));
    await expect(wrapped.projects.get(PROJECT)).rejects.toBeInstanceOf(ContractViolationError);
  });
});

describe('ProjectsClient.create and update', () => {
  it('posts the create input and reads the bare 201', async () => {
    const { projects, calls } = client(() => json(201, project));
    const input = { name: 'Ops', visibility: 'private' as const, fileIds: [], mcpServerIds: [] };
    expect(await projects.create(input)).toEqual(project);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
    expect(calls[0]?.json).toEqual(input);
  });

  it('patches only the fields given and surfaces an invalid patch by code', async () => {
    const { projects, calls } = client(() => json(200, { ...project, name: 'Ops 2' }));
    await projects.update(PROJECT, { name: 'Ops 2' });
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.json).toEqual({ name: 'Ops 2' });
    const invalid = client(() => problem(400, 'invalid_project'));
    const failure = await invalid.projects.update(PROJECT, {}).catch((e: unknown) => e);
    expect((failure as ApiProblemError).code).toBe('invalid_project');
  });
});

describe('ProjectsClient.archive and restore', () => {
  it('posts to the lifecycle routes with no body and reads the bare project', async () => {
    const archived = { ...project, archivedAt: '2026-09-21T11:00:00.000Z' };
    const { projects, calls } = client((request) =>
      json(200, request.url.pathname.endsWith('/archive') ? archived : project),
    );
    expect((await projects.archive(PROJECT)).archivedAt).toBe(archived.archivedAt);
    expect((await projects.restore(PROJECT)).archivedAt).toBeNull();
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      `POST /api/projects/${PROJECT}/archive`,
      `POST /api/projects/${PROJECT}/restore`,
    ]);
    expect(calls[0]?.json).toBeUndefined();
  });
});

describe('ProjectsClient.startSession', () => {
  it('posts an empty body for the default agent and reads the 201', async () => {
    const started = { id: SESSION, projectId: PROJECT, agentId: AGENT };
    const { projects, calls } = client(() => json(201, started));
    expect(await projects.startSession(PROJECT)).toEqual(started);
    expect(calls[0]?.url.pathname).toBe(`/api/projects/${PROJECT}/sessions`);
    expect(calls[0]?.json).toEqual({});
  });

  it('names the agent when given and accepts the 200 of an existing session', async () => {
    const started = { id: SESSION, projectId: PROJECT, agentId: AGENT };
    const { projects, calls } = client(() => json(200, started));
    await projects.startSession(PROJECT, { agentId: AGENT });
    expect(calls[0]?.json).toEqual({ agentId: AGENT });
  });

  it('surfaces the unresolvable-agent refusals by code', async () => {
    for (const code of ['project_default_agent_unresolvable', 'project_session_agent_not_found']) {
      const { projects } = client(() => problem(422, code));
      const failure = await projects.startSession(PROJECT).catch((e: unknown) => e);
      expect((failure as ApiProblemError).status).toBe(422);
      expect((failure as ApiProblemError).code).toBe(code);
    }
  });
});

describe('ProjectsClient.adoptSession', () => {
  it('posts exactly { sessionId } to the sessions route and reads the moved pair', async () => {
    const { projects, calls } = client(() => json(200, { projectId: PROJECT, sessionId: SESSION }));
    expect(await projects.adoptSession(PROJECT, SESSION)).toEqual({
      projectId: PROJECT,
      sessionId: SESSION,
    });
    const [call] = calls;
    expect(call?.method).toBe('POST');
    expect(call?.url.pathname).toBe(`/api/projects/${PROJECT}/sessions`);
    expect(call?.url.search).toBe('');
    expect(call?.headers.get('content-type')).toBe('application/json');
    expect(call?.headers.get('authorization')).toBe('Bearer ak_live_k');
    expect(call?.json).toEqual({ sessionId: SESSION });
  });

  it('encodes a caller-supplied project id so it cannot escape the path', async () => {
    const { projects, calls } = client(() => problem(404, 'project_not_found'));
    await projects.adoptSession('../agents?x=1#f', SESSION).catch(() => undefined);
    expect(calls[0]?.url.pathname).toBe('/api/projects/..%2Fagents%3Fx%3D1%23f/sessions');
    expect(calls[0]?.url.search).toBe('');
  });

  it('surfaces every refusal the route documents by status and code', async () => {
    for (const [status, code] of [
      [503, 'projects_runtime_not_configured'],
      [401, 'unauthenticated'],
      [403, 'forbidden'],
      [404, 'project_not_found'],
      [404, 'project_or_session_not_found'],
      [409, 'project_archived'],
      [409, 'project_session_has_runs'],
    ] as const) {
      const { projects } = client(() => problem(status, code));
      const failure = await projects.adoptSession(PROJECT, SESSION).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(ApiProblemError);
      expect((failure as ApiProblemError).status).toBe(status);
      expect((failure as ApiProblemError).code).toBe(code);
    }
  });

  it('refuses a 201 (a started session, not a move) and a started-session body as drift', async () => {
    const started = { id: SESSION, projectId: PROJECT, agentId: AGENT };
    const created = client(() => json(201, started));
    const wrongStatus = await created.projects
      .adoptSession(PROJECT, SESSION)
      .catch((e: unknown) => e);
    expect(wrongStatus).toBeInstanceOf(ApiProblemError);
    expect((wrongStatus as ApiProblemError).status).toBe(201);
    expect((wrongStatus as ApiProblemError).code).toBe('unrecognised_error_body');
    const wrongShape = client(() => json(200, started));
    const drift = await wrongShape.projects.adoptSession(PROJECT, SESSION).catch((e: unknown) => e);
    expect(drift).toBeInstanceOf(ContractViolationError);
    expect((drift as ContractViolationError).issues.join('\n')).toContain('sessionId');
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { projects, calls } = client((request) => {
      expect(request.init.signal?.aborted).toBe(true);
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });
    const failure = await projects
      .adoptSession(PROJECT, SESSION, { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
