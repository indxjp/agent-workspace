'use client';

/**
 * The one-time invitation reveal — issue #186's central security requirement.
 *
 * #186: *"Show the returned invitation link only in a dedicated one-time reveal element"*, and
 * *"keep the token out of persistent component caches, the URL, logs, analytics, error text,
 * localStorage, and sessionStorage"*. This component is that element, and the constraints below are
 * the whole of its design:
 *
 * - **The link is text, never an `<a href>`.** An anchor is one click away from putting the token in
 *   the address bar, in `document.referrer` for the next navigation, and in the browser's own
 *   history — three of the surfaces #186 names, reached by a control that looks helpful. It is a
 *   `<code>` a person selects, or copies with the button.
 * - **It renders nowhere else.** The link appears exactly once in this subtree and in no attribute:
 *   not in an `aria-label`, not in a `title`, not in a `data-` hook, and not in the copy failure
 *   text (`describeCopyState`). `invitation-reveal.test.tsx` counts the occurrences.
 * - **It holds no state.** Whether a reveal exists at all, and every path that ends one, belong to
 *   `./invitations-section.tsx`'s single `useState` — presentational here for the reason
 *   `./members-table.tsx` gives, and because a second place that could keep the secret is a second
 *   place that could fail to drop it.
 *
 * `data-invitation-reveal` is a stable hook rather than a styling class: `tests/browser/
 * team-invitations.spec.mjs` removes this element from `document.body.outerHTML` and asserts the
 * token is absent from everything that remains. That assertion needs a selector the markup promises
 * to keep.
 */
import { useEffect, useRef } from 'react';

import { describeCopyState, type CopyState, type RevealedInvitation } from './invitations-model';

const BTN =
  'inline-flex h-8 items-center rounded-(--radius-sm) border px-[13px] text-[13px] font-medium';
const BTN_PRIMARY = 'border-border-strong bg-surface text-text';

interface InvitationRevealProps {
  readonly revealed: RevealedInvitation;
  readonly copyState: CopyState;
  readonly onCopy: () => void;
  readonly onDismiss: () => void;
}

export function InvitationReveal({
  revealed,
  copyState,
  onCopy,
  onDismiss,
}: Readonly<InvitationRevealProps>) {
  const copyRef = useRef<HTMLButtonElement | null>(null);

  // Focus moves here the moment a reveal appears. The link is shown once and never again, so a
  // keyboard user who has to hunt for it may lose it; the control that submitted the invitation is
  // still mounted behind this panel, which is exactly why focus would otherwise stay there. Keyed
  // on the link so a resend's replacement re-focuses rather than leaving focus on the old copy
  // control. The move itself is only observable in `tests/browser/team-invitations.spec.mjs` — this
  // repository has no jsdom.
  useEffect(() => {
    copyRef.current?.focus();
  }, [revealed.link]);

  const copyNote = describeCopyState(copyState);

  return (
    <div
      data-invitation-reveal
      role="status"
      className="mb-4 rounded-(--radius) border border-border-strong bg-surface p-5 shadow-(--shadow)"
    >
      <h3 className="text-[14px] font-semibold text-text">Invitation link for {revealed.email}</h3>
      <p className="mt-1 text-[12.5px] text-danger">{revealed.warning}</p>
      <p className="mt-3 text-[12.5px] text-muted">
        This deployment sends no email, so relay this link yourself. It is not stored anywhere and
        leaving this screen loses it.
      </p>
      {/* The secret, and the only place in the document it appears. `break-all` because an accept
          link is longer than the card and a link that overflows is a link a person cannot select. */}
      <code className="mt-3 block rounded-(--radius-sm) border border-border bg-surface-2 p-3 text-[12.5px] break-all text-text">
        {revealed.link}
      </code>
      <div className="mt-4 flex items-center gap-2">
        <button
          ref={copyRef}
          type="button"
          aria-label={`Copy the invitation link for ${revealed.email}`}
          className={`${BTN} ${BTN_PRIMARY}`}
          onClick={onCopy}
        >
          Copy link
        </button>
        <button
          type="button"
          aria-label={`Dismiss the invitation link for ${revealed.email}`}
          className={`${BTN} ${BTN_PRIMARY}`}
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </div>
      {copyNote === null ? null : <p className="mt-3 text-[12.5px] text-text-2">{copyNote}</p>}
    </div>
  );
}
