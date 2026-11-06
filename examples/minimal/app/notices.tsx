import { signInHref } from '@indx-workspace/app/server';

import { strings } from './strings';

/** Where the portal guide explains how a person signs in. */
const SIGN_IN_HELP = 'https://docs.agentworkspace.indx.jp/building/portal#sign-in';

/**
 * What a page shows to nobody signed in, or to a person whose sign-in has expired: why, the way
 * to sign in and come back to `next`, and how sign-in is set up.
 */
export function SignInRequired({ next }: { readonly next?: string }) {
  return (
    <main>
      <h1>{strings.signInTitle}</h1>
      <p>{strings.signInBody}</p>
      <p>
        <a className="aw-app-button" href={signInHref(next)}>
          {strings.signIn}
        </a>
      </p>
      <p>
        <a href={SIGN_IN_HELP}>{strings.signInHelp}</a>
      </p>
    </main>
  );
}

/** A section's line when the platform gave no answer: `not-available` or `failed`. */
export function Unanswered({ kind }: { readonly kind: 'not-available' | 'failed' }) {
  return (
    <p role="status">
      {kind === 'failed' ? strings.failed : strings.notAvailable} <a href="/">{strings.home}</a>
    </p>
  );
}
