import type { RouteDeclaration } from '../inventory-support.js';
export const routes: readonly RouteDeclaration[] = [
  {
    method: 'GET',
    path: '/api/audit-events',
    owner: 'W6-CP-05',
    landed: true,
    mandate: { section: '36', because: 'The simple audit UI needs a workspace-scoped event feed.' },
  },
];
