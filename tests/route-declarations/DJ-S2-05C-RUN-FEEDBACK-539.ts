/**
 * DJ-S2-05C-RUN-FEEDBACK-539 · `POST /api/runs/:id/feedback` — issue #539 (developer journey
 * S2-05c, C19, ADR-0105 "Feedback"): a thumbs up or down on one run's answer.
 *
 * Spec §34 prints the path, so it carries no `mandate` (ADR-0026).
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'POST',
    path: '/api/runs/:id/feedback',
    owner: 'DJ-S2-05C-RUN-FEEDBACK-539',
    landed: true,
  },
];
