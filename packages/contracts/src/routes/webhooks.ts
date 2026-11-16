import type { ApiRoute } from './definition.js';
import { created, json, NO_CONTENT, ok } from './definition.js';
export const webhooksRoutes: readonly ApiRoute[] = [
  // §5.17 — run-outcome webhooks (N-3, issue #250, ADR-SDK-18-N3-250)
  {
    method: 'GET',
    path: '/api/webhooks',
    operationId: 'webhooks.list',
    tag: 'webhooks',
    feature: 'runs',
    summary: "List the workspace's webhooks (at most 10, unpaginated); the secret is never listed",
    success: ok(json('WebhookListResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/webhooks',
    operationId: 'webhooks.create',
    tag: 'webhooks',
    feature: 'runs',
    summary:
      'Register a webhook for terminal run outcomes. The URL must pass the egress policy; the ' +
      'whsec_ signing secret is returned once, in this answer',
    request: json('CreateWebhookRequestSchema'),
    success: created(json('CreateWebhookResponseSchema')),
  },

  {
    method: 'DELETE',
    path: '/api/webhooks/:id',
    operationId: 'webhooks.remove',
    tag: 'webhooks',
    feature: 'runs',
    summary: 'Remove a webhook, its pending deliveries and its signing secret',
    success: NO_CONTENT,
  },
];
