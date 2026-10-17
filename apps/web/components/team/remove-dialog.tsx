'use client';

/**
 * The removal confirmation — issue #185.
 *
 * Hand-written rather than `window.confirm` for the reason `../projects/project-archive.tsx` gives:
 * the impact summary is still loading when the dialog opens, so it cannot be a string argument to a
 * blocking browser primitive, and no test this repository can run observes one.
 *
 * Focus is managed here too, and #185 requires keyboard operation: Cancel takes focus on open and
 * takes it back the moment a submission stops being in flight (a disabled control is also a blurred
 * one, which would otherwise leave the `failed` panel with Escape and the Tab cycle dead), Escape
 * closes, Tab cycles within the panel, and focus returns to whatever `returnFocusTo` points at when
 * the dialog closes — the control that opened it, unless the screen redirected it because that
 * control is about to be unmounted.
 * `tests/browser/team-members.spec.mjs` holds those honest — a static-markup test cannot see focus.
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';

import { summariseRemovalImpact, type MemberDialogState, type MembershipResource } from './model';

const BTN =
  'inline-flex h-8 items-center rounded-(--radius-sm) border px-[13px] text-[13px] font-medium';
const BTN_DEFAULT = 'border-border-strong bg-surface text-text';
const BTN_DANGER = 'border-danger bg-surface text-danger';
const BTN_DISABLED = 'pointer-events-none opacity-[.45]';

const TITLE_ID = 'team-remove-dialog-title';

interface RemoveMemberDialogProps {
  readonly member: MembershipResource;
  readonly state: MemberDialogState;
  /**
   * The element focus goes back to when the dialog closes — the row's own Remove button, captured
   * by the screen when it opened this. Absent in a test that renders the dialog alone.
   *
   * Read at close time rather than at open time, so the screen can redirect it: after a successful
   * removal the row's button is about to be unmounted by the reload, and focusing it would land on
   * `<body>` one render later (`team-screen.tsx`'s `confirmRemoval`).
   */
  readonly returnFocusTo?: { current: HTMLElement | null };
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function RemoveMemberDialog({
  member,
  state,
  returnFocusTo,
  onCancel,
  onConfirm,
}: Readonly<RemoveMemberDialogProps>) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const busy = state.kind === 'submitting';

  useEffect(() => {
    const target = returnFocusTo;
    return () => target?.current?.focus();
  }, [returnFocusTo]);

  // Cancel is the focused control on open and again whenever a submission ends — the safe answer is
  // where a stray Enter should land. Keyed on `busy` alone: refocusing on every state change would
  // yank focus off Confirm while the impact counts are still arriving.
  useEffect(() => {
    if (!busy) cancelRef.current?.focus();
  }, [busy]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (busy) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = [
      ...(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? []),
    ];
    // Tab must not leave the panel while it is modal; a keyboard that walked off it would be the
    // same bug one control later.
    const edge = event.shiftKey ? controls.at(0) : controls.at(-1);
    if (edge === undefined || document.activeElement !== edge) return;
    event.preventDefault();
    (event.shiftKey ? controls.at(-1) : controls.at(0))?.focus();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={TITLE_ID}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
    >
      <div
        ref={panelRef}
        className="w-full max-w-[520px] rounded-(--radius) border border-border bg-surface p-5 shadow-xl"
      >
        <h2 id={TITLE_ID} className="text-[18px]">
          Remove {member.name} from this workspace?
        </h2>
        <p className="mt-1 text-[12.5px] text-muted">{member.email}</p>
        <RemovalImpact state={state} />
        {state.kind === 'failed' ? (
          <p className="mt-3 text-[13px] text-danger" role="alert">
            {state.message}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            className={`${BTN} ${BTN_DEFAULT} ${busy ? BTN_DISABLED : ''}`}
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            aria-label={`Remove ${member.name} from this workspace`}
            className={`${BTN} ${BTN_DANGER} ${busy ? BTN_DISABLED : ''}`}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? 'Removing…' : 'Remove member'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * What removal affects, in each state the two impact reads can be in.
 *
 * `impact-unavailable` still allows the removal: refusing would let an unrelated list endpoint's
 * failure block a change the server would accept, and printing "0 sessions and 0 projects" would be
 * a number nothing established. Saying so is the third option and the honest one.
 */
function RemovalImpact({ state }: Readonly<{ state: MemberDialogState }>) {
  switch (state.kind) {
    case 'counting':
      return (
        <p className="mt-3 text-[13px] text-muted" role="status">
          Counting the sessions and projects this member owns…
        </p>
      );
    case 'counted':
      return <p className="mt-3 text-[13px] text-text-2">{summariseRemovalImpact(state.impact)}</p>;
    case 'impact-unavailable':
      return (
        <p className="mt-3 text-[13px] text-text-2">
          What this member owns could not be counted, so this summary is incomplete. Removing a
          member ends their access here and deletes no history.
        </p>
      );
    case 'submitting':
    case 'failed':
      return (
        <p className="mt-3 text-[13px] text-text-2">
          Removing a member ends their access to this workspace. Completed sessions and the projects
          they created stay where they are.
        </p>
      );
    default: {
      const unreachable: never = state;
      throw new Error(`unhandled member dialog state ${JSON.stringify(unreachable)}`);
    }
  }
}
