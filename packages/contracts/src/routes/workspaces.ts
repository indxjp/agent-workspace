import type { ApiRoute } from './definition.js';
import { created, json, ok, UNDESCRIBED } from './definition.js';
export const workspacesRoutes: readonly ApiRoute[] = [
  {
    method: 'GET',
    path: '/api/workspaces',
    operationId: 'workspaces.list',
    tag: 'workspaces',
    feature: 'core',
    summary: 'List the workspaces the caller belongs to',
    success: ok(json('WorkspaceListResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/workspaces',
    operationId: 'workspaces.create',
    tag: 'workspaces',
    feature: 'core',
    summary: 'Create a workspace',
    request: UNDESCRIBED,
    success: created(json('WorkspaceMembershipResponseSchema')),
  },

  {
    method: 'GET',
    path: '/api/workspaces/:id',
    operationId: 'workspaces.get',
    tag: 'workspaces',
    feature: 'core',
    summary: 'Read one workspace and the caller membership in it',
    success: ok(json('WorkspaceMembershipResponseSchema')),
  },

  {
    method: 'PATCH',
    path: '/api/workspaces/:id',
    operationId: 'workspaces.update',
    tag: 'workspaces',
    feature: 'core',
    summary: 'Rename a workspace',
    request: UNDESCRIBED,
    success: ok(json('WorkspaceResponseSchema')),
  },

  {
    method: 'GET',
    path: '/api/workspaces/:id/features',
    operationId: 'workspaces.features.list',
    tag: 'workspaces',
    feature: 'core',
    summary: 'List the features of a workspace and whether each is on',
    success: ok(json('WorkspaceFeaturesSchema')),
  },

  {
    method: 'PUT',
    path: '/api/workspaces/:id/features',
    operationId: 'workspaces.features.set',
    tag: 'workspaces',
    feature: 'core',
    summary: 'Replace the set of features a workspace has switched off (Owner only)',
    request: json('UpdateWorkspaceFeaturesRequestSchema'),
    success: ok(json('WorkspaceFeaturesSchema')),
  },

  {
    method: 'POST',
    path: '/api/auth/workspace',
    operationId: 'workspaces.select',
    tag: 'workspaces',
    feature: 'core',
    summary: "Switch the session's workspace",
    request: json('WorkspaceSwitchRequestSchema'),
    success: ok(json('WorkspaceSwitchResponseSchema')),
    security: 'session-cookie',
  },

  {
    method: 'POST',
    path: '/api/auth/cli-workspace',
    operationId: 'workspaces.selectForUserToken',
    tag: 'workspaces',
    feature: 'core',
    summary: "Move the CLI's user token to another of the person's workspaces",
    request: json('WorkspaceSwitchRequestSchema'),
    success: ok(json('WorkspaceSwitchResponseSchema')),
    security: 'user-token',
  },
];
