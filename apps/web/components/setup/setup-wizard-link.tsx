import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * The words a server message uses to send the reader to `/setup` (`missingRuntimeProfile` in
 * `apps/web/server/compose/run-preflight.ts`). The message arrives as plain text, so the console
 * turns these words into the link rather than leaving the reader to find the route.
 */
const SETUP_WIZARD_WORDS = 'setup wizard';

/** `text` with its first mention of the setup wizard as a link to it; other text is unchanged. */
export function withSetupWizardLink(text: string): ReactNode {
  const at = text.indexOf(SETUP_WIZARD_WORDS);
  if (at === -1) return text;
  return (
    <>
      {text.slice(0, at)}
      <Link href="/setup" className="text-accent underline">
        {SETUP_WIZARD_WORDS}
      </Link>
      {text.slice(at + SETUP_WIZARD_WORDS.length)}
    </>
  );
}
