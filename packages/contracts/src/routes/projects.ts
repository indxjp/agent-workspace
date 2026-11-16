import type { ApiRoute } from './definition.js';
import { created, json, ok, UNDESCRIBED } from './definition.js';
export const projectsRoutes: readonly ApiRoute[] = [
  // §5.10 — projects
  {
    method: 'GET',
    path: '/api/projects',
    operationId: 'projects.list',
    tag: 'projects',
    feature: 'projects',
    summary: 'List projects',
    success: ok(json('ProjectListResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/projects',
    operationId: 'projects.create',
    tag: 'projects',
    feature: 'projects',
    summary: 'Create a project',
    request: UNDESCRIBED,
    success: created(json('ProjectResourceSchema')),
  },

  {
    method: 'GET',
    path: '/api/projects/:id',
    operationId: 'projects.get',
    tag: 'projects',
    feature: 'projects',
    summary: 'Read one project',
    success: ok(json('ProjectResourceSchema')),
  },

  {
    method: 'PATCH',
    path: '/api/projects/:id',
    operationId: 'projects.update',
    tag: 'projects',
    feature: 'projects',
    summary: 'Update a project',
    request: UNDESCRIBED,
    success: ok(json('ProjectResourceSchema')),
  },

  {
    method: 'POST',
    path: '/api/projects/:id/archive',
    operationId: 'projects.archive',
    tag: 'projects',
    feature: 'projects',
    summary: 'Archive a project',
    success: ok(json('ProjectResourceSchema')),
  },

  {
    method: 'POST',
    path: '/api/projects/:id/restore',
    operationId: 'projects.restore',
    tag: 'projects',
    feature: 'projects',
    summary: 'Restore an archived project',
    success: ok(json('ProjectResourceSchema')),
  },

  {
    method: 'POST',
    path: '/api/projects/:id/sessions',
    operationId: 'projects.startSession',
    tag: 'projects',
    feature: 'projects',
    summary: 'Start a session in a project, or adopt an existing one',
    request: UNDESCRIBED,
    success: [
      {
        status: 200,
        body: json('ProjectSessionResponseSchema', 'ProjectSessionMoveResponseSchema'),
      },
      { status: 201, body: json('ProjectSessionResponseSchema') },
    ],
  },
];
