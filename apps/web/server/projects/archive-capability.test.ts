/**
 * `resolveProjectArchiveCapability` and its parts — issue #184.
 *
 * The point of this file is that the UI's answer and the route's answer cannot drift. Every
 * expectation below is compared against `decide()` **itself**, not against a transcription of §21's
 * table: if `permissions.ts` widens or narrows a project grant tomorrow, these tests follow it, and
 * a capability resolver that stopped asking `decide()` fails them all.
 *
 * `ROLES` is `rbac/roles.ts`'s own list rather than four literals, so a fifth role added later is
 * covered here the moment it exists.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { decide, type Ownership } from '../rbac/decide';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { ROLES, type Role } from '../rbac/roles';
import { clearRbacRuntime } from '../rbac/runtime';
import {
  NO_ARCHIVE_CAPABILITY,
  archiveCapabilityFor,
  archiveGrantsForRole,
  resolveProjectArchiveCapability,
} from './archive-capability';

const WORKSPACE = { id: 'ws-archive-capability', slug: 'acme', name: 'Acme' };

/** What the archive route's own policy answers for this role and ownership. */
function routeAllows(role: Role, ownership: Ownership): boolean {
  return (
    decide({ role, method: 'POST', path: '/api/projects/:id/archive', ownership, scope: null })
      .effect === 'allow'
  );
}

function directoryWith(role: Role) {
  return createMemoryDirectory({
    users: [
      {
        id: `user-${role}`,
        email: `${role}@example.test`,
        name: `A ${role}`,
        workspaceId: WORKSPACE.id,
        role,
      },
    ],
    workspaces: [WORKSPACE],
  });
}

describe('archiveGrantsForRole', () => {
  it.each([...ROLES])('answers for %s exactly what the archive route answers', (role) => {
    expect(archiveGrantsForRole(role)).toEqual({
      canArchiveOwn: routeAllows(role, 'own'),
      canArchiveOther: routeAllows(role, 'other'),
    });
  });

  it('gives the workspace Owner both ownership answers', () => {
    expect(archiveGrantsForRole('owner')).toEqual({ canArchiveOwn: true, canArchiveOther: true });
  });

  it('gives a Builder their own projects and not anybody else’s', () => {
    expect(archiveGrantsForRole('builder')).toEqual({
      canArchiveOwn: true,
      canArchiveOther: false,
    });
  });

  it('gives an Admin neither, matching the project clause §21 does not give them', () => {
    expect(archiveGrantsForRole('admin')).toEqual({ canArchiveOwn: false, canArchiveOther: false });
  });

  it('gives a Viewer neither', () => {
    expect(archiveGrantsForRole('viewer')).toEqual({
      canArchiveOwn: false,
      canArchiveOther: false,
    });
  });

  it('refuses a role the table does not recognise rather than falling through', () => {
    expect(archiveGrantsForRole('superuser')).toEqual({
      canArchiveOwn: false,
      canArchiveOther: false,
    });
    expect(archiveGrantsForRole('')).toEqual({ canArchiveOwn: false, canArchiveOther: false });
  });

  it('answers restore identically, since both segments are writes on the same project', () => {
    for (const role of ROLES) {
      const grants = archiveGrantsForRole(role);
      expect(grants.canArchiveOwn).toBe(
        decide({
          role,
          method: 'POST',
          path: '/api/projects/:id/restore',
          ownership: 'own',
          scope: null,
        }).effect === 'allow',
      );
      expect(grants.canArchiveOther).toBe(
        decide({
          role,
          method: 'POST',
          path: '/api/projects/:id/restore',
          ownership: 'other',
          scope: null,
        }).effect === 'allow',
      );
    }
  });
});

describe('archiveCapabilityFor', () => {
  it.each([...ROLES])(
    'resolves %s against the directory, not against the session token',
    async (role) => {
      const capability = await archiveCapabilityFor(directoryWith(role), {
        sub: `${role}@example.test`,
        ws: WORKSPACE.slug,
      });
      const membership = (await directoryWith(role).membershipsForUser(`user-${role}`))[0];
      if (membership === undefined) throw new Error('membership fixture failed');
      expect(capability).toEqual({
        canArchiveOwn: routeAllows(role, 'own'),
        canArchiveOther: routeAllows(role, 'other'),
        viewerPrincipalId: membership.principalId,
      });
    },
  );

  it('refuses a Viewer both ownership answers, while still resolving who they are', async () => {
    const capability = await archiveCapabilityFor(directoryWith('viewer'), {
      sub: 'viewer@example.test',
      ws: WORKSPACE.slug,
    });
    expect(capability.canArchiveOwn).toBe(false);
    expect(capability.canArchiveOther).toBe(false);
    // A resolvable membership answers with its own user id whatever the grants say; refusing is the
    // grants' job (`canArchiveProject` reads both), and the id is the viewer's own.
    const membership = (await directoryWith('viewer').membershipsForUser('user-viewer'))[0];
    expect(capability.viewerPrincipalId).toBe(membership?.principalId);
  });

  it('refuses when the session names a user the directory does not have', async () => {
    expect(
      await archiveCapabilityFor(directoryWith('owner'), {
        sub: 'nobody@example.test',
        ws: WORKSPACE.slug,
      }),
    ).toEqual(NO_ARCHIVE_CAPABILITY);
  });

  it('refuses when the user holds no membership in the workspace the session names', async () => {
    // Issue #118's rule, enforced here rather than assumed: a membership removed since the cookie
    // was minted takes effect on this render, and the control disappears with it.
    expect(
      await archiveCapabilityFor(directoryWith('owner'), {
        sub: 'owner@example.test',
        ws: 'some-other-workspace',
      }),
    ).toEqual(NO_ARCHIVE_CAPABILITY);
  });
});

describe('resolveProjectArchiveCapability', () => {
  afterEach(() => {
    clearRbacRuntime();
  });

  it('refuses everything when no RBAC runtime is wired, rather than deciding without one', async () => {
    clearRbacRuntime();
    expect(await resolveProjectArchiveCapability()).toEqual(NO_ARCHIVE_CAPABILITY);
  });
});

describe('NO_ARCHIVE_CAPABILITY', () => {
  it('denies on every field, so a caller that spreads it cannot accidentally allow', () => {
    expect(NO_ARCHIVE_CAPABILITY).toEqual({
      canArchiveOwn: false,
      canArchiveOther: false,
      viewerPrincipalId: null,
    });
  });
});
