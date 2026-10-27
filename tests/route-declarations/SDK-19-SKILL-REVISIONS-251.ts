/**
 * SDK-19 · publishing an immutable skill revision (issue #251, N-1). Spec §34 prints no route for
 * it, so it carries a `mandate` (ADR-0026).
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'POST',
    path: '/api/skills/:name/revisions',
    owner: 'SDK-19-SKILL-REVISIONS-251',
    landed: true,
    mandate: {
      section: '7',
      because:
        'An agent that pins a skill needs a revision that cannot change under it; publishing freezes the skill as the next numbered revision.',
    },
  },
];
