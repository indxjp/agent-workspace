import type { ApiRoute } from './definition.js';
import { json, ok } from './definition.js';
export const observabilityRoutes: readonly ApiRoute[] = [
  // §5.14 — metrics and audit
  {
    method: 'GET',
    path: '/api/metrics',
    operationId: 'observability.metrics.recentRuns',
    tag: 'observability',
    feature: 'runs',
    summary: 'Recent run telemetry',
    success: ok(json('RunTelemetryListResponseSchema')),
  },

  {
    method: 'GET',
    path: '/api/audit-events',
    operationId: 'observability.audit.list',
    tag: 'observability',
    feature: 'core',
    summary: 'List audit events',
    success: ok(json('AuditEventListResponseSchema')),
  },
];
