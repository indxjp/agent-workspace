/** Shared fixtures for the `POST /api/auth/callback` suites. */
import { afterEach, beforeEach, expect, vi } from 'vitest';

import { oidcTransactionCookieName } from '../../../../server/auth';
import { clearApplicationContext } from '../../../../server/application-context';
import { installTestDomains } from '../../../../server/application-context-fixtures';
import { conferredBy } from '../../../../server/rbac/core/conferral';
import { createMemoryDirectory } from '../../../../server/rbac/memory-directory';

import type { CallbackDeps } from './route';

export const SECRET = 'a'.repeat(32);
export const HOST = 'app.example.test';
export const ISSUER = 'https://idp.example.test';
export const URL_ = `https://${HOST}/api/auth/callback`;

const OIDC_ENV_NAMES = [
  'OIDC_ISSUER_URL',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_REDIRECT_URI',
];

/** Sets the session secret and the complete OIDC configuration. */
export function stubCallbackEnvironment(): void {
  vi.stubEnv('SESSION_SECRET', SECRET);
  vi.stubEnv('OIDC_ISSUER_URL', ISSUER);
  vi.stubEnv('OIDC_CLIENT_ID', 'client');
  vi.stubEnv('OIDC_CLIENT_SECRET', 'client-secret');
  vi.stubEnv('OIDC_REDIRECT_URI', URL_);
}

/** Sets the callback environment before each test and restores it afterwards. */
export function useCallbackEnvironment(): void {
  beforeEach(stubCallbackEnvironment);

  afterEach(() => {
    vi.unstubAllEnvs();
    clearApplicationContext();
  });
}

/** Unsets every OIDC variable, as a deployment without OIDC would. */
export function unsetOidcEnvironment(): void {
  for (const name of OIDC_ENV_NAMES) vi.stubEnv(name, undefined);
}

export function request(options: {
  cookies?: Record<string, string>;
  origin?: string | null;
  form?: Record<string, string>;
}): Request {
  const headers = new Headers();
  if (options.cookies !== undefined) {
    headers.set(
      'cookie',
      Object.entries(options.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; '),
    );
  }
  headers.set('host', HOST);
  const origin = options.origin === undefined ? `https://${HOST}` : options.origin;
  if (origin !== null) headers.set('origin', origin);
  headers.set('content-type', 'application/x-www-form-urlencoded');
  const body = new URLSearchParams(
    options.form ?? { code: 'auth-code', state: 'state-value' },
  ).toString();
  return new Request(URL_, { method: 'POST', headers, body });
}

export function setCookieValue(response: Response, name: string): string | undefined {
  for (const raw of response.headers.getSetCookie()) {
    if (raw.startsWith(`${name}=`)) return raw.slice(name.length + 1).split(';')[0];
  }
  return undefined;
}

/**
 * The `Location` is asserted as a **whole string**, never through `new URL(location).pathname`.
 * Parsing is what hid this defect for three releases: `new URL('https://app.example.test/').pathname`
 * is also `/`, so a reading that goes through `URL` passes just as happily on a header that sends
 * the browser to a different origin than the one it asked — where the cookies riding on this very
 * response are not sent, and a completed sign-in arrives signed out.
 */
export function expectRelativeLocation(response: Response, expected: string): void {
  const location = response.headers.get('location');
  expect(location).toBe(expected);
  expect(location).not.toContain(HOST);
  expect(location).not.toContain('://');
}

type FakeIdentity = {
  subject: string;
  email: string;
  name: string | null;
  next?: string | null;
};

export function fakeDeps(identity: FakeIdentity | Error): CallbackDeps {
  return {
    finishOidcLogin: () =>
      identity instanceof Error ? Promise.reject(identity) : Promise.resolve(identity),
  };
}

/** A request carrying only the OIDC transaction cookie, i.e. a well-formed callback. */
export function transactionRequest(): Request {
  return request({ cookies: { [oidcTransactionCookieName()]: 'txn' } });
}

/** Installs the RBAC runtime over `directory`, with no pre-resolved identity. */
export function installDirectory(directory: ReturnType<typeof createMemoryDirectory>): void {
  installTestDomains({ rbac: { directory, identify: () => Promise.resolve(null) } });
}

/** A directory whose only user, `solo@example.test`, holds exactly one membership. */
export function soloDirectory(): ReturnType<typeof createMemoryDirectory> {
  return createMemoryDirectory({
    workspaces: [{ id: 'ws-a', slug: 'acme', name: 'Acme' }],
    users: [{ email: 'solo@example.test', name: 'Solo', workspaceId: 'ws-a', role: 'admin' }],
  });
}

/** A directory whose user, `multi@example.test`, holds a membership in two workspaces. */
export async function multiDirectory(): Promise<ReturnType<typeof createMemoryDirectory>> {
  const directory = createMemoryDirectory({
    workspaces: [
      { id: 'ws-a', slug: 'acme', name: 'Acme' },
      { id: 'ws-b', slug: 'beta', name: 'Beta Inc' },
    ],
    users: [{ email: 'multi@example.test', name: 'Multi', workspaceId: 'ws-a', role: 'admin' }],
  });
  await directory.forWorkspace('ws-b').createMembership({
    email: 'multi@example.test',
    role: conferredBy('owner', 'viewer', 'test'),
  });
  return directory;
}
