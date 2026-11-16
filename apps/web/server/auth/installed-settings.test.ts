import { afterEach, describe, expect, it, vi } from 'vitest';

import { getSession, signIn } from '.';
import {
  mintSessionToken,
  newSessionClaims,
  signIn as signInFromEnv,
  verifySessionToken,
} from './session';

const cookieJar = vi.hoisted(() => new Map<string, string>());
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value === undefined ? undefined : { name, value };
      },
    }),
}));

const SECRET = 'a-session-secret-of-at-least-32-characters';
const ADMIN = {
  BOOTSTRAP_ADMIN: 'admin@example.com',
  BOOTSTRAP_ADMIN_PASSWORD: 'a-long-enough-password',
};
const CREDENTIALS = { email: 'admin@example.com', password: 'a-long-enough-password' };

afterEach(() => {
  vi.unstubAllEnvs();
  cookieJar.clear();
});

describe('the auth root reads the installed sign-in settings (refactoring part 03, step 3)', () => {
  it("signs in under this deployment's cookie name, with its secret", async () => {
    vi.stubEnv('SESSION_SECRET', SECRET);
    vi.stubEnv('AW_INSTANCE_ID', 'acme-ai');
    for (const [name, value] of Object.entries(ADMIN)) vi.stubEnv(name, value);
    const result = await signIn(CREDENTIALS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cookie.name).toBe('__Host-aw_session_acme-ai');
    expect((await verifySessionToken(result.token, SECRET)).ok).toBe(true);
  });

  it('refuses with the reason when no administrator is configured', async () => {
    vi.stubEnv('SESSION_SECRET', SECRET);
    vi.stubEnv('BOOTSTRAP_ADMIN', '');
    expect(await signIn(CREDENTIALS)).toMatchObject({ ok: false, code: 'server_not_configured' });
  });

  it("reads the session from this deployment's cookie, verified with its secret", async () => {
    vi.stubEnv('SESSION_SECRET', SECRET);
    vi.stubEnv('AW_INSTANCE_ID', 'acme-ai');
    const token = await mintSessionToken(newSessionClaims('owner@example.test', 'default'), SECRET);
    cookieJar.set('__Host-aw_session_other', token);
    expect(await getSession()).toBeNull();
    cookieJar.set('__Host-aw_session_acme-ai', token);
    expect(await getSession()).toMatchObject({ sub: 'owner@example.test', ws: 'default' });
    vi.stubEnv('SESSION_SECRET', '');
    expect(await getSession()).toBeNull();
  });

  it('names the cookie from the environment it is given when signing in from one', async () => {
    const result = await signInFromEnv(CREDENTIALS, {
      SESSION_SECRET: SECRET,
      AW_INSTANCE_ID: 'acme-ai',
      ...ADMIN,
    });
    expect(result.ok && result.cookie.name).toBe('__Host-aw_session_acme-ai');
  });
});
