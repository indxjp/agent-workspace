/**
 * `resolveTeamCapability` and `teamCapabilityFor` — the composition, issue #186.
 *
 * The per-resource matrices are `membership-capability.test.ts`'s and
 * `invitation-capability.test.ts`'s. What this file owns is the part only the composition can get
 * wrong: that both halves are derived from the **same** viewer, that each half keeps its own §21
 * grant rather than inheriting the other's, and that every unresolvable input denies on both.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { NO_INVITATION_CAPABILITY } from '../../contracts/invitations';
import { NO_MEMBERSHIP_CAPABILITY } from '../../contracts/team';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { ROLES, type Role } from '../rbac/roles';
import { clearRbacRuntime } from '../rbac/runtime';
import { invitationCapabilityForViewer } from './invitation-capability';
import { membershipCapabilityForViewer } from './membership-capability';
import { NO_TEAM_CAPABILITY, resolveTeamCapability, teamCapabilityFor } from './team-capability';

const WORKSPACE = { id: 'ws-team-capability', slug: 'acme', name: 'Acme' };

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

function sessionFor(role: Role) {
  return { sub: `${role}@example.test`, ws: WORKSPACE.slug };
}

describe('teamCapabilityFor', () => {
  it.each([...ROLES])(
    'derives both halves for a %s from one resolution of that viewer',
    async (role) => {
      const viewer = { userId: `user-${role}`, role };
      expect(await teamCapabilityFor(directoryWith(role), sessionFor(role))).toEqual({
        membership: membershipCapabilityForViewer(viewer),
        invitation: invitationCapabilityForViewer(viewer),
      });
    },
  );

  it('gives an Owner both halves in full', async () => {
    const capability = await teamCapabilityFor(directoryWith('owner'), sessionFor('owner'));
    expect(capability.membership.canListMembers).toBe(true);
    expect(capability.invitation.canListInvitations).toBe(true);
    expect(capability.invitation.canCreateInvitation).toBe(true);
    expect(capability.invitation.canResendInvitation).toBe(true);
    expect(capability.invitation.canRevokeInvitation).toBe(true);
  });

  it.each(['builder', 'viewer'] as const)(
    'refuses a %s both resources, so neither half can be read as an empty workspace',
    async (role) => {
      const capability = await teamCapabilityFor(directoryWith(role), sessionFor(role));
      expect(capability.membership.canListMembers).toBe(false);
      expect(capability.membership.canChangeRole).toBe(false);
      expect(capability.membership.canRemoveMember).toBe(false);
      expect(capability.invitation.canListInvitations).toBe(false);
      expect(capability.invitation.canCreateInvitation).toBe(false);
      expect(capability.invitation.canResendInvitation).toBe(false);
      expect(capability.invitation.canRevokeInvitation).toBe(false);
      // They are still resolved as a person — the members half needs the id for "is this row me?"
      // — which is exactly why both halves must be denied on their own §21 grants rather than on
      // whether anybody was identified.
      expect(capability.membership.viewerUserId).toBe(`user-${role}`);
    },
  );

  it.each([
    ['a user the directory does not have', { sub: 'nobody@example.test', ws: WORKSPACE.slug }],
    ['no membership in the session’s workspace', { sub: 'owner@example.test', ws: 'elsewhere' }],
  ] as const)('denies both halves when the session names %s', async (_reason, session) => {
    expect(await teamCapabilityFor(directoryWith('owner'), session)).toEqual(NO_TEAM_CAPABILITY);
  });
});

describe('resolveTeamCapability', () => {
  afterEach(() => {
    clearRbacRuntime();
  });

  it('refuses both halves when no RBAC runtime is wired, rather than deciding without one', async () => {
    clearRbacRuntime();
    expect(await resolveTeamCapability()).toEqual(NO_TEAM_CAPABILITY);
  });
});

describe('NO_TEAM_CAPABILITY', () => {
  it('is the two all-deny constants, so a page that spreads it cannot accidentally allow', () => {
    expect(NO_TEAM_CAPABILITY).toEqual({
      membership: NO_MEMBERSHIP_CAPABILITY,
      invitation: NO_INVITATION_CAPABILITY,
    });
  });
});
