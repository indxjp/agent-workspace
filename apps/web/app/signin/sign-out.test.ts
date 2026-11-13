/**
 * `signOutAction` (refactoring part 06, step 4): expires the session, selection and
 * invitation-identity cookies under this deployment's names, then goes to the sign-in screen; a
 * cross-origin post signs nobody out.
 */
import { log as webLogger } from '../../server/telemetry/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface SetCookie {
  readonly name: string;
  readonly value: string;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: string;
  readonly path: string;
  readonly maxAge: number;
}

const request = vi.hoisted(() => ({
  headers: new Headers(),
  set: [] as SetCookie[],
}));

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(request.headers),
  cookies: () =>
    Promise.resolve({
      set: (cookie: SetCookie): void => {
        request.set.push(cookie);
      },
    }),
}));

vi.mock('next/navigation', () => ({
  redirect: (to: string): never => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

const { signOutAction } = await import('./actions');

beforeEach(() => {
  request.headers = new Headers({ origin: 'http://app.example', host: 'app.example' });
  request.set = [];
  vi.stubEnv('SESSION_SECRET', 'a'.repeat(32));
  vi.spyOn(webLogger, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('signOutAction', () => {
  it('expires the session, selection and invitation cookies, then goes to sign-in', async () => {
    await expect(signOutAction()).rejects.toThrow(/^REDIRECT \/signin$/);
    expect(request.set.map((cookie) => cookie.name)).toEqual([
      '__Host-aw_session',
      '__Host-aw_workspace_selection',
      '__Host-aw_invitation_identity',
    ]);
    for (const cookie of request.set) {
      expect(cookie).toMatchObject({
        value: '',
        maxAge: 0,
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
      });
    }
  });

  it("uses this deployment's cookie names when AW_INSTANCE_ID scopes them", async () => {
    vi.stubEnv('AW_INSTANCE_ID', 'acme-ai');
    await expect(signOutAction()).rejects.toThrow(/^REDIRECT \/signin$/);
    expect(request.set[0]?.name).toBe('__Host-aw_session_acme-ai');
    expect(request.set.every((cookie) => cookie.name.endsWith('_acme-ai'))).toBe(true);
  });

  it('signs nobody out from another origin', async () => {
    request.headers = new Headers({ origin: 'https://evil.example', host: 'app.example' });
    await expect(signOutAction()).rejects.toThrow(/^REDIRECT \/$/);
    expect(request.set).toEqual([]);
  });

  it('signs nobody out when the origin is missing', async () => {
    request.headers = new Headers({ host: 'app.example' });
    await expect(signOutAction()).rejects.toThrow(/^REDIRECT \/$/);
    expect(request.set).toEqual([]);
  });
});
