/**
 * DJ-80-13-FEEDBACK-LIST-620 · `GET /api/agents/:id/feedback` — issue #620 (80-13): the newest
 * ratings of an agent's runs, so a thumbs-down can become an evaluation case.
 *
 * Spec §34 prints the path, so it carries no `mandate` (ADR-0026).
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'GET',
    path: '/api/agents/:id/feedback',
    owner: 'DJ-80-13-FEEDBACK-LIST-620',
    landed: true,
  },
];
