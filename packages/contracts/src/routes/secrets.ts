import type { ApiRoute } from './definition.js';
import { created, json, NO_CONTENT, ok, UNDESCRIBED } from './definition.js';
export const secretsRoutes: readonly ApiRoute[] = [
  // §5.5 — secrets
  {
    method: 'GET',
    path: '/api/secrets',
    operationId: 'secrets.list',
    tag: 'secrets',
    feature: 'core',
    summary: 'List secrets (names only)',
    success: ok(json('SecretListResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/secrets',
    operationId: 'secrets.create',
    tag: 'secrets',
    feature: 'core',
    summary: 'Store a secret',
    request: UNDESCRIBED,
    success: created(json('SecretResourceSchema')),
  },

  {
    method: 'PUT',
    path: '/api/secrets/:id',
    operationId: 'secrets.replace',
    tag: 'secrets',
    feature: 'core',
    summary: "Replace a secret's value",
    request: UNDESCRIBED,
    success: ok(json('SecretResourceSchema')),
  },

  {
    method: 'DELETE',
    path: '/api/secrets/:id',
    operationId: 'secrets.remove',
    tag: 'secrets',
    feature: 'core',
    summary: 'Delete a secret nothing references (`409 secret_in_use` names the referrers)',
    success: NO_CONTENT,
  },
];
