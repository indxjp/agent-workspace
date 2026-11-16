import type { ApiRoute } from './definition.js';
import { created, json, ok } from './definition.js';
export const toolBundleRoutes: readonly ApiRoute[] = [
  // ADR-0118 TS1 — code-tool bundles, content-addressed
  {
    method: 'POST',
    path: '/api/tool-bundles',
    operationId: 'toolBundles.upload',
    tag: 'tool-bundles',
    feature: 'core',
    summary: 'Store a code-tool bundle by its SHA-256 (`200` when the workspace already held it)',
    request: json('UploadToolBundleRequestSchema'),
    success: [
      ...created(json('UploadToolBundleResponseSchema')),
      ...ok(json('UploadToolBundleResponseSchema')),
    ],
  },

  {
    method: 'GET',
    path: '/api/tool-bundles/:digest',
    operationId: 'toolBundles.get',
    tag: 'tool-bundles',
    feature: 'core',
    summary: 'Read the address and size of a stored code-tool bundle',
    success: ok(json('ToolBundleResponseSchema')),
  },
];
