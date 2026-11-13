/**
 * The Application Default Credentials {@link TokenSource}. The metadata server is link-local and
 * `guardedFetch` refuses it by design, so this adapter uses `google-auth-library`'s own transport.
 *
 * Deliberately not imported by `registry.ts`: `apps/web` imports the registry for discovery and
 * must not load the Google SDK. Only the gateway's composition root imports this file.
 */
import type { GoogleAuth } from 'google-auth-library';

import { ModelCredentialUnavailableError, type TokenSource } from '../types.js';

/** A cached token is refreshed this long before it expires. */
export const TOKEN_REFRESH_MARGIN_MS = 300_000;

/** The slice of a `google-auth-library` client this adapter uses; tests inject a fake. */
export type AdcClient = {
  getAccessToken(): Promise<{ token?: string | null }>;
  readonly credentials: { readonly expiry_date?: number | null };
};

export type GoogleAdcTokenSourceOptions = {
  /** Replaces the lazily loaded `GoogleAuth` client; called again after `invalidate()`. */
  readonly client?: () => Promise<AdcClient>;
  readonly now?: () => number;
};

async function googleClient(): Promise<AdcClient> {
  const { GoogleAuth: Auth } = await import('google-auth-library');
  const auth: GoogleAuth = new Auth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    clientOptions: { eagerRefreshThresholdMillis: TOKEN_REFRESH_MARGIN_MS },
  });
  return auth.getClient();
}

export function createGoogleAdcTokenSource(options: GoogleAdcTokenSourceOptions = {}): TokenSource {
  const newClient = options.client ?? googleClient;
  const now = options.now ?? Date.now;
  let client: Promise<AdcClient> | undefined;
  let cached: { readonly token: string; readonly refreshAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  async function fetchToken(): Promise<string> {
    try {
      client ??= newClient();
      const adc = await client;
      const { token } = await adc.getAccessToken();
      if (typeof token !== 'string' || token.length === 0) {
        throw new ModelCredentialUnavailableError();
      }
      const expiry = adc.credentials.expiry_date;
      // Without a known expiry the token is not cached here; the library still caches its own.
      cached =
        typeof expiry === 'number'
          ? { token, refreshAt: expiry - TOKEN_REFRESH_MARGIN_MS }
          : undefined;
      return token;
    } catch (error) {
      // A failed client load must not be remembered; the next call tries again.
      client = undefined;
      // The library's message is dropped on purpose: only fixed text may reach a log or a client.
      throw error instanceof ModelCredentialUnavailableError
        ? error
        : new ModelCredentialUnavailableError();
    }
  }

  return {
    accessToken() {
      if (cached !== undefined && now() < cached.refreshAt) return Promise.resolve(cached.token);
      inflight ??= fetchToken().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
    invalidate() {
      cached = undefined;
      // A new client has no token of its own, so the next fetch really reaches the identity.
      client = undefined;
    },
  };
}
