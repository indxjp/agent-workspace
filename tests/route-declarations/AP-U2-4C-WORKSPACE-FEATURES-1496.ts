/**
 * AP-U2-4C-WORKSPACE-FEATURES-1496 · `GET` and `PUT /api/workspaces/:id/features` — issue #1496,
 * ADR-0160 D6–D8.
 *
 * Spec §34's "Examples:" list prints neither, so each carries a `mandate` under
 * [ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2. §3 is the section that lets a workspace Owner subtract features from the platform.
 *
 * The `because` on each mandate is one quoted string: `tests/inventory-support.ts` reads a
 * declaration file as plain data and refuses any expression.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'GET',
    path: '/api/workspaces/:id/features',
    owner: 'AP-U2-4C-WORKSPACE-FEATURES-1496',
    landed: true,
    mandate: {
      section: '3',
      because:
        'spec §3 as amended by ADR-0160 lets a workspace Owner switch an installed feature off; this is the one place that choice is read.',
    },
  },
  {
    method: 'PUT',
    path: '/api/workspaces/:id/features',
    owner: 'AP-U2-4C-WORKSPACE-FEATURES-1496',
    landed: true,
    mandate: {
      section: '3',
      because:
        'spec §3 as amended by ADR-0160 lets a workspace Owner switch an installed feature off; this is the one place that choice is written.',
    },
  },
];
