/**
 * DJ-B2B-TOOL-BUNDLES-790 · `POST /api/tool-bundles`, `GET /api/tool-bundles/:digest` — issue #790,
 * ADR-0118 TS1.
 *
 * Spec §34's "Examples:" list does not print either route, so both carry a `mandate` under
 * [ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2. Each `because` is one quoted string: `declarationArrayToJson` refuses `+`.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'POST',
    path: '/api/tool-bundles',
    owner: 'DJ-B2B-TOOL-BUNDLES-790',
    landed: true,
    mandate: {
      section: '17',
      because:
        'spec §17 makes the agent definition what a Builder authors, and ADR-0118 TS1 makes a code tool a content-addressed bundle uploaded once by aw push and pinned by digest in the agent version.',
    },
  },
  {
    method: 'GET',
    path: '/api/tool-bundles/:digest',
    owner: 'DJ-B2B-TOOL-BUNDLES-790',
    landed: true,
    mandate: {
      section: '17',
      because:
        'spec §17 makes the agent definition what a Builder authors, and ADR-0118 TS1 lets a client ask whether the bundle a version pins is already stored before uploading it again.',
    },
  },
];
