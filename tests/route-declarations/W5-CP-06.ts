import type { RouteDeclaration } from '../inventory-support.js';
export const routes: readonly RouteDeclaration[] = [
  { method: 'POST', path: '/api/shares', owner: 'W5-CP-06', landed: true },
  { method: 'GET', path: '/api/shares', owner: 'W5-CP-06', landed: true },
  { method: 'DELETE', path: '/api/shares/:id', owner: 'W5-CP-06', landed: true },
  // `page.tsx` serves this GET. The route inventory deliberately counts route handlers only;
  // the screen inventory owns and verifies the public page.
  { method: 'GET', path: '/p/:token', owner: 'W5-CP-06', landed: false },
  { method: 'POST', path: '/p/:token/messages', owner: 'W5-CP-06', landed: true },
];
