'use client';

/**
 * The console composer's **Attach file** control (issue #1680). It hands the file to the session's
 * own attachments route, which saves it through the catalog service and refuses an archived
 * project; nothing here builds a storage path.
 *
 * The control is disabled with a reason the screen reader reads (`aria-disabled` stays focusable,
 * and `aria-describedby` points at the visible text) when the session has not started or its
 * project is archived. The session's project is read when the session starts and again when the
 * route answers 404, so a project archived while this screen is open turns the control off on the
 * next attempt.
 *
 * The list is the composer's (`run-view.tsx`): it sends the listed file ids with the next
 * follow-up, as that run's `attachments`, and then clears it.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiProblemError } from '@indx-workspace/sdk';

import { browserClient } from '../../lib/browser-client';
import { formatSize } from '../resources/resource-screens';
import { attachStrings, browserLocale } from './attach-messages';

export interface AttachedFile {
  readonly id: string;
  readonly name: string;
  readonly size: number;
}

export function AttachControl({
  sessionId,
  files,
  onAttached,
  buttonClass,
  disabledClass,
}: {
  readonly sessionId: string | null;
  /** What this session has attached and not yet sent; the composer owns and clears it. */
  readonly files: readonly AttachedFile[];
  readonly onAttached: (file: AttachedFile) => void;
  readonly buttonClass: string;
  readonly disabledClass: string;
}) {
  const [locale, setLocale] = useState<'en' | 'ja'>('en');
  const strings = attachStrings(locale);
  const [archived, setArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const reasonId = useId();
  // The session on screen now: an upload or read started for an earlier one applies nothing.
  const current = useRef(sessionId);
  current.current = sessionId;

  useEffect(() => setLocale(browserLocale(navigator.languages)), []);
  useEffect(() => {
    setArchived(false);
    setFailed(false);
  }, [sessionId]);

  const readArchived = useCallback(async (): Promise<void> => {
    if (sessionId === null) return;
    try {
      const client = browserClient();
      const { projectId } = await client.sessions.get(sessionId);
      const archivedAt =
        projectId === null ? null : (await client.projects.get(projectId)).archivedAt;
      if (current.current === sessionId) setArchived(archivedAt !== null);
    } catch {
      // An unreadable project leaves the control as it was; the route is the gate either way.
    }
  }, [sessionId]);
  useEffect(() => {
    void readArchived();
  }, [readArchived]);

  const upload = async (file: File): Promise<void> => {
    if (sessionId === null) return;
    setBusy(true);
    setFailed(false);
    try {
      const saved = await browserClient().sessions.attach(sessionId, file);
      if (current.current === sessionId) {
        onAttached({ id: saved.fileId, name: file.name, size: saved.size });
      }
    } catch (error) {
      if (current.current === sessionId) setFailed(true);
      if (error instanceof ApiProblemError && error.status === 404) await readArchived();
    } finally {
      setBusy(false);
    }
  };

  const reason = archived
    ? strings.archivedReason
    : sessionId === null
      ? strings.noSessionReason
      : null;
  const disabled = reason !== null;

  return (
    <>
      <button
        type="button"
        aria-disabled={disabled || busy}
        aria-describedby={reason === null ? undefined : reasonId}
        className={`${buttonClass} ${disabled || busy ? disabledClass : 'cursor-pointer'}`}
        onClick={() => {
          if (!disabled && !busy) input.current?.click();
        }}
      >
        {strings.attach}
      </button>
      <input
        ref={input}
        type="file"
        hidden
        tabIndex={-1}
        aria-label={strings.attach}
        data-testid="attach-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file !== undefined) void upload(file);
        }}
      />
      {reason === null ? null : (
        <span id={reasonId} className="order-last basis-full text-[12.5px] text-muted">
          {reason}
        </span>
      )}
      {/* Mounted while empty, so the text it gains is announced. */}
      <span
        role="status"
        className={busy ? 'order-last basis-full text-[12.5px] text-muted' : 'sr-only'}
      >
        {busy ? strings.uploading : ''}
      </span>
      {failed && !archived ? (
        <span role="alert" className="order-last basis-full text-[12.5px] text-danger">
          {strings.failed}
        </span>
      ) : null}
      {files.length === 0 ? null : (
        <ul
          aria-label={strings.attachedLabel}
          className="order-last m-0 flex basis-full list-none flex-wrap gap-2 p-0"
        >
          {files.map((file) => (
            <li
              key={file.id}
              className="rounded-[6px] border border-border bg-surface-2 px-2 py-0.5 text-[12.5px]"
            >
              {file.name}
              <span className="text-muted"> · {formatSize(file.size)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
