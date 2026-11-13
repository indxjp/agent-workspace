import type { ApiRoute } from './definition.js';
import { json, NO_CONTENT, ok, UNDESCRIBED } from './definition.js';
export const connectorsRoutes: readonly ApiRoute[] = [
  // §5.8 — connectors
  {
    method: 'GET',
    path: '/api/connectors',
    operationId: 'connectors.list',
    tag: 'connectors',
    feature: 'connectors',
    summary: 'List MCP connectors',
    success: ok(json('ConnectorListResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/connectors',
    operationId: 'connectors.create',
    tag: 'connectors',
    feature: 'connectors',
    summary: 'Create a connector, or test a draft without saving it',
    request: UNDESCRIBED,
    success: [
      { status: 200, body: json('TestConnectionOutcomeSchema') },
      { status: 201, body: json('ConnectorResourceSchema') },
    ],
  },

  {
    method: 'GET',
    path: '/api/connectors/:id',
    operationId: 'connectors.get',
    tag: 'connectors',
    feature: 'connectors',
    summary: 'Read one connector',
    success: ok(json('ConnectorResourceSchema')),
  },

  {
    method: 'PATCH',
    path: '/api/connectors/:id',
    operationId: 'connectors.rotateCredential',
    tag: 'connectors',
    feature: 'connectors',
    summary: "Replace a connector's credential",
    request: UNDESCRIBED,
    success: ok(json('ConnectorResourceSchema')),
  },

  {
    method: 'DELETE',
    path: '/api/connectors/:id',
    operationId: 'connectors.remove',
    tag: 'connectors',
    feature: 'connectors',
    summary: 'Delete a connector',
    success: NO_CONTENT,
  },

  {
    method: 'POST',
    path: '/api/connectors/:id/test-connection',
    operationId: 'connectors.test',
    tag: 'connectors',
    feature: 'connectors',
    summary: 'Test a saved connector',
    success: ok(json('TestConnectionOutcomeSchema')),
  },
];
