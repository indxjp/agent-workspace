import {
  MintTokenResponseSchema,
  type MintTokenResponse,
  type TokenScope,
} from '@indx-workspace/contracts/tokens';

import type { HttpClient, RequestOptions } from '../http.js';

/** {@link TokensClient.mint}'s options: the ordinary per-call ones, plus §3.1's TTL override. */
export interface MintTokenOptions extends RequestOptions {
  /** Seconds until the token expires; omit for the server's default (300). Bounded 60–3600. */
  readonly ttlSeconds?: number;
}

/**
 * `/api/tokens` — issue #236 (SDK-04, S-1): mint a short-lived, run- or session-scoped bearer for
 * a customer's own frontend. Minting is a backend operation — `auth: { kind: 'api-key' }` or
 * `{ kind: 'session' }`, Owner/Admin/Builder — and its result is what a frontend then presents as
 * `auth: { kind: 'browser-token', token }`. A browser token cannot mint another one: `tokens` is
 * in no scope's grammar, so calling this with a browser-token client answers `403
 * token_out_of_scope`.
 */
export class TokensClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  /** Mint a token scoped to `scope`. Refused for a target the caller may not itself reach. */
  public mint(scope: TokenScope, options: MintTokenOptions = {}): Promise<MintTokenResponse> {
    return this.#http.json({
      operation: 'tokens.mint',
      method: 'POST',
      path: '/api/tokens',
      body:
        options.ttlSeconds === undefined ? { scope } : { scope, ttlSeconds: options.ttlSeconds },
      expect: [201],
      schema: MintTokenResponseSchema,
      signal: options.signal,
    });
  }
}
