import type { RouteDeclaration } from '../inventory-support.js';
export const routes: readonly RouteDeclaration[] = [
  { method: 'GET', path: '/api/projects', owner: 'W5-CP-02', landed: true },
  { method: 'POST', path: '/api/projects', owner: 'W5-CP-02', landed: true },
  { method: 'GET', path: '/api/projects/:id', owner: 'W5-CP-02', landed: true },
  { method: 'PATCH', path: '/api/projects/:id', owner: 'W5-CP-02', landed: true },
  {
    method: 'POST',
    path: '/api/projects/:id/sessions',
    owner: 'W5-CP-02',
    landed: true,
    mandate: { section: '20.5', because: 'A session may move into a project.' },
  },
];
