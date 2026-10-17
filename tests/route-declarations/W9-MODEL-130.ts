import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'GET',
    path: '/api/model-connections',
    owner: 'W9-MODEL-130',
    landed: true,
    mandate: {
      section: '13',
      because:
        'Issue #129 repurposed GET /api/models for discovered models and its own doc comment promised this route as the connection view that replaced it; issue #130 adds it, since every model-selection surface needs connection names discovery rows do not carry. See docs/adr/W9-MODEL-130-model-connections-list-route.md.',
    },
  },
];
