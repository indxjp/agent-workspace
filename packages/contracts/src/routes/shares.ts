import type { ApiRoute } from './definition.js';
import { created, json, NO_CONTENT, ok, UNDESCRIBED } from './definition.js';
export const sharesRoutes: readonly ApiRoute[] = [
  // §5.13 — shares
  {
    method: 'GET',
    path: '/api/shares',
    operationId: 'shares.list',
    tag: 'shares',
    feature: 'sharing',
    summary: 'List shares',
    success: ok(json('ShareListResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/shares',
    operationId: 'shares.publish',
    tag: 'shares',
    feature: 'sharing',
    summary: 'Publish a session as a share',
    request: UNDESCRIBED,
    success: created(json('ShareResourceSchema')),
  },

  {
    method: 'DELETE',
    path: '/api/shares/:id',
    operationId: 'shares.revoke',
    tag: 'shares',
    feature: 'sharing',
    summary: 'Revoke a share',
    success: NO_CONTENT,
  },
];
