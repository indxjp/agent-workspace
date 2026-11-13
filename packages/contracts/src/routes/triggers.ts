import type { ApiRoute } from './definition.js';
import { created, json, ok } from './definition.js';
export const triggersRoutes: readonly ApiRoute[] = [
  // ADR-0144 — inbound triggers
  {
    method: 'GET',
    path: '/api/triggers',
    operationId: 'triggers.list',
    tag: 'triggers',
    feature: 'triggers',
    summary: 'List triggers',
    success: ok(json('TriggerListResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/triggers',
    operationId: 'triggers.create',
    tag: 'triggers',
    feature: 'triggers',
    summary: 'Create a webhook or schedule trigger; a webhook URL secret is returned once',
    request: json('CreateTriggerRequestSchema'),
    success: created(json('CreateTriggerResponseSchema')),
  },

  {
    method: 'GET',
    path: '/api/triggers/:id',
    operationId: 'triggers.get',
    tag: 'triggers',
    feature: 'triggers',
    summary: 'Read one trigger',
    success: ok(json('TriggerResponseSchema')),
  },

  {
    method: 'PATCH',
    path: '/api/triggers/:id',
    operationId: 'triggers.update',
    tag: 'triggers',
    feature: 'triggers',
    summary: "Change a trigger's name, prompt template, enabled flag or Zoom secret token",
    request: json('UpdateTriggerRequestSchema'),
    success: ok(json('TriggerResponseSchema')),
  },

  {
    method: 'DELETE',
    path: '/api/triggers/:id',
    operationId: 'triggers.remove',
    tag: 'triggers',
    feature: 'triggers',
    summary: 'Delete a trigger and its delivery records',
    success: ok(json('TriggerResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/triggers/:id/secret',
    operationId: 'triggers.rotateSecret',
    tag: 'triggers',
    feature: 'triggers',
    summary: "Rotate a webhook trigger's URL secret; the new secret is returned once",
    success: created(json('TriggerSecretResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/triggers/:id/fire/:secret',
    operationId: 'triggers.fire',
    tag: 'triggers',
    feature: 'triggers',
    summary:
      'Fire a webhook trigger: the body is the {{body}} of its prompt and a run starts as the ' +
      'trigger owner in a new session (202). The URL secret is the authentication and travels in ' +
      'the path, so it can appear in access logs of a proxy or CDN: rotate it if one may have ' +
      'leaked. Every miss answers one 404 trigger_not_found. A Microsoft Graph validationToken ' +
      'query parameter is echoed as text/plain, and Zoom endpoint.url_validation is answered with ' +
      'the token and its HMAC (200); neither starts a run.',
    request: { kind: 'binary' },
    success: [
      { status: 202, body: json('RunResponseSchema') },
      { status: 200, body: json('ZoomUrlValidationResponseSchema') },
    ],
    security: 'none',
  },
];
