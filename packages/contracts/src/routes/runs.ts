import type { ApiRoute } from './definition.js';
import { json, NO_CONTENT, ok, UNDESCRIBED } from './definition.js';
export const runsRoutes: readonly ApiRoute[] = [
  // §5.12 — runs and the event stream
  {
    method: 'POST',
    path: '/api/agents/:id/runs',
    operationId: 'runs.start',
    tag: 'runs',
    feature: 'core',
    summary: 'Start a run of an agent',
    request: json('StartRunRequestSchema'),
    headers: [
      {
        name: 'Idempotency-Key',
        required: false,
        description:
          'Makes a retried start safe (S-6, ADR-0151, spec §5.12): 1–255 characters after ' +
          'trimming, scoped to the calling principal. The same key with the same request returns ' +
          'the run the first start queued; the same key with a different request answers ' +
          '`409 run_idempotency_conflict`; a blank or longer key answers ' +
          '`400 invalid_idempotency_key`.',
      },
    ],
    success: [{ status: 202, body: json('StartRunResponseSchema') }],
  },

  {
    method: 'GET',
    path: '/api/runs',
    operationId: 'runs.list',
    tag: 'runs',
    feature: 'runs',
    summary: 'List runs',
    success: ok(json('RunListResponseSchema')),
  },

  {
    method: 'GET',
    path: '/api/runs/:id',
    operationId: 'runs.get',
    tag: 'runs',
    feature: 'core',
    summary:
      'Read one run, with its child runs (at most 16, oldest first) and treeCost, the read-time ' +
      'sum of cost over the run and its children (ADR-0104)',
    success: ok(json('RunDetailResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/runs/:id',
    operationId: 'runs.revokeTokensDeprecated',
    tag: 'runs',
    feature: 'core',
    summary: 'Revoke gateway tokens (deprecated alias of the revoke-tokens route)',
    request: UNDESCRIBED,
    success: ok(json('RevokeRunTokensResponseSchema')),
    deprecated: true,
  },

  {
    method: 'GET',
    path: '/api/runs/:id/events',
    operationId: 'runs.events',
    tag: 'runs',
    feature: 'core',
    summary: "Follow a run's events (resume with `Last-Event-ID`)",
    success: ok({
      kind: 'event-stream',
      frames: [
        'RunStatusEventDataSchema',
        'RunWarningEventDataSchema',
        'AgentFrameSchema',
        'RunFailedFrameDataSchema',
        'StreamResetFrameDataSchema',
      ],
    }),
  },

  {
    method: 'POST',
    path: '/api/runs/:id/interrupt',
    operationId: 'runs.interrupt',
    tag: 'runs',
    feature: 'core',
    summary: 'Interrupt a run',
    success: ok(json('InterruptRunResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/runs/:id/approval',
    operationId: 'runs.approval',
    tag: 'runs',
    feature: 'core',
    summary:
      'Approve or reject the tool call a paused run is waiting on (starts a continuation run; `409` once decided)',
    request: json('RunApprovalRequestSchema'),
    success: [{ status: 202, body: json('RunApprovalResponseSchema') }],
  },

  {
    method: 'POST',
    path: '/api/runs/:id/feedback',
    operationId: 'runs.feedback',
    tag: 'runs',
    feature: 'runs',
    summary: 'Rate a run (thumbs up or down)',
    request: json('RunFeedbackRequestSchema'),
    success: NO_CONTENT,
  },

  {
    method: 'POST',
    path: '/api/runs/:id/revoke-tokens',
    operationId: 'runs.revokeTokens',
    tag: 'runs',
    feature: 'core',
    summary: "Revoke a run's gateway tokens",
    request: UNDESCRIBED,
    success: ok(json('RevokeRunTokensResponseSchema')),
  },
];
