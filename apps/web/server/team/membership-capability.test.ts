/**
 * The membership capability and its parts — issue #185.
 *
 * The point of this file is that the team screen's answer and the membership routes' answer cannot
 * drift. Every expectation below is compared against `decide()` and `conferRole` **themselves**,
 * not against a transcription of §21's table: if `permissions.ts` or `conferral.ts` changes
 * tomorrow, these tests follow it, and a resolver that stopped asking them fails here.
 *
 * Two cells are additionally pinned by name, because they are product consequences and not only
 * code ones: Builder and Viewer cannot list members at all, and an Admin may confer exactly Admin
 * and Viewer.
 *
 * `ROLES` is `rbac/roles.ts`'s own list rather than four literals, so a fifth role added later is
 * covered the moment it exists.
 *
 * The directory reads moved to `./team-viewer.ts` when issue #186 gave this screen a second
 * resource to gate, so the resolution paths — no user, no membership, a corrupt role — are asserted
 * in `team-viewer.test.ts` and through `team-capability.test.ts` instead. What is driven here is the
 * same behaviour one layer in: a viewer, or the absence of one, to a capability.
 */
import { describe, expect, it } from 'vitest';

import { NO_MEMBERSHIP_CAPABILITY } from '../../contracts/team';
import { conferRole } from '../rbac/conferral';
import { decide, type Ownership } from '../rbac/decide';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { ROLES, type Role } from '../rbac/roles';
import {
  conferrableRolesFor,
  membershipCapabilityForViewer,
  membershipGrantsForRole,
} from './membership-capability';
import { resolveTeamViewer } from './team-viewer';

const WORKSPACE = { id: 'ws-membership-capability', slug: 'acme', name: 'Acme' };

/** What the membership routes' own policy answers for this role. */
function routeAllows(role: Role, method: string, path: string, ownership: Ownership): boolean {
  return decide({ role, method, path, ownership, scope: null }).effect === 'allow';
}

function grantsFromTheRoutes(role: Role) {
  return {
    canListMembers: routeAllows(role, 'GET', '/api/memberships', 'not-applicable'),
    canChangeRole: routeAllows(role, 'PATCH', '/api/memberships/:id', 'unknown'),
    canRemoveMember: routeAllows(role, 'DELETE', '/api/memberships/:id', 'unknown'),
  };
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

describe('membershipGrantsForRole', () => {
  it.each([...ROLES])('answers for %s exactly what the membership routes answer', (role) => {
    expect(membershipGrantsForRole(role)).toEqual(grantsFromTheRoutes(role));
  });

  it('gives the workspace Owner all three', () => {
    expect(membershipGrantsForRole('owner')).toEqual({
      canListMembers: true,
      canChangeRole: true,
      canRemoveMember: true,
    });
  });

  it('gives an Admin all three, because §21 grants them memberships in full', () => {
    expect(membershipGrantsForRole('admin')).toEqual({
      canListMembers: true,
      canChangeRole: true,
      canRemoveMember: true,
    });
  });

  it.each(['builder', 'viewer'] as const)(
    'refuses a %s the member list itself, so the screen owes a refused state rather than an empty table',
    (role) => {
      expect(membershipGrantsForRole(role)).toEqual({
        canListMembers: false,
        canChangeRole: false,
        canRemoveMember: false,
      });
    },
  );

  it('refuses a role the table does not recognise rather than falling through', () => {
    for (const unrecognised of ['superuser', '', 'Owner']) {
      expect(membershipGrantsForRole(unrecognised)).toEqual({
        canListMembers: false,
        canChangeRole: false,
        canRemoveMember: false,
      });
    }
  });
});

describe('conferrableRolesFor', () => {
  it.each([...ROLES])('answers for %s exactly what conferRole allows', (role) => {
    expect(conferrableRolesFor(role)).toEqual(
      ROLES.filter((candidate) => conferRole(role, candidate).effect === 'allow'),
    );
  });

  it('lets an Admin confer Admin, Builder and Viewer, and not Owner', () => {
    // ADR-0152 made roles monotonic, so Admin holds everything Builder holds. Owner holds
    // `secrets`, which Admin does not, so Admin still may not confer Owner.
    expect(conferrableRolesFor('admin')).toEqual(['admin', 'builder', 'viewer']);
  });

  it('lets an Owner confer every role', () => {
    expect(conferrableRolesFor('owner')).toEqual([...ROLES]);
  });

  it('offers nothing for a role the table does not recognise', () => {
    expect(conferrableRolesFor('superuser')).toEqual([]);
  });
});

describe('membershipCapabilityForViewer', () => {
  it.each([...ROLES])(
    'answers for a %s resolved from the directory exactly what the routes answer',
    async (role) => {
      // The viewer comes from the real resolution rather than a literal, so the role this is
      // measured against is the directory's own — never the session token's (issue #118).
      const viewer = await resolveTeamViewer(directoryWith(role), {
        sub: `${role}@example.test`,
        ws: WORKSPACE.slug,
      });
      expect(membershipCapabilityForViewer(viewer)).toEqual({
        ...grantsFromTheRoutes(role),
        conferrableRoles: conferrableRolesFor(role),
        viewerUserId: `user-${role}`,
      });
    },
  );

  it('refuses a Builder every control while still resolving who they are', () => {
    const capability = membershipCapabilityForViewer({ userId: 'user-builder', role: 'builder' });
    expect(capability.canListMembers).toBe(false);
    expect(capability.canChangeRole).toBe(false);
    expect(capability.canRemoveMember).toBe(false);
    expect(capability.viewerUserId).toBe('user-builder');
  });

  it('denies everything for a viewer that could not be resolved at all', () => {
    // Including `viewerUserId`: the "is this row me?" comparison is also a capability, and it has
    // no business being answered when nothing about the caller was established (ADR-0015).
    expect(membershipCapabilityForViewer(null)).toEqual(NO_MEMBERSHIP_CAPABILITY);
  });
});
