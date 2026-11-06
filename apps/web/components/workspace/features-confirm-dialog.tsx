'use client';

/**
 * The confirmation before a feature is switched off (06 J4, issue #1497): it names the navigation
 * entries that disappear for everyone and says the data is kept. Switching on needs none, because
 * it only restores what was there.
 *
 * Focus follows `../team/remove-dialog.tsx`: Cancel takes focus on open and again when a save
 * stops being in flight, Escape cancels, Tab cycles inside the panel, and focus returns to the
 * toggle that opened it. `tests/browser/workspace-features.spec.mjs` holds those, which a
 * static-markup test cannot see.
 */
import type { FeatureId } from '@indx-workspace/contracts/features';
import { useEffect, useRef, type KeyboardEvent } from 'react';

import type { FeaturesStrings } from './features-messages';
import { navLabelsHiddenBy } from './features-model';

const BTN =
  'inline-flex h-8 items-center rounded-(--radius-sm) border px-[13px] text-[13px] font-medium';
const BTN_DEFAULT = 'border-border-strong bg-surface text-text';
const BTN_DANGER = 'border-danger bg-surface text-danger';
const BTN_DISABLED = 'pointer-events-none opacity-[.45]';

const TITLE_ID = 'features-confirm-dialog-title';

interface FeaturesConfirmDialogProps {
  readonly feature: FeatureId;
  readonly strings: FeaturesStrings;
  readonly busy: boolean;
  /** The refusal banner of a failed save, already localised. */
  readonly failure: string | null;
  /** Read at close time: the toggle that opened the dialog. Absent in a test. */
  readonly returnFocusTo?: { current: HTMLElement | null };
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function FeaturesConfirmDialog({
  feature,
  strings,
  busy,
  failure,
  returnFocusTo,
  onCancel,
  onConfirm,
}: Readonly<FeaturesConfirmDialogProps>) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const label = strings.labels[feature];
  const hidden = navLabelsHiddenBy(feature);

  useEffect(() => {
    const target = returnFocusTo;
    return () => target?.current?.focus();
  }, [returnFocusTo]);

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
          {strings.dialogTitle(label)}
        </h2>
        <p className="mt-3 text-[13px] text-text-2">
          {hidden.length > 0
            ? strings.dialogHides(hidden.join(strings.listSeparator))
            : strings.dialogHidesNothing}
        </p>
        <p className="mt-2 text-[13px] text-text-2">{strings.dialogDataKept}</p>
        {failure === null ? null : (
          <p className="mt-3 text-[13px] text-danger" role="alert">
            {failure}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            className={`${BTN} ${BTN_DEFAULT} ${busy ? BTN_DISABLED : ''}`}
            disabled={busy}
            onClick={onCancel}
          >
            {strings.cancel}
          </button>
          <button
            type="button"
            className={`${BTN} ${BTN_DANGER} ${busy ? BTN_DISABLED : ''}`}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? strings.saving : strings.confirm(label)}
          </button>
        </div>
      </div>
    </div>
  );
}
