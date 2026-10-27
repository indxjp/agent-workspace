/**
 * The password half of `/signin?next=` (issue #971): `signInAction` reads `next` from the form,
 * passes it through `safeNextPath`, redirects to it on success and keeps it on a failed attempt.
 */
import { log as webLogger } from '../../server/telemetry/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => ({
  headers: new Headers({ origin: 'http://app.example', host: 'app.example' }),
  cookies: { set: (): void => undefined },
}));

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(request.headers),
  cookies: () => Promise.resolve(request.cookies),
}));

vi.mock('next/navigation', () => ({
  redirect: (to: string): never => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

const { signInAction } = await import('./actions');

function form(password: string, next: string): FormData {
  const data = new FormData();
  data.set('email', 'admin@example.com');
  data.set('password', password);
  data.set('next', next);
  return data;
}

beforeEach(() => {
  vi.stubEnv('SESSION_SECRET', 'a'.repeat(32));
  vi.stubEnv('BOOTSTRAP_ADMIN', 'admin@example.com');
  vi.stubEnv('BOOTSTRAP_ADMIN_PASSWORD', 'correct-horse-battery');
  vi.spyOn(webLogger, 'info').mockImplementation(() => undefined);
  vi.spyOn(webLogger, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('signInAction next', () => {
  it('redirects a successful sign-in to the same-origin next path', async () => {
    await expect(
      signInAction(form('correct-horse-battery', '/oauth/authorize?client_id=c')),
    ).rejects.toThrow('REDIRECT /oauth/authorize?client_id=c');
  });

  it('redirects a successful sign-in to / when next is off-origin', async () => {
    await expect(signInAction(form('correct-horse-battery', '//evil.example'))).rejects.toThrow(
      /^REDIRECT \/$/,
    );
  });

  it('keeps next on the way back to the form after a wrong password', async () => {
    await expect(
      signInAction(form('wrong-password-here', '/oauth/authorize?client_id=c')),
    ).rejects.toThrow('REDIRECT /signin?error=rejected&next=%2Foauth%2Fauthorize%3Fclient_id%3Dc');
  });
});
