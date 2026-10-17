/**
 * `/signin` — the screen the bootstrap administrator of spec §21 signs in on.
 *
 * The whole of Wave 1's identity story is one account: the email `pnpm db:seed` inserted as the
 * workspace owner, and the password the deployment configured. There is no registration, no
 * password reset, no second user and no OIDC — §21 makes OIDC the real answer and W6-CP-04 owns
 * it, with R-12 unwritten. A screen that offered any of those would be offering something this
 * build cannot do.
 *
 * The form posts to {@link signInAction}. It carries no client component and no JavaScript of its
 * own: a Next.js server action reached from a plain `<form action={…}>` is submitted by the
 * browser's own form machinery when React has not hydrated, which is why the acceptance transcript
 * on this task's PR can sign in with `curl` and get a `Set-Cookie` back. That is not a trick to
 * make a probe pass — it is the same request path a browser with JavaScript disabled takes.
 *
 * The error text below is deliberately coarse and never says which half was wrong. `signIn()`
 * compares email and password in constant time and always compares both, and a screen that said
 * "no such user" would give that back for free.
 */
import type { Metadata } from 'next';

import { safeNextPath } from '../../server/auth/next-path';
import { signInAction, type SignInScreenError } from './actions';

// Every route this application serves reads request state and must not be prerendered. A sign-in
// screen that was rendered at build time would be a page whose `?error=` never changes.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Sign in · Agent Workspace',
};

/**
 * The message for one `?error=` value.
 *
 * Reads the query parameter as an untrusted string and matches it *positively*: anything that is
 * not one of the three names this screen writes produces no message at all, rather than being
 * echoed back into the page. An unrecognised value is a link somebody constructed, and rendering
 * it would be a reflected-content hole in the one page an unauthenticated visitor can reach.
 */
function messageFor(raw: string | undefined): string | null {
  const known: Record<SignInScreenError, string> = {
    rejected: 'That email address and password did not match. Try again.',
    unconfigured:
      'This deployment cannot sign anyone in yet. Its SESSION_SECRET, BOOTSTRAP_ADMIN or ' +
      'BOOTSTRAP_ADMIN_PASSWORD is missing or too short — the server log names which.',
    cross_origin: 'That sign-in request did not come from this site, so it was refused.',
    rate_limited: 'Too many sign-in attempts. Wait a minute and try again.',
    // The two OIDC terminal states issue #118 adds. `no_membership` names the account's actual
    // condition rather than a generic failure, because it is not a credential problem — it is
    // Section 21's own rule that a user with no membership has nothing to sign in to.
    no_membership: 'That identity has no current membership in any workspace.',
    session_expired: 'That sign-in attempt expired. Start again.',
  };
  if (raw === undefined) return null;
  return Object.prototype.hasOwnProperty.call(known, raw) ? known[raw as SignInScreenError] : null;
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params['error'];
  const message = messageFor(typeof raw === 'string' ? raw : undefined);
  const next = safeNextPath(params['next']);
  const oidcConfigured = [
    'OIDC_ISSUER_URL',
    'OIDC_CLIENT_ID',
    'OIDC_CLIENT_SECRET',
    'OIDC_REDIRECT_URI',
  ].every((name) => Boolean(process.env[name]?.trim()));

  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'grid',
        placeItems: 'center',
        padding: '24px',
        background: 'var(--bg)',
        color: 'var(--text)',
        fontFamily: 'var(--font)',
      }}
    >
      <div
        style={{
          width: 'min(380px, 100%)',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow)',
          padding: '28px',
        }}
      >
        <h1 style={{ margin: '0 0 4px', fontSize: '18px', fontWeight: 600 }}>Agent Workspace</h1>
        <p style={{ margin: '0 0 20px', color: 'var(--muted)', fontSize: '13px' }}>
          Sign in as the workspace owner.
        </p>

        {message === null ? null : (
          <p
            role="alert"
            style={{
              margin: '0 0 16px',
              padding: '10px 12px',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--danger-soft)',
              color: 'var(--danger)',
              fontSize: '13px',
            }}
          >
            {message}
          </p>
        )}

        <form action={signInAction} style={{ display: 'grid', gap: '12px' }}>
          {next === null ? null : <input type="hidden" name="next" value={next} />}
          <label style={{ display: 'grid', gap: '6px', fontSize: '13px' }}>
            Email
            <input
              type="email"
              name="email"
              autoComplete="username"
              required
              style={{
                padding: '9px 10px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-strong)',
                background: 'var(--surface-2)',
                color: 'var(--text)',
                fontSize: '14px',
              }}
            />
          </label>
          <label style={{ display: 'grid', gap: '6px', fontSize: '13px' }}>
            Password
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
              style={{
                padding: '9px 10px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-strong)',
                background: 'var(--surface-2)',
                color: 'var(--text)',
                fontSize: '14px',
              }}
            />
          </label>
          <button
            type="submit"
            style={{
              marginTop: '4px',
              padding: '10px 12px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid transparent',
              background: 'var(--accent)',
              color: '#fff',
              fontSize: '14px',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Sign in
          </button>
        </form>
        {oidcConfigured ? (
          <>
            <p
              aria-hidden="true"
              style={{ margin: '18px 0', textAlign: 'center', color: 'var(--muted)' }}
            >
              or
            </p>
            <form action="/api/auth/login" method="get">
              {next === null ? null : <input type="hidden" name="next" value={next} />}
              <button
                type="submit"
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border-strong)',
                  background: 'var(--surface-2)',
                  color: 'var(--text)',
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                Continue with enterprise SSO
              </button>
            </form>
          </>
        ) : null}
      </div>
    </main>
  );
}
