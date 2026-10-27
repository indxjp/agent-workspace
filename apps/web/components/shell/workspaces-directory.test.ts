import { describe, expect, it } from 'vitest';

import {
  canAdministerWorkspace,
  findCurrentMembership,
  parseWorkspaceList,
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

/** One row through the list parser, which owns the timestamp grammar. */
function parseRow(body: { workspace: Record<string, unknown> }) {
  const parsed = parseWorkspaceList({ workspaces: [{ role: 'admin', ...body.workspace }] });
  return parsed === null ? null : parsed[0];
}

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
    expect(parseRow({ workspace: { ...RESOURCE, createdAt } })).toBeNull();
  });

  it('requires every timestamp field rather than allowing absence or null', () => {
    expect(parseRow({ workspace: withoutResourceField('createdAt') })).toBeNull();
    expect(parseRow({ workspace: withoutResourceField('updatedAt') })).toBeNull();
    expect(parseRow({ workspace: withoutResourceField('archivedAt') })).toBeNull();
    expect(parseRow({ workspace: { ...RESOURCE, createdAt: null } })).toBeNull();
    expect(parseRow({ workspace: { ...RESOURCE, updatedAt: null } })).toBeNull();
  });

  it('validates updatedAt and non-null archivedAt with the same strict calendar rule', () => {
    expect(
      parseRow({
        workspace: { ...RESOURCE, updatedAt: '2025-02-29T00:00:00.000Z' },
      }),
    ).toBeNull();
    expect(
      parseRow({
        workspace: { ...RESOURCE, archivedAt: '2026-04-31T00:00:00.000Z' },
      }),
    ).toBeNull();
    expect(
      parseRow({
        workspace: { ...RESOURCE, archivedAt: '2024-02-29T00:00:00.000Z' },
      }),
    ).toEqual({ ...ROW, archivedAt: '2024-02-29T00:00:00.000Z' });
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
