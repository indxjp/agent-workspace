/**
 * The one thing that turns the bootstrap administrator's credential into a session cookie.
 *
 * `signIn()` has existed in `apps/web/server/auth/session.ts` since W1-CP-06 and nothing served
 * it: the only session the Wave 1a integration ever produced was minted in-process by a scratch
 * launcher held outside every worktree. This file is what serves it, and it is deliberately the
 * whole of the sign-in story — no OIDC (that is W6-CP-04 and R-12 is unwritten), no user
 * management, no password reset, no second identity. §21 has one bootstrap administrator in this
 * wave and this action admits exactly that one.
 *
 * ## Why a server action and not a route handler
 *
 * `docs/adr/W1-CP-06-sign-in-lives-outside-the-api-prefix.md` establishes that the endpoint
 * cannot live under `/api/` — `middleware.ts` answers 401 to every `/api/**` request without a
 * session, and the gate has no opt-out on purpose — and names two placements that need no change
 * to it: a handler under `/p/`, or *"a Next.js server action or a form `POST` handled by a page
 * route: the page surface is also `allow`"*. This is the second. The reason the first was not
 * taken is recorded in `docs/adr/W1-COMP-01-sign-in-is-a-screen-not-a-route.md`: a
 * `route.ts` anywhere under `apps/web/app` joins the closed world `tests/route-inventory.test.ts`
 * asserts against spec §34, §34 prints no sign-in route, and the gate's own failure text says to
 * amend the specification first. A screen is not in that world — the inventory ignores `page.tsx`
 * by name — and sign-in genuinely is a screen rather than a control-plane API endpoint.
 *
 * ## The CSRF check is here because the middleware's does not run
 *
 * The same ADR states it as an obligation rather than something already done: *"A sign-in handler
 * gets no CSRF protection from the middleware, and must do its own … **This is a requirement on
 * W2-CP-06, not a thing already done**"*. The middleware returns early for an `allow` surface, so
 * `checkRequestOrigin()` never runs on the page surface either. Login CSRF — an attacker
 * submitting *their* credentials so a victim is silently signed into the attacker's account — is
 * the real risk, and it is the one this call refuses. Next.js also validates `Origin` against
 * `Host` for server actions on its own; this check is not a substitute for that and does not
 * depend on it, because a defence that only exists inside a framework's default is a defence
 * that leaves with the default.
 */
'use server';

import { log } from '../../server/telemetry/logger';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { safeNextPath } from '../../server/auth/next-path';
import { checkRequestOrigin } from '../../server/auth/origin';
import { admitSignInAttempt } from '../../server/auth/sign-in-limit';
import { sessionCookie, signIn, type SignInFailure } from '../../server/auth/session';

/**
 * What the sign-in screen may say back to an anonymous visitor.
 *
 * Three values, none of which names a variable, a secret or an identity — the *reason* strings
 * `signIn()` returns are for the server log, and go to it. `unconfigured` and `rejected` are
 * separated for the reason `SignInFailure` separates them: they are the same outcome for the
 * person typing and completely different outcomes for the operator, and collapsing them is how a
 * deployment with no `SESSION_SECRET` gets diagnosed as a forgotten password.
 */
export type SignInScreenError =
  | 'rejected'
  | 'unconfigured'
  | 'cross_origin'
  | 'rate_limited'
  // The two OIDC terminal states `/api/auth/callback` (issue #118) redirects here with.
  | 'no_membership'
  | 'session_expired';

/**
 * Where a failed attempt goes back to. Same screen, no credential in it; `next` (already passed
 * through {@link safeNextPath}) survives so the retry still lands where the visitor was going.
 */
function backToTheForm(error: SignInScreenError, next: string | null): never {
  redirect(`/signin?error=${error}${next === null ? '' : `&next=${encodeURIComponent(next)}`}`);
}

/**
 * Map `signIn()`'s failure to what the screen may show.
 *
 * Total over {@link SignInFailure}, with a `default` that reports rather than assumes: a fourth
 * failure added to that union and not to this switch becomes `unconfigured` — the arm that tells
 * an operator to look at the log — rather than `rejected`, which would tell a visitor their
 * password was wrong on the strength of a case nobody classified.
 */
function screenErrorFor(code: SignInFailure): SignInScreenError {
  switch (code) {
    case 'invalid_credentials':
      return 'rejected';
    case 'malformed_request':
      return 'rejected';
    case 'server_not_configured':
      return 'unconfigured';
    default: {
      const unhandled: never = code;
      log.error(`[signin] unclassified sign-in failure`, { code: unhandled });
      return 'unconfigured';
    }
  }
}

/**
 * Verify the bootstrap administrator's credential and set the session cookie.
 *
 * Redirects either way: to the same-origin `next` path (default `/`) with a cookie, or back to
 * `/signin?error=…` without one. Nothing
 * is returned to the caller, so there is no shape in which a token could be rendered into a page.
 */
export async function signInAction(form: FormData): Promise<void> {
  const next = safeNextPath(form.get('next'));
  const headerBag = await headers();
  const origin = checkRequestOrigin({
    method: 'POST',
    origin: headerBag.get('origin'),
    requestHost: headerBag.get('host'),
    hostHeader: headerBag.get('host'),
    forwardedHost: headerBag.get('x-forwarded-host'),
  });
  if (!origin.ok) {
    log.warn(`[signin] cross-origin sign-in refused`, { reason: origin.reason });
    backToTheForm('cross_origin', next);
  }
  if (!admitSignInAttempt(headerBag).admitted) backToTheForm('rate_limited', next);

  // `FormData.get` returns `string | File | null`. `signIn()` takes `unknown` and rejects
  // anything that is not a string with `malformed_request`, so the values are handed over as
  // they arrived rather than coerced here — a `File` coerced to `'[object File]'` would be
  // compared against the configured password as if someone had typed it.
  const result = await signIn({ email: form.get('email'), password: form.get('password') });
  if (!result.ok) {
    // The reason names the variable when the deployment is misconfigured, which is the only
    // place an operator can read it. It never reaches the browser.
    log.warn(`[signin] refused`, { code: result.code, reason: result.reason });
    backToTheForm(screenErrorFor(result.code), next);
  }

  const jar = await cookies();
  const cookie = sessionCookie(result.token);
  jar.set({
    name: cookie.name,
    value: cookie.value,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
    path: cookie.path,
    maxAge: cookie.maxAge,
  });
  log.info('[signin] session issued for the bootstrap administrator');
  redirect(next ?? '/');
}
