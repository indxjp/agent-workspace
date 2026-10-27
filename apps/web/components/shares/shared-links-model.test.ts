import { createClient } from '@indx-workspace/sdk';
import { fetchDouble, jsonResponse, type RecordedRequest } from '@indx-workspace/sdk/testing';
import { describe, expect, it } from 'vitest';

import { loadSharing, revokeShare, setPublicSharing } from './shared-links-model';

const share = {
  id: 'share 1/2',
  subjectType: 'session',
  subjectId: '55555555-5555-4555-8555-555555555555',
  subjectLabel: 'Incident review',
  visibility: 'workspace',
  mode: null,
  snapshot: null,
  include: {},
  budgetCapUsd: null,
  spentUsd: '0',
  stopped: false,
  expiresAt: null,
  revokedAt: null,
  suspendedAt: null,
  createdAt: '2026-09-21T10:00:00.000Z',
  viewCount: 3,
};

const problem = (status: number) =>
  jsonResponse(status, { error: { code: 'forbidden', message: 'forbidden' } });

function api(route: (request: RecordedRequest) => Response) {
  const double = fetchDouble(route);
  const client = createClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'session' },
    fetch: double.fetch,
  });
  return { client, calls: double.calls };
}

const answer = (shares: Response, policy: Response) => (request: RecordedRequest) =>
  request.url.pathname === '/api/shares' ? shares : policy;

describe('loadSharing', () => {
  it('reads the shares and the sharing policy with the session cookie', async () => {
    const { client, calls } = api(
      answer(jsonResponse(200, { shares: [share] }), jsonResponse(200, { publicSharing: false })),
    );
    await expect(loadSharing(client)).resolves.toEqual({ shares: [share], publicSharing: false });
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`).sort()).toEqual([
      'GET /api/shares',
      'GET /api/sharing-policies',
    ]);
    expect(calls.every((call) => call.init.credentials === 'include')).toBe(true);
  });

  it('names both statuses when a read is refused, as the screen always has', async () => {
    const { client } = api(answer(jsonResponse(200, { shares: [] }), problem(403)));
    await expect(loadSharing(client)).rejects.toThrow('Sharing request returned 200/403');
  });

  it('rejects with the contract violation instead of rendering a malformed row', async () => {
    const { client } = api(
      answer(
        jsonResponse(200, { shares: [{ id: 'x' }] }),
        jsonResponse(200, { publicSharing: true }),
      ),
    );
    await expect(loadSharing(client)).rejects.toMatchObject({ kind: 'contract' });
  });
});

describe('revokeShare', () => {
  it('deletes the encoded share and reports no problem', async () => {
    const { client, calls } = api(() => new Response(null, { status: 204 }));
    await expect(revokeShare(client, share.id)).resolves.toBeNull();
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url.pathname).toBe('/api/shares/share%201%2F2');
  });

  it('reports the refused status', async () => {
    const { client } = api(() => problem(404));
    await expect(revokeShare(client, share.id)).resolves.toBe('Revoke returned 404');
  });
});

describe('setPublicSharing', () => {
  it('patches the policy and reports no problem', async () => {
    const { client, calls } = api(() => jsonResponse(200, { publicSharing: true }));
    await expect(setPublicSharing(client, true)).resolves.toBeNull();
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url.pathname).toBe('/api/sharing-policies');
    expect(calls[0]?.json).toEqual({ publicSharing: true });
  });

  it('reports the refused status', async () => {
    const { client } = api(() => problem(403));
    await expect(setPublicSharing(client, false)).resolves.toBe('Policy update returned 403');
  });
});
