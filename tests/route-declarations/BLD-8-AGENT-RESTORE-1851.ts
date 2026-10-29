/**
 * BLD-8-AGENT-RESTORE-1851 · `POST /api/agents/:id/restore` — issue #1851 slice 4: a person
 * brings back an agent the auto-archive sweep archived.
 *
 * Spec §34's "Examples:" list does not print the route, so it carries a `mandate` under
 * [ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'POST',
    path: '/api/agents/:id/restore',
    owner: 'BLD-8-AGENT-RESTORE-1851',
    landed: true,
    mandate: {
      section: '17',
      because:
        'spec §17 makes the agent definition what a Builder authors, and issue #1851 archives an agent-made agent that sat unused, so restoring one is how a person keeps an agent the sweep archived.',
    },
  },
];
