import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * The words a refusal uses to send the reader to `/setup`: the server's English
 * (`missingRuntimeProfile` in `apps/web/server/compose/run-start-refusal.ts`) and the console's
 * Japanese for the same code (`../run/run-refusal-messages.ts`). The message arrives as plain
 * text, so the console turns these words into the link rather than leaving the reader to find
 * the route.
 */
const SETUP_WIZARD_WORDS = ['setup wizard', 'セットアップウィザード'] as const;

/** `text` with its first mention of the setup wizard as a link to it; other text is unchanged. */
export function withSetupWizardLink(text: string): ReactNode {
  for (const words of SETUP_WIZARD_WORDS) {
    const at = text.indexOf(words);
    if (at === -1) continue;
    return (
      <>
        {text.slice(0, at)}
        <Link href="/setup" className="text-accent underline">
          {words}
        </Link>
        {text.slice(at + words.length)}
      </>
    );
  }
  return text;
}
