'use client';

import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';

import { STORAGE_BUTTON as BUTTON, STORAGE_CARD as CARD } from './storage-form-parts';
import type { StorageStrings } from './storage-messages';

/**
 * While the dialog is open, the page behind it is `inert`: every sibling of the dialog and of each
 * of its ancestors up to `<body>`, the shell's navigation included. `aria-modal` alone leaves that
 * page clickable and reachable by a screen reader's virtual cursor. Only the elements this marked
 * are restored, so one that was already inert stays inert. Focus goes back to `returnFocusTo` once
 * the page is live again: an inert element cannot take focus.
 */
function useInertBackground(
  dialogRef: RefObject<HTMLElement | null>,
  returnFocusTo: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const marked: Element[] = [];
    for (let node = dialogRef.current; node?.parentElement; node = node.parentElement) {
      if (node === document.body) break;
      for (const sibling of node.parentElement.children) {
        if (sibling === node || sibling.hasAttribute('inert')) continue;
        sibling.setAttribute('inert', '');
        marked.push(sibling);
      }
    }
    return () => {
      for (const element of marked) element.removeAttribute('inert');
      returnFocusTo.current?.focus();
    };
  }, [dialogRef, returnFocusTo]);
}

/** Keeps Tab and Shift+Tab inside the panel's enabled buttons. */
function trapTab(event: KeyboardEvent<HTMLDivElement>, panel: HTMLElement | null) {
  const focusable = panel?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
  const first = focusable?.[0];
  const last = focusable?.[focusable.length - 1];
  if (first === undefined || last === undefined) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function DeleteDialog({
  name,
  busy,
  returnFocusTo,
  onCancel,
  onConfirm,
  strings,
}: Readonly<{
  name: string;
  busy: boolean;
  strings: StorageStrings;
  /** Focused when the dialog closes, whichever way it closes. */
  returnFocusTo: RefObject<HTMLElement | null>;
  onCancel: () => void;
  onConfirm: () => void;
}>) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useInertBackground(dialogRef, returnFocusTo);
  useEffect(() => cancelRef.current?.focus(), []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !busy) {
      event.preventDefault();
      onCancel();
    } else if (event.key === 'Tab') {
      trapTab(event, panelRef.current);
    }
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="storage-delete-title"
      aria-describedby="storage-delete-description"
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
    >
      <div ref={panelRef} className={`${CARD} w-full max-w-[480px] p-5`}>
        <h2 id="storage-delete-title" className="text-[18px]">
          {strings.deleteTitle(name)}
        </h2>
        <p id="storage-delete-description" className="mt-2 text-[13px] text-muted">
          {strings.deleteDescription}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            className={`${BUTTON} bg-surface`}
            aria-disabled={busy}
            onClick={() => {
              if (!busy) onCancel();
            }}
          >
            {strings.cancel}
          </button>
          <button
            type="button"
            className={`${BUTTON} border-danger bg-danger text-white`}
            aria-disabled={busy}
            onClick={() => {
              if (!busy) onConfirm();
            }}
          >
            {strings.deleteConnection}
          </button>
        </div>
      </div>
    </div>
  );
}
