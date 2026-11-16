/**
 * Google ID tokens for service-to-service calls to Cloud Run services behind IAM. The metadata
 * server is link-local and `guardedFetch` refuses it by design, so this adapter uses
 * `google-auth-library`'s own transport.
 *
 * Deliberately not imported by `registry.ts`: `apps/web` imports the registry for discovery and
 * must not load the Google SDK. Only the gateway's composition root imports this file.
 */
import type { GoogleAuth } from 'google-auth-library';

import { TOKEN_REFRESH_MARGIN_MS } from './google-adc-token.js';

/** The slice of a `google-auth-library` ID-token client this adapter uses; tests inject a fake. */
export type IdTokenClient = {
  idTokenProvider: { fetchIdToken: (audience: string) => Promise<string> };
};

export type GoogleIdTokenSourceOptions = {
  /** Replaces the lazily loaded `GoogleAuth` client; called again after a failure. */
  readonly client?: () => Promise<IdTokenClient>;
  readonly now?: () => number;
};

/** Raised when no ID token can be minted; its text is fixed and never carries token or library text. */
export class IdTokenUnavailableError extends Error {
  constructor() {
    super('A Google ID token could not be obtained.');
    this.name = 'IdTokenUnavailableError';
  }
}

async function googleClient(): Promise<IdTokenClient> {
  const { GoogleAuth: Auth } = await import('google-auth-library');
  const auth: GoogleAuth = new Auth();
  return auth.getIdTokenClient('https://placeholder.invalid');
}

/** The `exp` claim in milliseconds, read without verifying the token; `undefined` if unreadable. */
function expiryOf(token: string): number | undefined {
  try {
    const payload = token.split('.')[1];
    if (payload === undefined) return undefined;
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const exp =
      typeof claims === 'object' && claims !== null && 'exp' in claims ? claims.exp : undefined;
    return typeof exp === 'number' ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export function createGoogleIdTokenSource(
  options: GoogleIdTokenSourceOptions = {},
): (audience: string) => Promise<string> {
  const newClient = options.client ?? googleClient;
  const now = options.now ?? Date.now;
  let client: Promise<IdTokenClient> | undefined;
  const cached = new Map<string, { readonly token: string; readonly refreshAt: number }>();
  const inflight = new Map<string, Promise<string>>();

  async function fetchToken(audience: string): Promise<string> {
    try {
      client ??= newClient();
      const { idTokenProvider } = await client;
      const token = await idTokenProvider.fetchIdToken(audience);
      if (typeof token !== 'string' || token.length === 0) throw new IdTokenUnavailableError();
      const expiry = expiryOf(token);
      // Without a readable expiry the token is not cached here.
      if (expiry === undefined) cached.delete(audience);
      else cached.set(audience, { token, refreshAt: expiry - TOKEN_REFRESH_MARGIN_MS });
      return token;
    } catch (error) {
      // A failed client load must not be remembered; the next call tries again.
      client = undefined;
      // The library's message is dropped on purpose: only fixed text may reach a log or a client.
      throw error instanceof IdTokenUnavailableError ? error : new IdTokenUnavailableError();
    }
  }

  return (audience) => {
    const hit = cached.get(audience);
    if (hit !== undefined && now() < hit.refreshAt) return Promise.resolve(hit.token);
    let pending = inflight.get(audience);
    if (pending === undefined) {
      pending = fetchToken(audience).finally(() => inflight.delete(audience));
      inflight.set(audience, pending);
    }
    return pending;
  };
}
