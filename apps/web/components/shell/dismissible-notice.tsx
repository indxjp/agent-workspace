'use client';

/**
 * A notice the user can close with ×, remembered per browser in `localStorage`.
 *
 * `version` names the condition the notice is about (`driver=local`, an `archivedAt` timestamp):
 * a dismissal hides only that version, so the notice returns when the condition changes.
 *
 * The notice renders visible on the server and on the first client render, and hides itself in an
 * effect. That keeps the hydrated markup identical to the server's, at the cost of a brief flash on
 * reload — which errs toward showing the warning. See
 * docs/adr/W9-UI-1133-driver-band-is-dismissible-chip-is-the-a3-signal.md.
 */
import { useEffect, useState, type ReactNode } from 'react';

function storageKey(id: string): string {
  return `aw.notice.dismissed.${id}`;
}

/** False when storage is unavailable: a browser that refuses storage keeps seeing the notice. */
export function isDismissed(id: string, version: string): boolean {
  try {
    return window.localStorage.getItem(storageKey(id)) === version;
  } catch {
    return false;
  }
}

export function rememberDismissal(id: string, version: string): void {
  try {
    window.localStorage.setItem(storageKey(id), version);
  } catch {
    // Remembering is a convenience; the notice is still hidden for this page view.
  }
}

export interface DismissibleNoticeProps {
  readonly id: string;
  readonly version: string;
  /** Layout and tone classes for the notice's box; the × sits at its end. */
  readonly className: string;
  readonly role?: 'alert' | 'status';
  readonly testId?: string;
  readonly children: ReactNode;
}

export function DismissibleNotice({
  id,
  version,
  className,
  role,
  testId,
  children,
}: DismissibleNoticeProps) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    setHidden(isDismissed(id, version));
  }, [id, version]);

  if (hidden) return null;
  return (
    <div className={`flex items-start gap-3 ${className}`} role={role} data-testid={testId}>
      <div className="min-w-0 flex-1">{children}</div>
      <button
        type="button"
        aria-label="Dismiss"
        title="Dismiss"
        className="flex-none cursor-pointer leading-none opacity-70 hover:opacity-100"
        onClick={() => {
          setHidden(true);
          rememberDismissal(id, version);
        }}
      >
        ×
      </button>
    </div>
  );
}
