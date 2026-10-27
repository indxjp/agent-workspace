import { createClient } from '@indx-workspace/sdk';
import { fetchDouble, jsonResponse, type RecordedRequest } from '@indx-workspace/sdk/testing';
import { describe, expect, it } from 'vitest';

import {
  createWorkspace,
  describeWorkspacesError,
  loadWorkspaces,
  updateWorkspace,
} from './workspaces-requests-model';

function api(route: (request: RecordedRequest) => Response) {
  const double = fetchDouble(route);
  const client = createClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'session' },
    fetch: double.fetch,
  });
  return { client, calls: double.calls };
}

const ID = '11111111-1111-4111-8111-111111111111';
const row = {
  id: ID,
  slug: 'acme',
  name: 'Acme',
  archivedAt: null,
  publicSharingEnabled: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};
const problemBody = (code: string) => ({ error: { code, message: `${code} happened` } });

describe('loadWorkspaces', () => {
  it('lists with GET /api/workspaces', async () => {
    const { client, calls } = api(() =>
      jsonResponse(200, { workspaces: [{ ...row, role: 'owner' }] }),
    );
    const result = await loadWorkspaces(client);
    expect(result).toEqual({ ok: true, value: [{ ...row, role: 'owner' }] });
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url.pathname).toBe('/api/workspaces');
  });

  it('keeps the status and code a 401 carries, which session recovery branches on', async () => {
    const { client } = api(() => jsonResponse(401, problemBody('session_expired')));
    expect(await loadWorkspaces(client)).toEqual({
      ok: false,
      problem: {
        kind: 'api',
        status: 401,
        code: 'session_expired',
        detail: 'session_expired happened',
      },
    });
  });

  it('reports a body the contract refuses as a transport problem', async () => {
    const { client } = api(() => jsonResponse(200, { workspaces: [{ id: 1 }] }));
    const result = await loadWorkspaces(client);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.kind).toBe('transport');
  });
});

describe('loadWorkspaces problems', () => {
  it('maps a 500 authorisation_undecidable to an api problem, so session recovery fires', async () => {
    const { client } = api(() => jsonResponse(500, problemBody('authorisation_undecidable')));
    const result = await loadWorkspaces(client);
    expect(result).toMatchObject({
      ok: false,
      problem: { kind: 'api', status: 500, code: 'authorisation_undecidable' },
    });
  });

  it('words a contract violation as an unusual body, not as a failed request', async () => {
    const { client } = api(() => jsonResponse(200, { workspaces: [{ id: 1 }] }));
    expect(await loadWorkspaces(client)).toEqual({
      ok: false,
      problem: {
        kind: 'transport',
        reason: 'The server answered without the usual workspaces body.',
      },
    });
  });
});

describe('createWorkspace', () => {
  it('posts the name and slug and returns the membership', async () => {
    const { client, calls } = api(() =>
      jsonResponse(201, { workspace: { ...row, role: 'owner' } }),
    );
    const result = await createWorkspace(client, { name: 'Acme', slug: 'acme' });
    expect(result).toEqual({ ok: true, value: { ...row, role: 'owner' } });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe('/api/workspaces');
    expect(calls[0]?.json).toEqual({ name: 'Acme', slug: 'acme' });
  });

  it('shows the server wording of a refusal', async () => {
    const { client } = api(() => jsonResponse(409, problemBody('workspace_slug_taken')));
    const result = await createWorkspace(client, { name: 'Acme', slug: 'acme' });
    expect(result).toMatchObject({
      ok: false,
      problem: { kind: 'api', status: 409, detail: 'workspace_slug_taken happened' },
    });
  });
});

describe('updateWorkspace', () => {
  it('patches the encoded workspace path with the patch body', async () => {
    const { client, calls } = api(() =>
      jsonResponse(200, { workspace: { ...row, archivedAt: null } }),
    );
    const result = await updateWorkspace(client, ID, { archived: false });
    expect(result).toEqual({ ok: true, value: row });
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url.pathname).toBe(`/api/workspaces/${ID}`);
    expect(calls[0]?.json).toEqual({ archived: false });
  });
});

describe('describeWorkspacesError', () => {
  it('words a rejected request as a transport problem', () => {
    expect(describeWorkspacesError(new Error('reset'))).toEqual({
      kind: 'transport',
      reason: 'The request failed before the server could answer: reset',
    });
  });
});
