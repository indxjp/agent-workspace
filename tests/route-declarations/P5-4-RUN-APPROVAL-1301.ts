/**
 * P5-4-RUN-APPROVAL-1301 · `POST /api/runs/:id/approval` — issue #1301 (Path to 100 · P5-4,
 * ADR-0145 D2): approve or reject the tool call a run paused on, which starts the continuation
 * run in the same session.
 *
 * Spec §34's "Examples:" list does not print the path, so it carries a `mandate` under
 * [ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'POST',
    path: '/api/runs/:id/approval',
    owner: 'P5-4-RUN-APPROVAL-1301',
    landed: true,
    mandate: {
      section: '21',
      because:
        'spec §21 gives Builder "Create/edit/run agents" and Viewer "Run permitted agents"; deciding the tool call a paused run waits on is how that run continues, so it is the same run verb on the same own-runs grant as interrupt, and it is the only way an agent that requires a person in the loop can finish.',
    },
  },
];
