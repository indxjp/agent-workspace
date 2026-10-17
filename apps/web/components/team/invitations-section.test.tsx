import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { NO_INVITATION_CAPABILITY, type InvitationCapability } from '../../contracts/invitations';
import { InvitationsSection } from './invitations-section';

/**
 * The invitations section's first paint — issue #186.
 *
 * `renderToStaticMarkup` runs no effects, so what this file asserts is exactly what a person sees
 * before `GET /api/invitations` has answered — and, load-bearingly, that **no reveal exists on a
 * first paint at all**. A reveal that could appear without an action having produced it would be a
 * reveal that survived something, which is the one thing #186 forbids.
 *
 * The lifecycle itself — created, copied, cleared on reload, Back, resend, revoke, dismiss and a
 * workspace switch — is `tests/browser/team-invitations.spec.mjs`'s: it needs effects, a network
 * and a real document, and this repository has no jsdom.
 */
const OWNER_CAPABILITY: InvitationCapability = {
  canListInvitations: true,
  canCreateInvitation: true,
  canResendInvitation: true,
  canRevokeInvitation: true,
  invitableRoles: ['owner', 'admin', 'builder', 'viewer'],
};

function section(capability?: InvitationCapability): string {
  return renderToStaticMarkup(
    capability === undefined ? (
      <InvitationsSection />
    ) : (
      <InvitationsSection capability={capability} />
    ),
  );
}

describe('InvitationsSection', () => {
  it('opens on the loading state, not on an empty invitation list', () => {
    const html = section(OWNER_CAPABILITY);
    expect(html).toContain('Loading invitations…');
    expect(html).not.toContain('No invitations have been sent');
    expect(html).not.toContain('<table');
  });

  it('opens on the refusal for a caller the server will not give the list to', () => {
    const html = section(NO_INVITATION_CAPABILITY);
    expect(html).toContain('not part of your role');
    expect(html).not.toContain('Loading invitations…');
  });

  it('fails closed when mounted with no capability at all', () => {
    // The prop defaults to the deny-all constant, so a future caller that forgets it gets the
    // refusal rather than a section full of controls (ADR-0015).
    const html = section();
    expect(html).toContain('not part of your role');
    expect(html).not.toContain('Invite someone to this workspace');
  });

  it('never renders a reveal on a first paint, for any capability', () => {
    // The static half of "reload, Back and workspace switching never re-reveal it": a fresh mount
    // is what every one of those produces, and the reveal state starts empty in all of them.
    for (const capability of [OWNER_CAPABILITY, NO_INVITATION_CAPABILITY]) {
      const html = section(capability);
      expect(html).not.toContain('data-invitation-reveal');
      expect(html).not.toContain('accept-invitation');
      expect(html).not.toContain('only time this token is shown');
    }
  });

  it('is named by its own heading rather than by a duplicated label', () => {
    const html = section(OWNER_CAPABILITY);
    expect(html).toContain('aria-labelledby="team-invitations-heading"');
    expect(html).toContain('id="team-invitations-heading"');
  });

  it('makes that h2 programmatically focusable, as the post-dismiss focus target', () => {
    // Dismiss lives inside the reveal it removes, so focus cannot return to it: a detached element's
    // focus falls to `<body>` and the next Tab restarts from the top of the page. The heading
    // outlives every path that clears a reveal, so `clearReveal` sends focus here — which needs
    // `tabIndex={-1}` to be possible at all. The move itself is asserted in
    // `tests/browser/team-invitations.spec.mjs`; no test here can observe focus without a browser.
    expect(section(OWNER_CAPABILITY)).toMatch(/<h2[^>]*tabindex="-1"/u);
  });

  it('adds no second h1 to the screen, whose accessibility floor allows exactly one', () => {
    expect(section(OWNER_CAPABILITY)).not.toContain('<h1');
  });

  it('shows the invite form to a caller who may create, above the list', () => {
    const html = section(OWNER_CAPABILITY);
    expect(html).toContain('Invite someone to this workspace');
    expect(html.indexOf('Invite someone')).toBeLessThan(html.indexOf('Loading invitations'));
  });
});
