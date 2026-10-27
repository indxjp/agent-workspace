'use client';
import type { ShareExpiry, ShareVisibility } from '@indx-workspace/contracts/shares';
import { useEffect, useRef, useState } from 'react';

import { browserClient } from '../../lib/browser-client';
import { publishShare, sharePublishCommand, type ShareSubject } from './share-dialog-model';

export type { ShareSubject } from './share-dialog-model';

export function ShareDialog({
  subject,
  triggerLabel = 'Share',
  runIds,
}: Readonly<{
  subject: ShareSubject;
  triggerLabel?: string;
  /** For a session share: the runs on screen, whose stored text the share publishes. */
  runIds?: readonly string[];
}>) {
  const [open, setOpen] = useState(false);
  const [visibility, setVisibility] = useState<ShareVisibility>('workspace');
  const [expiry, setExpiry] = useState<ShareExpiry>('never');
  const [passphrase, setPassphrase] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstFieldRef = useRef<HTMLSelectElement>(null);
  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }
  useEffect(() => {
    if (!open) return;
    firstFieldRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);
  async function publish() {
    const outcome = await publishShare(
      browserClient(),
      sharePublishCommand(subject, visibility, expiry, passphrase, runIds),
    );
    if ('problem' in outcome) {
      setResult(outcome.problem);
      return;
    }
    const url = outcome.url;
    if (url === null) {
      setResult(visibility === 'private' ? 'Shared with you only.' : 'Shared with the workspace.');
      return;
    }
    // The clipboard is absent on an insecure origin (the call throws) and may refuse; either way
    // the link still shows for a manual copy.
    const copied = await Promise.resolve()
      .then(() => navigator.clipboard.writeText(url))
      .then(
        () => true,
        () => false,
      );
    setResult(copied ? `Link copied: ${url}` : url);
  }
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-(--radius-sm) border border-border-strong px-3 py-1.5 text-[13px]"
      >
        {triggerLabel}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Share ${subject.label}`}
          className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
        >
          <div className="w-full max-w-[520px] rounded-(--radius) border border-border bg-surface p-5 shadow-xl">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-[18px]">Share “{subject.label}”</h2>
                <p className="mt-1 text-[12px] text-muted">
                  Choose who can see this {subject.type}.
                </p>
              </div>
              <button type="button" onClick={close} aria-label="Close">
                ×
              </button>
            </div>
            <label className="mt-4 block text-[12px] font-semibold">
              Who can see this
              <select
                ref={firstFieldRef}
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as typeof visibility)}
                className="mt-1 block w-full rounded border border-border bg-surface p-2"
              >
                <option value="private">Only me</option>
                <option value="workspace">Everyone in this workspace</option>
                <option value="public">Anyone with the link</option>
              </select>
            </label>
            <label className="mt-3 block text-[12px] font-semibold">
              Expiry
              <select
                value={expiry}
                onChange={(e) => setExpiry(e.target.value as typeof expiry)}
                className="mt-1 block w-full rounded border border-border bg-surface p-2"
              >
                <option>24 h</option>
                <option>7 days</option>
                <option>30 days</option>
                <option>never</option>
              </select>
            </label>
            <label className="mt-3 block text-[12px] font-semibold">
              Passphrase (optional)
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                className="mt-1 block w-full rounded border border-border bg-surface p-2"
              />
            </label>
            {result ? (
              <p role="status" className="mt-3 break-all rounded bg-surface-2 p-2 text-[12px]">
                {result}
              </p>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={close} className="px-3 py-2 text-[13px]">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void publish()}
                className="rounded bg-accent px-3 py-2 text-[13px] text-white"
              >
                Copy link
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
