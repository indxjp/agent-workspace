import type { ApiRoute } from './definition.js';
import { json, ok } from './definition.js';
export const workspaceSelectionRoutes: readonly ApiRoute[] = [
  {
    method: 'GET',
    path: '/api/sharing-policies',
    operationId: 'workspaces.sharingPolicy.get',
    tag: 'workspaces',
    feature: 'sharing',
    summary: "Read the workspace's sharing policy",
    success: ok(json('SharingPolicySchema')),
  },

  {
    method: 'PATCH',
    path: '/api/sharing-policies',
    operationId: 'workspaces.sharingPolicy.set',
    tag: 'workspaces',
    feature: 'sharing',
    summary: "Change the workspace's sharing policy",
    request: json('SharingPolicySchema'),
    success: ok(json('SharingPolicySchema')),
  },
];
