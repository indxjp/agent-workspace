/**
 * SDK-08 · the missing delete operation for skills (issue #240, S-12). It is not printed in spec
 * §34's example list, so it carries a `mandate` (ADR-0026). The same issue's secret delete (S-10)
 * is declared in `W2-CP-02.ts`, the secrets resource's one declaration file, and its connector
 * field update (S-20) widens the existing `PATCH /api/connectors/:id` declared by `W2-CP-05.ts`.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'DELETE',
    path: '/api/skills/:name',
    owner: 'SDK-08-RESOURCES-240',
    landed: true,
    mandate: {
      section: '7',
      because:
        'Managing skills includes removing one; the delete is refused while an agent has the skill assigned, so no assignment is silently dropped.',
    },
  },
];
