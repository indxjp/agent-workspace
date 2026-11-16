/**
 * ST-P6-DEMO-MAINTENANCE · `PUT /api/demo/maintenance/:entry`, `GET /api/store/demos`,
 * `GET /api/demo/readiness` — the daily production test's verdict, the store's read of it, and the
 * deploy's readiness check of the Agent Store (phase P6).
 *
 * Spec §34's "Examples:" list prints none of the three, so each carries a `mandate` under
 * [ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2. Each `because` is one quoted string: `declarationArrayToJson` refuses `+`.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'PUT',
    path: '/api/demo/maintenance/:entry',
    owner: 'ST-P6-DEMO-MAINTENANCE',
    landed: true,
    mandate: {
      section: '21',
      because:
        "spec §21 defines the guest role and its demo, and the deployment's daily production test puts a demo that failed under maintenance, so a visitor sees its recording rather than a broken run.",
    },
  },
  {
    method: 'GET',
    path: '/api/store/demos',
    owner: 'ST-P6-DEMO-MAINTENANCE',
    landed: true,
    mandate: {
      section: '21',
      because:
        'spec §21 defines the guest role and its demo, and the store reads which demos are under maintenance to show it on their cards before anyone signs in.',
    },
  },
  {
    method: 'GET',
    path: '/api/demo/readiness',
    owner: 'ST-P6-DEMO-MAINTENANCE',
    landed: true,
    mandate: {
      section: '21',
      because:
        "spec §21 defines the guest role and its demo, whose runs need the deployment's model key, so the deploy checks, read-only, that the key is configured and the model API is reachable before it calls the store ready.",
    },
  },
];
