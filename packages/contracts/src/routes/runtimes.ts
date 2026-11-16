import type { ApiRoute } from './definition.js';
import { created, json, NO_CONTENT, ok, UNDESCRIBED } from './definition.js';
export const runtimesRoutes: readonly ApiRoute[] = [
  // §5.4 — runtimes
  {
    method: 'GET',
    path: '/api/runtime-profiles',
    operationId: 'runtimes.profiles.list',
    tag: 'runtimes',
    feature: 'core',
    summary: 'List runtime profiles',
    success: ok(json('RuntimeProfileListResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/runtime-profiles',
    operationId: 'runtimes.profiles.create',
    tag: 'runtimes',
    feature: 'core',
    summary: 'Create a runtime profile',
    request: UNDESCRIBED,
    success: created(json('RuntimeProfileResourceSchema')),
  },

  {
    method: 'GET',
    path: '/api/runtime-profiles/:id',
    operationId: 'runtimes.profiles.get',
    tag: 'runtimes',
    feature: 'core',
    summary: 'Read one runtime profile',
    success: ok(json('RuntimeProfileResourceSchema')),
  },

  {
    method: 'PATCH',
    path: '/api/runtime-profiles/:id',
    operationId: 'runtimes.profiles.update',
    tag: 'runtimes',
    feature: 'core',
    summary: 'Update a runtime profile',
    request: UNDESCRIBED,
    success: ok(json('RuntimeProfileResourceSchema')),
  },

  {
    method: 'DELETE',
    path: '/api/runtime-profiles/:id',
    operationId: 'runtimes.profiles.remove',
    tag: 'runtimes',
    feature: 'core',
    summary: 'Delete a runtime profile',
    success: NO_CONTENT,
  },

  {
    method: 'GET',
    path: '/api/runtime-connections',
    operationId: 'runtimes.connections.list',
    tag: 'runtimes',
    feature: 'core',
    summary: 'List runtime connections',
    success: ok(json('RuntimeConnectionListResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/runtime-connections',
    operationId: 'runtimes.connections.create',
    tag: 'runtimes',
    feature: 'core',
    summary: 'Create a runtime connection',
    request: UNDESCRIBED,
    success: created(json('RuntimeConnectionResourceSchema')),
  },

  {
    method: 'POST',
    path: '/api/runtimes/:id',
    operationId: 'runtimes.test',
    tag: 'runtimes',
    feature: 'core',
    summary: 'Test a runtime driver (the id is the literal `test`)',
    request: UNDESCRIBED,
    success: ok(UNDESCRIBED),
  },

  {
    method: 'GET',
    path: '/api/setup/runtime-detect',
    operationId: 'runtimes.detect',
    tag: 'runtimes',
    feature: 'core',
    summary: 'Detect which runtime drivers the host can run',
    success: ok(UNDESCRIBED),
    security: 'none',
  },
];
