/**
 * DJ-S1-06-AGENT-POINTERS-444 · `PUT /api/agents/:id/pointers` — issue #444 (developer journey
 * S1-06), ADR-0101.
 *
 * Spec §34's "Examples:" list does not print the route, so it carries a `mandate` under
 * [ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2. §17 makes the agent definition what a Builder authors, and ADR-0101 makes an
 * environment run the version its pointer names. `POST /api/agents` gains a body form (create from a
 * first version) and is already declared, so it is not repeated here.
 *
 * The `because` is one quoted string, not a concatenated one: `tests/inventory-support.ts`'s
 * `declarationArrayToJson` reads a declaration file as plain data and refuses any expression, `+`
 * included.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'PUT',
    path: '/api/agents/:id/pointers',
    owner: 'DJ-S1-06-AGENT-POINTERS-444',
    landed: true,
    mandate: {
      section: '17',
      because:
        'spec §17 makes the agent definition what a Builder authors, and ADR-0101 makes an environment run the version its pointer names, so pointing the local environment at a saved version is how a saved definition becomes the agent that runs.',
    },
  },
];
