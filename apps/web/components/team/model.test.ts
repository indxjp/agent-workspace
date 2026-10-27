/**
 * The team screen's decisions — issue #185.
 *
 * Everything the members table and the removal confirmation do is in `./model.ts` precisely so it
 * can be driven here: this repository has no jsdom, so a state reachable only through an internal
 * `useState` transition would be untestable, and an untestable state is an untested one.
 */
import { describe, expect, it } from 'vitest';

import { NO_MEMBERSHIP_CAPABILITY, type MembershipCapability } from '../../contracts/team';
import {
  canRemoveMember,
  describeMembershipFailure,
  describeRole,
  describeWithheldControls,
  formatTeamDate,
  isCurrentUser,
  removalImpactFromReads,
  roleOptionsFor,
  soleOwnerUserId,
  summariseRemovalImpact,
  type MembershipResource,
} from './model';

function member(overrides: Partial<MembershipResource> = {}): MembershipResource {
  return {
    id: 'membership-1',
    principalId: '11111111-1111-4111-8111-111111111111',
    userId: 'user-1',
    email: 'aya.ito@example.test',
    name: 'Aya Ito',
    role: 'owner',
    createdAt: '2026-09-12T00:00:00.000Z',
    ...overrides,
  };
}

const OWNER = member();
const ADMIN = member({
  id: 'membership-2',
  principalId: '22222222-2222-4222-8222-222222222222',
  userId: 'user-2',
  email: 'kenji.sato@example.test',
  name: 'Kenji Sato',
  role: 'admin',
});
const VIEWER = member({
  id: 'membership-3',
  principalId: '33333333-3333-4333-8333-333333333333',
  userId: 'user-3',
  email: 'lan.nguyen@example.test',
  name: 'Nguyen Thi Lan',
  role: 'viewer',
});

/** What `server/team/membership-capability.ts` answers for a workspace Owner. */
const OWNER_CAPABILITY: MembershipCapability = {
  canListMembers: true,
  canChangeRole: true,
  canRemoveMember: true,
  conferrableRoles: ['owner', 'admin', 'builder', 'viewer'],
  viewerUserId: 'user-1',
};

/** …and for an Admin, whose conferral set is two roles wide and does not include Owner. */
const ADMIN_CAPABILITY: MembershipCapability = {
  canListMembers: true,
  canChangeRole: true,
  canRemoveMember: true,
  conferrableRoles: ['admin', 'viewer'],
  viewerUserId: 'user-2',
};

describe('isCurrentUser', () => {
  it('marks the row whose user id the server said is the viewer', () => {
    expect(isCurrentUser(OWNER, OWNER_CAPABILITY)).toBe(true);
    expect(isCurrentUser(ADMIN, OWNER_CAPABILITY)).toBe(false);
  });

  it('marks nobody when the viewer could not be resolved', () => {
    expect(isCurrentUser(OWNER, NO_MEMBERSHIP_CAPABILITY)).toBe(false);
  });
});

describe('soleOwnerUserId', () => {
  it('names the only Owner', () => {
    expect(soleOwnerUserId([OWNER, ADMIN, VIEWER])).toBe('user-1');
  });

  it('names nobody when a second Owner exists, because neither is the last one', () => {
    expect(
      soleOwnerUserId([OWNER, member({ id: 'm4', userId: 'user-4', role: 'owner' })]),
    ).toBeNull();
  });

  it('names nobody in a list with no Owner at all', () => {
    expect(soleOwnerUserId([ADMIN, VIEWER])).toBeNull();
    expect(soleOwnerUserId([])).toBeNull();
  });
});

describe('roleOptionsFor', () => {
  it('offers an Owner every role the server said they may confer, minus the one already held', () => {
    expect(roleOptionsFor(ADMIN, OWNER_CAPABILITY, 'user-1')).toEqual([
      'owner',
      'builder',
      'viewer',
    ]);
  });

  it('offers an Admin only the roles conferral allows, so Owner is never in the list', () => {
    expect(roleOptionsFor(VIEWER, ADMIN_CAPABILITY, 'user-1')).toEqual(['admin']);
  });

  it('offers nothing on the sole Owner’s row, because every option is the refused demotion', () => {
    expect(roleOptionsFor(OWNER, OWNER_CAPABILITY, 'user-1')).toEqual([]);
  });

  it('offers the Owner’s row its options again once a second Owner exists', () => {
    expect(roleOptionsFor(OWNER, OWNER_CAPABILITY, null)).toEqual(['admin', 'builder', 'viewer']);
  });

  it('offers nothing at all when the server refused role changes', () => {
    expect(roleOptionsFor(ADMIN, NO_MEMBERSHIP_CAPABILITY, null)).toEqual([]);
  });
});

describe('canRemoveMember', () => {
  it('allows a member the server said this caller may remove', () => {
    expect(canRemoveMember(ADMIN, OWNER_CAPABILITY, 'user-1')).toBe(true);
  });

  it('withholds the sole Owner, whom the server refuses with 409 last_owner', () => {
    expect(canRemoveMember(OWNER, OWNER_CAPABILITY, 'user-1')).toBe(false);
  });

  it('withholds everyone when the server refused removals', () => {
    expect(canRemoveMember(ADMIN, NO_MEMBERSHIP_CAPABILITY, null)).toBe(false);
  });
});

describe('describeWithheldControls', () => {
  it('states the last-Owner reason on the row rather than only on failure', () => {
    expect(describeWithheldControls(OWNER, OWNER_CAPABILITY, 'user-1')).toBe(
      'Last Owner. Promote another member to Owner before changing or removing this one.',
    );
  });

  it('does not tell an Admin to make a promotion the server refuses them', () => {
    // `conferRole('admin', 'owner')` is deny, so an Admin's conferral set is `['admin', 'viewer']`
    // and `roleOptionsFor` offers Owner on no row. "Promote another member to Owner" would name a
    // control this screen never gives them, which is the opposite of #185's "actionable and direct".
    const sentence = describeWithheldControls(OWNER, ADMIN_CAPABILITY, 'user-1');
    expect(sentence).toContain('Last Owner');
    expect(sentence).toContain('Only an Owner can promote');
    expect(sentence).not.toMatch(/^Last Owner\. Promote/u);
  });

  it('says nothing on a row whose controls are offered', () => {
    expect(describeWithheldControls(ADMIN, OWNER_CAPABILITY, 'user-1')).toBeNull();
  });

  it('says nothing to a caller who has no controls to withhold in the first place', () => {
    // A Builder or Viewer never reaches the list at all; explaining a restriction on a control
    // they were never offered would invent a refusal the server never made.
    expect(describeWithheldControls(OWNER, NO_MEMBERSHIP_CAPABILITY, 'user-1')).toBeNull();
  });
});

describe('removalImpactFromReads', () => {
  it('reports both counts when both reads answered', () => {
    expect(removalImpactFromReads(2, 1)).toEqual({ sessions: 2, projects: 1 });
  });

  it('reports nothing when either read did not, rather than substituting a zero', () => {
    expect(removalImpactFromReads(null, 1)).toBeNull();
    expect(removalImpactFromReads(2, null)).toBeNull();
  });
});

describe('summariseRemovalImpact', () => {
  it('says so plainly when the member owns nothing', () => {
    expect(summariseRemovalImpact({ sessions: 0, projects: 0 })).toContain(
      'owns no sessions and no projects',
    );
  });

  it('names the counts in the singular', () => {
    const sentence = summariseRemovalImpact({ sessions: 1, projects: 1 });
    expect(sentence).toContain('1 session and 1 project');
    expect(sentence).toContain('no history is deleted');
  });

  it('names the counts in the plural', () => {
    expect(summariseRemovalImpact({ sessions: 3, projects: 12 })).toContain(
      '3 sessions and 12 projects',
    );
  });

  it('warns that owned sessions may refuse the removal outright', () => {
    expect(summariseRemovalImpact({ sessions: 1, projects: 0 })).toContain('may be refused');
  });

  it('warns about kept projects even when there are no sessions', () => {
    const sentence = summariseRemovalImpact({ sessions: 0, projects: 4 });
    expect(sentence).toContain('0 sessions and 4 projects');
    expect(sentence).toContain('may be refused');
  });
});

describe('describeMembershipFailure', () => {
  const noImpact = { status: 409, impact: null };

  it('renders the last-Owner refusal in the server’s own words', () => {
    expect(
      describeMembershipFailure(
        {
          kind: 'api',
          status: 409,
          code: 'last_owner',
          message: 'This is the workspace’s last Owner. Promote another member first.',
        },
        noImpact,
      ),
    ).toBe('This is the workspace’s last Owner. Promote another member first.');
  });

  it.each([
    ['forbidden_role_conferral', 403, 'A caller may not confer a role it does not itself hold.'],
    ['forbidden', 403, 'spec §21 → write on "memberships" is granted "none".'],
    ['no_such_membership', 404, 'No membership membership-2 in this workspace.'],
    ['invalid_field', 400, '"role" must be one of spec §21’s four roles.'],
    ['authorisation_undecidable', 500, 'No conferral decision was made.'],
  ])('renders %s with the sentence the route sent', (code, status, message) => {
    expect(describeMembershipFailure({ kind: 'api', status, code, message }, noImpact)).toBe(
      message,
    );
  });

  it('names the still-owned sessions when an unenveloped 500 follows a count that found some', () => {
    // The referential-integrity case: `sessions_member_workspace_fk` rejects the delete, the
    // membership routes are outside `server/http/route-error-boundaries.ts`, and the violation
    // therefore arrives with no envelope at all. The sessions named here were counted by this
    // screen moments earlier — it is a measurement, not a guess.
    const sentence = describeMembershipFailure(
      { kind: 'transport', reason: 'The server answered 500 without the usual error envelope.' },
      { status: 500, impact: { sessions: 2, projects: 0 } },
    );
    expect(sentence).toContain('The server answered 500 without the usual error envelope.');
    expect(sentence).toContain('still owns 2 sessions');
    expect(sentence).toContain('Delete or reassign those sessions first');
  });

  it('adds nothing to a 500 when the count found no sessions to blame it on', () => {
    expect(
      describeMembershipFailure(
        { kind: 'transport', reason: 'The server answered 500 without the usual error envelope.' },
        { status: 500, impact: { sessions: 0, projects: 3 } },
      ),
    ).toBe('The server answered 500 without the usual error envelope.');
  });

  it('adds nothing to a 500 when the impact could not be counted at all', () => {
    expect(
      describeMembershipFailure(
        { kind: 'transport', reason: 'The server answered 500 without the usual error envelope.' },
        { status: 500, impact: null },
      ),
    ).toBe('The server answered 500 without the usual error envelope.');
  });

  it('reports a transport failure as itself, with no status to blame', () => {
    expect(
      describeMembershipFailure(
        { kind: 'transport', reason: 'The request failed before the server could answer: reset.' },
        { status: null, impact: { sessions: 5, projects: 0 } },
      ),
    ).toBe('The request failed before the server could answer: reset.');
  });
});

describe('display helpers', () => {
  it('prints a role the way §21 prints it', () => {
    expect(describeRole('owner')).toBe('Owner');
    expect(describeRole('viewer')).toBe('Viewer');
  });

  it('returns the raw string rather than "Invalid Date" for a malformed timestamp', () => {
    expect(formatTeamDate('not-a-date')).toBe('not-a-date');
  });

  it('formats a real join timestamp as a date', () => {
    expect(formatTeamDate('2026-09-12T00:00:00.000Z')).not.toBe('2026-09-12T00:00:00.000Z');
  });
});
