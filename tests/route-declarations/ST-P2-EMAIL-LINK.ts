/**
 * ST-P2-EMAIL-LINK · `POST /api/auth/email-link`, `POST /api/auth/email-link/verify` — the Agent
 * Store's passwordless sign-in (phase P2).
 *
 * Spec §34's "Examples:" list does not print either route, so both carry a `mandate` under
 * [ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2. Each `because` is one quoted string: `declarationArrayToJson` refuses `+`.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'POST',
    path: '/api/auth/email-link',
    owner: 'ST-P2-EMAIL-LINK',
    landed: true,
    mandate: {
      section: '21',
      because:
        'spec §21 defines the guest role, and a guest has no password or identity provider account, so an address is sent a single-use link that signs it in to a demo workspace as that guest.',
    },
  },
  {
    method: 'POST',
    path: '/api/auth/email-link/verify',
    owner: 'ST-P2-EMAIL-LINK',
    landed: true,
    mandate: {
      section: '21',
      because:
        'spec §21 defines the guest role, and opening the emailed link consumes it once and binds the visitor as the guest of a demo workspace made for that address alone.',
    },
  },
];
