import type { ApiRoute } from './definition.js';
import { json, NO_CONTENT, ok } from './definition.js';
export const authRoutes: readonly ApiRoute[] = [
  {
    method: 'POST',
    path: '/api/auth/cli-device',
    operationId: 'auth.startDevice',
    tag: 'auth',
    feature: 'core',
    summary: 'Start a device authorization for `aw login` (RFC 8628)',
    success: ok(json('DeviceAuthorizationResponseSchema')),
    security: 'none',
  },

  {
    method: 'POST',
    path: '/api/auth/cli-token',
    operationId: 'auth.pollToken',
    tag: 'auth',
    feature: 'core',
    summary: 'Poll with the device code; the user token once the person approved',
    request: json('CliTokenRequestSchema'),
    success: ok(json('CliTokenResponseSchema')),
    security: 'none',
  },

  {
    method: 'DELETE',
    path: '/api/auth/cli-token',
    operationId: 'auth.revoke',
    tag: 'auth',
    feature: 'core',
    summary: 'Revoke the presented user token (`aw logout`)',
    success: NO_CONTENT,
    security: 'user-token',
  },

  {
    method: 'POST',
    path: '/api/auth/token-exchange',
    operationId: 'auth.exchange',
    tag: 'auth',
    feature: 'core',
    summary:
      "Exchange the signed-in person's OIDC ID token for a short-lived access token of an app-backend endpoint client (ADR-0161)",
    request: json('TokenExchangeRequestSchema'),
    success: ok(json('TokenExchangeResponseSchema')),
    security: 'none',
  },
];
