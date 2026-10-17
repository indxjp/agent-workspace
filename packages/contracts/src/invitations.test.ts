import { describe, expect, it } from 'vitest';

import {
  AcceptedInvitationResponseSchema,
  INVITATION_TOKEN_MAX_LENGTH,
  InvitationListResponseSchema,
  InvitationResourceSchema,
  InvitationResponseSchema,
  IssuedInvitationResponseSchema,
} from './invitations.js';

const INVITATION = '7f1c1f2e-8d5a-4f7b-9c2e-1a2b3c4d5e6f';

const pending = {
  id: INVITATION,
  email: 'new.person@example.test',
  role: 'builder',
  invitedBy: '22222222-2222-4222-8222-222222222222',
  expiresAt: '2026-09-28T12:00:00.000Z',
  acceptedAt: null,
  revokedAt: null,
  createdAt: '2026-09-21T12:00:00.000Z',
};

const issued = {
  invitation: pending,
  token: 'aG9yc2UtYmF0dGVyeS1zdGFwbGU',
  link: `/accept-invitation?id=${INVITATION}&token=aG9yc2UtYmF0dGVyeS1zdGFwbGU`,
  warning: 'This is the only time this token is shown.',
};

const membership = {
  id: '11111111-1111-4111-8111-111111111111',
  principalId: '44444444-4444-4444-8444-444444444444',
  userId: '33333333-3333-4333-8333-333333333333',
  email: pending.email,
  name: 'new.person',
  role: 'builder',
  createdAt: '2026-09-22T09:00:00.000Z',
};

/** A copy of `source` with one key absent — the "missing field" case. */
function without(source: object, field: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...source };
  delete copy[field];
  return copy;
}

describe('InvitationResourceSchema', () => {
  it('accepts a pending, an accepted and a revoked row, and one with no inviter', () => {
    expect(InvitationResourceSchema.safeParse(pending).success).toBe(true);
    expect(
      InvitationResourceSchema.safeParse({ ...pending, acceptedAt: '2026-09-22T09:00:00.000Z' })
        .success,
    ).toBe(true);
    expect(
      InvitationResourceSchema.safeParse({ ...pending, revokedAt: '2026-09-22T09:00:00.000Z' })
        .success,
    ).toBe(true);
    expect(InvitationResourceSchema.safeParse({ ...pending, invitedBy: null }).success).toBe(true);
  });

  it('rejects a wrong type, an unknown role, a missing field and an absent nullable', () => {
    expect(InvitationResourceSchema.safeParse({ ...pending, expiresAt: 'next week' }).success).toBe(
      false,
    );
    expect(InvitationResourceSchema.safeParse({ ...pending, role: 'superuser' }).success).toBe(
      false,
    );
    expect(InvitationResourceSchema.safeParse(without(pending, 'expiresAt')).success).toBe(false);
    expect(InvitationResourceSchema.safeParse(without(pending, 'acceptedAt')).success).toBe(false);
  });

  it('rejects an unknown key, including the token and its hash', () => {
    expect(InvitationResourceSchema.safeParse({ ...pending, token: 'plaintext' }).success).toBe(
      false,
    );
    expect(InvitationResourceSchema.safeParse({ ...pending, tokenHash: 'abc' }).success).toBe(
      false,
    );
    expect(InvitationResourceSchema.safeParse({ ...pending, status: 'pending' }).success).toBe(
      false,
    );
  });
});

describe('invitation envelopes', () => {
  it('reads the list, the revoked item and the issued (create/resend) body', () => {
    expect(InvitationListResponseSchema.safeParse({ invitations: [pending] }).success).toBe(true);
    expect(
      InvitationListResponseSchema.safeParse({ invitations: [pending], total: 1 }).success,
    ).toBe(false);
    expect(InvitationResponseSchema.safeParse({ invitation: pending }).success).toBe(true);
    expect(InvitationResponseSchema.safeParse({ ...issued }).success).toBe(false);
    expect(IssuedInvitationResponseSchema.safeParse(issued).success).toBe(true);
  });

  it('refuses an issued body with no token, no link or no warning, so a reveal never renders blank', () => {
    for (const field of ['token', 'link', 'warning'] as const) {
      expect(IssuedInvitationResponseSchema.safeParse(without(issued, field)).success).toBe(false);
      expect(IssuedInvitationResponseSchema.safeParse({ ...issued, [field]: '' }).success).toBe(
        false,
      );
    }
    expect(IssuedInvitationResponseSchema.safeParse({ ...issued, sent: true }).success).toBe(false);
  });

  it('reads the accepted body with the membership’s principal id, and refuses one without a workspace', () => {
    const accepted = AcceptedInvitationResponseSchema.safeParse({
      workspaceId: '44444444-4444-4444-8444-444444444444',
      membership,
    });
    expect(accepted.success).toBe(true);
    expect(accepted.success && accepted.data.membership.principalId).toBe(membership.principalId);
    expect(AcceptedInvitationResponseSchema.safeParse({ membership }).success).toBe(false);
    expect(
      AcceptedInvitationResponseSchema.safeParse({ workspaceId: 'w', membership, token: 't' })
        .success,
    ).toBe(false);
  });

  it('exposes the token bound the accept route applies', () => {
    expect(INVITATION_TOKEN_MAX_LENGTH).toBe(4096);
  });
});
