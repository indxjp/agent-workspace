import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'POST',
    path: '/api/model-connections/:id/credential',
    owner: 'W9-PROV-126',
    landed: true,
    mandate: {
      section: '13',
      because:
        'Issue #126 requires a write-only credential-rotation path so an operator can replace a provider key without the write-once PATCH route ever accepting or exposing it.',
    },
  },
];
