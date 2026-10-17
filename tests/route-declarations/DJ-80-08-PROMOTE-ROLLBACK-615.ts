/**
 * DJ-80-08-PROMOTE-ROLLBACK-615 · `POST /api/agents/:id/promote` and `POST /api/agents/:id/rollback`
 * — issue #615 (80-08): pointer moves with history.
 *
 * Spec §34's "Examples:" list does not print the routes, so each carries a `mandate` under
 * [ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2. The environment travels in the body, not the path, because §34's shape allows nothing
 * deeper than `/api/<resource>/:id/<sub>`.
 *
 * The `because` is one quoted string, not a concatenated one: `tests/inventory-support.ts`'s
 * `declarationArrayToJson` reads a declaration file as plain data and refuses any expression.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'POST',
    path: '/api/agents/:id/promote',
    owner: 'DJ-80-08-PROMOTE-ROLLBACK-615',
    landed: true,
    mandate: {
      section: '17',
      because:
        'spec §17 makes the agent definition what a Builder authors, ADR-0101 makes an environment run the version its pointer names, and issue #615 asks for production to reach a version deliberately, so promoting points production at the version local runs.',
    },
  },
  {
    method: 'POST',
    path: '/api/agents/:id/rollback',
    owner: 'DJ-80-08-PROMOTE-ROLLBACK-615',
    landed: true,
    mandate: {
      section: '17',
      because:
        'spec §17 makes the agent definition what a Builder authors, ADR-0101 makes an environment run the version its pointer names, and issue #615 asks for production to roll back in one request, so a rollback points an environment at the version it pointed at before.',
    },
  },
];
