import {
  CliTokenResponseSchema,
  DeviceAuthorizationResponseSchema,
  type CliTokenResponse,
  type DeviceAuthorizationResponse,
} from '@indx-workspace/contracts/cli-auth';
import { z } from 'zod';

import type { HttpClient, RequestOptions } from '../http.js';

const NoContentSchema = z.null();

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
