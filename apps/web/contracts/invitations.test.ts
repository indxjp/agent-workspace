/**
 * The invitation wire contract — issue #186.
 *
 * Two assertions here are load-bearing rather than routine. The first is that a **real**
 * `InvitationSummary`, built the way `apps/web/server/rbac/postgres-directory.ts` builds one,
 * parses: a wire mapper has to prove that persistence-shaped values satisfy the shared schema, and
 * the timestamps are the part that drifts. The second is the negative one — a list row carrying a
 * `token` is rejected — because `.strict()` is what keeps §22's "shown once" from being undone by a
 * future list field.
 */
import { describe, expect, it } from 'vitest';

import type { InvitationSummary } from '../server/rbac/directory';
import {
  InvitationListResponseSchema,
  InvitationResourceSchema,
  IssuedInvitationResponseSchema,
  NO_INVITATION_CAPABILITY,
} from './invitations';

/**
 * Shaped exactly like `postgres-directory.ts`'s `invitation()` projection, and typed as the server's
 * own `InvitationSummary` so a field added there fails this file rather than the screen.
 */
const pending: InvitationSummary = {
  id: '7f1c1f2e-8d5a-4f7b-9c2e-1a2b3c4d5e6f',
  email: 'new.person@example.test',
  role: 'builder',
  invitedBy: 'user-1',
  expiresAt: '2026-09-21T12:00:00.000Z',
  acceptedAt: null,
  revokedAt: null,
  createdAt: '2026-09-14T12:00:00.000Z',
};

/** A copy of `source` with one key absent — the "missing field" and "absent, not null" cases. */
function without(source: object, field: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...source };
  delete copy[field];
  return copy;
}

describe('InvitationResourceSchema', () => {
  it('accepts a row shaped exactly as the directory projects one', () => {
    expect(InvitationResourceSchema.parse(pending)).toEqual(pending);
  });

  it('accepts the accepted and revoked rows, whose timestamps are present rather than null', () => {
    const accepted = { ...pending, acceptedAt: '2026-09-15T08:00:00.000Z' };
    const revoked = { ...pending, revokedAt: '2026-09-15T09:30:00.000Z' };
    expect(InvitationResourceSchema.parse(accepted)).toEqual(accepted);
    expect(InvitationResourceSchema.parse(revoked)).toEqual(revoked);
  });

  it('accepts a row no inviter can be named for, because the directory types it nullable', () => {
    expect(InvitationResourceSchema.safeParse({ ...pending, invitedBy: null }).success).toBe(true);
  });

  it('rejects a nullable timestamp that is absent rather than null', () => {
    // `exactOptionalPropertyTypes` is on and the protocol spells "not yet" as `null`, so an absent
    // key is a response this screen has not been taught to read — not a row with no acceptance.
    expect(InvitationResourceSchema.safeParse(without(pending, 'acceptedAt')).success).toBe(false);
    expect(InvitationResourceSchema.safeParse(without(pending, 'revokedAt')).success).toBe(false);
  });

  it('rejects a missing field, a blank id and a role §21 does not name', () => {
    expect(InvitationResourceSchema.safeParse(without(pending, 'expiresAt')).success).toBe(false);
    expect(InvitationResourceSchema.safeParse({ ...pending, id: '' }).success).toBe(false);
    expect(InvitationResourceSchema.safeParse({ ...pending, role: 'superuser' }).success).toBe(
      false,
    );
  });

  it('rejects a timestamp that is not ISO-8601', () => {
    expect(InvitationResourceSchema.safeParse({ ...pending, expiresAt: 'next week' }).success).toBe(
      false,
    );
    expect(
      InvitationResourceSchema.safeParse({ ...pending, createdAt: 1_757_000_000 }).success,
    ).toBe(false);
  });

  it('rejects an unknown key, including a token a list response must never carry', () => {
    // The whole point of `.strict()` on this schema. `listInvitations` cannot produce a token today
    // (`InvitationSummary` has nowhere to put one); if it ever could, this fails instead of a token
    // reaching a component that has no reveal to put it in.
    expect(InvitationResourceSchema.safeParse({ ...pending, unexpected: true }).success).toBe(
      false,
    );
    expect(InvitationResourceSchema.safeParse({ ...pending, token: 'plaintext' }).success).toBe(
      false,
    );
    expect(InvitationResourceSchema.safeParse({ ...pending, tokenHash: 'abc' }).success).toBe(
      false,
    );
  });
});

describe('InvitationListResponseSchema', () => {
  it('accepts an empty list and a populated one', () => {
    expect(InvitationListResponseSchema.parse({ invitations: [] })).toEqual({ invitations: [] });
    expect(InvitationListResponseSchema.parse({ invitations: [pending] })).toEqual({
      invitations: [pending],
    });
  });

  it('rejects a body that is not the envelope this route answers with', () => {
    expect(InvitationListResponseSchema.safeParse({ invitations: {} }).success).toBe(false);
    expect(InvitationListResponseSchema.safeParse([pending]).success).toBe(false);
    expect(
      InvitationListResponseSchema.safeParse({ invitations: [pending], total: 1 }).success,
    ).toBe(false);
  });
});

describe('IssuedInvitationResponseSchema', () => {
  const issued = {
    invitation: pending,
    token: 'aG9yc2UtYmF0dGVyeS1zdGFwbGU',
    link: '/accept-invitation?id=7f1c1f2e-8d5a-4f7b-9c2e-1a2b3c4d5e6f&token=aG9yc2UtYmF0dGVyeS1zdGFwbGU',
    warning:
      'This is the only time this token is shown. Only its hash is stored; it cannot be recovered, only revoked and reissued by resending.',
  };

  it('accepts the create and resend bodies, warning sentence included', () => {
    expect(IssuedInvitationResponseSchema.parse(issued)).toEqual(issued);
  });

  it('rejects a body with no link, no token or no warning, so the reveal can never render a blank', () => {
    for (const field of ['token', 'link', 'warning'] as const) {
      expect(IssuedInvitationResponseSchema.safeParse(without(issued, field)).success).toBe(false);
      expect(IssuedInvitationResponseSchema.safeParse({ ...issued, [field]: '' }).success).toBe(
        false,
      );
    }
  });

  it('rejects an unknown key and a malformed nested invitation', () => {
    expect(IssuedInvitationResponseSchema.safeParse({ ...issued, sent: true }).success).toBe(false);
    expect(
      IssuedInvitationResponseSchema.safeParse({
        ...issued,
        invitation: { ...pending, role: 'superuser' },
      }).success,
    ).toBe(false);
  });
});

describe('NO_INVITATION_CAPABILITY', () => {
  it('denies on every field, so a caller that spreads it cannot accidentally allow', () => {
    expect(NO_INVITATION_CAPABILITY).toEqual({
      canListInvitations: false,
      canCreateInvitation: false,
      canResendInvitation: false,
      canRevokeInvitation: false,
      invitableRoles: [],
    });
  });
});
