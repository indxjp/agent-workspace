'use client';

/** A button that copies `text` to the clipboard and says so; the label is the locale's. */
import { useState, type ReactNode } from 'react';

export function CopyButton({
  text,
  label,
  copiedLabel,
}: {
  readonly text: string;
  readonly label: string;
  readonly copiedLabel: string;
}): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="rounded-(--radius) border border-border px-2 py-1 text-[12px] font-semibold hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2"
      onClick={() => {
        // The clipboard is absent on an insecure origin, so the call itself throws; deferring it
        // into the promise chain turns that into a rejection and the text stays selectable.
        void Promise.resolve()
          .then(() => navigator.clipboard.writeText(text))
          .then(
            () => {
              setCopied(true);
            },
            () => undefined,
          );
      }}
    >
      <span aria-live="polite">{copied ? copiedLabel : label}</span>
    </button>
  );
}
