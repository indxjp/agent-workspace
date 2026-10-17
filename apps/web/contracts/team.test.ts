/**
 * The team capability contract — issue #185.
 *
 * The load-bearing test here is the one that reads `apps/web/server/rbac/roles.ts`. A contract
 * module may not import a server one, so `MEMBERSHIP_ROLES` is written out; ADR-0016 forbids
 * leaving a duplicated list to a comment, so the duplication is gated instead. A fifth role, or a
 * rename, fails this file rather than shipping a members table that silently cannot offer it.
 */
import { describe, expect, it } from 'vitest';

import { ROLES, type Role } from '../server/rbac/roles';
import {
  MEMBERSHIP_ROLES,
  MembershipListResponseSchema,
  MembershipResourceSchema,
  NO_MEMBERSHIP_CAPABILITY,
  type MembershipRoleName,
} from './team';

const membership = {
  id: 'membership-1',
  principalId: '11111111-1111-4111-8111-111111111111',
  userId: 'user-1',
  email: 'aya.ito@example.test',
  name: 'Aya Ito',
  role: 'owner',
  createdAt: '2026-09-12T00:00:00.000Z',
};

describe('MEMBERSHIP_ROLES', () => {
  it('is exactly the RBAC tree’s own role list, in the same order', () => {
    expect([...MEMBERSHIP_ROLES]).toEqual([...ROLES]);
  });

  it('is the same type in both directions, so neither list can gain a member alone', () => {
    // The compile-time half. `pnpm typecheck` fails on these two lines if either union stops
    // covering the other — a check the runtime comparison above cannot make, because a `Role` the
    // contract has not got would still be a string.
    const contractCoversServer: Role extends MembershipRoleName ? true : false = true;
    const serverCoversContract: MembershipRoleName extends Role ? true : false = true;
    expect([contractCoversServer, serverCoversContract]).toEqual([true, true]);
  });
});

describe('membership API contracts', () => {
  it('accepts the complete membership wire representation', () => {
    expect(MembershipListResponseSchema.parse({ memberships: [membership] })).toEqual({
      memberships: [membership],
    });
  });

  it('rejects malformed, missing and extra response fields', () => {
    expect(MembershipResourceSchema.safeParse({ ...membership, role: 'superuser' }).success).toBe(
      false,
    );
    expect(MembershipResourceSchema.safeParse({ ...membership, name: '' }).success).toBe(false);
    expect(MembershipResourceSchema.safeParse({ ...membership, createdAt: 'today' }).success).toBe(
      false,
    );
    expect(MembershipResourceSchema.safeParse({ ...membership, unexpected: true }).success).toBe(
      false,
    );
    expect(
      MembershipResourceSchema.safeParse({
        id: membership.id,
        email: membership.email,
        name: membership.name,
        role: membership.role,
        createdAt: membership.createdAt,
      }).success,
    ).toBe(false);
  });
});

describe('NO_MEMBERSHIP_CAPABILITY', () => {
  it('denies on every field, so a caller that spreads it cannot accidentally allow', () => {
    expect(NO_MEMBERSHIP_CAPABILITY).toEqual({
      canListMembers: false,
      canChangeRole: false,
      canRemoveMember: false,
      conferrableRoles: [],
      viewerUserId: null,
    });
  });
});
