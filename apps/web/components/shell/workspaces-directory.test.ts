import { describe, expect, it } from 'vitest';

import { problem } from '../../server/rbac/http';

import {
  canAdministerWorkspace,
  describeTransportRejection,
  describeWorkspacesFailure,
  findCurrentMembership,
  parseWorkspaceItem,
  parseWorkspaceList,
  parseWorkspaceMutation,
  type WorkspaceMembership,
  type WorkspaceResource,
} from './workspaces-directory';

const RESOURCE: WorkspaceResource = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'acme',
  name: 'Acme Corp',
  archivedAt: null,
  publicSharingEnabled: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const ROW: WorkspaceMembership = { ...RESOURCE, role: 'admin' };
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

function withoutResourceField(field: keyof WorkspaceResource): Record<string, unknown> {
  return Object.fromEntries(Object.entries(RESOURCE).filter(([key]) => key !== field));
}

describe('parseWorkspaceList', () => {
  it('reads every well-formed row of GET /api/workspaces', () => {
    expect(
      parseWorkspaceList({ workspaces: [ROW, { ...ROW, id: OTHER_ID, role: 'viewer' }] }),
    ).toEqual([ROW, { ...ROW, id: OTHER_ID, role: 'viewer' }]);
  });

  it('renders zero and one membership exactly as returned, not as a special case', () => {
    expect(parseWorkspaceList({ workspaces: [] })).toEqual([]);
    expect(parseWorkspaceList({ workspaces: [ROW] })).toEqual([ROW]);
  });

  it('rejects the whole response rather than silently omitting a malformed row', () => {
    expect(parseWorkspaceList({ workspaces: [ROW, { ...ROW, role: 'superuser' }] })).toBeNull();
  });

  it('is null for a body that is not this response at all', () => {
    expect(parseWorkspaceList({ error: { code: 'x', detail: 'y' } })).toBeNull();
    expect(parseWorkspaceList(null)).toBeNull();
    expect(parseWorkspaceList('workspaces')).toBeNull();
  });

  it('rejects undeclared keys on both the list wrapper and each membership row', () => {
    expect(parseWorkspaceList({ workspaces: [ROW], page: 1 })).toBeNull();
    expect(parseWorkspaceList({ workspaces: [{ ...ROW, tenantHint: 'other' }] })).toBeNull();
  });

  it('requires the closed UUID, role, boolean and nullable-archive domains', () => {
    expect(parseWorkspaceList({ workspaces: [{ ...ROW, id: 'workspace-1' }] })).toBeNull();
    expect(parseWorkspaceList({ workspaces: [{ ...ROW, role: 'Owner' }] })).toBeNull();
    expect(parseWorkspaceList({ workspaces: [{ ...ROW, publicSharingEnabled: 0 }] })).toBeNull();
    expect(parseWorkspaceList({ workspaces: [{ ...ROW, archivedAt: false }] })).toBeNull();
    expect(
      parseWorkspaceList({
        workspaces: [{ ...ROW, id: RESOURCE.id.toUpperCase(), publicSharingEnabled: true }],
      }),
    ).toEqual([{ ...ROW, id: RESOURCE.id.toUpperCase(), publicSharingEnabled: true }]);
  });

  // BREAK-IT CHECK (done by hand, reverted before commit): loosening `isRole` to accept any
  // non-empty string instead of the closed §21 set makes the malformed-row test above accept a
  // response with `role: 'superuser'` — every role-keyed branch in the screen would then be
  // reasoning about a server contract that does not exist. Restoring the closed `Set` membership
  // check rejects the response again.
});

describe('parseWorkspaceItem', () => {
  it('reads the item body GET /api/workspaces/:id answers with', () => {
    expect(parseWorkspaceItem({ workspace: ROW })).toEqual(ROW);
  });

  it('is null for a wrapper with no workspace field, an archived flag included', () => {
    expect(parseWorkspaceItem({ notWorkspace: ROW })).toBeNull();
    expect(
      parseWorkspaceItem({ workspace: { ...ROW, archivedAt: '2026-02-01T00:00:00.000Z' } }),
    ).toEqual({
      ...ROW,
      archivedAt: '2026-02-01T00:00:00.000Z',
    });
  });

  it('rejects undeclared keys on both the item wrapper and its membership row', () => {
    expect(parseWorkspaceItem({ workspace: ROW, requestId: 'leaked' })).toBeNull();
    expect(parseWorkspaceItem({ workspace: { ...ROW, requestId: 'leaked' } })).toBeNull();
  });
});

describe('parseWorkspaceMutation', () => {
  it('reads the role-free workspace body PATCH /api/workspaces/:id returns', () => {
    expect(parseWorkspaceMutation({ workspace: RESOURCE })).toEqual(RESOURCE);
  });

  it('refuses a malformed mutation body', () => {
    expect(parseWorkspaceMutation({ workspace: { ...RESOURCE, updatedAt: undefined } })).toBeNull();
    expect(parseWorkspaceMutation({ error: { code: 'forbidden' } })).toBeNull();
  });

  it('rejects undeclared keys on both the mutation wrapper and its role-free resource', () => {
    expect(parseWorkspaceMutation({ workspace: RESOURCE, requestId: 'leaked' })).toBeNull();
    expect(parseWorkspaceMutation({ workspace: { ...RESOURCE, role: 'owner' } })).toBeNull();
  });
});

describe('workspace response timestamps', () => {
  it.each([
    ['unparseable text', 'not-a-timestamp'],
    ['an impossible calendar day', '2026-02-30T00:00:00.000Z'],
    ['an overflowing month', '2026-13-01T00:00:00.000Z'],
    ['an overflowing day', '2026-01-32T00:00:00.000Z'],
    ['an overflowing hour', '2026-01-01T24:00:00.000Z'],
    ['a timezone offset', '2026-01-01T00:00:00.000+00:00'],
    ['no fractional seconds', '2026-01-01T00:00:00Z'],
    ['too few fractional digits', '2026-01-01T00:00:00.00Z'],
    ['too many fractional digits', '2026-01-01T00:00:00.0000Z'],
    ['a lower-case UTC marker', '2026-01-01T00:00:00.000z'],
  ])('rejects createdAt with %s', (_description, createdAt) => {
    expect(parseWorkspaceMutation({ workspace: { ...RESOURCE, createdAt } })).toBeNull();
  });

  it('requires every timestamp field rather than allowing absence or null', () => {
    expect(parseWorkspaceMutation({ workspace: withoutResourceField('createdAt') })).toBeNull();
    expect(parseWorkspaceMutation({ workspace: withoutResourceField('updatedAt') })).toBeNull();
    expect(parseWorkspaceMutation({ workspace: withoutResourceField('archivedAt') })).toBeNull();
    expect(parseWorkspaceMutation({ workspace: { ...RESOURCE, createdAt: null } })).toBeNull();
    expect(parseWorkspaceMutation({ workspace: { ...RESOURCE, updatedAt: null } })).toBeNull();
  });

  it('validates updatedAt and non-null archivedAt with the same strict calendar rule', () => {
    expect(
      parseWorkspaceMutation({
        workspace: { ...RESOURCE, updatedAt: '2025-02-29T00:00:00.000Z' },
      }),
    ).toBeNull();
    expect(
      parseWorkspaceMutation({
        workspace: { ...RESOURCE, archivedAt: '2026-04-31T00:00:00.000Z' },
      }),
    ).toBeNull();
    expect(
      parseWorkspaceMutation({
        workspace: { ...RESOURCE, archivedAt: '2024-02-29T00:00:00.000Z' },
      }),
    ).toEqual({ ...RESOURCE, archivedAt: '2024-02-29T00:00:00.000Z' });
  });
});

describe('canAdministerWorkspace', () => {
  it('is true for Owner and false for every other role — issue #119’s ownerOwnershipResolver', () => {
    expect(canAdministerWorkspace({ role: 'owner' })).toBe(true);
    expect(canAdministerWorkspace({ role: 'admin' })).toBe(false);
    expect(canAdministerWorkspace({ role: 'builder' })).toBe(false);
    expect(canAdministerWorkspace({ role: 'viewer' })).toBe(false);
  });
});

describe('describeWorkspacesFailure', () => {
  it('reads the workspaces envelope’s own "detail" field, not "message"', async () => {
    const response = new Response(null, { status: 409 });
    const problem = await describeWorkspacesFailure(response, () =>
      Promise.resolve({ error: { code: 'slug_taken', detail: '"acme" is already in use.' } }),
    );
    expect(problem).toEqual({
      kind: 'api',
      status: 409,
      code: 'slug_taken',
      detail: '"acme" is already in use.',
    });
  });

  it('reads the standard { code, message, detail } body the server renders today as an API problem', async () => {
    const rendered = problem(401, 'unauthorised', 'Sign in again.');
    const response = new Response(null, { status: rendered.status });
    const read = await describeWorkspacesFailure(response, () => Promise.resolve(rendered.body));
    expect(read).toEqual({
      kind: 'api',
      status: 401,
      code: 'unauthorised',
      detail: 'Sign in again.',
    });
  });

  it('prefers "message" over "detail" when a standard body carries both', async () => {
    const response = new Response(null, { status: 403 });
    const read = await describeWorkspacesFailure(response, () =>
      Promise.resolve({ error: { code: 'forbidden', message: 'Preferred.', detail: 'Legacy.' } }),
    );
    expect(read).toEqual({ kind: 'api', status: 403, code: 'forbidden', detail: 'Preferred.' });
  });

  it('refuses a standard body whose "message" is not a string, or that lacks "detail"', async () => {
    const response = new Response(null, { status: 403 });
    const nonString = await describeWorkspacesFailure(response, () =>
      Promise.resolve({ error: { code: 'forbidden', message: 7, detail: 'No.' } }),
    );
    const messageOnly = await describeWorkspacesFailure(response, () =>
      Promise.resolve({ error: { code: 'forbidden', message: 'No.' } }),
    );
    expect(nonString.kind).toBe('transport');
    expect(messageOnly.kind).toBe('transport');
  });

  it('falls back to a transport problem when the body is not JSON', async () => {
    const response = new Response(null, { status: 500 });
    const problem = await describeWorkspacesFailure(response, () =>
      Promise.reject(new Error('bad json')),
    );
    expect(problem).toEqual({
      kind: 'transport',
      reason: 'The server answered 500 with a body that was not JSON.',
    });
  });

  it('falls back to a transport problem when the body carries no error envelope', async () => {
    const response = new Response(null, { status: 502 });
    const problem = await describeWorkspacesFailure(response, () => Promise.resolve({}));
    expect(problem).toEqual({
      kind: 'transport',
      reason: 'The server answered 502 without the usual error envelope.',
    });
  });

  it('rejects undeclared keys at either error-envelope layer', async () => {
    const response = new Response(null, { status: 403 });
    const outerExtra = await describeWorkspacesFailure(response, () =>
      Promise.resolve({ error: { code: 'forbidden', detail: 'No.' }, trace: 'secret' }),
    );
    const innerExtra = await describeWorkspacesFailure(response, () =>
      Promise.resolve({ error: { code: 'forbidden', detail: 'No.', trace: 'secret' } }),
    );
    const standardExtra = await describeWorkspacesFailure(response, () =>
      Promise.resolve({
        error: { code: 'forbidden', message: 'No.', detail: 'No.', trace: 'secret' },
      }),
    );
    expect(standardExtra).toEqual({
      kind: 'transport',
      reason: 'The server answered 403 without the usual error envelope.',
    });
    expect(outerExtra).toEqual({
      kind: 'transport',
      reason: 'The server answered 403 without the usual error envelope.',
    });
    expect(innerExtra).toEqual({
      kind: 'transport',
      reason: 'The server answered 403 without the usual error envelope.',
    });
  });

  // BREAK-IT CHECK (done by hand, reverted before commit): reading `body.error.message` here
  // instead of `body.error.detail` — the agents screens' field name — makes the first test above
  // report the fallback "without the usual error envelope" text instead of the server's actual
  // "acme" wording, silently dropping the one thing #120's acceptance criterion asks this function
  // to carry. Reading `.detail` fixes it.
});

describe('findCurrentMembership', () => {
  it('finds the row whose slug is the session’s current workspace', () => {
    const other = { ...ROW, id: OTHER_ID, slug: 'beta', name: 'Beta' };
    expect(findCurrentMembership([ROW, other], 'beta')).toEqual(other);
  });

  it('is undefined when the current slug is not (or no longer) in the list', () => {
    expect(findCurrentMembership([ROW], 'gone')).toBeUndefined();
    expect(findCurrentMembership([], 'acme')).toBeUndefined();
  });
});

describe('describeTransportRejection', () => {
  it('names the underlying error', () => {
    expect(describeTransportRejection(new Error('network down'))).toEqual({
      kind: 'transport',
      reason: 'The request failed before the server could answer: network down',
    });
  });

  it('stringifies a non-Error rejection rather than losing it', () => {
    expect(describeTransportRejection('boom')).toEqual({
      kind: 'transport',
      reason: 'The request failed before the server could answer: boom',
    });
  });
});
