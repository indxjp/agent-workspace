import type { ApiRoute } from './definition.js';
import { created, json, NO_CONTENT, ok, UNDESCRIBED } from './definition.js';
export const modelsRoutes: readonly ApiRoute[] = [
  // §5.3 — model connections and models
  {
    method: 'GET',
    path: '/api/model-connections',
    operationId: 'models.connections.list',
    tag: 'models',
    feature: 'core',
    summary: 'List model connections',
    success: ok(json('ModelConnectionListResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/model-connections',
    operationId: 'models.connections.create',
    tag: 'models',
    feature: 'core',
    summary: 'Create a model connection',
    request: UNDESCRIBED,
    success: created(json('ModelConnectionResourceSchema')),
  },

  {
    method: 'GET',
    path: '/api/model-connections/:id',
    operationId: 'models.connections.get',
    tag: 'models',
    feature: 'core',
    summary: 'Read one model connection',
    success: ok(json('ModelConnectionResourceSchema')),
  },

  {
    method: 'PATCH',
    path: '/api/model-connections/:id',
    operationId: 'models.connections.update',
    tag: 'models',
    feature: 'core',
    summary: 'Update a model connection',
    request: UNDESCRIBED,
    success: ok(json('ModelConnectionResourceSchema')),
  },

  {
    method: 'DELETE',
    path: '/api/model-connections/:id',
    operationId: 'models.connections.remove',
    tag: 'models',
    feature: 'core',
    summary: 'Delete a model connection',
    success: ok(json('DeleteModelConnectionResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/model-connections/:id/credential',
    operationId: 'models.connections.rotateCredential',
    tag: 'models',
    feature: 'core',
    summary: "Replace a model connection's credential",
    request: UNDESCRIBED,
    success: NO_CONTENT,
  },

  {
    method: 'POST',
    path: '/api/model-connections/:id/test',
    operationId: 'models.connections.test',
    tag: 'models',
    feature: 'core',
    summary: 'Probe a model connection; a failed probe answers 502 with the outcome',
    success: [
      { status: 200, body: json('ModelConnectionTestOutcomeSchema') },
      { status: 502, body: json('ModelConnectionTestOutcomeSchema') },
    ],
  },

  {
    method: 'GET',
    path: '/api/models',
    operationId: 'models.discover',
    tag: 'models',
    feature: 'core',
    summary: 'Discover the models every connection offers',
    success: ok(json('DiscoveredModelsResponseSchema')),
  },
];
