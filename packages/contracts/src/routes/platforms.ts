import type { ApiRoute } from './definition.js';
import { BINARY, json, ok } from './definition.js';
export const platformsRoutes: readonly ApiRoute[] = [
  // §5.16 — platforms
  {
    method: 'GET',
    path: '/api/platforms',
    operationId: 'platforms.list',
    tag: 'platforms',
    feature: 'core',
    summary: 'List the agent platforms an agent can be exported to',
    success: ok(json('PlatformListResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/agents/:id/platform-exports',
    operationId: 'platforms.export',
    tag: 'platforms',
    feature: 'core',
    summary: 'Export a saved version of an agent for one platform, with the verdict report',
    request: json('PlatformExportRequestSchema'),
    success: ok(json('PlatformExportResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/agents/:id/platform-archives',
    operationId: 'platforms.exportArchive',
    tag: 'platforms',
    feature: 'core',
    summary: 'The same export as a POSIX tar archive',
    request: json('PlatformExportRequestSchema'),
    success: ok(BINARY),
  },
];
