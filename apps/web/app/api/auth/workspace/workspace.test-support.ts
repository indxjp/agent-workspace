/**
 * Shared fixtures for the `/api/auth/workspace` route tests (`workspace.test.ts`,
 * `workspace.json.test.ts`, `workspace.email-link.test.ts`): request builders, the Set-Cookie
 * reader, and the in-memory directory install/teardown every suite repeats.
 */
import { vi } from 'vitest';

import { clearApplicationContext } from '../../../../server/application-context';
import { installTestDomains } from '../../../../server/application-context-fixtures';
import {
  mintSignInSessionToken,
  newSignInSessionClaims,
  signInSessionCookieName,
} from '../../../../server/auth';
import { POST } from './route';
import { conferredBy } from '../../../../server/rbac/core/conferral';
import {
  createMemoryDirectory,
  type MemoryDirectory,
  type MemoryDirectoryOptions,
} from '../../../../server/rbac/memory-directory';

export const SECRET = 'a'.repeat(32);
export const HOST = 'app.example.test';
export const URL_ = `https://${HOST}/api/auth/workspace`;
export const viewer = conferredBy('owner', 'viewer', 'test fixture');

export const U1_EMAIL = 'u1@example.test';

/** Seed for suites that need one workspace (`acme`) and the admin user `U1_EMAIL`. */
export const SINGLE_WORKSPACE_SEED: MemoryDirectoryOptions = {
  workspaces: [{ id: 'ws-a', slug: 'acme', name: 'Acme' }],
  users: [{ email: U1_EMAIL, name: 'U1', workspaceId: 'ws-a', role: 'admin' }],
};

/** Three workspaces; U1 is an admin of `acme`, U2 an owner of `gamma`. */
export const MULTI_WORKSPACE_SEED: MemoryDirectoryOptions = {
  workspaces: [
    { id: 'ws-a', slug: 'acme', name: 'Acme' },
    { id: 'ws-b', slug: 'beta', name: 'Beta Inc' },
    { id: 'ws-c', slug: 'gamma', name: 'Gamma LLC' },
  ],
  users: [
    { email: U1_EMAIL, name: 'U1', workspaceId: 'ws-a', role: 'admin' },
    { email: 'u2@example.test', name: 'U2', workspaceId: 'ws-c', role: 'owner' },
  ],
};

type Cookies = Record<string, string>;

function cookieHeader(cookies: Cookies): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

export function request(options: {
  method: 'GET' | 'POST';
  cookies?: Cookies;
  origin?: string | null;
  form?: Record<string, string>;
}): Request {
  const headers = new Headers();
  if (options.cookies !== undefined) headers.set('cookie', cookieHeader(options.cookies));
  headers.set('host', HOST);
  if (options.origin !== undefined && options.origin !== null)
    headers.set('origin', options.origin);
  if (options.origin === undefined && options.method === 'POST')
    headers.set('origin', `https://${HOST}`);

  let body: string | undefined;
  if (options.form !== undefined) {
    headers.set('content-type', 'application/x-www-form-urlencoded');
    body = new URLSearchParams(options.form).toString();
  }
  return body === undefined
    ? new Request(URL_, { method: options.method, headers })
    : new Request(URL_, { method: options.method, headers, body });
}

export function jsonRequest(options: {
  method: 'POST';
  cookies?: Cookies;
  origin?: string | null;
  body?: unknown;
  rawBody?: string;
}): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.cookies !== undefined) headers.set('cookie', cookieHeader(options.cookies));
  headers.set('host', HOST);
  const origin = options.origin === undefined ? `https://${HOST}` : options.origin;
  if (origin !== null) headers.set('origin', origin);
  return new Request(URL_, {
    method: options.method,
    headers,
    body: options.rawBody ?? JSON.stringify(options.body ?? {}),
  });
}

export function setCookieValue(response: Response, name: string): string | undefined {
  for (const raw of response.headers.getSetCookie()) {
    if (raw.startsWith(`${name}=`)) return raw.slice(name.length + 1).split(';')[0];
  }
  return undefined;
}

/** The cookie bag carrying a signed-in session token. */
export function sessionCookies(session: string): Cookies {
  return { [signInSessionCookieName()]: session };
}

/** A fresh session token for `email`, signed into `workspaceSlug`. */
export function mintSession(email = U1_EMAIL, workspaceSlug = 'acme'): Promise<string> {
  return mintSignInSessionToken(newSignInSessionClaims(email, workspaceSlug), SECRET);
}

/** POSTs a form as a signed-in `acme` session, optionally from a given `Origin`. */
export async function postAsSession(
  form: Record<string, string>,
  origin?: string,
): Promise<Response> {
  return POST(
    request({
      method: 'POST',
      cookies: sessionCookies(await mintSession()),
      ...(origin === undefined ? {} : { origin }),
      form,
    }),
  );
}

/** Sets the session secret and installs an in-memory directory built from `seed`. */
export function installDirectory(seed: MemoryDirectoryOptions): MemoryDirectory {
  vi.stubEnv('SESSION_SECRET', SECRET);
  const directory = createMemoryDirectory(seed);
  installTestDomains({ rbac: { directory, identify: () => Promise.resolve(null) } });
  return directory;
}

export function uninstallDirectory(): void {
  vi.unstubAllEnvs();
  clearApplicationContext();
}
