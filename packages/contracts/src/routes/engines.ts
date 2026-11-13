import type { ApiRoute } from './definition.js';
import { json, ok } from './definition.js';
export const enginesRoutes: readonly ApiRoute[] = [
  // §5.15 — engines
  {
    method: 'GET',
    path: '/api/engines',
    operationId: 'engines.list',
    tag: 'engines',
    feature: 'core',
    summary: 'List the engines this deployment knows',
    success: ok(json('EngineListResponseSchema')),
  },
];
