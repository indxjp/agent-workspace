'use client';

/**
 * The invitations half of `/admin/users` — issue #186.
 *
 * It owns the fetches, the busy flags, and **the one place in this program that holds a plaintext
 * invitation token in the browser**. Everything it decides is `./invitations-model.ts`'s; everything
 * it renders is `./invitation-form.tsx`, `./invitation-reveal.tsx` and `./invitations-table.tsx`.
 *
 * ## Where the token is, and every way it stops being there
 *
 * `revealed` is a single `useState` holding three strings
 * ({@link import('./invitations-model').RevealedInvitation}). There is no context, no ref, no
 * module-level variable, no `localStorage`, no `sessionStorage`, no query string, no `router` call
 * and no `<a href>` anywhere on this path — the reveal renders the link as text
 * (`./invitation-reveal.tsx` says why an anchor is the defect). The response body itself is not
 * stored: `revealIssuedInvitation` destructures it into those three fields and the parsed object is
 * unreachable the moment it returns, so the `token` field never enters React state at all.
 *
 * #186 requires the reveal to survive none of five things. Each is handled, and one of them for
 * free:
 *
 * - **Action completion.** {@link clearReveal} runs at the top of create, resend and revoke, so a
 *   second action never leaves the first one's secret behind it, and never shows two.
 * - **Unmount and client-side navigation.** React destroys the state with the component; a Next.js
 *   route change unmounts this tree.
 * - **Reload and a workspace switch.** Both are full document navigations — the switcher submits a
 *   form to `/api/auth/workspace` (`../shell/workspace-switcher.tsx`) — so no React state survives.
 * - **Back into a bfcached document,** which is the one case where React state *does* survive. The
 *   shell reloads a restored entry from its own `pageshow` handler, but that is another component's
 *   promise; this screen drops the reveal on its own `pagehide` rather than depend on it, which
 *   covers both the bfcache and an ordinary navigation away.
 *
 * ## Why nothing is cached
 *
 * The rule `./team-screen.tsx`'s header states: every read is `cache: 'no-store'`, the page above is
 * `force-dynamic`, and there is no client cache of any kind. A stale invitation list is worse here
 * than on the members table, because a revoked row that still rendered a Resend control would offer
 * an action the server has already refused.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { NO_INVITATION_CAPABILITY } from '../../contracts/invitations';
import { browserClient } from '../../lib/browser-client';
import { InvitationForm } from './invitation-form';
import { InvitationReveal } from './invitation-reveal';
import {
  describeInvitationFailure,
  EMPTY_INVITATION_DRAFT,
  invitationRequestFrom,
  type CopyState,
  type InvitationCapability,
  type InvitationDraft,
  type InvitationResource,
  type RevealedInvitation,
} from './invitations-model';
import { InvitationsTable, type InvitationsTableState } from './invitations-table';
import {
  issueInvitation,
  loadInvitations,
  resendInvitation as resend,
  revokeInvitation as revoke,
} from './team-requests-model';

const HEADING_ID = 'team-invitations-heading';

/**
 * What is said when a create succeeded but its body could not be read.
 *
 * It quotes no part of the response, deliberately: a body this screen failed to parse still has a
 * token somewhere in it, and an error message built from a fragment of it is precisely the leak
 * #186's "keep the token out of … error text" forbids. The invitation itself exists — the request
 * succeeded — so the honest instruction is to revoke it and start again rather than to retry.
 */
const UNREADABLE_ISSUED =
  'The invitation was created, but the response carrying its link could not be read, so the link ' +
  'is gone. Revoke the invitation below and send a new one.';

/**
 * The same failure on the resend path, which needs the opposite remedy.
 *
 * A resend created nothing: the row already existed and the server minted a replacement token for
 * it, invalidating the previous one. Revoking it — {@link UNREADABLE_ISSUED}'s instruction — would
 * destroy a live invitation over a parse failure, where resending rotates the token once more and
 * costs nothing. It quotes the response no more than the create message does.
 */
const UNREADABLE_RESENT =
  'The invitation was resent, but the response carrying its new link could not be read, so the ' +
  'link is gone. Resend it again to get a fresh one.';

export function InvitationsSection({
  capability = NO_INVITATION_CAPABILITY,
}: Readonly<{ capability?: InvitationCapability }>) {
  // The refused state is the FIRST state for a caller the server will not give the list to, not one
  // reached after a 403 — the same reasoning `./team-screen.tsx` gives for the members table.
  const [table, setTable] = useState<InvitationsTableState>(
    capability.canListInvitations ? { kind: 'loading' } : { kind: 'refused' },
  );
  const [draft, setDraft] = useState<InvitationDraft>(EMPTY_INVITATION_DRAFT);
  const [sending, setSending] = useState(false);
  const [createProblem, setCreateProblem] = useState<string | null>(null);
  const [busyInvitationId, setBusyInvitationId] = useState<string | null>(null);
  const [actionProblem, setActionProblem] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<RevealedInvitation | null>(null);
  const [copyState, setCopyState] = useState<CopyState>('untouched');

  // This section's own heading, focusable only programmatically (`tabIndex={-1}`), for the same
  // reason `./team-screen.tsx` gives its h1: it is the nearest element that outlives a reveal and
  // names where the reader now is.
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  /**
   * Drop the secret.
   *
   * The single place that ends a reveal, called by every path that must: the top of create, resend
   * and revoke, the Dismiss control, and `pagehide`. One function rather than five inline pairs of
   * setters, so "is every path covered?" is a question about call sites instead of about bodies.
   *
   * Dismiss is inside the reveal it removes, so the focused element is about to be detached and
   * `document.activeElement` would fall to `<body>` — the next Tab restarting from the top of the
   * page, which is the failure `./team-screen.tsx` documents for the removal dialog. Focus therefore
   * moves to the heading, but only when it is currently inside the reveal: a resend or revoke driven
   * from the table clears the reveal too, and stealing focus from the row control the reader just
   * used would be its own defect.
   */
  const clearReveal = useCallback(() => {
    const active = document.activeElement;
    if (active !== null && document.querySelector('[data-invitation-reveal]')?.contains(active)) {
      headingRef.current?.focus();
    }
    setRevealed(null);
    setCopyState('untouched');
  }, []);

  const load = useCallback(async () => {
    if (!capability.canListInvitations) {
      setTable({ kind: 'refused' });
      return;
    }
    const result = await loadInvitations(browserClient());
    setTable(
      result.ok
        ? // The clock is read here, once, so the table stays a pure render of its props: the four
          // states are `expiresAt` compared against this number.
          { kind: 'ready', invitations: result.value, nowMs: Date.now() }
        : { kind: 'failed', message: describeInvitationFailure(result.problem) },
    );
  }, [capability.canListInvitations]);

  useEffect(() => {
    void load();
  }, [load]);

  // `pagehide` rather than `beforeunload`: it fires for an ordinary navigation away *and* for a
  // document about to enter the bfcache, which is the only cache that can carry React state — and
  // therefore this token — across a full navigation and back. `unload` is not used because a page
  // that registers one is excluded from the bfcache entirely, which would change this screen's
  // behaviour to hide a leak rather than close it.
  useEffect(() => {
    window.addEventListener('pagehide', clearReveal);
    return () => window.removeEventListener('pagehide', clearReveal);
  }, [clearReveal]);

  /**
   * Show a create or resend answer as the reveal. `false` when the answer could not be read.
   *
   * The response is never stored — `revealIssuedInvitation` returns three strings and the object
   * it read goes out of scope — so the `token` field exists only for the duration of the request.
   */
  function showReveal(next: RevealedInvitation | null): boolean {
    if (next === null) return false;
    setRevealed(next);
    setCopyState('untouched');
    return true;
  }

  async function createInvitation() {
    const request = invitationRequestFrom(draft);
    if (request === null) return;
    clearReveal();
    setCreateProblem(null);
    setActionProblem(null);
    setSending(true);
    const result = await issueInvitation(browserClient(), request, window.location.origin);
    setSending(false);
    if (!result.ok) {
      setCreateProblem(describeInvitationFailure(result.problem));
      return;
    }
    if (!showReveal(result.value)) setCreateProblem(UNREADABLE_ISSUED);
    // The address is cleared so the next invitation starts from an empty field rather than from one
    // that looks like it still needs sending. The role is cleared with it: carrying the previous
    // choice forward would make the next invitation's grant something nobody chose for it.
    setDraft(EMPTY_INVITATION_DRAFT);
    await load();
  }

  async function resendInvitation(invitation: InvitationResource) {
    // Before the request, not after: the previous reveal's token is invalidated by this resend
    // (`handlers.ts`'s own warning says so), so leaving it on screen would show a link that has
    // stopped working, next to one that has not.
    clearReveal();
    setActionProblem(null);
    setCreateProblem(null);
    setBusyInvitationId(invitation.id);
    const result = await resend(browserClient(), invitation.id, window.location.origin);
    setBusyInvitationId(null);
    if (!result.ok) {
      setActionProblem(describeInvitationFailure(result.problem));
      return;
    }
    if (!showReveal(result.value)) setActionProblem(UNREADABLE_RESENT);
    // Reload rather than patch the row: the resend moved this row's expiry, and the state the table
    // shows is derived from it.
    await load();
  }

  async function revokeInvitation(invitation: InvitationResource) {
    clearReveal();
    setActionProblem(null);
    setCreateProblem(null);
    setBusyInvitationId(invitation.id);
    const result = await revoke(browserClient(), invitation.id);
    setBusyInvitationId(null);
    if (!result.ok) {
      setActionProblem(describeInvitationFailure(result.problem));
      return;
    }
    await load();
  }

  async function copyLink() {
    if (revealed === null) return;
    try {
      await navigator.clipboard.writeText(revealed.link);
      setCopyState('copied');
    } catch {
      // Every way this can fail is the same answer to the person, and `describeCopyState` gives it:
      // the link is still on screen, select it. The rejection value is deliberately not read — it
      // is the one error path in this component whose message a browser could build from the string
      // it was asked to copy, and #186 forbids the token reaching error text.
      setCopyState('unavailable');
    }
  }

  return (
    <section aria-labelledby={HEADING_ID} className="mt-10">
      <h2
        ref={headingRef}
        tabIndex={-1}
        id={HEADING_ID}
        className="text-[18px] font-semibold text-text"
      >
        Invitations
      </h2>
      <p className="mt-1 mb-4 text-sm text-muted">
        People invited to this workspace, and what became of each invitation.
      </p>
      <InvitationForm
        capability={capability}
        draft={draft}
        sending={sending}
        problem={createProblem}
        onChange={setDraft}
        onSubmit={() => void createInvitation()}
      />
      {revealed === null ? null : (
        <InvitationReveal
          revealed={revealed}
          copyState={copyState}
          onCopy={() => void copyLink()}
          onDismiss={clearReveal}
        />
      )}
      <InvitationsTable
        state={table}
        capability={capability}
        busyInvitationId={busyInvitationId}
        actionProblem={actionProblem}
        onResend={(invitation) => void resendInvitation(invitation)}
        onRevoke={(invitation) => void revokeInvitation(invitation)}
      />
    </section>
  );
}
