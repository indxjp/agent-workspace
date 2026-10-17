import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { NO_INVITATION_CAPABILITY, type InvitationCapability } from '../../contracts/invitations';
import { NO_MEMBERSHIP_CAPABILITY, type MembershipCapability } from '../../contracts/team';
import { TeamScreen } from './team-screen';

/**
 * The team screen's first paint — issues #185 and #186.
 *
 * `renderToStaticMarkup` runs no effects, so what this file asserts is exactly what a person sees
 * before `GET /api/memberships` and `GET /api/invitations` have answered. Two states have to be
 * right there and neither can be reached by a later transition: a caller who may see a list gets
 * "loading" rather than an invented empty table, and a caller the server will refuse gets the
 * refusal immediately rather than a promise of a list that will never arrive.
 *
 * The two capabilities are asserted **independently**, because they are different §21 grants and
 * the screen must not read one as the other.
 */
const OWNER_CAPABILITY: MembershipCapability = {
  canListMembers: true,
  canChangeRole: true,
  canRemoveMember: true,
  conferrableRoles: ['owner', 'admin', 'builder', 'viewer'],
  viewerUserId: 'user-1',
};

const OWNER_INVITATION_CAPABILITY: InvitationCapability = {
  canListInvitations: true,
  canCreateInvitation: true,
  canResendInvitation: true,
  canRevokeInvitation: true,
  invitableRoles: ['owner', 'admin', 'builder', 'viewer'],
};

describe('TeamScreen', () => {
  it('opens on the loading state, not on an empty member list', () => {
    const html = renderToStaticMarkup(<TeamScreen capability={OWNER_CAPABILITY} />);
    expect(html).toContain('Loading members…');
    expect(html).not.toContain('no members yet');
    expect(html).not.toContain('<table');
  });

  it('is a single-h1 screen, which the accessibility floor requires', () => {
    expect(
      renderToStaticMarkup(<TeamScreen capability={OWNER_CAPABILITY} />).match(/<h1/gu),
    ).toHaveLength(1);
  });

  it('makes that h1 programmatically focusable, as the post-removal focus target', () => {
    // Focus cannot go back to the row's Remove button after a successful removal: the reload
    // unmounts it, and a detached element's focus falls to `<body>`. The heading outlives the
    // reload, so `confirmRemoval` sends focus here — which needs `tabIndex={-1}` to be possible at
    // all. The move itself is asserted in `tests/browser/team-members.spec.mjs`; no test in this
    // repository can observe focus without a browser.
    expect(renderToStaticMarkup(<TeamScreen capability={OWNER_CAPABILITY} />)).toMatch(
      /<h1[^>]*tabindex="-1"/u,
    );
  });

  it('opens on the refusal for a caller the server will not give the list to', () => {
    const html = renderToStaticMarkup(<TeamScreen capability={NO_MEMBERSHIP_CAPABILITY} />);
    expect(html).toContain('not part of your role');
    expect(html).not.toContain('Loading members…');
  });

  it('fails closed when mounted with no capability at all', () => {
    // The prop defaults to the deny-all constant, so a future caller that forgets it gets the
    // refusal rather than a screen full of controls (ADR-0015).
    expect(renderToStaticMarkup(<TeamScreen />)).toContain('not part of your role');
  });

  it('never mounts the confirmation before it is opened', () => {
    expect(renderToStaticMarkup(<TeamScreen capability={OWNER_CAPABILITY} />)).not.toContain(
      'role="dialog"',
    );
  });
});

describe('TeamScreen invitations section', () => {
  it('renders the invitations section under the members table', () => {
    const html = renderToStaticMarkup(
      <TeamScreen
        capability={OWNER_CAPABILITY}
        invitationCapability={OWNER_INVITATION_CAPABILITY}
      />,
    );
    expect(html).toContain('id="team-invitations-heading"');
    expect(html.indexOf('Loading members')).toBeLessThan(html.indexOf('Loading invitations'));
  });

  it('reads the two capabilities independently, never one as the other', () => {
    // They are different §21 grants (`memberships` and `invitations`), and an Owner of one is not
    // automatically permitted the other — `NOTHING` is the fallback for a role with no entry. A
    // screen that passed the members capability down to the invitations section would show controls
    // the invitation routes refuse.
    const membersOnly = renderToStaticMarkup(
      <TeamScreen capability={OWNER_CAPABILITY} invitationCapability={NO_INVITATION_CAPABILITY} />,
    );
    expect(membersOnly).toContain('Loading members…');
    expect(membersOnly).toContain('Inviting people is not part of your role');
    expect(membersOnly).not.toContain('Invite someone to this workspace');

    const invitationsOnly = renderToStaticMarkup(
      <TeamScreen
        capability={NO_MEMBERSHIP_CAPABILITY}
        invitationCapability={OWNER_INVITATION_CAPABILITY}
      />,
    );
    expect(invitationsOnly).toContain('Managing members is not part of your role');
    expect(invitationsOnly).toContain('Loading invitations…');
  });

  it('fails the invitations half closed when only the members capability is given', () => {
    // The prop defaults to the deny-all constant (ADR-0015), so the page adding one capability and
    // forgetting the other cannot produce invitation controls.
    const html = renderToStaticMarkup(<TeamScreen capability={OWNER_CAPABILITY} />);
    expect(html).toContain('Inviting people is not part of your role');
    expect(html).not.toContain('Invite someone to this workspace');
  });

  it('mounts no reveal on a first paint, whatever the capabilities are', () => {
    // Every one of #186's "must not re-reveal" events — reload, Back, a workspace switch — produces
    // a fresh mount of this tree, and this is the assertion that covers all of them statically.
    const html = renderToStaticMarkup(
      <TeamScreen
        capability={OWNER_CAPABILITY}
        invitationCapability={OWNER_INVITATION_CAPABILITY}
      />,
    );
    expect(html).not.toContain('data-invitation-reveal');
    expect(html).not.toContain('accept-invitation');
  });

  it('is still a single-h1 screen with both sections mounted', () => {
    expect(
      renderToStaticMarkup(
        <TeamScreen
          capability={OWNER_CAPABILITY}
          invitationCapability={OWNER_INVITATION_CAPABILITY}
        />,
      ).match(/<h1/gu),
    ).toHaveLength(1);
  });
});
