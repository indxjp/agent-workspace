import { createClient } from '@indx-workspace/sdk';
import {
  fetchDouble,
  fixtures,
  jsonResponse,
  type RecordedRequest,
} from '@indx-workspace/sdk/testing';
import { describe, expect, it } from 'vitest';

import {
  changeMemberRole,
  countRemovalImpact,
  issueInvitation,
  loadInvitations,
  loadMembers,
  removeMember,
  resendInvitation,
  revokeInvitation,
  UNREADABLE_INVITATIONS,
  UNREADABLE_MEMBERS,
} from './team-requests-model';

const ORIGIN = 'https://workspace.example.test';
const TOKEN = 'S3CR3T-token-value-nobody-may-echo';

const member = {
  id: 'membership 1/2',
  userId: 'user-2',
  principalId: '22222222-2222-4222-8222-222222222222',
  email: 'ada@example.test',
  name: 'Ada',
  role: 'admin',
  createdAt: '2026-09-01T10:00:00.000Z',
};
const invitation = {
  id: '7f1c1f2e-8d5a-4f7b-9c2e-1a2b3c4d5e6f',
  email: 'new.person@example.test',
  role: 'builder',
  invitedBy: 'user-1',
  expiresAt: '2026-09-21T12:00:00.000Z',
  acceptedAt: null,
  revokedAt: null,
  createdAt: '2026-09-14T11:00:00.000Z',
};
const issued = {
  invitation,
  token: TOKEN,
  link: `/accept-invitation?id=${invitation.id}&token=${TOKEN}`,
  warning: 'This is the only time this token is shown.',
};
const project = (id: string, createdBy: string | null) => ({
  id,
  workspaceId: 'workspace-1',
  name: id,
  instructions: null,
  defaultAgentId: null,
  defaultModelConnectionId: null,
  defaultModel: null,
  visibility: 'workspace',
  createdBy,
  ownerPrincipalId: '11111111-1111-4111-8111-111111111111',
  archivedAt: null,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
  fileIds: [],
  mcpServerIds: [],
});

const refused = (status: number, code: string) =>
  jsonResponse(status, { error: { code, message: `${code} sentence` } });

function api(route: (request: RecordedRequest) => Response) {
  const double = fetchDouble(route);
  const client = createClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'session' },
    fetch: double.fetch,
  });
  return { client, calls: double.calls };
}
const shape = (calls: readonly RecordedRequest[]) =>
  calls.map((call) => `${call.method} ${call.url.pathname}${call.url.search}`);

describe('members', () => {
  it('loads the list with the session cookie', async () => {
    const { client, calls } = api(() => jsonResponse(200, { memberships: [member] }));
    await expect(loadMembers(client)).resolves.toEqual({ ok: true, value: [member] });
    expect(shape(calls)).toEqual(['GET /api/memberships']);
    expect(calls[0]?.init.credentials).toBe('include');
  });

  it('keeps the server sentence and status of a refusal', async () => {
    const { client } = api(() => refused(403, 'forbidden'));
    await expect(loadMembers(client)).resolves.toEqual({
      ok: false,
      status: 403,
      problem: { kind: 'api', status: 403, code: 'forbidden', message: 'forbidden sentence' },
    });
  });

  it('refuses a malformed list instead of showing a partial table', async () => {
    const { client } = api(() => jsonResponse(200, { memberships: [{ id: 'x' }] }));
    await expect(loadMembers(client)).resolves.toEqual({
      ok: false,
      status: null,
      problem: { kind: 'transport', reason: UNREADABLE_MEMBERS },
    });
  });

  it('reports an unenveloped 500 with its status, for the session-ownership explanation', async () => {
    const { client } = api(() => new Response('boom', { status: 500 }));
    await expect(removeMember(client, member.id)).resolves.toEqual({
      ok: false,
      status: 500,
      problem: {
        kind: 'transport',
        reason: 'The server answered 500 without the usual error envelope.',
      },
    });
  });

  it('reports a dropped connection with no status', async () => {
    const { client } = api(() => {
      throw new TypeError('reset');
    });
    await expect(loadMembers(client)).resolves.toMatchObject({
      ok: false,
      status: null,
      problem: { kind: 'transport' },
    });
  });

  it('patches the encoded membership with the new role', async () => {
    const { client, calls } = api(() =>
      jsonResponse(200, { membership: { ...member, role: 'viewer' } }),
    );
    await expect(changeMemberRole(client, member.id, 'viewer')).resolves.toMatchObject({
      ok: true,
    });
    expect(shape(calls)).toEqual(['PATCH /api/memberships/membership%201%2F2']);
    expect(calls[0]?.json).toEqual({ role: 'viewer' });
  });

  it('words a last-owner refusal as the server did', async () => {
    const { client } = api(() => refused(409, 'last_owner'));
    await expect(changeMemberRole(client, member.id, 'viewer')).resolves.toMatchObject({
      ok: false,
      status: 409,
      problem: { kind: 'api', code: 'last_owner', message: 'last_owner sentence' },
    });
  });

  it('deletes the encoded membership', async () => {
    const { client, calls } = api(() => new Response(null, { status: 204 }));
    await expect(removeMember(client, member.id)).resolves.toEqual({ ok: true, value: null });
    expect(shape(calls)).toEqual(['DELETE /api/memberships/membership%201%2F2']);
  });
});

describe('countRemovalImpact', () => {
  it('counts every page of sessions and every project, archived included', async () => {
    const { client, calls } = api((request) => {
      if (request.url.pathname === '/api/projects') {
        return jsonResponse(200, {
          projects: [project('p1', 'user-2'), project('p2', null), project('p3', 'user-9')],
        });
      }
      return request.url.searchParams.has('cursor')
        ? jsonResponse(200, {
            sessions: [fixtures.session({ id: 's3', userId: 'user-2' })],
            projectKey: 'k',
            nextCursor: null,
          })
        : jsonResponse(200, {
            sessions: [
              fixtures.session({ id: 's1', userId: 'user-2' }),
              fixtures.session({ id: 's2', userId: 'user-9' }),
            ],
            projectKey: 'k',
            nextCursor: 'next',
          });
    });
    await expect(countRemovalImpact(client, 'user-2')).resolves.toEqual({
      sessions: 2,
      projects: 1,
    });
    expect(shape(calls).sort()).toEqual([
      'GET /api/projects?archived=all',
      'GET /api/sessions',
      'GET /api/sessions?cursor=next',
    ]);
  });

  it('answers null when a read is refused: a failed read is not a zero', async () => {
    const { client } = api(() => refused(403, 'forbidden'));
    await expect(countRemovalImpact(client, 'user-2')).resolves.toBeNull();
  });
});

describe('invitations', () => {
  it('loads the list', async () => {
    const { client, calls } = api(() => jsonResponse(200, { invitations: [invitation] }));
    await expect(loadInvitations(client)).resolves.toEqual({ ok: true, value: [invitation] });
    expect(shape(calls)).toEqual(['GET /api/invitations']);
  });

  it('refuses the token-bearing create answer as a list', async () => {
    const { client } = api(() => jsonResponse(200, issued));
    await expect(loadInvitations(client)).resolves.toMatchObject({
      ok: false,
      problem: { kind: 'transport', reason: UNREADABLE_INVITATIONS },
    });
  });

  it('creates an invitation and reveals an absolute link', async () => {
    const { client, calls } = api(() => jsonResponse(201, issued));
    const result = await issueInvitation(
      client,
      { email: invitation.email, role: 'builder' },
      ORIGIN,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        email: invitation.email,
        link: `${ORIGIN}/accept-invitation?id=${invitation.id}&token=${TOKEN}`,
        warning: issued.warning,
      },
    });
    expect(shape(calls)).toEqual(['POST /api/invitations']);
    expect(calls[0]?.json).toEqual({ email: invitation.email, role: 'builder' });
  });

  it('answers a created-but-unreadable body with null and quotes none of it', async () => {
    const { client } = api(() => jsonResponse(201, { token: TOKEN }));
    const result = await issueInvitation(client, { email: 'a@b.c', role: 'viewer' }, ORIGIN);
    expect(result).toEqual({ ok: true, value: null });
  });

  it('keeps the server sentence of a duplicate invitation', async () => {
    const { client } = api(() => refused(409, 'already_invited'));
    await expect(
      issueInvitation(client, { email: 'a@b.c', role: 'viewer' }, ORIGIN),
    ).resolves.toMatchObject({
      ok: false,
      status: 409,
      problem: { kind: 'api', code: 'already_invited', message: 'already_invited sentence' },
    });
  });

  it('resends to the encoded invitation and reveals the replacement link', async () => {
    const { client, calls } = api(() => jsonResponse(200, issued));
    const result = await resendInvitation(client, 'a b', ORIGIN);
    expect(result).toMatchObject({ ok: true, value: { email: invitation.email } });
    expect(shape(calls)).toEqual(['POST /api/invitations/a%20b/resend']);
  });

  it('revokes the encoded invitation', async () => {
    const revoked = { ...invitation, revokedAt: '2026-09-15T00:00:00.000Z' };
    const { client, calls } = api(() => jsonResponse(200, { invitation: revoked }));
    await expect(revokeInvitation(client, 'a b')).resolves.toEqual({ ok: true, value: revoked });
    expect(shape(calls)).toEqual(['DELETE /api/invitations/a%20b']);
  });

  it('words a refused revoke as the server did', async () => {
    const { client } = api(() => refused(404, 'no_such_invitation'));
    await expect(revokeInvitation(client, 'x')).resolves.toMatchObject({
      ok: false,
      problem: { kind: 'api', code: 'no_such_invitation' },
    });
  });
});
