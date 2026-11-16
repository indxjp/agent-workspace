'use client';
/**
 * The email link's landing: read the fragment once, take it out of the address bar, send it to the
 * platform to open the visitor's demo workspace, and go to the entry's Try tab. A refusal says
 * what happened and links back.
 */
import { useEffect, useRef, useState } from 'react';

import { EmailLinkVerifiedResponseSchema } from '@indx-workspace/contracts/email-link';

import { pick, type Lang } from '../lang';
import { callPlatform } from '../platform-api';
import { signInBackLabel, signInStep, verifyRefusalMessage } from '../agents/[slug]/try/messages';
import { afterSignInPath } from './fragment';

const WORDS = {
  title: { ja: 'サインイン', en: 'Signing you in' },
  working: { ja: 'デモ環境を準備しています…', en: 'Preparing your demo workspace…' },
};

export type State = 'working' | { readonly failed: string; readonly back: string };

export function VerifyLink({
  lang,
  platformUrl,
}: {
  readonly lang: Lang;
  readonly platformUrl: string;
}) {
  const [state, setState] = useState<State>('working');
  // StrictMode runs effects twice; the fragment is read once, so the page never shows a false failure.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const step = signInStep(window.location.hash, lang);
    // The token is single-use and secret: it leaves the address bar (and so history) at once.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    if ('failed' in step) {
      setState(step);
      return;
    }
    const link = step.request;
    void callPlatform(platformUrl, '/api/auth/email-link/verify', EmailLinkVerifiedResponseSchema, {
      method: 'POST',
      body: link,
    }).then((answer) => {
      if (answer.ok) window.location.replace(afterSignInPath(link.entry));
      else {
        // The visitor re-enters the address where the form is: the entry's Try tab.
        setState({ failed: verifyRefusalMessage(answer, lang), back: afterSignInPath(link.entry) });
      }
    });
  }, [lang, platformUrl]);

  return <SignInView state={state} lang={lang} />;
}

/** What the page shows: the work in progress, or why it stopped and the way back. */
export function SignInView({ state, lang }: { readonly state: State; readonly lang: Lang }) {
  return (
    <main>
      <h1>{pick(WORDS.title, lang)}</h1>
      {state === 'working' ? (
        <p role="status">{pick(WORDS.working, lang)}</p>
      ) : (
        <>
          <p role="alert">{state.failed}</p>
          <p>
            <a href={state.back}>{signInBackLabel(state.back, lang)}</a>
          </p>
        </>
      )}
    </main>
  );
}
