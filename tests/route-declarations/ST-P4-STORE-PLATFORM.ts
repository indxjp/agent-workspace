/**
 * ST-P4-STORE-PLATFORM · `POST /api/store/leads`, `GET /api/store/privacy`, `GET /api/demo/allowance`
 * — the platform half of the Agent Store's app (phase P4).
 *
 * Spec §34's "Examples:" list prints none of the three, so each carries a `mandate` under
 * [ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2. Each `because` is one quoted string: `declarationArrayToJson` refuses `+`.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'POST',
    path: '/api/store/leads',
    owner: 'ST-P4-STORE-PLATFORM',
    landed: true,
    mandate: {
      section: '21',
      because:
        'spec §21 defines the guest role and its demo, and a visitor who has not signed in sends the store enquiry form or a launch-notice request, kept as one lead for that address.',
    },
  },
  {
    method: 'GET',
    path: '/api/store/privacy',
    owner: 'ST-P4-STORE-PLATFORM',
    landed: true,
    mandate: {
      section: '21',
      because:
        'spec §21 defines the guest role and its demo, and the store privacy notice states the lead retention period and the demo workspace lifetime from the deployment configuration, so a visitor can read them before signing in.',
    },
  },
  {
    method: 'GET',
    path: '/api/demo/allowance',
    owner: 'ST-P4-STORE-PLATFORM',
    landed: true,
    mandate: {
      section: '21',
      because:
        'spec §21 defines the guest role inside its own demo workspace, and the store shows the guest how many demo runs are left and when the workspace ends, read from the platform and never typed in.',
    },
  },
];
