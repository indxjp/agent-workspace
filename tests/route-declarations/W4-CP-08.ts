import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  { method: 'GET', path: '/api/models', owner: 'W4-CP-08', landed: true },
  { method: 'POST', path: '/api/model-connections', owner: 'W4-CP-08', landed: true },
  {
    method: 'GET',
    path: '/api/model-connections/:id',
    owner: 'W4-CP-08',
    landed: true,
    mandate: {
      section: '13',
      because: 'A saved provider must be readable without displaying its write-once API key.',
    },
  },
  {
    method: 'PATCH',
    path: '/api/model-connections/:id',
    owner: 'W4-CP-08',
    landed: true,
    mandate: {
      section: '13',
      because:
        'Operators may update non-secret provider settings while the saved API key remains write-once.',
    },
  },
  {
    method: 'DELETE',
    path: '/api/model-connections/:id',
    owner: 'W4-CP-08',
    landed: true,
    mandate: {
      section: '13',
      because:
        'The Models page lists saved providers and requires a corresponding deletion operation.',
    },
  },
  {
    method: 'POST',
    path: '/api/model-connections/:id/test',
    owner: 'W4-CP-08',
    landed: true,
    mandate: {
      section: '13',
      because: 'The Add Provider flow explicitly requires Test Connection before and after save.',
    },
  },
];
