import { createClient } from '@indx-workspace/sdk';
import {
  fetchDouble,
  fixtures,
  jsonResponse,
  type RecordedRequest,
} from '@indx-workspace/sdk/testing';
import { describe, expect, it } from 'vitest';

import { USER_FILTER_PROBE_ID } from './history';
import { loadCatalog, loadRunDetail, loadRunPage, probeUserFilter } from './run-requests-model';

const RUN_ID = 'a1111111-1111-4111-8111-111111111111';
const problem = (status: number, code: string, message: string) =>
  jsonResponse(status, { error: { code, message } });

function api(route: (request: RecordedRequest) => Response) {
  const double = fetchDouble(route);
  const client = createClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'session' },
    fetch: double.fetch,
  });
  return { client, calls: double.calls };
}

describe('loadRunPage', () => {
  it('sends only the recognised filters and the cursor, and returns the page', async () => {
    const { client, calls } = api(() =>
      jsonResponse(200, { runs: [fixtures.run({ id: RUN_ID })], nextCursor: 'next' }),
    );

    const outcome = await loadRunPage(
      client,
      { query: 'ignored', status: 'running', agentId: 'ag1', projectId: 'pr1', userId: 'us1' },
      'cur1',
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url.pathname).toBe('/api/runs');
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({
      status: 'running',
      agent: 'ag1',
      project: 'pr1',
      user: 'us1',
      cursor: 'cur1',
    });
    expect(outcome.ok && outcome.value.nextCursor).toBe('next');
    expect(outcome.ok && outcome.value.runs.map((run) => run.id)).toEqual([RUN_ID]);
  });

  it("shows the server's code and message for a refusal", async () => {
    const { client } = api(() => problem(400, 'invalid_query', 'status is not a run status.'));

    await expect(loadRunPage(client, { status: 'nope' }, null)).resolves.toEqual({
      ok: false,
      problem: {
        kind: 'api',
        status: 400,
        code: 'invalid_query',
        message: 'status is not a run status.',
      },
    });
  });

  it('names a body that is not a run list as a transport problem', async () => {
    const { client } = api(() => jsonResponse(200, { accepted: true }));

    const outcome = await loadRunPage(client, {}, null);

    expect(outcome).toMatchObject({ ok: false, problem: { kind: 'transport' } });
  });

  it('refuses a run whose token counters contradict its total', async () => {
    const run = fixtures.run();
    const { client } = api(() =>
      jsonResponse(200, {
        runs: [{ ...run, usage: { ...run.usage, inputTokens: 5 } }],
        nextCursor: null,
      }),
    );

    const outcome = await loadRunPage(client, {}, null);

    expect(outcome).toMatchObject({ ok: false, problem: { kind: 'transport' } });
  });
});

describe('loadRunDetail', () => {
  it('reads GET /api/runs/:id', async () => {
    const { client, calls } = api(() => jsonResponse(200, { run: fixtures.run({ id: RUN_ID }) }));

    const load = await loadRunDetail(client, RUN_ID);

    expect(calls.map((call) => [call.method, call.url.pathname])).toEqual([
      ['GET', `/api/runs/${RUN_ID}`],
    ]);
    expect(load).toMatchObject({ kind: 'loaded', run: { id: RUN_ID } });
  });

  it('answers a 404 as not-found, not as a problem', async () => {
    const { client } = api(() => problem(404, 'run_not_found', 'No such run.'));

    await expect(loadRunDetail(client, RUN_ID)).resolves.toEqual({ kind: 'not-found' });
  });

  it('shows the server problem for any other refusal', async () => {
    const { client } = api(() => problem(403, 'forbidden', 'Not yours.'));

    await expect(loadRunDetail(client, RUN_ID)).resolves.toEqual({
      kind: 'problem',
      problem: { kind: 'api', status: 403, code: 'forbidden', message: 'Not yours.' },
    });
  });

  it.each(['../users', '../../api/workspaces', '%2e%2e/users'])(
    'does not send a request for a non-UUID run id: %s',
    async (runId) => {
      const { client, calls } = api(() => jsonResponse(200, {}));

      await expect(loadRunDetail(client, runId)).resolves.toMatchObject({ kind: 'problem' });
      expect(calls).toHaveLength(0);
    },
  );
});

describe('loadCatalog', () => {
  const id = 'c1111111-1111-4111-8111-111111111111';
  const createdAt = '2026-09-12T10:00:00.000Z';

  it('reads the project catalogue with archived projects too (issue #184)', async () => {
    const { client, calls } = api(() =>
      jsonResponse(200, {
        projects: [
          {
            id,
            workspaceId: 'b1111111-1111-4111-8111-111111111111',
            name: 'Launch',
            instructions: null,
            defaultAgentId: null,
            defaultModelConnectionId: null,
            defaultModel: null,
            visibility: 'workspace',
            createdBy: 'f1111111-1111-4111-8111-111111111111',
            ownerPrincipalId: '91111111-1111-4111-8111-111111111111',
            archivedAt: createdAt,
            createdAt,
            updatedAt: createdAt,
            fileIds: [],
            mcpServerIds: [],
          },
        ],
      }),
    );

    const catalog = await loadCatalog(client, 'projects');

    expect(calls[0]?.url.pathname).toBe('/api/projects');
    expect(calls[0]?.url.searchParams.get('archived')).toBe('all');
    expect(catalog.byId.get(id)).toBe('Launch');
  });

  it('reads the user catalogue from /api/users', async () => {
    const { client, calls } = api(() =>
      jsonResponse(200, { users: [{ id, email: 'o@example.test', name: 'Owner', createdAt }] }),
    );

    expect((await loadCatalog(client, 'users')).byId.get(id)).toBe('Owner');
    expect(calls[0]?.url.pathname).toBe('/api/users');
  });

  it('rejects when the server refuses', async () => {
    const { client } = api(() => problem(403, 'forbidden', 'No.'));

    await expect(loadCatalog(client, 'agents')).rejects.toThrow('No.');
  });
});

describe('probeUserFilter', () => {
  it('is available on a clean 200 for the probe id', async () => {
    const { client, calls } = api(() => jsonResponse(200, { runs: [], nextCursor: null }));

    await expect(probeUserFilter(client)).resolves.toBe('available');
    expect(calls[0]?.url.searchParams.get('limit')).toBe('1');
    expect(calls[0]?.url.searchParams.get('user')).toBe(USER_FILTER_PROBE_ID);
  });

  it.each([
    [403, 'user_filter_forbidden'],
    [500, 'oops'],
  ])('fails closed on a %s %s', async (status, code) => {
    const { client } = api(() => problem(status, code, 'x'));

    await expect(probeUserFilter(client)).resolves.toBe('unavailable');
  });
});
