import type { ApiRoute } from './definition.js';
import { json, ok } from './definition.js';
export const meRoutes: readonly ApiRoute[] = [
  // §3 / §5.1 — identity, workspaces, tokens
  {
    method: 'GET',
    path: '/api/me',
    operationId: 'me',
    tag: 'me',
    feature: 'core',
    summary: 'Read the calling principal, its workspace and role',
    success: ok(json('MeResponseSchema')),
  },
];
