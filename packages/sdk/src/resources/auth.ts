import {
  CliTokenResponseSchema,
  DeviceAuthorizationResponseSchema,
  type CliTokenResponse,
  type DeviceAuthorizationResponse,
} from '@indx-workspace/contracts/cli-auth';
import {
  ID_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,
  TokenExchangeResponseSchema,
  type TokenExchangeRequest,
  type TokenExchangeResponse,
} from '@indx-workspace/contracts/token-exchange';
import { z } from 'zod';

import type { HttpClient, RequestOptions } from '../http.js';

const NoContentSchema = z.null();

/** What `aw.auth.exchange` trades: an `app-backend` endpoint client's pair and a person's ID token. */
export interface TokenExchangeInput {
  /** The `app-backend` endpoint client's id. */
  readonly clientId: string;
  /** That client's confidential secret (`POST /api/endpoint-clients/:id/secret`). */
  readonly clientSecret: string;
  /** The signed-in person's OIDC ID token, issued by the deployment's own `OIDC_ISSUER_URL`. */
  readonly idToken: string;
}

/**
 * RFC 6749 §2.3.1 `client_secret_basic`: each half is form-urlencoded before the two are joined and
 * base64'd, so a `:` or a non-ASCII character in either survives the server's split.
 */
function basicCredentials(clientId: string, clientSecret: string): string {
  const encode = (value: string) => encodeURIComponent(value).replace(/%20/gu, '+');
  return `Basic ${btoa(`${encode(clientId)}:${encode(clientSecret)}`)}`;
}

/**
 * `/api/auth/cli-*` — issue #242 (SDK-10, S-22): sign a person in from a terminal with an OAuth
 * 2.0 device authorization grant (RFC 8628), and sign them out again. ADR-0083.
 *
 * `startDevice` and `pollToken` need no credential: call them on a client built with
 * `{ kind: 'session' }`, which sends none. A client of any other kind sends its bearer with every
 * request, these two included, so an API key or token would travel to unauthenticated routes that
 * have no use for it. The token `pollToken` returns is what a `{ kind: 'user-token', token }`
 * client presents afterwards; `revoke` must be called on such a client. Every request, these
 * included, states the contracts version it was built against (ADR-0078).
 *
 * `exchange` (ADR-0161) is the app-backend half: a backend trades the signed-in person's ID token
 * for a short-lived `awo_live_` access token, which a `{ kind: 'access-token', token }` client then
 * presents. It too belongs on a `{ kind: 'session' }` client, since it authenticates with the
 * endpoint client's own pair, and it runs only on a server: the client secret never reaches a
 * browser.
 */
export class AuthClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  /** Start a sign-in: a device code to poll with, and a user code for the person to approve. */
  public startDevice(options: RequestOptions = {}): Promise<DeviceAuthorizationResponse> {
    return this.#http.json({
      operation: 'auth.startDevice',
      method: 'POST',
      path: '/api/auth/cli-device',
      body: {},
      expect: [200],
      schema: DeviceAuthorizationResponseSchema,
      signal: options.signal,
    });
  }

  /**
   * Poll once. Until the person answers, this throws an `ApiProblemError` whose `code` is
   * `authorization_pending` or `slow_down` (poll again after the interval) or `access_denied`,
   * `expired_token` or `invalid_grant` (stop).
   */
  public pollToken(deviceCode: string, options: RequestOptions = {}): Promise<CliTokenResponse> {
    return this.#http.json({
      operation: 'auth.pollToken',
      method: 'POST',
      path: '/api/auth/cli-token',
      body: { deviceCode },
      expect: [200],
      schema: CliTokenResponseSchema,
      signal: options.signal,
    });
  }

  /**
   * Exchange the signed-in person's OIDC ID token for an access token of an `app-backend` endpoint
   * client (ADR-0161): `POST /api/auth/token-exchange` with RFC 8693's fields as JSON and the client
   * pair as `Authorization: Basic`, never in the body. The token lasts at most
   * `TOKEN_EXCHANGE_TTL_SECONDS` (300 s) and has no refresh token; cache one per person for its
   * `expires_in` and exchange again with a fresh ID token after. It acts as that person within the
   * client's binding: start runs on the client's bound agents the person may run, read and
   * interrupt the runs the person can see, and read `me`.
   *
   * A refusal throws an `ApiProblemError` whose `code` is one of `TOKEN_EXCHANGE_PROBLEM_CODES`
   * (`invalid_client`, `subject_token_invalid`, `subject_not_member`, …). Neither the ID token nor
   * the secret is ever put in an error message.
   */
  public exchange(
    input: TokenExchangeInput,
    options: RequestOptions = {},
  ): Promise<TokenExchangeResponse> {
    const body: TokenExchangeRequest = {
      grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
      subject_token: input.idToken,
      subject_token_type: ID_TOKEN_TYPE,
    };
    return this.#http.json({
      operation: 'auth.exchange',
      method: 'POST',
      path: '/api/auth/token-exchange',
      body,
      headers: { authorization: basicCredentials(input.clientId, input.clientSecret) },
      expect: [200],
      schema: TokenExchangeResponseSchema,
      signal: options.signal,
    });
  }

  /** Sign out: revoke this client's own user token on the server. */
  public async revoke(options: RequestOptions = {}): Promise<void> {
    await this.#http.json({
      operation: 'auth.revoke',
      method: 'DELETE',
      path: '/api/auth/cli-token',
      expect: [204],
      schema: NoContentSchema,
      signal: options.signal,
    });
  }
}
