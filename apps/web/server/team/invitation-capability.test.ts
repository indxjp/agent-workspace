/**
 * The invitation capability and its parts — issue #186.
 *
 * The point of this file is that the invitations section's answer and the invitation routes' answer
 * cannot drift. Every expectation is compared against `decide()` and `conferRole` **themselves**,
 * not against a transcription of §21: if `permissions.ts`, `conferral.ts` or the `resend`
 * sub-resource declaration changes tomorrow, these tests follow it, and a resolver that stopped
 * asking them fails here.
 *
 * Two cells are pinned by name because they are #186's acceptance criteria and not only code
 * consequences: Builder and Viewer are refused all four routes — *"Builder and Viewer users cannot
 * see or invoke invitation controls"* — and an Admin may invite exactly Admin and Viewer.
 */
import { describe, expect, it } from 'vitest';

import { NO_INVITATION_CAPABILITY } from '../../contracts/invitations';
import { conferRole } from '../rbac/conferral';
import { decide, type Ownership } from '../rbac/decide';
import { ROLES, type Role } from '../rbac/roles';
import { invitationCapabilityForViewer, invitationGrantsForRole } from './invitation-capability';

/** What the invitation routes' own policy answers for this role. */
function routeAllows(role: Role, method: string, path: string, ownership: Ownership): boolean {
  return decide({ role, method, path, ownership, scope: null }).effect === 'allow';
}

/**
 * The four cells, read from `decide()` with the ownership each route file passes: `not-applicable`
 * for the collection pair, `unknown` for the two that have not read the row yet.
 */
function grantsFromTheRoutes(role: Role) {
  return {
    canListInvitations: routeAllows(role, 'GET', '/api/invitations', 'not-applicable'),
    canCreateInvitation: routeAllows(role, 'POST', '/api/invitations', 'not-applicable'),
    canResendInvitation: routeAllows(role, 'POST', '/api/invitations/:id/resend', 'unknown'),
    canRevokeInvitation: routeAllows(role, 'DELETE', '/api/invitations/:id', 'unknown'),
  };
}

const ALL_FOUR_DENIED = {
  canListInvitations: false,
  canCreateInvitation: false,
  canResendInvitation: false,
  canRevokeInvitation: false,
};

describe('invitationGrantsForRole', () => {
  it.each([...ROLES])('answers for %s exactly what the invitation routes answer', (role) => {
    expect(invitationGrantsForRole(role)).toEqual(grantsFromTheRoutes(role));
  });

  it.each(['owner', 'admin'] as const)(
    'gives a %s all four, because §21 grants them invitations in full',
    (role) => {
      expect(invitationGrantsForRole(role)).toEqual({
        canListInvitations: true,
        canCreateInvitation: true,
        canResendInvitation: true,
        canRevokeInvitation: true,
      });
    },
  );

  it('admits resend at the same width as the other writes, which is what the declaration says', () => {
    // `rbac/declarations/W9-TEAM-121.ts` declares `resend` a sub-resource of `invitations`, so
    // `decide()` answers it at the parent's width. Asking it separately is what proves that: an
    // undeclared sub-resource would answer `refuse`, and this cell would read `false` for an Owner.
    expect(invitationGrantsForRole('owner').canResendInvitation).toBe(true);
    expect(invitationGrantsForRole('admin').canResendInvitation).toBe(true);
  });

  it.each(['builder', 'viewer'] as const)(
    'refuses a %s all four routes, so the section owes a refused state rather than an empty table',
    (role) => {
      expect(invitationGrantsForRole(role)).toEqual(ALL_FOUR_DENIED);
    },
  );

  it('refuses a role the table does not recognise rather than falling through', () => {
    for (const unrecognised of ['superuser', '', 'Owner']) {
      expect(invitationGrantsForRole(unrecognised)).toEqual(ALL_FOUR_DENIED);
    }
  });
});

describe('invitationCapabilityForViewer', () => {
  it.each([...ROLES])(
    'answers for a %s viewer the routes’ grants and conferRole’s allow set',
    (role) => {
      expect(invitationCapabilityForViewer({ userId: `user-${role}`, role })).toEqual({
        ...grantsFromTheRoutes(role),
        invitableRoles: ROLES.filter((candidate) => conferRole(role, candidate).effect === 'allow'),
      });
    },
  );

  it('lets an Admin invite Admin, Builder and Viewer, and not Owner', () => {
    // ADR-0152 made roles monotonic, so Admin now holds everything Builder holds and may invite
    // one. Owner holds `secrets`, which Admin does not, so `POST /api/invitations` still answers
    // an Admin's Owner invitation `403` (`readConferredRole`).
    expect(
      invitationCapabilityForViewer({ userId: 'user-admin', role: 'admin' }).invitableRoles,
    ).toEqual(['admin', 'builder', 'viewer']);
  });

  it('lets an Owner invite every role §21 names', () => {
    expect(
      invitationCapabilityForViewer({ userId: 'user-owner', role: 'owner' }).invitableRoles,
    ).toEqual([...ROLES]);
  });

  it.each(['builder', 'viewer'] as const)('gives a %s no invitation control at all', (role) => {
    const capability = invitationCapabilityForViewer({ userId: `user-${role}`, role });
    expect(capability).toMatchObject(ALL_FOUR_DENIED);
    // `invitableRoles` is **not** empty for these two, and that is `conferral.ts`'s answer rather
    // than an oversight: grant domination is reflexive and roles are monotonic (ADR-0152), so a
    // Builder's set is `['builder', 'viewer']` and a Viewer's `['viewer']`. The two checks are independent — §21 decides
    // whether this caller may create an invitation at all, `conferRole` decides which role a
    // permitted caller may name — so the create form is gated on `canCreateInvitation` and never on
    // this set being empty. `invitations-table.test.tsx` asserts that gate over the markup.
    expect(capability.invitableRoles).toEqual(ROLES.slice(ROLES.indexOf(role)));
    expect(capability.canCreateInvitation).toBe(false);
  });

  it('denies everything for a viewer that could not be resolved at all', () => {
    // The unresolvable paths themselves — no runtime, no session, no user, no membership, a corrupt
    // role — are `team-viewer.test.ts`'s and `team-capability.test.ts`'s. What is asserted here is
    // that every one of them lands on the all-deny constant (ADR-0015).
    expect(invitationCapabilityForViewer(null)).toEqual(NO_INVITATION_CAPABILITY);
  });
});
