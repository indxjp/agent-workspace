/**
 * The invitations model — issue #186.
 *
 * Three groups here are load-bearing rather than routine:
 *
 * - **State precedence.** A row can be revoked *and* expired *and* accepted at once, and the table
 *   has to say one thing about it. The order is asserted against every combination.
 * - **Action availability.** "Resend invalidates the prior token" and "revoke immediately removes
 *   any usable invitation action" are acceptance criteria, and both are decided here.
 * - **The token never reaches a string.** Every describer is driven with a token-bearing input
 *   where one can reach it at all, and asserted not to echo it.
 */
import { describe, expect, it } from 'vitest';

import type { InvitationCapability } from '../../contracts/invitations';
import {
  canResendInvitation,
  canRevokeInvitation,
  describeCopyState,
  describeInvitationFailure,
  describeInvitationState,
  describeInvitationTiming,
  describeSettledInvitation,
  EMPTY_INVITATION_DRAFT,
  invitationRequestFrom,
  invitationStateOf,
  revealIssuedInvitation,
  type InvitationResource,
  type InvitationState,
} from './invitations-model';

const NOW = Date.parse('2026-09-14T12:00:00.000Z');
const TOKEN = 'S3CR3T-token-value-nobody-may-echo';

const PENDING: InvitationResource = {
  id: '7f1c1f2e-8d5a-4f7b-9c2e-1a2b3c4d5e6f',
  email: 'new.person@example.test',
  role: 'builder',
  invitedBy: 'user-1',
  expiresAt: '2026-09-21T12:00:00.000Z',
  acceptedAt: null,
  revokedAt: null,
  createdAt: '2026-09-14T11:00:00.000Z',
};

/** Same row, its expiry already behind `NOW`. */
const EXPIRED: InvitationResource = { ...PENDING, expiresAt: '2026-09-13T12:00:00.000Z' };

const OWNER_CAPABILITY: InvitationCapability = {
  canListInvitations: true,
  canCreateInvitation: true,
  canResendInvitation: true,
  canRevokeInvitation: true,
  invitableRoles: ['owner', 'admin', 'builder', 'viewer'],
};

const REFUSED_CAPABILITY: InvitationCapability = {
  canListInvitations: false,
  canCreateInvitation: false,
  canResendInvitation: false,
  canRevokeInvitation: false,
  invitableRoles: [],
};

/** The create/resend body, exactly as `server/invitations/handlers.ts` builds it. */
function issuedBody(invitation: InvitationResource = PENDING) {
  return {
    invitation,
    token: TOKEN,
    link: `/accept-invitation?id=${invitation.id}&token=${TOKEN}`,
    warning:
      'This is the only time this token is shown. Only its hash is stored; it cannot be recovered, only revoked and reissued by resending.',
  };
}

describe('invitationStateOf', () => {
  it('calls a row with a future expiry and no other timestamp pending', () => {
    expect(invitationStateOf(PENDING, NOW)).toBe('pending');
  });

  it('calls a row whose expiry has passed expired', () => {
    expect(invitationStateOf(EXPIRED, NOW)).toBe('expired');
  });

  it('calls a row whose expiry has exactly arrived expired, as the accept path does', () => {
    // `acceptInvitation` treats `expiresAt <= now` as expired
    // (`server/rbac/memory-directory.ts`), so the table must not call the same row pending.
    expect(invitationStateOf({ ...PENDING, expiresAt: '2026-09-14T12:00:00.000Z' }, NOW)).toBe(
      'expired',
    );
    expect(invitationStateOf({ ...PENDING, expiresAt: '2026-09-14T12:00:00.001Z' }, NOW)).toBe(
      'pending',
    );
  });

  it('calls an accepted row accepted even while its expiry is still in the future', () => {
    expect(invitationStateOf({ ...PENDING, acceptedAt: '2026-09-14T11:30:00.000Z' }, NOW)).toBe(
      'accepted',
    );
  });

  it('prefers revoked over accepted, expired, and both together', () => {
    // The precedence, over every combination a row can actually carry. Revocation is the
    // deliberate act; expiry is the clock. Only one of them tells a person why the row is finished.
    const revokedAt = '2026-09-14T11:45:00.000Z';
    expect(invitationStateOf({ ...PENDING, revokedAt }, NOW)).toBe('revoked');
    expect(invitationStateOf({ ...EXPIRED, revokedAt }, NOW)).toBe('revoked');
    expect(
      invitationStateOf({ ...PENDING, revokedAt, acceptedAt: '2026-09-14T11:30:00.000Z' }, NOW),
    ).toBe('revoked');
    expect(
      invitationStateOf({ ...EXPIRED, revokedAt, acceptedAt: '2026-09-14T11:30:00.000Z' }, NOW),
    ).toBe('revoked');
  });

  it('prefers accepted over expired', () => {
    expect(invitationStateOf({ ...EXPIRED, acceptedAt: '2026-09-13T11:00:00.000Z' }, NOW)).toBe(
      'accepted',
    );
  });
});

describe('describeInvitationState and describeInvitationTiming', () => {
  const states: readonly InvitationState[] = ['pending', 'expired', 'accepted', 'revoked'];

  it('names every state', () => {
    expect(states.map(describeInvitationState)).toEqual([
      'Pending',
      'Expired',
      'Accepted',
      'Revoked',
    ]);
  });

  it('shows the one timestamp each state is actually about', () => {
    expect(describeInvitationTiming(PENDING, 'pending')).toMatch(/^Expires /u);
    expect(describeInvitationTiming(EXPIRED, 'expired')).toMatch(/^Expired /u);
    expect(
      describeInvitationTiming({ ...PENDING, acceptedAt: '2026-09-14T11:30:00.000Z' }, 'accepted'),
    ).toMatch(/^Accepted /u);
    expect(
      describeInvitationTiming({ ...PENDING, revokedAt: '2026-09-14T11:45:00.000Z' }, 'revoked'),
    ).toMatch(/^Revoked /u);
  });

  it('does not print an expiry beside a revoked or accepted row', () => {
    // "Expires 21 Sep" beside "Revoked" invites a person to wait for something that cannot happen.
    const revoked = { ...PENDING, revokedAt: '2026-09-14T11:45:00.000Z' };
    expect(describeInvitationTiming(revoked, 'revoked')).not.toContain('Expires');
    expect(describeInvitationTiming(revoked, 'revoked')).not.toContain('21');
  });

  it('prints a date rather than the raw ISO timestamp', () => {
    expect(describeInvitationTiming(PENDING, 'pending')).not.toContain('2026-09-21T12:00:00.000Z');
  });

  it('says nothing rather than "Revoked null" for a state whose timestamp is absent', () => {
    // Only reachable if a caller passes a state the row does not support. Saying nothing is the
    // honest answer; `describeInvitationState` still names the state.
    expect(describeInvitationTiming(PENDING, 'revoked')).toBe('');
    expect(describeInvitationTiming(PENDING, 'accepted')).toBe('');
  });
});

describe('canResendInvitation and canRevokeInvitation', () => {
  it('offers both actions on a pending row to a caller the server permits', () => {
    expect(canResendInvitation('pending', OWNER_CAPABILITY)).toBe(true);
    expect(canRevokeInvitation('pending', OWNER_CAPABILITY)).toBe(true);
  });

  it('offers both actions on an expired row, because resend mints a fresh expiry', () => {
    // `resendInvitation` has no `expired` outcome and the repository re-stamps `expires_at`, so an
    // expired row is resendable — and it has to be, since the partial pending-uniqueness index
    // makes a fresh `POST` for the same address a `409 already_invited` while that row exists.
    expect(canResendInvitation('expired', OWNER_CAPABILITY)).toBe(true);
    expect(canRevokeInvitation('expired', OWNER_CAPABILITY)).toBe(true);
  });

  it.each(['accepted', 'revoked'] as const)('offers no action on a %s row', (state) => {
    // "Revoke immediately removes any usable invitation action" — asserted as the state transition
    // rather than as a click, which is what a pure model can prove.
    expect(canResendInvitation(state, OWNER_CAPABILITY)).toBe(false);
    expect(canRevokeInvitation(state, OWNER_CAPABILITY)).toBe(false);
  });

  it.each(['pending', 'expired', 'accepted', 'revoked'] as const)(
    'offers nothing on a %s row to a caller the server refuses',
    (state) => {
      expect(canResendInvitation(state, REFUSED_CAPABILITY)).toBe(false);
      expect(canRevokeInvitation(state, REFUSED_CAPABILITY)).toBe(false);
    },
  );

  it('withholds each action on its own grant, not on the pair', () => {
    const revokeOnly: InvitationCapability = { ...OWNER_CAPABILITY, canResendInvitation: false };
    expect(canResendInvitation('pending', revokeOnly)).toBe(false);
    expect(canRevokeInvitation('pending', revokeOnly)).toBe(true);
  });
});

describe('describeSettledInvitation', () => {
  it('says why a finished row has no action, and where the person is now managed', () => {
    expect(describeSettledInvitation('accepted', OWNER_CAPABILITY)).toContain('members table');
    expect(describeSettledInvitation('revoked', OWNER_CAPABILITY)).toContain('new invitation');
  });

  it('says nothing on a row that still has actions', () => {
    expect(describeSettledInvitation('pending', OWNER_CAPABILITY)).toBeNull();
    expect(describeSettledInvitation('expired', OWNER_CAPABILITY)).toBeNull();
  });

  it('says nothing at all to a caller with no invitation grants', () => {
    // The whole section is already a refusal for them; a per-row note would be noise.
    expect(describeSettledInvitation('accepted', REFUSED_CAPABILITY)).toBeNull();
    expect(describeSettledInvitation('revoked', REFUSED_CAPABILITY)).toBeNull();
  });
});

describe('revealIssuedInvitation', () => {
  it('reads the create response into an absolute link the invitee can actually open', () => {
    const revealed = revealIssuedInvitation(issuedBody(), 'https://workspace.example.test');
    expect(revealed).toEqual({
      email: PENDING.email,
      link: `https://workspace.example.test/accept-invitation?id=${PENDING.id}&token=${TOKEN}`,
      warning: issuedBody().warning,
    });
  });

  it('carries the server’s own warning rather than a reworded one', () => {
    // A resend's warning differs from a create's — "The previous token no longer works" — and #186
    // asks the reveal to state that the prior token is invalidated. Carrying it is how that happens.
    const resent = {
      ...issuedBody(),
      warning: 'This is the only time this token is shown. The previous token no longer works.',
    };
    expect(revealIssuedInvitation(resent, 'https://workspace.example.test')?.warning).toBe(
      resent.warning,
    );
  });

  it('returns null rather than a broken string when the link and origin make no URL', () => {
    expect(revealIssuedInvitation(issuedBody(), 'not-an-origin')).toBeNull();
  });
});

describe('describeCopyState', () => {
  it('says nothing before the control has been used', () => {
    expect(describeCopyState('untouched')).toBeNull();
  });

  it('confirms a copy and repeats that the link is not shown again', () => {
    expect(describeCopyState('copied')).toContain('not shown again');
  });

  it('tells a caller with no clipboard to select the link, without quoting it', () => {
    const unavailable = describeCopyState('unavailable') ?? '';
    expect(unavailable).toContain('Select the link above');
    expect(unavailable).not.toContain(TOKEN);
  });
});

describe('invitationRequestFrom', () => {
  it('builds the POST body from a filled draft, trimming the address', () => {
    expect(
      invitationRequestFrom({ email: '  new.person@example.test  ', role: 'builder' }),
    ).toEqual({ email: 'new.person@example.test', role: 'builder' });
  });

  it('refuses a fresh draft, so the form cannot submit nothing', () => {
    expect(invitationRequestFrom(EMPTY_INVITATION_DRAFT)).toBeNull();
    expect(invitationRequestFrom({ email: '   ', role: 'builder' })).toBeNull();
  });

  it('holds no role in a fresh draft, so no grant is ever the default', () => {
    // `invitableRoles` is ordered most privileged first, so the alternative — the first of that
    // list — would make Owner the grant an untouched form sends.
    expect(EMPTY_INVITATION_DRAFT).toEqual({ email: '', role: null });
  });

  it('refuses a draft with no role, because the invitable set is the server’s to supply', () => {
    expect(invitationRequestFrom({ email: 'new.person@example.test', role: null })).toBeNull();
  });

  it('refuses only what the person can see is wrong, leaving the grammar to the server', () => {
    // `readEmail` (`server/rbac/handlers.ts`) is the boundary that decides what this API accepts. A
    // stricter browser pattern would refuse addresses the server would take, so the only rejection
    // here is a missing `@`.
    expect(invitationRequestFrom({ email: 'nobody', role: 'viewer' })).toBeNull();
    expect(invitationRequestFrom({ email: 'a@b', role: 'viewer' })).toEqual({
      email: 'a@b',
      role: 'viewer',
    });
  });
});

describe('describeInvitationFailure', () => {
  const apiProblem = (status: number, code: string, message: string) =>
    ({ kind: 'api', status, code, message }) as const;

  it.each([
    [
      409,
      'already_invited',
      'new.person@example.test already has a pending invitation to this workspace. Resend it, or revoke it before sending a new one.',
    ],
    [
      409,
      'already_accepted',
      "new.person@example.test's invitation has already been accepted; there is nothing to resend.",
    ],
    [
      409,
      'invitation_revoked',
      "new.person@example.test's invitation was revoked. Create a new one instead of resending it.",
    ],
    [
      403,
      'forbidden_role_conferral',
      'Your role may not confer the role "owner" in this workspace.',
    ],
    [403, 'forbidden', 'Your role may not perform this operation on invitations.'],
    [400, 'invalid_field', '"workspaceId" is not accepted by this request.'],
    [
      503,
      'invitations_runtime_not_configured',
      'The invitation audit sink and send-invitation seam are not wired into this deployment.',
    ],
    [
      500,
      'authorisation_undecidable',
      'The authenticated session no longer resolves to a current workspace member. No invitation change was made.',
    ],
  ])('keeps the server’s own sentence for %s %s', (status, code, message) => {
    expect(describeInvitationFailure(apiProblem(status, code, message))).toBe(message);
  });

  it('adds the one sentence the server cannot say, for a concealed 404', () => {
    // `no_such_invitation` is byte-identical for a foreign id and a nonexistent one (PR #175's
    // concealment finding), so the server cannot say which. What is true whenever this screen
    // provokes it is that the row it was showing is gone.
    const described = describeInvitationFailure(
      apiProblem(404, 'no_such_invitation', 'No invitation exists in this workspace.'),
    );
    expect(described).toContain('No invitation exists in this workspace.');
    expect(described).toContain('out of date');
  });

  it('reports a transport failure as the transport described it', () => {
    expect(
      describeInvitationFailure({
        kind: 'transport',
        reason: 'The request failed before the server could answer: network error',
      }),
    ).toBe('The request failed before the server could answer: network error');
  });

  it('never echoes a token, because it is never given one', () => {
    // The structural half of the guarantee: the argument is a `RequestProblem` built from an error
    // envelope, and the two responses that carry a token are both successes. Even so, a message
    // that somehow contained one is returned as the server wrote it and never interpolated into a
    // second sentence — so the assertion is over every describer this module exports that a token
    // could reach at all.
    const row = { ...PENDING, email: `${TOKEN}@example.test` };
    expect(describeInvitationState(invitationStateOf(row, NOW))).not.toContain(TOKEN);
    expect(describeInvitationTiming(row, 'pending')).not.toContain(TOKEN);
    expect(describeSettledInvitation('revoked', OWNER_CAPABILITY)).not.toContain(TOKEN);
    expect(describeCopyState('copied')).not.toContain(TOKEN);
    expect(describeCopyState('unavailable')).not.toContain(TOKEN);
  });
});
