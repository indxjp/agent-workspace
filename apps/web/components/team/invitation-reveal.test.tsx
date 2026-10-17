import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { InvitationReveal } from './invitation-reveal';
import type { CopyState, RevealedInvitation } from './invitations-model';

/**
 * The one-time reveal — issue #186's central security requirement, asserted over the markup.
 *
 * This repository has no jsdom and no Testing Library, so a component test is one
 * `renderToStaticMarkup` pass with no effects and no events. What that *can* prove is exactly what
 * matters most here, and it is all negative: the token appears **once** in the document, inside the
 * reveal element and in no attribute, and it is never an `<a href>`.
 *
 * Deleting the `<code>`-not-`<a>` decision fails `renders the link as inert text, never as a link`.
 */
const TOKEN = 'S3CR3T-token-value-nobody-may-echo';

const REVEALED: RevealedInvitation = {
  email: 'new.person@example.test',
  link: `https://workspace.example.test/accept-invitation?id=7f1c1f2e-8d5a-4f7b-9c2e-1a2b3c4d5e6f&token=${TOKEN}`,
  warning:
    'This is the only time this token is shown. Only its hash is stored; it cannot be recovered, only revoked and reissued by resending.',
};

const noop = () => undefined;

function reveal(copyState: CopyState = 'untouched', revealed = REVEALED): string {
  return renderToStaticMarkup(
    <InvitationReveal revealed={revealed} copyState={copyState} onCopy={noop} onDismiss={noop} />,
  );
}

/** Something on the page that is not the reveal, so "outside the reveal" is a non-empty string. */
const DECOY = 'decoy-sibling-of-the-reveal';

/**
 * The reveal with a sibling beside it.
 *
 * The reveal is otherwise the root element of every render here, so removing it would leave `''` and
 * an assertion that nothing outside it carries the token would hold however the component behaved.
 * With a sibling there is something left to assert about — and {@link reveal} renders the identical
 * markup on its own, which is what makes removing it exact rather than a regex guess at where the
 * element ends.
 */
function revealBesideASibling(): string {
  return renderToStaticMarkup(
    <div>
      <InvitationReveal revealed={REVEALED} copyState="untouched" onCopy={noop} onDismiss={noop} />
      <p>{DECOY}</p>
    </div>,
  );
}

/**
 * The link as it appears in the markup. React escapes `&` between the query parameters, which is
 * correct HTML and is what a `<code>` element containing a URL must do — the DOM text node still
 * reads as the original, which is what the clipboard and a manual selection get.
 */
const RENDERED_LINK = REVEALED.link.replace(/&/gu, '&amp;');

describe('InvitationReveal', () => {
  it('shows the link, the invitee and the server’s own one-time warning', () => {
    const html = reveal();
    expect(html).toContain(RENDERED_LINK);
    expect(html).toContain('new.person@example.test');
    expect(html).toContain('only time this token is shown');
  });

  it('carries the warning the server wrote rather than one of its own', () => {
    // A resend's warning differs from a create's, and #186 asks the reveal to state that the prior
    // token is invalidated. It can only do that by rendering what the server sent.
    const resent: RevealedInvitation = {
      ...REVEALED,
      warning: 'This is the only time this token is shown. The previous token no longer works.',
    };
    expect(reveal('untouched', resent)).toContain('The previous token no longer works.');
  });

  it('renders the link as inert text, never as a link', () => {
    // An anchor is one click away from putting the token in the address bar, in `document.referrer`
    // and in browser history — three of the five surfaces #186 names. The whole element is asserted
    // free of any anchor and of any `href` at all.
    const html = reveal();
    expect(html).toContain('<code');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href');
  });

  it('puts the token in exactly one place in the document, and that place is the reveal', () => {
    // The load-bearing assertion of this file, and the static half of the browser spec's
    // five-surface leak snapshot.
    const html = revealBesideASibling();
    expect(html.split(TOKEN)).toHaveLength(2);
    const outside = html.replace(reveal(), '');
    // The removal took the reveal and only the reveal: without this the assertion below would pass
    // over an empty string no matter what the component rendered.
    expect(outside).toContain(DECOY);
    expect(outside).not.toContain(TOKEN);
  });

  it('keeps the token out of every attribute, including the controls’ accessible names', () => {
    const html = reveal();
    // The token occurs once, and between a `>` and a `<` — element text, not an attribute value.
    expect(html).toMatch(new RegExp(`>[^<]*${TOKEN}[^<]*<`, 'u'));
    for (const attribute of ['aria-label', 'title', 'id', 'class', 'data-invitation-reveal']) {
      expect(html).not.toMatch(new RegExp(`${attribute}="[^"]*${TOKEN}`, 'u'));
    }
  });

  it('is a live region, so a screen reader is told the link arrived', () => {
    expect(reveal()).toContain('role="status"');
  });

  it('carries the stable hook the browser spec removes the element by', () => {
    // `tests/browser/team-invitations.spec.mjs` deletes this element from `document.body.outerHTML`
    // and asserts the token is absent from what remains. That needs a selector the markup promises.
    expect(reveal()).toContain('data-invitation-reveal');
  });

  it('names the invitee in both controls, which the accessibility floor requires', () => {
    const html = reveal();
    expect(html).toContain('aria-label="Copy the invitation link for new.person@example.test"');
    expect(html).toContain('aria-label="Dismiss the invitation link for new.person@example.test"');
  });

  it('says nothing about copying before the control has been used', () => {
    const html = reveal('untouched');
    expect(html).not.toContain('Link copied');
    expect(html).not.toContain('would not give the page the clipboard');
  });

  it('confirms a copy, and reports an unavailable clipboard without quoting the link', () => {
    expect(reveal('copied')).toContain('Link copied');
    const unavailable = reveal('unavailable');
    expect(unavailable).toContain('Select the link above');
    // The failure text is the one message a careless implementation would build from what it failed
    // to copy. The token is still in this markup — once, in the `<code>` — and nowhere else.
    expect(unavailable.split(TOKEN)).toHaveLength(2);
  });

  it('tells the reader the link is not stored and is lost on leaving', () => {
    // The honest statement of what the lifecycle clears mean for a person, rather than a surprise.
    expect(reveal()).toContain('leaving this screen loses it');
  });
});
