import type { ApiRoute } from './definition.js';
import { created, json } from './definition.js';
export const tokensRoutes: readonly ApiRoute[] = [
  {
    method: 'POST',
    path: '/api/tokens',
    operationId: 'tokens.mint',
    tag: 'tokens',
    feature: 'core',
    summary: 'Mint a short-lived browser token',
    request: json('MintTokenRequestSchema'),
    success: created(json('MintTokenResponseSchema')),
  },
];
