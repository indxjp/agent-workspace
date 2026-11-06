import { describe, expect, it } from 'vitest';
import {
  MIN_SESSION_SECRET_LENGTH,
  sessionCookieName,
  readBootstrapAdmin,
  signIn,
  verifySessionToken,
} from '../apps/web/server/auth/session.js';

const SECRET = 'a'.repeat(MIN_SESSION_SECRET_LENGTH);

const GOOD_ENV = {
  SESSION_SECRET: SECRET,
  BOOTSTRAP_ADMIN: 'Admin@Example.com',
  BOOTSTRAP_ADMIN_PASSWORD: 'correct horse battery staple',
} as const;

describe('readBootstrapAdmin', () => {
  it('lower-cases the email so it matches the row the seed inserted', () => {
    const result = readBootstrapAdmin(GOOD_ENV);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.admin.email).toBe('admin@example.com');
      expect(result.admin.workspaceSlug).toBe('default');
    }
  });

  it('takes the workspace slug from WORKSPACE_SLUG, as the seed does', () => {
    const result = readBootstrapAdmin({ ...GOOD_ENV, WORKSPACE_SLUG: 'acme-eu' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.admin.workspaceSlug).toBe('acme-eu');
  });

  it('fails closed, naming the variable, for every unusable configuration', () => {
    const cases: readonly [Record<string, string>, string][] = [
      [{}, 'BOOTSTRAP_ADMIN'],
      [{ BOOTSTRAP_ADMIN: '   ' }, 'BOOTSTRAP_ADMIN'],
      [{ BOOTSTRAP_ADMIN: 'not-an-email' }, 'BOOTSTRAP_ADMIN'],
      [{ BOOTSTRAP_ADMIN: 'a@b.c' }, 'BOOTSTRAP_ADMIN_PASSWORD'],
      [{ BOOTSTRAP_ADMIN: 'a@b.c', BOOTSTRAP_ADMIN_PASSWORD: '' }, 'BOOTSTRAP_ADMIN_PASSWORD'],
      [{ BOOTSTRAP_ADMIN: 'a@b.c', BOOTSTRAP_ADMIN_PASSWORD: 'short' }, 'BOOTSTRAP_ADMIN_PASSWORD'],
      [{ ...GOOD_ENV, WORKSPACE_SLUG: 'Not A Slug' }, 'WORKSPACE_SLUG'],
    ];
    for (const [env, expected] of cases) {
      const result = readBootstrapAdmin(env);
      expect(result.ok, JSON.stringify(env)).toBe(false);
      if (!result.ok) expect(result.reason, JSON.stringify(env)).toContain(expected);
    }
  });
});

describe('signIn', () => {
  it('mints a verifiable session for the configured administrator', async () => {
    const result = await signIn(
      { email: 'ADMIN@example.com ', password: GOOD_ENV.BOOTSTRAP_ADMIN_PASSWORD },
      GOOD_ENV,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const verified = await verifySessionToken(result.token, SECRET);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims.sub).toBe('admin@example.com');
      expect(verified.claims.ws).toBe('default');
      expect(verified.claims.role).toBe('owner');
    }
    expect(result.cookie.name).toBe(sessionCookieName());
  });

  it('refuses a wrong password and a wrong email with the same code', async () => {
    const wrongPassword = await signIn(
      { email: GOOD_ENV.BOOTSTRAP_ADMIN, password: 'nope nope nope' },
      GOOD_ENV,
    );
    const wrongEmail = await signIn(
      { email: 'someone@else.test', password: GOOD_ENV.BOOTSTRAP_ADMIN_PASSWORD },
      GOOD_ENV,
    );
    expect(wrongPassword.ok).toBe(false);
    expect(wrongEmail.ok).toBe(false);
    if (!wrongPassword.ok) expect(wrongPassword.code).toBe('invalid_credentials');
    if (!wrongEmail.ok) expect(wrongEmail.code).toBe('invalid_credentials');
  });

  it('refuses non-string credentials rather than coercing them', async () => {
    for (const input of [
      { email: undefined, password: GOOD_ENV.BOOTSTRAP_ADMIN_PASSWORD },
      { email: GOOD_ENV.BOOTSTRAP_ADMIN, password: undefined },
      {
        email: { toString: () => GOOD_ENV.BOOTSTRAP_ADMIN },
        password: GOOD_ENV.BOOTSTRAP_ADMIN_PASSWORD,
      },
      { email: GOOD_ENV.BOOTSTRAP_ADMIN, password: ['correct horse battery staple'] },
    ]) {
      const result = await signIn(input, GOOD_ENV);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('malformed_request');
    }
  });

  it('refuses to sign anybody in when the deployment is not configured', async () => {
    const cases: readonly Record<string, string>[] = [
      // No SESSION_SECRET at all.
      {
        BOOTSTRAP_ADMIN: GOOD_ENV.BOOTSTRAP_ADMIN,
        BOOTSTRAP_ADMIN_PASSWORD: GOOD_ENV.BOOTSTRAP_ADMIN_PASSWORD,
      },
      // No administrator at all.
      { SESSION_SECRET: SECRET },
      // An administrator with no credential.
      { SESSION_SECRET: SECRET, BOOTSTRAP_ADMIN: GOOD_ENV.BOOTSTRAP_ADMIN },
      // Everything set, but the secret is too short to sign with.
      { ...GOOD_ENV, SESSION_SECRET: 'too-short' },
    ];
    for (const env of cases) {
      const result = await signIn(
        { email: GOOD_ENV.BOOTSTRAP_ADMIN, password: GOOD_ENV.BOOTSTRAP_ADMIN_PASSWORD },
        env,
      );
      expect(result.ok, JSON.stringify(env)).toBe(false);
      if (!result.ok) expect(result.code).toBe('server_not_configured');
    }
  });

  it('refuses an empty password even if the caller sends an empty password too', async () => {
    const result = await signIn(
      { email: GOOD_ENV.BOOTSTRAP_ADMIN, password: '' },
      {
        SESSION_SECRET: SECRET,
        BOOTSTRAP_ADMIN: GOOD_ENV.BOOTSTRAP_ADMIN,
        BOOTSTRAP_ADMIN_PASSWORD: '',
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('server_not_configured');
  });
});
