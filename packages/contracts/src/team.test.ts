import { describe, expect, it } from 'vitest';

import {
  CreatedUserResponseSchema,
  MEMBERSHIP_ROLES,
  MembershipListResponseSchema,
  MembershipResourceSchema,
  MembershipResponseSchema,
  MeResponseSchema,
  PRINCIPAL_KINDS,
  USER_EMAIL_MAX_LENGTH,
  USER_NAME_MAX_LENGTH,
  UserListResponseSchema,
  UserResourceSchema,
} from './team.js';

const membership = {
  id: '11111111-1111-4111-8111-111111111111',
  principalId: '33333333-3333-4333-8333-333333333333',
  userId: '22222222-2222-4222-8222-222222222222',
  email: 'aya.ito@example.test',
  name: 'Aya Ito',
  role: 'owner',
  createdAt: '2026-09-12T00:00:00.000Z',
};

const user = {
  id: membership.userId,
  email: membership.email,
  name: membership.name,
  createdAt: '2026-09-01T00:00:00.000Z',
};

const sessionPrincipal = {
  principalId: '33333333-3333-4333-8333-333333333333',
  kind: 'membership',
  role: 'owner',
  workspaceId: '44444444-4444-4444-8444-444444444444',
  userId: membership.userId,
  label: membership.name,
};

const apiKeyPrincipal = {
  principalId: '55555555-5555-4555-8555-555555555555',
  kind: 'api-key',
  role: 'builder',
  workspaceId: sessionPrincipal.workspaceId,
  userId: null,
  label: 'ci',
};

/** A copy of `source` with one key absent — the "missing field" case. */
function without(source: object, field: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...source };
  delete copy[field];
  return copy;
}

describe('MEMBERSHIP_ROLES', () => {
  it('is exactly §21’s four roles in §21’s order, and the bounds the routes apply', () => {
    expect([...MEMBERSHIP_ROLES]).toEqual(['owner', 'admin', 'builder', 'viewer']);
    expect(USER_EMAIL_MAX_LENGTH).toBe(320);
    expect(USER_NAME_MAX_LENGTH).toBe(200);
  });
});

describe('MembershipResourceSchema', () => {
  it('accepts a membership row with its principal id', () => {
    expect(MembershipResourceSchema.safeParse(membership).success).toBe(true);
  });

  it('rejects a role §21 does not name, a wrong type, a blank principal id and an unknown key', () => {
    expect(MembershipResourceSchema.safeParse({ ...membership, role: 'superuser' }).success).toBe(
      false,
    );
    expect(
      MembershipResourceSchema.safeParse({ ...membership, createdAt: 1_757_000_000 }).success,
    ).toBe(false);
    expect(MembershipResourceSchema.safeParse({ ...membership, principalId: '' }).success).toBe(
      false,
    );
    expect(MembershipResourceSchema.safeParse(without(membership, 'principalId')).success).toBe(
      false,
    );
    expect(MembershipResourceSchema.safeParse({ ...membership, unexpected: true }).success).toBe(
      false,
    );
  });

  it('rejects a missing required field and a blank name', () => {
    expect(MembershipResourceSchema.safeParse(without(membership, 'userId')).success).toBe(false);
    expect(MembershipResourceSchema.safeParse({ ...membership, name: '' }).success).toBe(false);
  });
});

describe('membership envelopes', () => {
  it('reads the list and the wrapped item, and refuses a bare item where a wrap is promised', () => {
    expect(MembershipListResponseSchema.safeParse({ memberships: [membership] }).success).toBe(
      true,
    );
    expect(
      MembershipListResponseSchema.safeParse({ memberships: [membership], total: 1 }).success,
    ).toBe(false);
    expect(MembershipResponseSchema.safeParse({ membership }).success).toBe(true);
    expect(MembershipResponseSchema.safeParse(membership).success).toBe(false);
  });
});

describe('UserResourceSchema', () => {
  it('accepts a user row and rejects a wrong type, an unknown key and a missing field', () => {
    expect(UserResourceSchema.safeParse(user).success).toBe(true);
    expect(UserResourceSchema.safeParse({ ...user, createdAt: 'yesterday' }).success).toBe(false);
    expect(UserResourceSchema.safeParse({ ...user, role: 'owner' }).success).toBe(false);
    expect(UserResourceSchema.safeParse(without(user, 'email')).success).toBe(false);
  });

  it('reads the list and the 201 of a created user with its membership', () => {
    expect(UserListResponseSchema.safeParse({ users: [user] }).success).toBe(true);
    expect(UserListResponseSchema.safeParse({ users: [user], memberships: [] }).success).toBe(
      false,
    );
    expect(CreatedUserResponseSchema.safeParse({ user, membership }).success).toBe(true);
    expect(CreatedUserResponseSchema.safeParse({ user }).success).toBe(false);
  });
});

describe('MeResponseSchema', () => {
  it('names the two principal kinds the RBAC layer distinguishes, kebab-cased', () => {
    expect([...PRINCIPAL_KINDS]).toEqual(['membership', 'api-key']);
  });

  it('accepts a membership principal, which always names a user', () => {
    expect(MeResponseSchema.safeParse(sessionPrincipal).success).toBe(true);
  });

  it('accepts an API-key principal, whose userId is null', () => {
    const parsed = MeResponseSchema.safeParse(apiKeyPrincipal);
    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data.userId : 'not parsed').toBeNull();
  });

  it('rejects an unknown key, so nothing the server adds arrives unread', () => {
    expect(MeResponseSchema.safeParse({ ...sessionPrincipal, apiKeyId: 'key-1' }).success).toBe(
      false,
    );
    expect(MeResponseSchema.safeParse({ ...sessionPrincipal, via: 'session' }).success).toBe(false);
  });

  it('rejects each field being absent', () => {
    for (const field of Object.keys(sessionPrincipal)) {
      expect(
        MeResponseSchema.safeParse(without(sessionPrincipal, field)).success,
        `${field} absent was accepted`,
      ).toBe(false);
    }
  });

  it('rejects a kind or a role outside its set, and any blank string', () => {
    // The server's own spelling of the second kind. The wire is kebab-case, and a body that
    // carried the stored `api_key` would be the mapping having been skipped.
    expect(MeResponseSchema.safeParse({ ...sessionPrincipal, kind: 'api_key' }).success).toBe(
      false,
    );
    expect(MeResponseSchema.safeParse({ ...sessionPrincipal, kind: 'service' }).success).toBe(
      false,
    );
    expect(MeResponseSchema.safeParse({ ...sessionPrincipal, role: 'superuser' }).success).toBe(
      false,
    );
    for (const field of ['principalId', 'workspaceId', 'label', 'userId'] as const) {
      expect(
        MeResponseSchema.safeParse({ ...sessionPrincipal, [field]: '' }).success,
        `a blank ${field} was accepted`,
      ).toBe(false);
    }
    // `null` is the one way `userId` may say "there is no user"; `undefined` is a missing field.
    expect(MeResponseSchema.safeParse({ ...apiKeyPrincipal, userId: undefined }).success).toBe(
      false,
    );
  });
});
