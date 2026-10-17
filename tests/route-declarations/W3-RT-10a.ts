import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'POST',
    path: '/api/runtimes/:id',
    owner: 'W3-RT-10a',
    landed: true,
    mandate: {
      section: '14',
      because: 'Section 14.8 requires Test Runtime to create a sandbox, run echo, and destroy it.',
    },
  },
];
