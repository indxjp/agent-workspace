'use client';
import {
  SHARE_EXPIRIES,
  type ShareExpiry,
  type ShareVisibility,
} from '@indx-workspace/contracts/shares';
import { useEffect, useRef, useState } from 'react';

import { browserClient } from '../../lib/browser-client';
import type { VersionsLocale } from '../agents/versions-messages';
import { browserLocale } from '../run/attach-messages';
import { shareStrings } from './share-dialog-messages';
import {
  absoluteShareUrl,
  oneTimeLinkMessage,
  publishButtonLabel,
  publishShare,
  sharePublishCommand,
  type ShareSubject,
} from './share-dialog-model';

export type { ShareSubject } from './share-dialog-model';

export function ShareDialog({
  subject,
  triggerLabel,
  runIds,
}: Readonly<{
  subject: ShareSubject;
  triggerLabel?: string;
  /** For a session share: the runs on screen, whose stored text the share publishes. */
  runIds?: readonly string[];
}>) {
  const [locale, setLocale] = useState<VersionsLocale>('en');
  useEffect(() => setLocale(browserLocale(navigator.languages)), []);
  const strings = shareStrings(locale);
  const [open, setOpen] = useState(false);
  const [visibility, setVisibility] = useState<ShareVisibility>('workspace');
  const [expiry, setExpiry] = useState<ShareExpiry>('never');
  const [passphrase, setPassphrase] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const publishingRef = useRef(false);
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
    // One share per click: a second click while the first is in flight would publish a second link.
    if (publishingRef.current) return;
    publishingRef.current = true;
    setPublishing(true);
    try {
      await publishOnce();
    } finally {
      publishingRef.current = false;
      setPublishing(false);
    }
  }
  async function publishOnce() {
    const outcome = await publishShare(
      browserClient(),
      sharePublishCommand(subject, visibility, expiry, passphrase, runIds),
      strings,
    );
    if ('problem' in outcome) {
      setResult(outcome.problem);
      return;
    }
    if (outcome.url === null) {
      setResult(visibility === 'private' ? strings.sharedPrivately : strings.sharedWithWorkspace);
      return;
    }
    const url = absoluteShareUrl(outcome.url, window.location.origin);
    // The clipboard is absent on an insecure origin (the call throws) and may refuse; either way
    // the link still shows for a manual copy.
    const copied = await Promise.resolve()
      .then(() => navigator.clipboard.writeText(url))
      .then(
        () => true,
        () => false,
      );
    setResult(oneTimeLinkMessage(url, copied, strings));
  }
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-(--radius-sm) border border-border-strong px-3 py-1.5 text-[13px]"
      >
        {triggerLabel ?? strings.trigger}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={strings.dialogLabel(subject.label)}
          className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
        >
          <div className="w-full max-w-[520px] rounded-(--radius) border border-border bg-surface p-5 shadow-xl">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-[18px]">{strings.heading(subject.label)}</h2>
                <p className="mt-1 text-[12px] text-muted">{strings.intro(subject.type)}</p>
              </div>
              <button type="button" onClick={close} aria-label={strings.close}>
                ×
              </button>
            </div>
            <label className="mt-4 block text-[12px] font-semibold">
              {strings.whoCanSee}
              <select
                ref={firstFieldRef}
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as typeof visibility)}
                className="mt-1 block w-full rounded border border-border bg-surface p-2"
              >
                <option value="private">{strings.visibility.private}</option>
                <option value="workspace">{strings.visibility.workspace}</option>
                <option value="public">{strings.visibility.public}</option>
              </select>
            </label>
            <label className="mt-3 block text-[12px] font-semibold">
              {strings.expiryLabel}
              <select
                value={expiry}
                onChange={(e) => setExpiry(e.target.value as typeof expiry)}
                className="mt-1 block w-full rounded border border-border bg-surface p-2"
              >
                {/* The value is the contract's own word; only the text is translated. */}
                {SHARE_EXPIRIES.map((value) => (
                  <option key={value} value={value}>
                    {strings.expiry[value]}
                  </option>
                ))}
              </select>
            </label>
            <label className="mt-3 block text-[12px] font-semibold">
              {strings.passphrase}
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
                {strings.cancel}
              </button>
              <button
                type="button"
                onClick={() => void publish()}
                disabled={publishing}
                className="rounded bg-accent px-3 py-2 text-[13px] text-white disabled:opacity-60"
              >
                {publishButtonLabel(visibility, strings)}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
